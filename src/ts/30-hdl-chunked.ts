// @ts-nocheck
// Runs with Icarus, in chunks, and the Run, Resume, Step and Back actions
// that move through the recording in HDL mode.

// vvp takes no input while it runs, so Run records in chunks of about
// HDL_CHUNK_MS of simulation, each from the checkpoint at the end of the
// last, and the page follows each as it arrives: flat out to its end, at
// Real time paced to the clock, with the simulation held at most two
// chunks ahead. An input moved meanwhile goes on the timeline at the cycle
// shown and the recording is replayed from there before the next chunk,
// as when paused; Pause and breakpoints take effect between chunks. The
// post-synthesis check compares one whole run from reset, so with it on a
// Run is recorded in one go.
const HDL_CHUNK_MS = 300;
let hdlChunked = null;            // { stop } during a chunked run
let hdlPaced = null;              // { cyc, applied }: a run without the trace, shown at the paced clock

function hdlChunkedStop() {
  if (!hdlChunked) return false;
  hdlChunked.stop = true;
  hdlStopPlay();
  hdlStatus('pausing...', 'busy');
  return true;
}

async function hdlRunChunked() {
  return hdlWithBusy(async () => {
    const resume = !!hdlTrace && (hdlTraceEnabled || !hdlTrace.steps.length);
    const report = (stop, t) => {
      if (stop === 'breakpoint') {
        hdlStatus('stopped at a breakpoint - line ' + currentExecLine, 'ok');
        setStatus('HDL (' + hdlModeLabel() + ') stopped at breakpoint (line ' +
          currentExecLine + ', instruction ' + hdlIdx + ')', 'warn');
      } else if (stop === 'paused') {
        hdlStatus('paused at cycle ' + hdlCurrentCycle().toLocaleString(), 'ok');
        setStatus('HDL paused - ' + hdlRunSummary(t, t.budget) + ' recorded', 'info');
      } else {
        hdlStatus('done - ' + t.budget.toLocaleString() + ' cycles, LED=0x' + ledState.toString(16).padStart(2, '0'), 'ok');
        setStatus('HDL ' + hdlModeLabel() + ' run finished - ' + hdlRunSummary(t, t.budget), 'success');
      }
    };
    if (resume) {
      // A breakpoint still ahead in what is already recorded is reached
      // without simulating anything.
      const hit = hdlBreakAt(hdlIdx + 1);
      if (hit >= 0) { hdlPlayTo(hit, () => report('breakpoint', hdlTrace)); return hdlTrace; }
    } else {
      hdlClearConsole();
    }
    const end = Math.min(HDL_MAX_CYCLES, (resume ? hdlTrace.budget : 0) + hdlCycleBudget);
    if (resume && hdlTrace.budget >= end) {
      hdlLog('Already recording the maximum of 2,000,000 cycles.', 'warn');
      hdlPlayTo(hdlTrace.steps.length, () => report('end', hdlTrace));
      return hdlTrace;
    }
    const run = hdlChunked = { stop: false };
    updateToolbarButtonStates();
    const noise = /\$readmemh\(AA_(IROM|DMEM)\.mem\): Not enough words/;
    const said = t => {
      const text = String(t.newOutput || '').split('\n').filter(l => l.trim() && !noise.test(l)).join('\n');
      if (text) hdlLog(text, 'out');
    };
    let size = 1000, first = !resume, stop = 'end', preApplied = resume ? hdlTrace.pre.length : 0;
    const wall0 = performance.now(), cyc0 = resume ? hdlCurrentCycle() : 0;
    // Without the trace, Real time holds what is shown to the paced clock:
    // each event, and the PC, is applied as the clock reaches it, and a
    // chunk is about HDL_CHUNK_MS of the clock, so the recording stays
    // close ahead.
    const paced = runPace === 'real' && !hdlTraceEnabled;
    const cap = n => paced ? Math.min(n, Math.max(1, Math.round(cpuHz() * HDL_CHUNK_MS / 1000))) : n;
    size = cap(size);
    const showPaced = () => {
      const t = hdlTrace;
      if (!hdlPaced || !t || t.steps.length) return;
      hdlPaced.cyc = Math.min(t.budget, cyc0 + (performance.now() - wall0) / 1000 * cpuHz());
      const from = preApplied, n = hdlPreShown();
      for (let i = from; i < n; i++) hdlApplyPer(t.pre[i][0], t.pre[i][1]);
      preApplied = n;
      totalCycles = hdlCurrentCycle();
      if (n > from) {
        renderUartTerminal();
        updatePeripherals();
        if (typeof updateOledCanvas === 'function') updateOledCanvas();
        updateWaveView();
      }
      updateStats();
    };
    if (paced) hdlPaced = { cyc: cyc0, applied: preApplied };
    const pacer = paced ? setInterval(showPaced, 50) : null;
    // What the page shows follows the recording: the instructions, or
    // without the trace the peripheral events as they come.
    const follow = (t, replayed) => {
      if (t.steps.length) {
        if (runPace === 'real') hdlPlayTo(t.steps.length);
        else hdlSeek(t.steps.length, true, true);
        return;
      }
      // Unless +PCLOG reports it as it changes, the PC is known only
      // where each chunk ends (@@N).
      if (t.next !== null && t.next !== undefined) t.pre.push(['C', [String(t.budget - 1), t.next.toString(16)]]);
      if (replayed) {
        hdlSeek(0, false, !!hdlPaced);
        preApplied = hdlPaced ? hdlPaced.applied : t.pre.length;
      }
      if (hdlPaced) { showPaced(); return; }
      if (replayed) return;
      for (let i = preApplied; i < t.pre.length; i++) hdlApplyPer(t.pre[i][0], t.pre[i][1]);
      preApplied = t.pre.length;
      totalCycles = t.budget;
      renderUartTerminal();
      updatePeripherals();
      if (typeof updateOledCanvas === 'function') updateOledCanvas();
      updateWaveView();
      updateStats();
    };
    let hit = -1;
    try {
      for (;;) {
        if (run.stop) { stop = 'paused'; break; }
        if (hdlPendingResim && hdlTrace && !first) {
          hdlPendingResim = false;
          // A change at the end of the recording is simply taken by the next chunk.
          if (hdlTimelineDiff(hdlTrace.timeline, { stim: hdlStim, rx: hdlRx }) < hdlTrace.budget) {
            const keep = hdlIdx;
            const t = await hdlBuildTrace(hdlTrace.budget, { quiet: true, chunk: true });
            if (!t) return null;
            hdlIdx = Math.min(keep, t.steps.length);
            follow(t, true);
          }
          continue;
        }
        const at = first ? 0 : hdlTrace.budget;
        if (at >= end) break;
        if (runPace === 'real' && !first) {
          const shown = hdlTrace.steps.length ? hdlCurrentCycle()
            : cyc0 + (performance.now() - wall0) / 1000 * cpuHz();
          if (at - shown > 2 * size) { await new Promise(r => setTimeout(r, 50)); continue; }
        }
        const target = Math.min(end, at + size);
        const from = first ? 0 : hdlTrace.steps.length;
        const t0 = performance.now();
        const t = first ? await hdlStartTrace(target, { chunk: true })
                        : await hdlBuildTrace(target, { quiet: true, chunk: true });
        if (!t) return null;
        size = cap(Math.max(200, Math.min(200000, Math.round((target - at) * HDL_CHUNK_MS / Math.max(1, performance.now() - t0)))));
        if (first) {
          first = false;
          if (runPace === 'real') { hdlSeek(0); if (hdlPaced) preApplied = hdlPaced.applied; }
        }
        else said(t);
        hit = hdlBreakAt(Math.max(from, hdlIdx + 1));
        if (hit >= 0) { stop = 'breakpoint'; break; }
        follow(t, false);
        hdlStatus('running - cycle ' + (hdlPaced ? hdlCurrentCycle() : t.budget).toLocaleString() + ' of ' + end.toLocaleString() +
          (runPace === 'real' ? ', paced to ' + fmtHz(cpuHz()) : ''), 'busy');
      }
      // The last chunk is recorded before the clock shown reaches it.
      if (stop === 'end' && hdlPaced) {
        while (!run.stop && hdlTrace && hdlPaced.cyc < hdlTrace.budget) await new Promise(r => setTimeout(r, 50));
        if (run.stop) stop = 'paused';
      }
    } finally {
      if (pacer) clearInterval(pacer);
      if (paced) hdlPaced = null;
      if (hdlChunked === run) hdlChunked = null;
    }
    const t = hdlTrace;
    if (!t) return null;
    if (!resume) {
      hdlLog('--- ' + hdlRunSummary(t, t.budget) + ', ' + uartTxBytes.length + ' UART bytes out ---', 'sys');
      if (hdlLooksPipelined(t))
        hdlLog('This core writes registers after its PC has moved on, as a pipeline does. Step, Back, ' +
          'breakpoints and the instruction count follow the fetch PC, so they run ahead of the results; ' +
          'registers, memory, peripherals and the cross-check are unaffected.', 'warn');
    }
    if (stop === 'paused') { hdlSeek(hdlIdx); report('paused', t); }
    else hdlPlayTo(stop === 'breakpoint' ? hit : t.steps.length, () => report(stop, t));
    if (hdlCompareEnabled) await hdlCompareWithJs();
    waveRevealForRun();
    return t;
  });
}

