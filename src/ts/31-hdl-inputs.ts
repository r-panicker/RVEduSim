// @ts-nocheck
// Inputs changed while a recording is in hand: each goes on the timeline
// and the run is replayed.

// The simulation is deterministic, so a change made while paused can be
// stamped at the current cycle and the run replayed, from the last
// checkpoint before it where there is one: everything before that point
// comes out bit-identical and you keep your place. What lay beyond the
// change was recorded with the old input and is gone either way, so the
// new recording reaches one Cycles past it rather than all the way back
// to where the old one ended.
async function hdlResimulate(keepIdx) {
  const budget = Math.min(hdlTrace.budget, hdlCurrentCycle() + hdlCycleBudget);
  const t = await hdlBuildTrace(budget, { quiet: true });
  if (!t) return;
  hdlSeek(Math.min(keepIdx, t.steps.length));
}

// A second input moved while the first is still re-simulating must not be
// dropped, or the recording would stop matching the switches on screen.
// The change goes onto the timeline either way; the replay is coalesced.
let hdlPendingResim = false;

function hdlQueueResim(what) {
  if (hdlRunning) { hdlPendingResim = true; return; }
  const at = hdlIdx;
  hdlWithBusy(async () => {
    await hdlResimulate(at);
    while (hdlPendingResim) {
      hdlPendingResim = false;
      await hdlResimulate(hdlIdx);
    }
    hdlStatus(what, 'ok');
    return null;
  });
}

function hdlOnInputChanged(code, value) {
  if (simEngineMode !== 'hdl') return;
  if (hdlLive) {
    hdlLiveSend('in ' + code + ' ' + (value >>> 0));
    hdlStimmedInRun.add(code);
    return;
  }
  if (!hdlTrace) return;
  const cyc = hdlCurrentCycle();
  if (hdlRunning) hdlStimmedInRun.add(code);
  // One change per input per cycle; a later edit at the same point
  // replaces the earlier one rather than stacking up.
  hdlStim = hdlStim.filter(e => !(e.cycle === cyc && e.code === code));
  hdlStim.push({ cycle: cyc, code: code, value: value >>> 0 });
  hdlQueueResim('re-simulated from cycle ' + cyc + ' with the new input');
}

// The bytes are already on the timeline by the time this runs; all that
// is left is to replay the run so the hardware sees them.
function hdlOnUartInput(count) {
  if (simEngineMode !== 'hdl' || !hdlTrace || !count) return;
  hdlQueueResim('re-simulated with ' + count + ' more UART byte(s)');
}
