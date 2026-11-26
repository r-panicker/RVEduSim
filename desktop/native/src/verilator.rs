//! Verilator for the desktop app. A build turns the page's sources into a
//! native model with verilator_bin and a C++20 compiler, and is cached on
//! disk by content, so the same sources build once. A run is then like a vvp
//! run: a temporary directory, plusargs, output and kept files back.
//!
//! The compiler is the user's own when one works (CXX, g++, clang++; on
//! macOS only once the Xcode command line tools are installed, since probing
//! clang++ without them opens the installer). Otherwise a pinned Zig release
//! is downloaded once into the cache, checked against its SHA-256, and
//! "zig c++" is used. Each step is reported through progress so the page
//! can say what a long first build is doing.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::jobs::{code_of, Ended, Jobs};
use crate::process::{check_name, kept_files, run_process, write_files, FileData, RunOpts, RunResult, TempDir};
use crate::EXE;

const TOP: &str = "cg3207_hdl_tb";
const KEEP_MODELS: usize = 8;
/// Compiled into every model; see its header. The testbench only calls it with +LIVE.
const LIVE_CPP: &str = include_str!("live.cpp");

/// Measured on the RV/ RTL against Verilator's own default, -Os: the
/// simulation runs about 1.85 times as fast without the trace, 1.37 with it,
/// for about 0.9 s more per build.
fn opt() -> String { std::env::var("RVSIM_VL_OPT").unwrap_or_else(|_| "-O3".into()) }

const ZIG_VERSION: &str = "0.17.1";
/// The Zig release for this platform: its file and SHA-256.
fn zig_release() -> Option<(&'static str, &'static str)> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some(("zig-x86_64-linux-0.17.1.tar.xz", "3581863e3cbcfd0fce0efc682ce7e9e93da96668a977791d356a26d2a7e9b17a")),
        ("windows", "x86_64") => Some(("zig-x86_64-windows-0.17.1.zip", "b03f477a1943673e02aca0f570e8030dffd536ce1f45cbc4d3326ec31159562e")),
        ("macos", "aarch64") => Some(("zig-aarch64-macos-0.17.1.tar.xz", "75f1bc7a1e9852f17ec9a0c1895f767c4ec56d46bc8a834920eece1d0359dd8d")),
        ("macos", "x86_64") => Some(("zig-x86_64-macos-0.17.1.tar.xz", "9af07b20319fbd0c92ee46ad23e81d6a782b1aaea2cfb8dcbff35f1d2c7ddbb7")),
        _ => None,
    }
}
/// RVSIM_ZIG_URL replaces the base URL, for testing without the network.
fn zig_base() -> String { std::env::var("RVSIM_ZIG_URL").unwrap_or_else(|_| format!("https://ziglang.org/download/{ZIG_VERSION}/")) }

/// What a build reports as it goes: { phase, ... }, as the page reads it.
pub type Progress<'a> = &'a (dyn Fn(Value) + Sync);

#[derive(Clone)]
struct Compiler {
    cmd: String,
    pre: Vec<String>,
    flags: Vec<String>,
    id: String,
    env: Vec<(String, String)>,
    name: String,
}

/// language: a --default-language value; headers: sources only there to be
/// included; wave_top: dump only the Wrapper's own signals.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildOpts {
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub wave_top: bool,
}

#[derive(Debug, Default, Serialize)]
pub struct BuildResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compiler: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ms: Option<Value>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cancelled: bool,
}

impl BuildResult {
    fn cancelled() -> Self { BuildResult { cancelled: true, ..Default::default() } }
    fn failed(log: String, compiler: Option<String>) -> Self { BuildResult { ok: Some(false), log: Some(log), compiler, ..Default::default() } }
}

/// A file a live run has written: its size, and its bytes unless larger than asked for.
#[derive(Debug, Serialize)]
pub struct LiveFile {
    pub size: u64,
    #[serde(skip)]
    pub data: Option<Vec<u8>>,
}

struct Live {
    stdin: Option<ChildStdin>,
    dir: PathBuf,
}

pub struct Verilator {
    pub root: PathBuf,
    pub version: String,
    cache: PathBuf,
    jobs: Jobs,
    /// The compiler the first build found; a failure is not remembered, so
    /// going online and building again can fetch Zig.
    compiler: Mutex<Option<Compiler>>,
    live: Mutex<HashMap<u64, Live>>,
    /// Commands sent to a live run before its process started.
    early: Mutex<HashMap<u64, Vec<String>>>,
}