// The Run button. With a recording already in hand this resumes from the
// current position rather than throwing the run away - Reset is how you
// ask for a fresh one, exactly as in the functional engine.
async function runHdlSimulation() {
  if (hdlLiveCapable()) return hdlRunLive();
  if (!hdlSynthEnabled) return hdlRunChunked();
  if (hdlTrace && hdlTraceEnabled) {
    return hdlWithBusy(async () => {
      await hdlResumeRun(r => {
        if (r.stop === 'breakpoint') {
          hdlStatus('stopped at a breakpoint - line ' + currentExecLine, 'ok');
          setStatus('HDL (' + hdlModeLabel() + ') stopped at breakpoint (line ' +
            currentExecLine + ', instruction ' + hdlIdx + ')', 'warn');
        } else {
          hdlStatus('at the end of ' + hdlTrace.budget + ' recorded cycles', 'ok');
          setStatus('HDL (' + hdlModeLabel() + ') ran ' + r.ran +
            ' more instructions - end of the ' + hdlTrace.budget +
            '-cycle recording', 'success');
        }
      });
      return hdlTrace;
    });
  }
  return hdlWithBusy(async () => {
    hdlClearConsole();
    const t = await hdlStartTrace(hdlCycleBudget);
    if (!t) return null;
    // Honour breakpoints on the very first run too, so a breakpoint set
    // before pressing Run behaves the way it does in the functional model.
    const hit = hdlBreakAt(0);
    if (runPace === 'real') hdlSeek(0);
    hdlPlayTo(hit >= 0 ? hit : t.steps.length, () => {
      hdlLog('--- ' + t.steps.length + ' instructions, ' + uartTxBytes.length + ' UART bytes out ---', 'sys');
      if (hdlLooksPipelined(t))
        hdlLog('This core writes registers after its PC has moved on, as a pipeline does. Step, Back, ' +
          'breakpoints and the instruction count follow the fetch PC, so they run ahead of the results; ' +
          'registers, memory, peripherals and the cross-check are unaffected.', 'warn');
      if (hit >= 0) {
        hdlStatus('stopped at a breakpoint - line ' + currentExecLine, 'ok');
        setStatus('HDL (' + hdlModeLabel() + ') stopped at breakpoint (line ' +
          currentExecLine + ', instruction ' + hit + ')', 'warn');
      } else {
        hdlStatus('done - ' + t.budget + ' cycles, LED=0x' +
          ledState.toString(16).padStart(2, '0'), 'ok');
        setStatus('HDL ' + hdlModeLabel() + ' run finished - ' + hdlRunSummary(t, t.budget), 'success');
      }
    });
    if (hdlCompareEnabled) await hdlCompareWithJs();
    waveRevealForRun();
    return t;
  });
}

