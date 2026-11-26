//! Running processes by job id, so that a job can be stopped from another
//! thread: the page cancels a run by the id it started it with.

use std::collections::{HashMap, HashSet};
use std::process::{Child, Command, ExitStatus};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Default)]
pub struct Jobs {
    running: Mutex<HashMap<u64, Vec<Arc<Mutex<Child>>>>>,
    killed: Mutex<HashSet<u64>>,
}

/// How a process ended: its exit status, or stopped through kill().
pub enum Ended {
    Exited(ExitStatus),
    Killed,
}

impl Jobs {
    pub fn new() -> Self { Self::default() }

    /// Whether kill() has been called for this job since it started.
    pub fn is_killed(&self, id: u64) -> bool { self.killed.lock().unwrap().contains(&id) }

    /// Forgets that a job was killed, once the job is over.
    pub fn finish(&self, id: u64) { self.killed.lock().unwrap().remove(&id); }

    /// Stops every process of the job, and any it starts from now on.
    pub fn kill(&self, id: u64) {
        self.killed.lock().unwrap().insert(id);
        if let Some(list) = self.running.lock().unwrap().get(&id) {
            for c in list { let _ = c.lock().unwrap().kill(); }
        }
    }

    pub fn kill_all(&self) {
        let ids: Vec<u64> = self.running.lock().unwrap().keys().copied().collect();
        for id in ids { self.kill(id); }
    }

    /// Starts cmd as part of job id, or None when the job has been killed.
    pub fn spawn(&self, id: u64, cmd: &mut Command) -> std::io::Result<Option<Arc<Mutex<Child>>>> {
        no_window(cmd);
        // Holding the killed set while spawning means a kill() either sees
        // the new process or stops it from starting.
        let killed = self.killed.lock().unwrap();
        if killed.contains(&id) { return Ok(None); }
        let child = Arc::new(Mutex::new(cmd.spawn()?));
        self.running.lock().unwrap().entry(id).or_default().push(child.clone());
        drop(killed);
        Ok(Some(child))
    }

    /// Waits for a process started with spawn(). The process is polled so
    /// that kill() can reach it while this waits.
    pub fn wait(&self, id: u64, child: &Arc<Mutex<Child>>) -> std::io::Result<Ended> {
        let mut pause = 1;
        let status = loop {
            if let Some(s) = child.lock().unwrap().try_wait()? { break s; }
            thread::sleep(Duration::from_millis(pause));
            pause = (pause * 2).min(20);
        };
        let mut running = self.running.lock().unwrap();
        if let Some(list) = running.get_mut(&id) {
            list.retain(|c| !Arc::ptr_eq(c, child));
            if list.is_empty() { running.remove(&id); }
        }
        drop(running);
        if self.is_killed(id) || killed_by_signal(&status) { Ok(Ended::Killed) } else { Ok(Ended::Exited(status)) }
    }

    /// spawn() then wait(); Killed when the job was stopped before or during it.
    pub fn run(&self, id: u64, cmd: &mut Command) -> std::io::Result<Ended> {
        match self.spawn(id, cmd)? {
            Some(child) => self.wait(id, &child),
            None => Ok(Ended::Killed),
        }
    }
}

#[cfg(unix)]
fn killed_by_signal(s: &ExitStatus) -> bool {
    use std::os::unix::process::ExitStatusExt;
    matches!(s.signal(), Some(9) | Some(15))
}
#[cfg(not(unix))]
fn killed_by_signal(_: &ExitStatus) -> bool { false }

/// No console window flashing up for each tool on Windows.
#[cfg(windows)]
pub fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}
#[cfg(not(windows))]
pub fn no_window(_: &mut Command) {}

/// The exit code a result reports: the process's own, or -1 when it has none.
pub fn code_of(s: &ExitStatus) -> i32 { s.code().unwrap_or(-1) }
