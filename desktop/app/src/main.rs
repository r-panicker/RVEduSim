//! RVEduSim's desktop app: the page in a window, with window.rvNative (see
//! rvnative.js) backed by the Rust engine in desktop/native. Icarus Verilog
//! and Verilator are carried as resources; Verilator's models, and the Zig
//! compiler when the computer has none, are cached in the app's data folder.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use base64::Engine;
use rvnative::verilator::{BuildOpts, BuildResult};
use rvnative::{read_folder, FileData, Icarus, RunOpts, RunResult, Verilator};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::ipc::{Channel, Response};
use tauri::{Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// The toolchains' folder for this platform, as the build scripts name it.
fn target() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", _) => "win-x64",
        ("macos", "aarch64") => "mac-arm64",
        ("macos", _) => "mac-x64",
        _ => "linux-x64",
    }
}

/// The platform as the page names it (Node's process.platform).
fn platform() -> &'static str {
    match std::env::consts::OS { "windows" => "win32", "macos" => "darwin", o => o }
}

struct App {
    icarus: Option<Icarus>,
    vl_root: Option<PathBuf>,
    vl_cache: PathBuf,
    verilator: OnceLock<Option<Verilator>>,
    settings_path: PathBuf,
    settings: Mutex<serde_json::Map<String, Value>>,
    /// The folders the page may read: only ones the user chose here.
    allowed: Mutex<HashSet<String>>,
}

impl App {
    fn verilator(&self) -> Option<&Verilator> {
        self.verilator.get_or_init(|| self.vl_root.clone().and_then(|r| Verilator::new(r, self.vl_cache.clone()).ok())).as_ref()
    }
    fn save_settings(&self) {
        let s = Value::Object(self.settings.lock().unwrap().clone());
        let _ = std::fs::write(&self.settings_path, serde_json::to_string_pretty(&s).unwrap_or_default());
    }
}

type AppState<'a> = State<'a, Arc<App>>;

/// A file from the page: text, or { b64 } for bytes.
#[derive(Deserialize)]
#[serde(untagged)]
enum WireFile {
    Text(String),
    Bytes { b64: String },
}

fn files_in(files: BTreeMap<String, WireFile>) -> Result<BTreeMap<String, FileData>, String> {
    files.into_iter().map(|(k, v)| Ok((k, match v {
        WireFile::Text(s) => FileData::Text(s),
        WireFile::Bytes { b64 } => FileData::Bytes(base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?),
    }))).collect()
}

/// A result as one binary frame: a JSON header (with the kept files' names
/// and sizes), then their bytes. A waveform can be hundreds of megabytes,
/// which JSON would multiply.
fn frame(mut head: Value, files: &BTreeMap<String, Vec<u8>>) -> Response {
    head["files"] = json!(files.iter().map(|(k, v)| json!([k, v.len()])).collect::<Vec<_>>());
    let h = serde_json::to_vec(&head).unwrap_or_default();
    let mut out = Vec::with_capacity(4 + h.len() + files.values().map(Vec::len).sum::<usize>());
    out.extend_from_slice(&(h.len() as u32).to_le_bytes());
    out.extend_from_slice(&h);
    for v in files.values() { out.extend_from_slice(v); }
    Response::new(out)
}

fn run_frame(r: RunResult) -> Response {
    if r.cancelled { return frame(json!({ "cancelled": true }), &BTreeMap::new()); }
    frame(json!({ "out": r.out, "err": r.err, "code": r.code }), &r.files)
}

/// Runs f off the IPC thread: every tool run blocks until the tool exits.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn hdl_run(app: AppState<'_>, id: u64, tool: String, files: BTreeMap<String, WireFile>, args: Vec<String>, opts: RunOpts) -> Result<Response, String> {
    let app = app.inner().clone();
    blocking(move || {
        let ic = app.icarus.as_ref().ok_or("This build has no native Icarus Verilog.")?;
        ic.run(id, &tool, &files_in(files)?, &args, &opts).map(run_frame).map_err(|e| e.to_string())
    }).await
}