// Running or stepping off the end of the recording simply records more of
// the run. Resume adds one Cycles-worth at a time, which is what makes
// "run for another N cycles" mean something; stepping off the end grows
// geometrically instead, so a long program does not re-simulate on every
// step. The Cycles field itself is never rewritten - it stays the
// increment the user chose.
async function hdlGrowTrace(target) {
  const cap = hdlSimulator === 'verilator' ? Infinity : HDL_MAX_CYCLES;
  const grown = Math.min(cap, Math.max(target, hdlTrace.budget + 1));
  if (grown <= hdlTrace.budget) {
    hdlLog('Already recording the maximum of 2,000,000 cycles.', 'warn');
    return false;
  }
  const before = hdlTrace.steps.length;
  hdlStatus('extending the trace to ' + grown + ' cycles...', 'busy');
  const t = await hdlBuildTrace(grown, { quiet: true });
  if (!t) return false;
  if (t.steps.length <= before) {
    hdlLog('The PC is not advancing past this point - the program has ' +
      'halted or is spinning on the same instruction.', 'warn');
    return false;
  }
  hdlLog('Recording extended to ' + grown + ' cycles (' + t.steps.length +
    ' instructions).', 'sys');
  return true;
}

// Real time, a run is recorded and then played back at the clock: the
// position moves to the last instruction that has begun by now.
let hdlPlay = null;              // { to, trace, wall, cyc0, done, timer }
function hdlStepCycle(k) {
  const steps = hdlTrace.steps;
  if (k < steps.length) return steps[k].cyc;
  return hdlTrace.final ? hdlTrace.final.cyc : (steps.length ? steps[steps.length - 1].cyc : 0);
}
function hdlStopPlay() {
  if (!hdlPlay) return false;
  clearTimeout(hdlPlay.timer);
  hdlPlay = null;
  updateToolbarButtonStates();
  updateStats();
  return true;
}
function hdlPlayTo(to, done) {
  hdlStopPlay();
  if (runPace !== 'real' || to <= hdlIdx) { hdlSeek(to); if (done) done(); return; }
  const play = hdlPlay = { to, trace: hdlTrace, wall: performance.now(), cyc0: hdlCurrentCycle(), done, timer: null };
  rtRatio = 1;
  const frame = () => {
    if (hdlPlay !== play) return;
    if (hdlTrace !== play.trace) { hdlStopPlay(); return; }
    const hz = cpuHz(), elapsed = performance.now() - play.wall;
    const want = play.cyc0 + elapsed / 1000 * hz;
    let k = hdlIdx;
    while (k < to && hdlStepCycle(k + 1) <= want) k++;
    if (k !== hdlIdx) hdlSeek(k, true, hz > RT_FOLLOW_HZ);
    if (k >= to) {
      hdlPlay = null;
      hdlSeek(k);
      if (play.done) play.done();
      return;
    }
    const next = (hdlStepCycle(k + 1) - play.cyc0) / hz * 1000 - elapsed;
    play.timer = setTimeout(frame, Math.max(16, Math.min(100, next)));
  };
  updateToolbarButtonStates();
  frame();
}

