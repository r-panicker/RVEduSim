//! Every Verilog source (or, for an examples folder, every program and
//! index) under a folder the user picked, as { path, src } with
//! "/"-separated paths relative to it. The page decides which of them to
//! load; it leaves out Vivado's output folders by path, and these are not
//! worth walking at all.

use std::fs;
use std::path::Path;

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct FolderFile {
    pub path: String,
    pub src: String,
}

const MAX_FILES: usize = 500;

fn skip_dir(name: &str) -> bool { name.starts_with('.') || name == "node_modules" }

fn hdl_file(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    [".v", ".sv", ".vh", ".svh"].iter().any(|e| l.ends_with(e))
}

fn example_file(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    l == "index.txt" || [".asm", ".s", ".c"].iter().any(|e| l.ends_with(e))
}

/// The Verilog sources under dir.
pub fn read_folder(dir: &Path) -> Vec<FolderFile> { read_folder_kind(dir, "hdl") }

/// "hdl": Verilog sources; "examples": programs and index.txt.
pub fn read_folder_kind(dir: &Path, kind: &str) -> Vec<FolderFile> {
    let mut out = Vec::new();
    walk(dir, "", if kind == "examples" { example_file } else { hdl_file }, &mut out);
    out
}

fn walk(dir: &Path, rel: &str, want: fn(&str) -> bool, out: &mut Vec<FolderFile>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| { let n = e.file_name().to_string_lossy().into_owned(); (n.to_lowercase(), n) });
    for e in entries {
        if out.len() >= MAX_FILES { return; }
        let name = e.file_name().to_string_lossy().into_owned();
        let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if !skip_dir(&name) { walk(&e.path(), &r, want, out); }
        } else if ft.is_file() && want(&name) {
            if let Ok(b) = fs::read(e.path()) { out.push(FolderFile { path: r, src: String::from_utf8_lossy(&b).into_owned() }); }
        }
    }
}
