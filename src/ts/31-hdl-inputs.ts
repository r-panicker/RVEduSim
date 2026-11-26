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
  const budget = Math.min(hdlRec.trace.budget, hdlCurrentCycle() + hdlConfig.cycleBudget);
  const t = await hdlBuildTrace(budget, { quiet: true });
  if (!t) return;
  hdlSeek(Math.min(keepIdx, t.steps.length));
}

// A second input moved while the first is still re-simulating must not be
// dropped, or the recording would stop matching the switches on screen.
// The change goes onto the timeline either way; the replay is coalesced.

function hdlQueueResim(what) {
  if (hdlActivity.running) { hdlRec.pendingResim = true; return; }
  const at = hdlRec.idx;
  hdlWithBusy(async () => {
    await hdlResimulate(at);
    while (hdlRec.pendingResim) {
      hdlRec.pendingResim = false;
      await hdlResimulate(hdlRec.idx);
    }
    hdlStatus(what, 'ok');
    return null;
  });
}

function hdlOnInputChanged(code, value) {
  if (ui.engine !== 'hdl') return;
  if (hdlActivity.live) {
    hdlLiveSend('in ' + code + ' ' + (value >>> 0));
    hdlRec.stimmedInRun.add(code);
    return;
  }
  if (!hdlRec.trace) return;
  const cyc = hdlCurrentCycle();
  if (hdlActivity.running) hdlRec.stimmedInRun.add(code);
  // One change per input per cycle; a later edit at the same point
  // replaces the earlier one rather than stacking up.
  hdlRec.stim = hdlRec.stim.filter(e => !(e.cycle === cyc && e.code === code));
  hdlRec.stim.push({ cycle: cyc, code: code, value: value >>> 0 });
  hdlQueueResim('re-simulated from cycle ' + cyc + ' with the new input');
}

// The bytes are already on the timeline by the time this runs; all that
// is left is to replay the run so the hardware sees them.
function hdlOnUartInput(count) {
  if (ui.engine !== 'hdl' || !hdlRec.trace || !count) return;
  hdlQueueResim('re-simulated with ' + count + ' more UART byte(s)');
}