impl Verilator {
    /// Whether dir holds a build of Verilator.
    pub fn found(dir: &Path) -> bool {
        dir.join("bin").join(format!("verilator_bin{EXE}")).exists() && dir.join("include").join("verilated.cpp").exists()
    }

    pub fn find(candidates: &[PathBuf]) -> Option<PathBuf> { candidates.iter().find(|d| Self::found(d)).cloned() }

    pub fn new(root: PathBuf, cache: PathBuf) -> std::io::Result<Self> {
        let version = fs::read_to_string(root.join("VERSION"))?.trim().to_string();
        fs::create_dir_all(&cache)?;
        Ok(Verilator { root, version, cache, jobs: Jobs::new(), compiler: Mutex::new(None), live: Mutex::new(HashMap::new()), early: Mutex::new(HashMap::new()) })
    }

    /// The version the page shows: its first word.
    pub fn short_version(&self) -> String { self.version.split_whitespace().next().unwrap_or("").to_string() }

    fn bin(&self) -> PathBuf { self.root.join("bin").join(format!("verilator_bin{EXE}")) }
    fn inc(&self) -> PathBuf { self.root.join("include") }
    fn model_dir(&self, key: &str) -> PathBuf { self.cache.join("models").join(key) }
    fn model_exe(&self, key: &str) -> PathBuf { self.model_dir(key).join(format!("V{TOP}{EXE}")) }

    // ---- the compiler ------------------------------------------------------
    const PROBE: &'static str = "#include <coroutine>\nstruct T { struct promise_type { T get_return_object() { return {}; } std::suspend_never initial_suspend() { return {}; } std::suspend_never final_suspend() noexcept { return {}; } void return_void() {} void unhandled_exception() {} }; };\nT f() { co_return; }\nint main() { f(); return 0; }\n";

    /// Whether cmd compiles C++20 coroutines, and with which extra flags.
    fn works(&self, cmd: &str, pre: &[String], env: &[(String, String)]) -> Option<(Vec<String>, String)> {
        let tmp = TempDir::new("rvsim-cxx-").ok()?;
        fs::write(tmp.path().join("p.cpp"), Self::PROBE).ok()?;
        for extra in [vec![], vec!["-fcoroutines".to_string()]] {
            let mut args: Vec<String> = pre.to_vec();
            args.push("-std=c++20".into());
            args.extend(extra.iter().cloned());
            args.extend(["p.cpp".into(), "-o".into(), format!("p{EXE}")]);
            if sh(cmd, &args, Some(tmp.path()), env).0 == 0 {
                let mut va = pre.to_vec();
                va.push("--version".into());
                let v = sh(cmd, &va, None, env).1;
                return Some((extra, v.lines().next().unwrap_or("").trim().to_string()));
            }
        }
        None
    }

    fn system_compilers() -> Vec<String> {
        let mut list = Vec::new();
        if std::env::var_os("RVSIM_FORCE_ZIG").is_some() { return list; }
        if let Ok(cxx) = std::env::var("CXX") { if !cxx.is_empty() { list.push(cxx); } }
        if cfg!(target_os = "macos") {
            if sh("xcode-select", &["-p".into()], None, &[]).0 == 0 { list.push("clang++".into()); }
        } else {
            list.push("g++".into());
            list.push("clang++".into());
        }
        list
    }

    fn fetch_zig(&self, id: u64, progress: Progress) -> Result<Option<PathBuf>, String> {
        let Some((file, sha)) = zig_release() else { return Ok(None) };
        let name = file.trim_end_matches(".tar.xz").trim_end_matches(".zip");
        let dest = self.cache.join(name);
        let zig = dest.join(format!("zig{EXE}"));
        if zig.exists() { return Ok(Some(zig)); }
        let archive = self.cache.join(file);
        progress(json!({ "phase": "compiler-download", "received": 0, "total": 0, "file": file }));
        let part = self.cache.join(format!("{file}.part"));
        download(&format!("{}{file}", zig_base()), &part, sha, progress, &|| self.jobs.is_killed(id))?;
        fs::rename(&part, &archive).map_err(|e| e.to_string())?;
        progress(json!({ "phase": "compiler-unpack" }));
        let tmp = self.cache.join(format!("{name}.part"));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        // Windows' own tar (bsdtar) reads the .zip; a GNU tar from Git or
        // MSYS2 earlier on the PATH does not.
        let tar = system_tar();
        let (code, out) = sh(&tar, &["-xf".into(), archive.to_string_lossy().into_owned(), "-C".into(), tmp.to_string_lossy().into_owned()], None, &[]);
        if code != 0 { return Err(format!("Could not unpack {file}: {out}")); }
        let _ = fs::remove_dir_all(&dest);
        fs::rename(tmp.join(name), &dest).map_err(|e| e.to_string())?;
        let _ = fs::remove_dir_all(&tmp);
        let _ = fs::remove_file(&archive);
        Ok(Some(zig))
    }

