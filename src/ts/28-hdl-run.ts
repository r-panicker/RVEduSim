// @ts-nocheck
// HDL mode's run plumbing: breakpoint search, discarding a recording,
// the inputs a run starts from and starting a fresh trace.

// Breakpoints are source lines, exactly as in the functional engine, so
// the recording is searched by mapping each recorded PC back to its line.
// Position k means "about to execute steps[k]", which is where execution
// should come to rest when steps[k] is on a breakpoint line.
function hdlBreakAt(from) {
  if (!hdlTrace || !run.breakpoints || !run.breakpoints.size) return -1;
  const steps = hdlTrace.steps;
  for (let k = Math.max(0, from); k < steps.length; k++) {
    const line = sourceLineForPc(steps[k].pc);
    if (line >= 1 && run.breakpoints.has(line)) return k;
  }
  return -1;
}

function hdlDiscardTrace() {
  // A run still in flight was for what is being discarded.
  if (hdlRunning) hdlStopWorker();
  hdlEpoch++;
  hdlCk = null;
  hdlTrace = null;
  hdlLastRtlOut = null;
  hdlIdx = 0;
  hdlStim = [];
  hdlRx = [];
  // The VCD belongs to the run being discarded, so it goes with it -
  // otherwise the download button and the waveform both keep offering
  // the previous run's data as if it were current.
  hdlLastVcd = null;
  refreshDownloadMenu();
  updateWaveView();
}

function hdlCurrentInputs() {
  return {
    dip: board.dip & 0xFFFF,
    pb: board.buttons & 0x7,
    accel: hdlAccelWord(),
    adrdy: !!accel.dready
  };
}

function hdlCaptureBaseInputs() {
  hdlBase = hdlCurrentInputs();
}

async function hdlWithBusy(fn) {
  if (hdlRunning) return null;
  hdlStopPlay();
  hdlRunning = true;
  updateHdlReadiness();
  updateToolbarButtonStates();
  const inputs = hdlCurrentInputs();
  try {
    return await fn();
  } catch (e) {
    if (e && e.cancelled) { hdlStatus('stopped', 'ok'); return null; }
    hdlLog(String(e && e.message ? e.message : e), 'err');
    hdlStatus('error', 'err');
    setStatus('HDL simulation failed - see the console below the editor', 'error');
    return null;
  } finally {
    hdlRunning = false;
    updateHdlReadiness();
    updateToolbarButtonStates();
    setTimeout(() => hdlCatchUpInputs(inputs), 0);
  }
}

// The page stays live while the engine runs, so an input can move in the
// middle of a run that was given the old one. Once the run is done the
// change goes on the timeline where the recording now stands, and the
// run is replayed with it.
let hdlStimmedInRun = new Set();   // inputs already put on the timeline mid-run
function hdlCatchUpInputs(before) {
  if (simEngineMode !== 'hdl' || hdlRunning) return;
  let again = hdlPendingResim;
  hdlPendingResim = false;
  const stimmed = hdlStimmedInRun;
  hdlStimmedInRun = new Set();
  if (hdlTrace) {
    const now = hdlCurrentInputs(), cyc = hdlCurrentCycle();
    const moved = [[HDL_STIM_DIP, 'dip'], [HDL_STIM_PB, 'pb'], [HDL_STIM_ACCEL, 'accel'], [HDL_STIM_ADRDY, 'adrdy']]
      .filter(([code, f]) => now[f] !== before[f] && !stimmed.has(code));
    for (const [code, f] of moved) {
      const value = f === 'adrdy' ? (now[f] ? 1 : 0) : now[f] >>> 0;
      hdlStim = hdlStim.filter(e => !(e.cycle === cyc && e.code === code));
      hdlStim.push({ cycle: cyc, code: code, value: value });
    }
    again = again || moved.length > 0;
  }
  if (again && hdlTrace) hdlQueueResim('re-simulated with the inputs changed during the run');
}

// A fresh trace: the current switch positions become the starting
// environment and the timeline of later changes starts empty.
async function hdlStartTrace(budget, opts) {
  await hdlReadFolder();
  hdlStim = [];
  hdlRx = [];
  hdlIdx = 0;
  hdlCaptureBaseInputs();
  hdlSyncRx();
  return hdlBuildTrace(budget, Object.assign({ fresh: true }, opts));
}