#[tauri::command]
fn hdl_kill(app: AppState<'_>, id: u64) {
    if let Some(i) = &app.icarus { i.kill(id); }
    if let Some(v) = app.verilator.get().and_then(Option::as_ref) { v.kill(id); }
}

#[tauri::command]
async fn vl_build(app: AppState<'_>, id: u64, files: BTreeMap<String, String>, opts: BuildOpts, on_progress: Channel<Value>) -> Result<BuildResult, String> {
    let app = app.inner().clone();
    blocking(move || {
        let vl = app.verilator().ok_or("This build has no Verilator.")?;
        let progress = move |p: Value| { let _ = on_progress.send(p); };
        vl.build(id, &files, &opts, &progress).map_err(|e| e.to_string())
    }).await
}

#[tauri::command]
async fn vl_run(app: AppState<'_>, id: u64, key: String, files: BTreeMap<String, WireFile>, args: Vec<String>, opts: RunOpts) -> Result<Response, String> {
    let app = app.inner().clone();
    blocking(move || {
        let vl = app.verilator().ok_or("This build has no Verilator.")?;
        vl.run(id, &key, &files_in(files)?, &args, &opts).map(run_frame).map_err(|e| e.to_string())
    }).await
}

/// A live run's output is passed on every 50 ms rather than as it comes.
#[tauri::command]
async fn vl_live(app: AppState<'_>, id: u64, key: String, files: BTreeMap<String, WireFile>, args: Vec<String>, opts: RunOpts, on_data: Channel<String>) -> Result<Response, String> {
    let app = app.inner().clone();
    blocking(move || {
        let vl = app.verilator().ok_or("This build has no Verilator.")?;
        let buf = Arc::new(Mutex::new(String::new()));
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flush = { let buf = buf.clone(); let ch = on_data.clone(); move || {
            let text = std::mem::take(&mut *buf.lock().unwrap());
            if !text.is_empty() { let _ = ch.send(text); }
        } };
        let ticker = { let flush = flush.clone(); let done = done.clone(); thread::spawn(move || {
            while !done.load(std::sync::atomic::Ordering::Relaxed) { thread::sleep(Duration::from_millis(50)); flush(); }
        }) };
        let sink = { let buf = buf.clone(); move |t: String| buf.lock().unwrap().push_str(&t) };
        let r = vl.run_live(id, &key, &files_in(files)?, &args, &opts.keep, &sink);
        done.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = ticker.join();
        flush();
        r.map(run_frame).map_err(|e| e.to_string())
    }).await
}

#[tauri::command]
fn vl_live_send(app: AppState<'_>, id: u64, line: String) {
    if let Some(v) = app.verilator.get().and_then(Option::as_ref) { v.live_send(id, &line); }
}

#[tauri::command]
fn vl_live_read(app: AppState<'_>, id: u64, name: String, max: u64) -> Response {
    let f = app.verilator.get().and_then(Option::as_ref).and_then(|v| v.live_read(id, &name, max));
    match f {
        None => frame(json!({ "none": true }), &BTreeMap::new()),
        Some(f) => {
            let mut files = BTreeMap::new();
            if let Some(d) = f.data { files.insert("data".to_string(), d); }
            frame(json!({ "size": f.size }), &files)
        }
    }
}

#[tauri::command]
async fn folder_pick(app: AppState<'_>, handle: tauri::AppHandle) -> Result<Option<String>, String> {
    let app = app.inner().clone();
    blocking(move || {
        // RVSIM_TEST_FOLDER stands in for the dialog's answer: a WebDriver
        // test cannot reach a native dialog.
        let dir = match std::env::var("RVSIM_TEST_FOLDER") {
            Ok(d) => d,
            Err(_) => {
                let mut d = handle.dialog().file();
                if let Some(Value::String(f)) = app.settings.lock().unwrap().get("folder") { d = d.set_directory(f); }
                let Some(picked) = d.blocking_pick_folder() else { return Ok(None) };
                picked.into_path().map_err(|e| e.to_string())?.to_string_lossy().into_owned()
            }
        };
        app.allowed.lock().unwrap().insert(dir.clone());
        app.settings.lock().unwrap().insert("folder".into(), Value::String(dir.clone()));
        app.save_settings();
        Ok(Some(dir))
    }).await
}