    fn find_compiler(&self, id: u64, progress: Progress) -> Result<Compiler, String> {
        let mut slot = self.compiler.lock().unwrap();
        if let Some(c) = slot.as_ref() { return Ok(c.clone()); }
        for cmd in Self::system_compilers() {
            if let Some((flags, vid)) = self.works(&cmd, &[], &[]) {
                let c = Compiler { cmd: cmd.clone(), pre: vec![], flags, id: vid, env: vec![], name: cmd };
                *slot = Some(c.clone());
                return Ok(c);
            }
        }
        let zig = self.fetch_zig(id, progress).map_err(|e| format!(
            "Verilator needs a C++ compiler. None was found on this computer, and the one the simulator uses instead \
             (Zig {ZIG_VERSION}) could not be downloaded: {e}. Connect to the internet and build again, or install one: \
             g++ on Linux, the Xcode command line tools on macOS (xcode-select --install)."))?;
        if let Some(zig) = zig {
            // Zig keeps its own cache of compiled C and C++ libraries; it
            // lives with ours rather than in the user's home directory. Its
            // first compile builds the C++ library, which takes a while, once.
            progress(json!({ "phase": "compiler-check" }));
            let env = vec![("ZIG_GLOBAL_CACHE_DIR".to_string(), self.cache.join("zig-cache").to_string_lossy().into_owned())];
            let cmd = zig.to_string_lossy().into_owned();
            let pre = vec!["c++".to_string()];
            if let Some((flags, vid)) = self.works(&cmd, &pre, &env) {
                let c = Compiler { cmd, pre, flags, id: format!("zig {vid}"), env, name: format!("Zig {ZIG_VERSION}") };
                *slot = Some(c.clone());
                return Ok(c);
            }
        }
        Err(format!("No C++20 compiler was found, and Zig {ZIG_VERSION} did not work on this computer."))
    }

