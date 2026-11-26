//! Icarus Verilog's stages run natively, the way the page runs them under
//! WASM. The page writes its files into the root of an Emscripten file
//! system and names them "/name"; here they go into the temporary directory
//! the tool runs in, and "/name" becomes "name".

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::jobs::Jobs;
use crate::process::{run_process, FileData, RunOpts, RunResult};
use crate::EXE;

pub struct Icarus {
    pub bin_dir: PathBuf,
    pub version: Option<String>,
    jobs: Jobs,
}

impl Icarus {
    /// The first of candidates that holds a build of Icarus, or None.
    pub fn find(candidates: &[PathBuf]) -> Option<Icarus> {
        candidates.iter().find(|d| d.join(format!("vvp{EXE}")).exists() && d.join(format!("ivl{EXE}")).exists()).map(|d| {
            let version = std::fs::read_to_string(d.join("VERSION")).ok().map(|v| v.trim().to_string());
            Icarus { bin_dir: d.clone(), version, jobs: Jobs::new() }
        })
    }

    /// Runs one stage (ivlpp, ivl or vvp) as job id.
    pub fn run(&self, id: u64, tool: &str, files: &BTreeMap<String, FileData>, args: &[String], opts: &RunOpts) -> std::io::Result<RunResult> {
        if !["ivlpp", "ivl", "vvp"].contains(&tool) { return Err(std::io::Error::other(format!("unknown tool {tool}"))); }
        let mut local = files.clone();
        if tool == "ivl" {
            if let Some(conf) = files.get("ivl.conf") {
                local.insert("ivl.conf".into(), FileData::Text(local_conf(&String::from_utf8_lossy(conf.bytes()), &self.bin_dir)));
            }
        }
        let mut argv: Vec<String> = Vec::new();
        if tool == "vvp" { argv.push("-M".into()); argv.push(self.bin_dir.to_string_lossy().into_owned()); }
        argv.extend(args.iter().map(|a| local_arg(a)));
        run_process(&self.jobs, id, &self.bin_dir.join(format!("{tool}{EXE}")), &argv, &local, opts)
    }

    pub fn kill(&self, id: u64) { self.jobs.kill(id); }
    pub fn kill_all(&self) { self.jobs.kill_all(); }
}

/// "/name" and "-X/name" as the tool sees them in its own directory.
fn local_arg(a: &str) -> String {
    let (flag, rest) = if a.len() > 2 && a.starts_with('-') && a.as_bytes()[1].is_ascii_alphabetic() && a.as_bytes()[2] == b'/' {
        (&a[..2], &a[2..])
    } else { ("", a) };
    match rest.strip_prefix('/') {
        Some(name) if !name.is_empty() && !name.contains('/') => format!("{flag}{name}"),
        _ => a.to_string(),
    }
}

/// ivl.conf names the directory its code generator (vvp.tgt) and the VPI
/// modules live in, and where to write the .vvp. The module paths end up
/// quoted in the .vvp, so they use forward slashes, which Windows accepts,
/// rather than backslashes vvp would read as escapes.
fn local_conf(text: &str, bin_dir: &Path) -> String {
    text.split('\n').map(|l| {
        if l.starts_with("basedir:") { return format!("basedir:{}", bin_dir.to_string_lossy()); }
        if let Some(m) = l.strip_prefix("module:") {
            if !m.contains(['/', '\\']) { return format!("module:{}", bin_dir.join(m).to_string_lossy().replace('\\', "/")); }
        }
        if let Some(o) = l.strip_prefix("out:/") {
            if !o.contains('/') { return format!("out:{o}"); }
        }
        l.to_string()
    }).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn args_lose_their_root() {
        assert_eq!(local_arg("/src.v"), "src.v");
        assert_eq!(local_arg("-C/ivl.conf"), "-Civl.conf");
        assert_eq!(local_arg("--"), "--");
        assert_eq!(local_arg("+CYCLES=10"), "+CYCLES=10");
        assert_eq!(local_arg("/a/b"), "/a/b");
    }
    #[test]
    fn conf_points_at_the_build() {
        let c = local_conf("basedir:/\nmodule:system.vpi\nout:/out.vvp\nflag:X", Path::new("/opt/iv"));
        assert_eq!(c, "basedir:/opt/iv\nmodule:/opt/iv/system.vpi\nout:out.vvp\nflag:X");
    }
}
