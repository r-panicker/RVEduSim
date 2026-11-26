//! One tool run in a fresh temporary directory: the page's files written
//! into it, the tool started there, its output and the files it wrote read
//! back.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::jobs::{code_of, Ended, Jobs};

/// A file the page hands over: text, or bytes (a compiled .vvp).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FileData {
    Text(String),
    Bytes(Vec<u8>),
}

impl FileData {
    pub fn bytes(&self) -> &[u8] {
        match self { FileData::Text(s) => s.as_bytes(), FileData::Bytes(b) => b }
    }
}

/// merge: stderr goes to the same lines as stdout, in order; keep: a regular
/// expression naming the files to read back; env: variables to add.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct RunOpts {
    #[serde(default)]
    pub merge: bool,
    #[serde(default)]
    pub keep: Option<String>,
    #[serde(skip)]
    pub env: Vec<(String, String)>,
}

/// A run's output lines, the kept files, and its exit code; or cancelled.
#[derive(Debug, Default, Serialize)]
pub struct RunResult {
    pub out: Vec<String>,
    pub err: Vec<String>,
    #[serde(skip)]
    pub files: BTreeMap<String, Vec<u8>>,
    pub code: i32,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cancelled: bool,
}

impl RunResult {
    pub fn cancelled() -> Self { RunResult { cancelled: true, ..Default::default() } }
}

/// A directory removed when dropped.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(prefix: &str) -> std::io::Result<Self> {
        let base = std::env::temp_dir();
        for n in 0..100u32 {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
            let p = base.join(format!("{prefix}{}-{:x}-{n}", std::process::id(), stamp));
            if fs::create_dir(&p).is_ok() { return Ok(TempDir(p)); }
        }
        Err(std::io::Error::other("could not make a temporary directory"))
    }
    pub fn path(&self) -> &Path { &self.0 }
}

impl Drop for TempDir {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

/// A plain file name, never a path: the page's files all live in one directory.
pub fn check_name(name: &str) -> std::io::Result<()> {
    let ok = !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', ':']);
    if ok { Ok(()) } else { Err(std::io::Error::other(format!("bad file name {name}"))) }
}

pub fn write_files(dir: &Path, files: &BTreeMap<String, FileData>) -> std::io::Result<()> {
    for (name, data) in files {
        check_name(name)?;
        fs::write(dir.join(name), data.bytes())?;
    }
    Ok(())
}

/// The files in dir whose names match keep.
pub fn kept_files(dir: &Path, keep: &Option<String>) -> std::io::Result<BTreeMap<String, Vec<u8>>> {
    let mut got = BTreeMap::new();
    if let Some(src) = keep {
        let re = Regex::new(src).map_err(|e| std::io::Error::other(e.to_string()))?;
        for e in fs::read_dir(dir)? {
            let e = e?;
            let name = e.file_name().to_string_lossy().into_owned();
            if re.is_match(&name) && e.file_type()?.is_file() { got.insert(name, fs::read(e.path())?); }
        }
    }
    Ok(got)
}

/// Text as the page reads it: lines, without a final empty one.
pub fn lines(text: &[u8]) -> Vec<String> {
    let t = String::from_utf8_lossy(text);
    let mut v: Vec<String> = t.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect();
    if v.last().map(|l| l.is_empty()).unwrap_or(false) { v.pop(); }
    v
}

/// Runs exe with argv in a fresh temporary directory holding files, as job id.
pub fn run_process(jobs: &Jobs, id: u64, exe: &Path, argv: &[String], files: &BTreeMap<String, FileData>, opts: &RunOpts) -> std::io::Result<RunResult> {
    let tmp = TempDir::new("rvsim-")?;
    let dir = tmp.path();
    write_files(dir, files)?;
    // stdout and stderr share one file when merged, so that their lines
    // stay in the order the tool wrote them.
    let out_path = dir.join(".stdout");
    let err_path = dir.join(".stderr");
    let out_file = fs::File::create(&out_path)?;
    let err_file = if opts.merge { out_file.try_clone()? } else { fs::File::create(&err_path)? };
    let mut cmd = Command::new(exe);
    cmd.args(argv).current_dir(dir).stdin(Stdio::null()).stdout(out_file).stderr(err_file);
    for (k, v) in &opts.env { cmd.env(k, v); }
    let ended = jobs.run(id, &mut cmd);
    jobs.finish(id);
    let status = match ended? { Ended::Killed => return Ok(RunResult::cancelled()), Ended::Exited(s) => s };
    let read = |p: &Path| fs::read(p).map(|b| lines(&b)).unwrap_or_default();
    Ok(RunResult {
        out: read(&out_path),
        err: if opts.merge { vec![] } else { read(&err_path) },
        files: kept_files(dir, &opts.keep)?,
        code: code_of(&status),
        cancelled: false,
    })
}