    // ---- building ----------------------------------------------------------
    /// The runtime is linked into the model statically, so the DPI functions
    /// are not DLL imports on Windows (DPI_DLLISPEC), and the time comes from
    /// the context the generated main advances (VL_TIME_CONTEXT), not from
    /// the weak sc_time_stamp() Windows cannot provide.
    fn cxx_flags(&self, cc: &Compiler, vars: &BTreeMap<String, String>) -> Vec<String> {
        let mut f: Vec<String> = vec!["-std=c++20".into()];
        f.extend(cc.flags.iter().cloned());
        let inc = self.inc();
        f.extend([opt(), "-I.".into(), format!("-I{}", inc.to_string_lossy()), format!("-I{}", inc.join("vltstd").to_string_lossy()),
            "-faligned-new".into(), "-fcf-protection=none".into(), "-w".into()]);
        f.extend(["-DVERILATOR=1".into(), "-DVL_TIME_CONTEXT".into(), "-DDPI_DLLISPEC=".into()]);
        for (k, v) in vars {
            if k.starts_with("VM_") && !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()) { f.push(format!("-D{k}={v}")); }
        }
        if let Some(p) = vars.get("VM_PREFIX_INCLUDE") { f.push(format!("-DVM_PREFIX_INCLUDE={p}")); }
        f
    }

    /// Runs a compile step as part of job id; (code, output), or None when the job was killed.
    fn exec(&self, id: u64, cmd: &str, args: &[String], cwd: &Path, env: &[(String, String)]) -> Option<(i32, String)> {
        let mut c = Command::new(cmd);
        c.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for (k, v) in env { c.env(k, v); }
        let child = match self.jobs.spawn(id, &mut c) {
            Ok(Some(ch)) => ch,
            Ok(None) => return None,
            Err(e) => return Some((1, e.to_string())),
        };
        let (out, err) = { let mut g = child.lock().unwrap(); (g.stdout.take(), g.stderr.take()) };
        let text = Arc::new(Mutex::new(Vec::<u8>::new()));
        let readers: Vec<_> = [out.map(|o| Box::new(o) as Box<dyn Read + Send>), err.map(|e| Box::new(e) as Box<dyn Read + Send>)]
            .into_iter().flatten().map(|mut r| { let t = text.clone(); thread::spawn(move || {
                let mut buf = [0u8; 8192];
                while let Ok(n) = r.read(&mut buf) { if n == 0 { break; } t.lock().unwrap().extend_from_slice(&buf[..n]); }
            }) }).collect();
        let ended = self.jobs.wait(id, &child);
        for r in readers { let _ = r.join(); }
        let out = String::from_utf8_lossy(&text.lock().unwrap()).into_owned();
        match ended { Ok(Ended::Exited(s)) => Some((code_of(&s), out)), Ok(Ended::Killed) => None, Err(e) => Some((1, e.to_string())) }
    }

    /// Runs f over items, at most one per processor at a time; the first
    /// failure, or None. f's error "cancelled" stops the rest.
    fn pool<T: Sync>(items: &[T], f: &(dyn Fn(&T) -> Option<String> + Sync)) -> Option<String> {
        let n = thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(items.len().max(1));
        let next = Mutex::new(0usize);
        let failed = Mutex::new(None::<String>);
        thread::scope(|s| {
            for _ in 0..n {
                s.spawn(|| loop {
                    if failed.lock().unwrap().is_some() { return; }
                    let i = { let mut g = next.lock().unwrap(); let i = *g; *g += 1; i };
                    if i >= items.len() { return; }
                    if let Some(e) = f(&items[i]) { let mut g = failed.lock().unwrap(); if g.is_none() { *g = Some(e); } }
                });
            }
        });
        failed.into_inner().unwrap()
    }

    /// Verilator's own runtime, compiled once per compiler and Verilator.
    fn runtime_objects(&self, id: u64, cc: &Compiler, vars: &BTreeMap<String, String>, obj_dir: &Path, progress: Progress) -> Result<Vec<PathBuf>, String> {
        let names: Vec<String> = format!("{} {}", vars.get("VM_GLOBAL_FAST").map(String::as_str).unwrap_or(""), vars.get("VM_GLOBAL_SLOW").map(String::as_str).unwrap_or(""))
            .split_whitespace().map(String::from).collect();
        let flags = self.cxx_flags(cc, vars);
        let dir = self.cache.join(format!("runtime-{}", hash(&[self.version.as_bytes(), cc.id.as_bytes(), flags.join(" ").as_bytes()])));
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let objs: Vec<PathBuf> = names.iter().map(|n| dir.join(format!("{n}.o"))).collect();
        let todo: Vec<&String> = names.iter().filter(|n| !dir.join(format!("{n}.o")).exists()).collect();
        let done = Mutex::new(0usize);
        if !todo.is_empty() { progress(json!({ "phase": "runtime", "done": 0, "total": todo.len() })); }
        let inc = self.inc();
        let fail = Self::pool(&todo, &|n: &&String| {
            let tmp = dir.join(format!("{n}.o.part"));
            let mut args = cc.pre.clone();
            args.extend(flags.iter().cloned());
            args.extend(["-c".into(), inc.join(format!("{n}.cpp")).to_string_lossy().into_owned(), "-o".into(), tmp.to_string_lossy().into_owned()]);
            match self.exec(id, &cc.cmd, &args, obj_dir, &cc.env) {
                None => Some("cancelled".into()),
                Some((0, _)) => {
                    if let Err(e) = fs::rename(&tmp, dir.join(format!("{n}.o"))) { return Some(e.to_string()); }
                    let mut d = done.lock().unwrap(); *d += 1;
                    progress(json!({ "phase": "runtime", "done": *d, "total": todo.len() }));
                    None
                }
                Some((_, out)) => Some(format!("{n}.cpp: {out}")),
            }
        });
        match fail {
            Some(e) if e == "cancelled" => Err(e),
            Some(e) => Err(format!("Compiling the Verilator runtime failed: {e}")),
            None => Ok(objs),
        }
    }

    fn prune_models(&self) {
        let dir = self.cache.join("models");
        let Ok(rd) = fs::read_dir(&dir) else { return };
        let mut entries: Vec<(std::time::SystemTime, PathBuf)> = rd.flatten().map(|e| {
            let p = e.path();
            let t = fs::metadata(p.join("used")).or_else(|_| fs::metadata(&p)).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            (t, p)
        }).collect();
        entries.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, p) in entries.into_iter().skip(KEEP_MODELS) { let _ = fs::remove_dir_all(p); }
    }

    /// Builds files (name -> source, each compiled) into a model, as job id.
    pub fn build(&self, id: u64, files: &BTreeMap<String, String>, opts: &BuildOpts, progress: Progress) -> std::io::Result<BuildResult> {
        let r = self.build_inner(id, files, opts, progress);
        self.jobs.finish(id);
        r
    }

    fn build_inner(&self, id: u64, files: &BTreeMap<String, String>, opts: &BuildOpts, progress: Progress) -> std::io::Result<BuildResult> {
        let cc = match self.find_compiler(id, progress) {
            _ if self.jobs.is_killed(id) => return Ok(BuildResult::cancelled()),
            Ok(c) => c,
            Err(e) => return Ok(BuildResult::failed(e, None)),
        };
        let mut vargs: Vec<String> = ["--cc", "--exe", "--main", "--timing", "--trace", "--top-module", TOP, "--default-language"]
            .iter().map(|s| s.to_string()).collect();
        vargs.push(opts.language.clone().unwrap_or_else(|| "1364-2005".into()));
        vargs.extend(["-Wno-fatal", "-Wno-lint", "-Wno-style", "-Wno-TIMESCALEMOD", "-Wno-MULTITOP", "--x-assign", "fast",
            "--x-initial", "fast", "-O3", "--Mdir", "obj"].iter().map(|s| s.to_string()));
        // Verilator ignores $dumpvars's depth, and inlining makes --trace-depth
        // count everything under the Wrapper as one level, so what a model can
        // dump is limited by scope, when it is built. A scope pattern matches a
        // scope's own signals too, so dut.*.* leaves the Wrapper's signals in
        // and takes out everything instantiated in it.
        let mut extra: BTreeMap<String, String> = BTreeMap::new();
        if opts.wave_top { extra.insert("wave_top.vlt".into(), format!("`verilator_config\ntracing_off -scope \"{TOP}.dut.*.*\"\n")); }
        let mut parts: Vec<Vec<u8>> = vec![self.version.clone().into_bytes(), cc.id.clone().into_bytes(), vargs.join(" ").into_bytes()];
        for (n, s) in files { parts.push(format!("{n}\n{s}").into_bytes()); }
        for (n, s) in &opts.headers { parts.push(format!("h {n}\n{s}").into_bytes()); }
        for (n, s) in &extra { parts.push(format!("{n}{s}").into_bytes()); }
        parts.push(LIVE_CPP.as_bytes().to_vec());
        let key = hash(&parts.iter().map(|p| p.as_slice()).collect::<Vec<_>>());
        let model_dir = self.model_dir(&key);
        let model = self.model_exe(&key);
        if model.exists() {
            let _ = fs::write(model_dir.join("used"), b"");
            return Ok(BuildResult { ok: Some(true), key: Some(key), cached: Some(true),
                log: Some(fs::read_to_string(model_dir.join("verilator.log")).unwrap_or_default()), compiler: Some(cc.name), ..Default::default() });
        }
        let tmp = TempDir::new("rvsim-vl-")?;
        let dir = tmp.path();
        for (n, s) in files.iter().chain(opts.headers.iter()).chain(extra.iter()) {
            check_name(n)?;
            fs::write(dir.join(n), s)?;
        }
        let t0 = std::time::Instant::now();
        let mut args = vargs.clone();
        args.extend(extra.keys().cloned());
        args.extend(files.keys().cloned());
        let root_env = vec![("VERILATOR_ROOT".to_string(), self.root.to_string_lossy().into_owned())];
        let Some((vcode, vout)) = self.exec(id, &self.bin().to_string_lossy(), &args, dir, &root_env) else { return Ok(BuildResult::cancelled()) };
        if vcode != 0 { return Ok(BuildResult::failed(vout, Some(cc.name))); }
        let t1 = std::time::Instant::now();
        let obj_dir = dir.join("obj");
        fs::write(obj_dir.join("cg3207_live.cpp"), LIVE_CPP)?;
        let vars = read_mk(&obj_dir);
        let rt = match self.runtime_objects(id, &cc, &vars, &obj_dir, progress) {
            Ok(r) => r,
            Err(e) if e == "cancelled" => return Ok(BuildResult::cancelled()),
            Err(e) => return Ok(BuildResult::failed(e, Some(cc.name))),
        };
        let flags = self.cxx_flags(&cc, &vars);
        let mut srcs: Vec<String> = fs::read_dir(&obj_dir)?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".cpp")).collect();
        srcs.sort();
        let done = Mutex::new(0usize);
        progress(json!({ "phase": "cxx", "done": 0, "total": srcs.len() }));
        let fail = Self::pool(&srcs, &|n: &String| {
            let mut a = cc.pre.clone();
            a.extend(flags.iter().cloned());
            a.extend(["-c".into(), n.clone(), "-o".into(), n.replace(".cpp", ".o")]);
            match self.exec(id, &cc.cmd, &a, &obj_dir, &cc.env) {
                None => Some("cancelled".into()),
                Some((0, _)) => { let mut d = done.lock().unwrap(); *d += 1; progress(json!({ "phase": "cxx", "done": *d, "total": srcs.len() })); None }
                Some((_, out)) => Some(format!("{n}: {out}")),
            }
        });
        match fail {
            Some(e) if e == "cancelled" => return Ok(BuildResult::cancelled()),
            Some(e) => return Ok(BuildResult::failed(format!("{vout}\nC++ compilation failed: {e}"), Some(cc.name))),
            None => {}
        }
        // macOS: Verilator's weak symbols are left for the loader, as its own makefile does.
        progress(json!({ "phase": "link" }));
        let mut link = cc.pre.clone();
        link.extend(srcs.iter().map(|n| n.replace(".cpp", ".o")));
        link.extend(rt.iter().map(|p| p.to_string_lossy().into_owned()));
        link.extend(["-o".into(), format!("V{TOP}{EXE}")]);
        if cfg!(target_os = "macos") { link.extend(["-pthread".into(), "-Wl,-U,__Z15vl_time_stamp64v,-U,__Z13sc_time_stampv,-U,_vlog_startup_routines".into()]); }
        else if !cfg!(windows) { link.push("-pthread".into()); }
        let Some((lcode, lout)) = self.exec(id, &cc.cmd, &link, &obj_dir, &cc.env) else { return Ok(BuildResult::cancelled()) };
        if lcode != 0 { return Ok(BuildResult::failed(format!("{vout}\nLinking failed: {lout}"), Some(cc.name))); }
        fs::create_dir_all(&model_dir)?;
        fs::copy(obj_dir.join(format!("V{TOP}{EXE}")), &model)?;
        make_executable(&model)?;
        fs::write(model_dir.join("verilator.log"), &vout)?;
        fs::write(model_dir.join("used"), b"")?;
        self.prune_models();
        Ok(BuildResult { ok: Some(true), key: Some(key), cached: Some(false), log: Some(vout), compiler: Some(cc.name),
            ms: Some(json!({ "verilate": (t1 - t0).as_millis() as u64, "cxx": t1.elapsed().as_millis() as u64 })), ..Default::default() })
    }

    fn model_for(&self, key: &str) -> std::io::Result<PathBuf> {
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) { return Err(std::io::Error::other("bad model key")); }
        let m = self.model_exe(key);
        if !m.exists() { return Err(std::io::Error::other("The Verilator model is no longer cached; run again from Reset.")); }
        Ok(m)
    }

    pub fn run(&self, id: u64, key: &str, files: &BTreeMap<String, FileData>, args: &[String], opts: &RunOpts) -> std::io::Result<RunResult> {
        let model = self.model_for(key)?;
        run_process(&self.jobs, id, &model, args, files, opts)
    }

    /// A live run: the model keeps stdin open for commands (see live.cpp) and
    /// its output is handed to on_data as it comes. The files it writes stay
    /// readable through live_read() until it ends.
    pub fn run_live(&self, id: u64, key: &str, files: &BTreeMap<String, FileData>, args: &[String], keep: &Option<String>, on_data: &(dyn Fn(String) + Sync)) -> std::io::Result<RunResult> {
        let r = self.run_live_inner(id, key, files, args, keep, on_data);
        self.live.lock().unwrap().remove(&id);
        self.early.lock().unwrap().remove(&id);
        self.jobs.finish(id);
        r
    }

    fn run_live_inner(&self, id: u64, key: &str, files: &BTreeMap<String, FileData>, args: &[String], keep: &Option<String>, on_data: &(dyn Fn(String) + Sync)) -> std::io::Result<RunResult> {
        let model = self.model_for(key)?;
        let tmp = TempDir::new("rvsim-live-")?;
        let dir = tmp.path().to_path_buf();
        write_files(&dir, files)?;
        let mut cmd = Command::new(&model);
        cmd.args(args).current_dir(&dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let Some(child) = self.jobs.spawn(id, &mut cmd)? else { return Ok(RunResult::cancelled()) };
        let (stdin, out, err) = { let mut g = child.lock().unwrap(); (g.stdin.take(), g.stdout.take(), g.stderr.take()) };
        {
            let mut live = self.live.lock().unwrap();
            let mut l = Live { stdin, dir: dir.clone() };
            for line in self.early.lock().unwrap().remove(&id).unwrap_or_default() { send_line(&mut l, &line); }
            live.insert(id, l);
        }
        let ended = thread::scope(|s| {
            for r in [out.map(|o| Box::new(o) as Box<dyn Read + Send>), err.map(|e| Box::new(e) as Box<dyn Read + Send>)].into_iter().flatten() {
                s.spawn(move || {
                    let mut r = r;
                    let mut buf = [0u8; 16384];
                    let mut pending: Vec<u8> = Vec::new();
                    while let Ok(n) = r.read(&mut buf) {
                        if n == 0 { break; }
                        pending.extend_from_slice(&buf[..n]);
                        // Whole UTF-8 characters only; the rest waits for the next read.
                        let cut = match std::str::from_utf8(&pending) { Ok(_) => pending.len(), Err(e) => e.valid_up_to() };
                        if cut > 0 {
                            let text: String = String::from_utf8_lossy(&pending[..cut]).replace('\r', "");
                            pending.drain(..cut);
                            on_data(text);
                        }
                    }
                    if !pending.is_empty() { on_data(String::from_utf8_lossy(&pending).replace('\r', "")); }
                });
            }
            self.jobs.wait(id, &child)
        });
        let status = match ended? { Ended::Killed => return Ok(RunResult::cancelled()), Ended::Exited(s) => s };
        Ok(RunResult { files: kept_files(&dir, keep)?, code: code_of(&status), ..Default::default() })
    }

    /// One command line to a live run; held until its process has started.
    pub fn live_send(&self, id: u64, line: &str) {
        let text = line.replace(['\r', '\n'], " ");
        let mut live = self.live.lock().unwrap();
        match live.get_mut(&id) {
            Some(l) => send_line(l, &text),
            None => self.early.lock().unwrap().entry(id).or_default().push(text),
        }
    }

    /// A file a live run has written so far; None when there is none.
    pub fn live_read(&self, id: u64, name: &str, max: u64) -> Option<LiveFile> {
        if check_name(name).is_err() { return None; }
        let p = self.live.lock().unwrap().get(&id)?.dir.join(name);
        let size = fs::metadata(&p).ok()?.len();
        if max > 0 && size > max { return Some(LiveFile { size, data: None }); }
        Some(LiveFile { size, data: fs::read(&p).ok() })
    }

    pub fn kill(&self, id: u64) { self.jobs.kill(id); }
    pub fn kill_all(&self) { self.jobs.kill_all(); }
}