// Continue from where we are to the next breakpoint, or to the end of
// what has been recorded, recording another Cycles-worth first when there
// is nothing left ahead to stop at.
async function hdlResumeRun(done) {
  const steps = () => hdlTrace.steps;
  let hit = hdlBreakAt(hdlIdx + 1);
  if (hit < 0 && ((breakpoints && breakpoints.size) || hdlIdx >= steps().length)) {
    if (await hdlGrowTrace(hdlTrace.budget + hdlCycleBudget)) hit = hdlBreakAt(hdlIdx + 1);
  }
  const to = hit >= 0 ? hit : steps().length;
  const r = { stop: hit >= 0 ? 'breakpoint' : 'end', ran: to - hdlIdx };
  hdlPlayTo(to, done ? () => done(r) : null);
  return r;
}

// Statement Stepping is engine-agnostic: one Step should cover every
// machine instruction the current source line expands to. In HDL mode
// that is a longer seek through the recording rather than more execution.
function hdlStatementTarget(from) {
  const steps = hdlTrace.steps;
  if (!statementStepping || from >= steps.length) return from + 1;
  const startLine = sourceLineForPc(steps[from].pc);
  if (!(startLine > 0)) return from + 1;
  let k = from + 1;
  while (k < steps.length && k - from < 10000) {
    const line = sourceLineForPc(steps[k].pc);
    if (line !== startLine || (breakpoints && breakpoints.has(line))) break;
    k++;
  }
  return k;
}

// The mirror image, so Back undoes exactly what Step did.
function hdlStatementBackTarget(from) {
  const steps = hdlTrace.steps;
  if (from <= 0) return 0;
  let k = from - 1;
  if (!statementStepping) return k;
  const line = sourceLineForPc(steps[k].pc);
  if (!(line > 0)) return k;
  while (k > 0 && sourceLineForPc(steps[k - 1].pc) === line) k--;
  return k;
}

async function hdlStepOnce() {
  // Without the architectural trace there is no recording to move
  // through, so say that rather than silently doing nothing.
  if (!hdlTraceEnabled) {
    hdlLog('Stepping needs the architectural trace. Tick "Record the architectural ' +
      'trace" under Settings > Simulation.', 'warn');
    setStatus('HDL stepping needs the Trace option', 'warn');
    return null;
  }
  return hdlWithBusy(async () => {
    if (!hdlTrace) {
      // A first Step needs a recording to step through, not a whole
      // run's worth, which would take seconds to a minute to record.
      const t = await hdlStartTrace(Math.min(hdlCycleBudget, hdlSimulator === 'verilator' ? 100000 : 2000));
      if (!t) return null;
      hdlSeek(0);
      setStatus('HDL stepped to line ' + (currentExecLine > 0 ? currentExecLine : '?'), 'info');
      return t;
    }
    if (hdlIdx >= hdlTrace.steps.length) {
      if (!(await hdlGrowTrace(Math.max(hdlTrace.budget * 4, 1000)))) {
        setStatus('End of the recorded HDL trace', 'info');
        return null;
      }
    }
    const from = hdlIdx;
    hdlSeek(hdlStatementTarget(from));
    const covered = hdlIdx - from;
    const where = 'line ' + (currentExecLine > 0 ? currentExecLine : '?');
    setStatus(covered > 1
      ? 'HDL statement step \u2014 ' + covered + ' instructions, now at ' + where
      : 'HDL stepped to ' + where, 'info');
    return hdlTrace;
  });
}

function hdlStepBack() {
  if (!hdlTrace || hdlIdx <= 0) {
    setStatus('Already at the start of the HDL trace', 'info');
    return;
  }
  hdlSeek(hdlStatementBackTarget(hdlIdx));
  setStatus('HDL stepped back to line ' + (currentExecLine > 0 ? currentExecLine : '?'), 'info');
}
