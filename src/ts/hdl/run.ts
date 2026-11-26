// @ts-nocheck
// HDL mode's run plumbing: breakpoint search, discarding a recording,
// the inputs a run starts from and starting a fresh trace.

import { hdlStopPlay } from './chunked';
import { HDL_STIM_ACCEL, HDL_STIM_ADRDY, HDL_STIM_DIP, HDL_STIM_PB, hdlAccelWord, hdlSyncRx } from './compile';
import { hdlLog, hdlStatus, hdlStopWorker } from './engine';
import { hdlQueueResim } from './inputs';
import { hdlCurrentCycle } from './seek';
import { hdlReadFolder, updateHdlReadiness } from './sources';
import { hdlActivity, hdlBuild, hdlCheckpoints, hdlRec } from './state';
import { hdlBuildTrace } from './trace';
import { accel, board, run, ui } from '../machine/state';
import { setStatus } from '../ui/editor';
import { refreshDownloadMenu, sourceLineForPc } from '../ui/execution';
import { updateToolbarButtonStates } from '../ui/run-control';
import { updateWaveView } from '../ui/waveform';

// Breakpoints are source lines, exactly as in the functional engine, so
// the recording is searched by mapping each recorded PC back to its line.
// Position k means "about to execute steps[k]", which is where execution
// should come to rest when steps[k] is on a breakpoint line.
export function hdlBreakAt(from) {
  if (!hdlRec.trace || !run.breakpoints || !run.breakpoints.size) return -1;
  const steps = hdlRec.trace.steps;
  for (let k = Math.max(0, from); k < steps.length; k++) {
    const line = sourceLineForPc(steps[k].pc);
    if (line >= 1 && run.breakpoints.has(line)) return k;
  }
  return -1;
}

export function hdlDiscardTrace() {
  // A run still in flight was for what is being discarded.
  if (hdlActivity.running) hdlStopWorker();
  hdlRec.epoch++;
  hdlCheckpoints.set = null;
  hdlRec.trace = null;
  hdlBuild.lastRtlOut = null;
  hdlRec.idx = 0;
  hdlRec.stim = [];
  hdlRec.rx = [];
  // The VCD belongs to the run being discarded, so it goes with it -
  // otherwise the download button and the waveform both keep offering
  // the previous run's data as if it were current.
  hdlBuild.lastVcd = null;
  refreshDownloadMenu();
  updateWaveView();
}

export function hdlCurrentInputs() {
  return {
    dip: board.dip & 0xFFFF,
    pb: board.buttons & 0x7,
    accel: hdlAccelWord(),
    adrdy: !!accel.dready
  };
}

export function hdlCaptureBaseInputs() {
  hdlRec.base = hdlCurrentInputs();
}

export async function hdlWithBusy(fn) {
  if (hdlActivity.running) return null;
  hdlStopPlay();
  hdlActivity.running = true;
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
    hdlActivity.running = false;
    updateHdlReadiness();
    updateToolbarButtonStates();
    setTimeout(() => hdlCatchUpInputs(inputs), 0);
  }
}

// The page stays live while the engine runs, so an input can move in the
// middle of a run that was given the old one. Once the run is done the
// change goes on the timeline where the recording now stands, and the
// run is replayed with it.
export function hdlCatchUpInputs(before) {
  if (ui.engine !== 'hdl' || hdlActivity.running) return;
  let again = hdlRec.pendingResim;
  hdlRec.pendingResim = false;
  const stimmed = hdlRec.stimmedInRun;
  hdlRec.stimmedInRun = new Set();
  if (hdlRec.trace) {
    const now = hdlCurrentInputs(), cyc = hdlCurrentCycle();
    const moved = [[HDL_STIM_DIP, 'dip'], [HDL_STIM_PB, 'pb'], [HDL_STIM_ACCEL, 'accel'], [HDL_STIM_ADRDY, 'adrdy']]
      .filter(([code, f]) => now[f] !== before[f] && !stimmed.has(code));
    for (const [code, f] of moved) {
      const value = f === 'adrdy' ? (now[f] ? 1 : 0) : now[f] >>> 0;
      hdlRec.stim = hdlRec.stim.filter(e => !(e.cycle === cyc && e.code === code));
      hdlRec.stim.push({ cycle: cyc, code: code, value: value });
    }
    again = again || moved.length > 0;
  }
  if (again && hdlRec.trace) hdlQueueResim('re-simulated with the inputs changed during the run');
}

// A fresh trace: the current switch positions become the starting
// environment and the timeline of later changes starts empty.
export async function hdlStartTrace(budget, opts) {
  await hdlReadFolder();
  hdlRec.stim = [];
  hdlRec.rx = [];
  hdlRec.idx = 0;
  hdlCaptureBaseInputs();
  hdlSyncRx();
  return hdlBuildTrace(budget, Object.assign({ fresh: true }, opts));
}