fn send_line(l: &mut Live, text: &str) {
    if let Some(stdin) = l.stdin.as_mut() {
        if stdin.write_all(format!("{text}\n").as_bytes()).and_then(|_| stdin.flush()).is_err() { l.stdin = None; }
    }
}

/// The variables of the makefiles Verilator writes, which say which runtime
/// files the model needs and the -D flags it is compiled with.
fn read_mk(obj_dir: &Path) -> BTreeMap<String, String> {
    let mut text = String::new();
    for n in [format!("V{TOP}.mk"), format!("V{TOP}_classes.mk")] {
        if let Ok(t) = fs::read_to_string(obj_dir.join(n)) { text.push_str(&t.replace("\r\n", "\n")); text.push('\n'); }
    }
    let mut vars: BTreeMap<String, String> = BTreeMap::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        let mut full = line.to_string();
        while full.ends_with('\\') {
            full.pop();
            match lines.next() { Some(n) => { full.push(' '); full.push_str(n); } None => break }
        }
        let name_end = full.find(|c: char| !(c.is_ascii_uppercase() || c == '_')).unwrap_or(full.len());
        if name_end == 0 { continue; }
        let rest = full[name_end..].trim_start();
        let rest = rest.strip_prefix("+=").or_else(|| rest.strip_prefix(":=")).or_else(|| rest.strip_prefix('='));
        if let Some(v) = rest {
            let e = vars.entry(full[..name_end].to_string()).or_default();
            *e = format!("{e} {}", v.trim()).trim().to_string();
        }
    }
    vars
}

