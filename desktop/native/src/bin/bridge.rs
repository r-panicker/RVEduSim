//! The desktop engine behind a pipe, for the test suites: they run the page
//! in Node and give it a window.rvNative that forwards here, so the code the
//! app runs is the code they test.
//!
//!   rvnative-bridge [--icarus DIR] [--verilator DIR] [--cache DIR]
//!
//! One JSON request per line on stdin, { "id", "cmd", "args" }; one reply per
//! line on stdout, { "id", "result" } or { "id", "error" }, and in between
//! events, { "event": "progress" | "live", "job", "data" }. File contents sent
//! are strings, or { "b64": ... } for bytes; files a run kept come back as
//! { "path" } of a copy for the caller to read and delete, since a waveform
//! can be hundreds of megabytes. Requests run concurrently.

use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use base64::Engine;
use rvnative::verilator::BuildOpts;
use rvnative::{read_folder_kind, FileData, Icarus, RunOpts, RunResult, Verilator};
use serde_json::{json, Value};

struct Bridge {
    icarus: Option<Icarus>,
    out_dir: PathBuf,
    seq: std::sync::atomic::AtomicU64,
    verilator: Option<Verilator>,
    out: Mutex<std::io::Stdout>,
}

impl Bridge {
    fn send(&self, v: Value) {
        let mut o = self.out.lock().unwrap();
        let _ = writeln!(o, "{v}");
        let _ = o.flush();
    }
}

fn files_in(v: &Value) -> Result<BTreeMap<String, FileData>, String> {
    let mut m = BTreeMap::new();
    for (k, f) in v.as_object().ok_or("files must be an object")? {
        let d = match f {
            Value::String(s) => FileData::Text(s.clone()),
            Value::Object(o) => FileData::Bytes(base64::engine::general_purpose::STANDARD
                .decode(o.get("b64").and_then(Value::as_str).ok_or("bad file")?).map_err(|e| e.to_string())?),
            _ => return Err(format!("bad file {k}")),
        };
        m.insert(k.clone(), d);
    }
    Ok(m)
}

/// A kept file, handed over as a file of its own.
fn handed(b: &Bridge, name: &str, data: &[u8]) -> Result<Value, String> {
    let n = b.seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let p = b.out_dir.join(format!("{n}-{name}"));
    std::fs::write(&p, data).map_err(|e| e.to_string())?;
    Ok(json!({ "path": p.to_string_lossy() }))
}

fn result_out(b: &Bridge, r: RunResult) -> Result<Value, String> {
    if r.cancelled { return Ok(json!({ "cancelled": true })); }
    let mut files = serde_json::Map::new();
    for (k, v) in &r.files { files.insert(k.clone(), handed(b, k, v)?); }
    Ok(json!({ "out": r.out, "err": r.err, "files": files, "code": r.code }))
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default()
}

