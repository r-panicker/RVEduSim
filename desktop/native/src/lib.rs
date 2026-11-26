//! RVEduSim's desktop engine: what the page reaches through window.rvNative
//! in the desktop app. Icarus Verilog's three stages and Verilator models run
//! as native processes in temporary directories, the way the page runs them
//! under WASM; Verilog folders the user picked are read from disk.
//!
//! Everything here blocks: the Tauri shell and the bridge the tests use call
//! it from threads of their own.

pub mod folder;
pub mod icarus;
pub mod jobs;
pub mod process;
pub mod verilator;

pub use folder::read_folder;
pub use icarus::Icarus;
pub use jobs::Jobs;
pub use process::{FileData, RunOpts, RunResult};
pub use verilator::Verilator;

/// The executable suffix of this platform.
pub const EXE: &str = if cfg!(windows) { ".exe" } else { "" };