/// The first 24 hex digits of the SHA-256 of parts, each ended with a NUL.
fn hash(parts: &[&[u8]]) -> String {
    let mut h = Sha256::new();
    for p in parts { h.update(p); h.update([0u8]); }
    let d = h.finalize();
    d.iter().take(12).map(|b| format!("{b:02x}")).collect()
}

/// Runs cmd to completion; (exit code, stdout and stderr).
fn sh(cmd: &str, args: &[String], cwd: Option<&Path>, env: &[(String, String)]) -> (i32, String) {
    let mut c = Command::new(cmd);
    c.args(args).stdin(Stdio::null());
    if let Some(d) = cwd { c.current_dir(d); }
    for (k, v) in env { c.env(k, v); }
    crate::jobs::no_window(&mut c);
    match c.output() {
        Ok(o) => (o.status.code().unwrap_or(1), format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))),
        Err(e) => (1, e.to_string()),
    }
}

fn system_tar() -> String {
    if cfg!(windows) {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let t = Path::new(&root).join("System32").join("tar.exe");
        if t.exists() { return t.to_string_lossy().into_owned(); }
    }
    "tar".into()
}

#[cfg(unix)]
fn make_executable(p: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(p, fs::Permissions::from_mode(0o755))
}
#[cfg(not(unix))]
fn make_executable(_: &Path) -> std::io::Result<()> { Ok(()) }