fn handle(b: &Arc<Bridge>, cmd: &str, a: &Value) -> Result<Value, String> {
    let job = a.get("id").and_then(Value::as_u64).unwrap_or(0);
    let opts = || -> Result<RunOpts, String> { serde_json::from_value(a.get("opts").cloned().unwrap_or(json!({}))).map_err(|e| e.to_string()) };
    let vl = || b.verilator.as_ref().ok_or_else(|| "This build has no Verilator.".to_string());
    match cmd {
        "info" => Ok(json!({
            "icarus": b.icarus.is_some(),
            "icarusVersion": b.icarus.as_ref().and_then(|i| i.version.clone()),
            "verilator": b.verilator.is_some(),
            "verilatorVersion": b.verilator.as_ref().map(|v| v.short_version()),
        })),
        "hdlRun" => {
            let ic = b.icarus.as_ref().ok_or("This build has no native Icarus Verilog.")?;
            let r = ic.run(job, a["tool"].as_str().unwrap_or(""), &files_in(&a["files"])?, &strings(&a["args"]), &opts()?).map_err(|e| e.to_string())?;
            result_out(b, r)
        }
        "hdlKill" => {
            if let Some(i) = &b.icarus { i.kill(job); }
            if let Some(v) = &b.verilator { v.kill(job); }
            Ok(Value::Null)
        }
        "vlBuild" => {
            let files: BTreeMap<String, String> = serde_json::from_value(a["files"].clone()).map_err(|e| e.to_string())?;
            let o: BuildOpts = serde_json::from_value(a.get("opts").cloned().unwrap_or(json!({}))).map_err(|e| e.to_string())?;
            let bb = b.clone();
            let progress = move |p: Value| bb.send(json!({ "event": "progress", "job": job, "data": p }));
            let r = vl()?.build(job, &files, &o, &progress).map_err(|e| e.to_string())?;
            serde_json::to_value(r).map_err(|e| e.to_string())
        }
        "vlRun" => {
            let r = vl()?.run(job, a["key"].as_str().unwrap_or(""), &files_in(&a["files"])?, &strings(&a["args"]), &opts()?).map_err(|e| e.to_string())?;
            result_out(b, r)
        }
        "vlLive" => {
            let bb = b.clone();
            let on_data = move |text: String| bb.send(json!({ "event": "live", "job": job, "data": text }));
            let keep = opts()?.keep;
            let r = vl()?.run_live(job, a["key"].as_str().unwrap_or(""), &files_in(&a["files"])?, &strings(&a["args"]), &keep, &on_data).map_err(|e| e.to_string())?;
            result_out(b, r)
        }
        "vlLiveSend" => { vl()?.live_send(job, a["line"].as_str().unwrap_or("")); Ok(Value::Null) }
        "vlLiveRead" => {
            let f = vl()?.live_read(job, a["name"].as_str().unwrap_or(""), a.get("max").and_then(Value::as_u64).unwrap_or(0));
            Ok(match f { None => Value::Null, Some(f) => match f.data { Some(d) => json!({ "size": f.size, "data": handed(b, "live", &d)? }), None => json!({ "size": f.size }) } })
        }
        "readFolder" => serde_json::to_value(read_folder_kind(&PathBuf::from(a["dir"].as_str().unwrap_or("")),
            a["kind"].as_str().unwrap_or("hdl"))).map_err(|e| e.to_string()),
        _ => Err(format!("unknown command {cmd}")),
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let (mut icarus, mut verilator, mut cache) = (None, None, std::env::temp_dir().join("rvnative-cache"));
    while let Some(a) = args.next() {
        let v = args.next().map(PathBuf::from);
        match (a.as_str(), v) {
            ("--icarus", Some(d)) => icarus = Some(d),
            ("--verilator", Some(d)) => verilator = Some(d),
            ("--cache", Some(d)) => cache = d,
            _ => { eprintln!("usage: rvnative-bridge [--icarus DIR] [--verilator DIR] [--cache DIR]"); std::process::exit(2); }
        }
    }
    let icarus = icarus.and_then(|d| Icarus::find(&[d]));
    let verilator = verilator.filter(|d| Verilator::found(d)).and_then(|d| Verilator::new(d, cache).ok());
    let out_dir = std::env::temp_dir().join(format!("rvnative-bridge-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&out_dir);
    let b = Arc::new(Bridge { icarus, verilator, out_dir: out_dir.clone(), seq: Default::default(), out: Mutex::new(std::io::stdout()) });
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let req: Value = match serde_json::from_str(&line) { Ok(v) => v, Err(e) => { b.send(json!({ "id": null, "error": e.to_string() })); continue; } };
        let quick = matches!(req["cmd"].as_str(), Some("vlLiveSend" | "hdlKill" | "vlLiveRead" | "info"));
        let run = {
            let b = b.clone();
            move || {
                let id = req.get("id").cloned().unwrap_or(Value::Null);
                match handle(&b, req["cmd"].as_str().unwrap_or(""), req.get("args").unwrap_or(&Value::Null)) {
                    Ok(r) => b.send(json!({ "id": id, "result": r })),
                    Err(e) => b.send(json!({ "id": id, "error": e })),
                }
            }
        };
        // What returns at once is answered here, in the order it was sent: a
        // live run's commands (two UART bytes, say) must reach the model in
        // that order. Runs and builds each get a thread.
        if quick { run() } else { thread::spawn(run); }
    }
    // stdin closed: the test is done with us.
    if let Some(i) = &b.icarus { i.kill_all(); }
    if let Some(v) = &b.verilator { v.kill_all(); }
    let _ = std::fs::remove_dir_all(&out_dir);
}