#[tauri::command]
async fn folder_read(app: AppState<'_>, dir: String) -> Result<Vec<rvnative::folder::FolderFile>, String> {
    if !app.allowed.lock().unwrap().contains(&dir) { return Err("That folder was not chosen in this app.".into()); }
    blocking(move || Ok(read_folder(&PathBuf::from(dir)))).await
}

#[tauri::command]
fn folder_forget(app: AppState<'_>) {
    app.settings.lock().unwrap().remove("folder");
    app.save_settings();
}

#[tauri::command]
fn open_external(handle: tauri::AppHandle, url: String) {
    if url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:") {
        let _ = handle.opener().open_url(url, None::<&str>);
    }
}

fn main() {
    // WebKitGTK's DMA-BUF renderer leaves the window blank on some graphics
    // drivers (NVIDIA's in particular); the older path draws everywhere.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![hdl_run, hdl_kill, vl_build, vl_run, vl_live, vl_live_send, vl_live_read,
            folder_pick, folder_read, folder_forget, open_external])
        .setup(|app| {
            // RVSIM_USER_DATA keeps an instance's settings and caches apart
            // from the installed app's (the tests use it).
            let data = std::env::var_os("RVSIM_USER_DATA").map(PathBuf::from).unwrap_or(app.path().app_data_dir()?);
            std::fs::create_dir_all(&data)?;
            let res = app.path().resource_dir().ok();
            let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
            let icarus = Icarus::find(&[res.clone().map(|r| r.join("iverilog")), Some(dev.join("iverilog").join(target()))].into_iter().flatten().collect::<Vec<_>>());
            let vl_root = Verilator::find(&[res.map(|r| r.join("verilator")), Some(dev.join("verilator").join(target()))].into_iter().flatten().collect::<Vec<_>>());
            let settings_path = data.join("settings.json");
            let settings: serde_json::Map<String, Value> = std::fs::read_to_string(&settings_path).ok()
                .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            let folder = settings.get("folder").and_then(Value::as_str).map(String::from);
            let vl_version = vl_root.as_ref().and_then(|r| std::fs::read_to_string(r.join("VERSION")).ok())
                .map(|v| v.split_whitespace().next().unwrap_or("").to_string());
            let info = json!({
                "icarus": icarus.is_some(), "icarusVersion": icarus.as_ref().and_then(|i| i.version.clone()),
                "verilator": vl_root.is_some(), "verilatorVersion": vl_version,
                "folder": folder, "platform": platform(),
            });
            let state = Arc::new(App {
                icarus, vl_root, vl_cache: data.join("verilator"), verilator: OnceLock::new(), settings_path,
                allowed: Mutex::new(folder.into_iter().collect()), settings: Mutex::new(settings),
            });
            app.manage(state);

            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("RVEduSim")
                .inner_size(1440.0, 920.0)
                .background_color(tauri::window::Color(0x1e, 0x1e, 0x2e, 0xff))
                .initialization_script(format!("window.__RVNATIVE_INFO__ = {info};\n{}", include_str!("rvnative.js")))
                // The app's own pages stay in the window; anything else opens in the browser.
                .on_navigation(move |url| {
                    let local = url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost");
                    if !local { let _ = handle.opener().open_url(url.as_str(), None::<&str>); }
                    local
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not start RVEduSim");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let state = handle.state::<Arc<App>>();
            if let Some(i) = &state.icarus { i.kill_all(); }
            if let Some(v) = state.verilator.get().and_then(Option::as_ref) { v.kill_all(); }
        }
    });
}