/// Downloads url to dest, reporting progress and checking the SHA-256;
/// stops when cancelled() says so.
fn download(url: &str, dest: &Path, sha: &str, progress: Progress, cancelled: &dyn Fn() -> bool) -> Result<(), String> {
    let mut resp = ureq::get(url).header("User-Agent", "rvedusim").call().map_err(|e| e.to_string())?;
    let total: u64 = resp.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut reader = resp.body_mut().as_reader();
    let mut file = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let (mut got, mut last) = (0u64, 0u64);
    let mut buf = vec![0u8; 1 << 16];
    loop {
        if cancelled() { drop(file); let _ = fs::remove_file(dest); return Err("cancelled".into()); }
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        h.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        got += n as u64;
        if got - last > (1 << 20) || got == total { last = got; progress(json!({ "phase": "compiler-download", "received": got, "total": total })); }
    }
    drop(file);
    let digest: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if digest != sha { let _ = fs::remove_file(dest); return Err("The download did not match its checksum.".into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn makefile_variables() {
        let d = TempDir::new("rvsim-mk-").unwrap();
        fs::write(d.path().join(format!("V{TOP}.mk")), "VM_TRACE = 1\r\nVM_GLOBAL_FAST += verilated \\\n\tverilated_vcd_c\nVM_PREFIX_INCLUDE := <x.h>\n").unwrap();
        fs::write(d.path().join(format!("V{TOP}_classes.mk")), "VM_GLOBAL_FAST += verilated_timing\n").unwrap();
        let v = read_mk(d.path());
        assert_eq!(v["VM_TRACE"], "1");
        assert_eq!(v["VM_GLOBAL_FAST"].split_whitespace().collect::<Vec<_>>(), ["verilated", "verilated_vcd_c", "verilated_timing"]);
        assert_eq!(v["VM_PREFIX_INCLUDE"], "<x.h>");
    }
    #[test]
    fn hash_is_24_hex_digits() { let h = hash(&[b"a", b"b"]); assert_eq!(h.len(), 24); assert!(h.chars().all(|c| c.is_ascii_hexdigit())); }
}
