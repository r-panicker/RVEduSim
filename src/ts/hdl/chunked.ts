// Runs with Icarus, in chunks, and the Run, Resume, Step and Back actions
// that move through the recording in HDL mode.

import { hdlTimelineDiff } from './checkpoints';
import { hdlCompareWithJs, hdlLooksPipelined } from './compare';
import { HDL_MAX_CYCLES, hdlClearConsole, hdlLog, hdlStatus } from './engine';
import { hdlLiveCapable, hdlRunLive } from './live';
import { hdlBreakAt, hdlStartTrace, hdlWithBusy } from './run';
import { hdlApplyPer, hdlCurrentCycle, hdlPreShown, hdlSeek } from './seek';
import { hdlActivity, hdlConfig, hdlRec, type HdlTrace, hdlRecording, type HdlPlayback } from './state';
import { hdlModeLabel } from './synthesis';
import { hdlBuildTrace, hdlRunSummary } from './trace';
import { RT_FOLLOW_HZ, cpuHz, fmtHz } from '../machine/clock';
import { board, clock, cpu, run, uart } from '../machine/state';
import { setStatus } from '../ui/editor';
import { sourceLineForPc, updateStats } from '../ui/execution';
import { renderUartTerminal, updateOledCanvas, updatePeripherals } from '../ui/peripherals';
import { updateToolbarButtonStates } from '../ui/run-control';
import { updateWaveView, waveRevealForRun } from '../ui/waveform';

// vvp takes no input while it runs, so Run records in chunks of about
// HDL_CHUNK_MS of simulation, each from the checkpoint at the end of the
// last, and the page follows each as it arrives: flat out to its end, at
// Real time paced to the clock, with the simulation held at most two
// chunks ahead. An input moved meanwhile goes on the timeline at the cycle
// shown and the recording is replayed from there before the next chunk,
// as when paused; Pause and breakpoints take effect between chunks. The
// post-synthesis check compares one whole run from reset, so with it on a
// Run is recorded in one go.
export const HDL_CHUNK_MS = 300;

export function hdlChunkedStop() {
  if (!hdlActivity.chunked) return false;
  hdlActivity.chunked.stop = true;
  hdlStopPlay();
  hdlStatus('pausing...', 'busy');
  return true;
}

export async function hdlRunChunked() {
  return hdlWithBusy(async () => {
    const resume = !!hdlRec.trace && (hdlConfig.traceEnabled || !hdlRec.trace.steps.length);
    const report = (stop: string, t: HdlTrace) => {
      if (stop === 'breakpoint') {
        hdlStatus('stopped at a breakpoint - line ' + run.currentLine, 'ok');
        setStatus('HDL (' + hdlModeLabel() + ') stopped at breakpoint (line ' +
          run.currentLine + ', instruction ' + hdlRec.idx + ')', 'warn');
      } else if (stop === 'paused') {
        hdlStatus('paused at cycle ' + hdlCurrentCycle().toLocaleString(), 'ok');
        setStatus('HDL paused - ' + hdlRunSummary(t, t.budget) + ' recorded', 'info');
      } else {
        hdlStatus('done - ' + t.budget.toLocaleString() + ' cycles, LED=0x' + board.leds.toString(16).padStart(2, '0'), 'ok');
        setStatus('HDL ' + hdlModeLabel() + ' run finished - ' + hdlRunSummary(t, t.budget), 'success');
      }
    };
    if (resume) {
      // A breakpoint still ahead in what is already recorded is reached
      // without simulating anything.
      const hit = hdlBreakAt(hdlRec.idx + 1);
      if (hit >= 0) { hdlPlayTo(hit, () => report('breakpoint', hdlRecording())); return hdlRec.trace; }
    } else {
      hdlClearConsole();
    }
    const end = Math.min(HDL_MAX_CYCLES, (resume ? hdlRecording().budget : 0) + hdlConfig.cycleBudget);
    if (resume && hdlRecording().budget >= end) {
      hdlLog('Already recording the maximum of 2,000,000 cycles.', 'warn');
      hdlPlayTo(hdlRecording().steps.length, () => report('end', hdlRecording()));
      return hdlRec.trace;
    }
    const chunk = hdlActivity.chunked = { stop: false };
    updateToolbarButtonStates();
    const noise = /\$readmemh\(AA_(IROM|DMEM)\.mem\): Not enough words/;
    const said = (t: HdlTrace) => {
      const text = String(t.newOutput || '').split('\n').filter(l => l.trim() && !noise.test(l)).join('\n');
      if (text) hdlLog(text, 'out');
    };
    let size = 1000, first = !resume, stop = 'end', preApplied = resume ? hdlRecording().pre.length : 0;
    const wall0 = performance.now(), cyc0 = resume ? hdlCurrentCycle() : 0;
    // Without the trace, Real time holds what is shown to the paced clock:
    // each event, and the PC, is applied as the clock reaches it, and a
    // chunk is about HDL_CHUNK_MS of the clock, so the recording stays
    // close ahead.
    const paced = clock.pace === 'real' && !hdlConfig.traceEnabled;
    const cap = (n: number) => paced ? Math.min(n, Math.max(1, Math.round(cpuHz() * HDL_CHUNK_MS / 1000))) : n;
    size = cap(size);
    const showPaced = () => {
      const t = hdlRec.trace;
      if (!hdlActivity.paced || !t || t.steps.length) return;
      hdlActivity.paced.cyc = Math.min(t.budget, cyc0 + (performance.now() - wall0) / 1000 * cpuHz());
      const from = preApplied, n = hdlPreShown();
      for (let i = from; i < n; i++) hdlApplyPer(t.pre[i][0], t.pre[i][1]);
      preApplied = n;
      cpu.totalCycles = hdlCurrentCycle();
      if (n > from) {
        renderUartTerminal();
        updatePeripherals();
        if (typeof updateOledCanvas === 'function') updateOledCanvas();
        updateWaveView();
      }
      updateStats();
    };
    if (paced) hdlActivity.paced = { cyc: cyc0, applied: preApplied };
    const pacer = paced ? setInterval(showPaced, 50) : null;
    // What the page shows follows the recording: the instructions, or
    // without the trace the peripheral events as they come.
    const follow = (t: HdlTrace, replayed: boolean) => {
      if (t.steps.length) {
        if (clock.pace === 'real') hdlPlayTo(t.steps.length);
        else hdlSeek(t.steps.length, true, true);
        return;
      }
      // Unless +PCLOG reports it as it changes, the PC is known only
      // where each chunk ends (@@N).
      if (t.next !== null && t.next !== undefined) t.pre.push(['C', [String(t.budget - 1), t.next.toString(16)]]);
      if (replayed) {
        hdlSeek(0, false, !!hdlActivity.paced);
        preApplied = hdlActivity.paced ? hdlActivity.paced.applied : t.pre.length;
      }
      if (hdlActivity.paced) { showPaced(); return; }
      if (replayed) return;
      for (let i = preApplied; i < t.pre.length; i++) hdlApplyPer(t.pre[i][0], t.pre[i][1]);
      preApplied = t.pre.length;
      cpu.totalCycles = t.budget;
      renderUartTerminal();
      updatePeripherals();
      if (typeof updateOledCanvas === 'function') updateOledCanvas();
      updateWaveView();
      updateStats();
    };
    let hit = -1;
    try {
      for (;;) {
        if (chunk.stop) { stop = 'paused'; break; }
        if (hdlRec.pendingResim && hdlRec.trace && !first) {
          hdlRec.pendingResim = false;
          // A change at the end of the recording is simply taken by the next chunk.
          if (hdlTimelineDiff(hdlRec.trace.timeline ?? { stim: [], rx: [] }, { stim: hdlRec.stim, rx: hdlRec.rx }) < hdlRec.trace.budget) {
            const keep = hdlRec.idx;
            const t = await hdlBuildTrace(hdlRec.trace.budget, { quiet: true, chunk: true });
            if (!t) return null;
            hdlRec.idx = Math.min(keep, t.steps.length);
            follow(t, true);
          }
          continue;
        }
        const at = first ? 0 : hdlRecording().budget;
        if (at >= end) break;
        if (clock.pace === 'real' && !first) {
          const shown = hdlRecording().steps.length ? hdlCurrentCycle()
            : cyc0 + (performance.now() - wall0) / 1000 * cpuHz();
          if (at - shown > 2 * size) { await new Promise(r => setTimeout(r, 50)); continue; }
        }
        const target = Math.min(end, at + size);
        const from = first ? 0 : hdlRecording().steps.length;
        const t0 = performance.now();
        const t = first ? await hdlStartTrace(target, { chunk: true })
                        : await hdlBuildTrace(target, { quiet: true, chunk: true });
        if (!t) return null;
        size = cap(Math.max(200, Math.min(200000, Math.round((target - at) * HDL_CHUNK_MS / Math.max(1, performance.now() - t0)))));
        if (first) {
          first = false;
          if (clock.pace === 'real') { hdlSeek(0); if (hdlActivity.paced) preApplied = hdlActivity.paced.applied; }
        }
        else said(t);
        hit = hdlBreakAt(Math.max(from, hdlRec.idx + 1));
        if (hit >= 0) { stop = 'breakpoint'; break; }
        follow(t, false);
        hdlStatus('running - cycle ' + (hdlActivity.paced ? hdlCurrentCycle() : t.budget).toLocaleString() + ' of ' + end.toLocaleString() +
          (clock.pace === 'real' ? ', paced to ' + fmtHz(cpuHz()) : ''), 'busy');
      }
      // The last chunk is recorded before the clock shown reaches it.
      if (stop === 'end' && hdlActivity.paced) {
        while (!chunk.stop && hdlRec.trace && hdlActivity.paced.cyc < hdlRec.trace.budget) await new Promise(r => setTimeout(r, 50));
        if (chunk.stop) stop = 'paused';
      }
    } finally {
      if (pacer) clearInterval(pacer);
      if (paced) hdlActivity.paced = null;
      if (hdlActivity.chunked === chunk) hdlActivity.chunked = null;
    }
    const t = hdlRec.trace;
    if (!t) return null;
    if (!resume) {
      hdlLog('--- ' + hdlRunSummary(t, t.budget) + ', ' + uart.txBytes.length + ' UART bytes out ---', 'sys');
      if (hdlLooksPipelined(t))
        hdlLog('This core writes registers after its PC has moved on, as a pipeline does. Step, Back, ' +
          'breakpoints and the instruction count follow the fetch PC, so they run ahead of the results; ' +
          'registers, memory, peripherals and the cross-check are unaffected.', 'warn');
    }
    if (stop === 'paused') { hdlSeek(hdlRec.idx); report('paused', t); }
    else hdlPlayTo(stop === 'breakpoint' ? hit : t.steps.length, () => report(stop, t));
    if (hdlConfig.compareEnabled) await hdlCompareWithJs();
    waveRevealForRun();
    return t;
  });
}

// The Run button. With a recording already in hand this resumes from the
// current position rather than throwing the run away - Reset is how you
// ask for a fresh one, exactly as in the functional engine.
export async function runHdlSimulation() {
  if (hdlLiveCapable()) return hdlRunLive();
  if (!hdlConfig.synthEnabled) return hdlRunChunked();
  if (hdlRec.trace && hdlConfig.traceEnabled) {
    return hdlWithBusy(async () => {
      await hdlResumeRun((r) => {
        if (r.stop === 'breakpoint') {
          hdlStatus('stopped at a breakpoint - line ' + run.currentLine, 'ok');
          setStatus('HDL (' + hdlModeLabel() + ') stopped at breakpoint (line ' +
            run.currentLine + ', instruction ' + hdlRec.idx + ')', 'warn');
        } else {
          hdlStatus('at the end of ' + hdlRecording().budget + ' recorded cycles', 'ok');
          setStatus('HDL (' + hdlModeLabel() + ') ran ' + r.ran +
            ' more instructions - end of the ' + hdlRecording().budget +
            '-cycle recording', 'success');
        }
      });
      return hdlRec.trace;
    });
  }
  return hdlWithBusy(async () => {
    hdlClearConsole();
    const t = await hdlStartTrace(hdlConfig.cycleBudget);
    if (!t) return null;
    // Honour breakpoints on the very first run too, so a breakpoint set
    // before pressing Run behaves the way it does in the functional model.
    const hit = hdlBreakAt(0);
    if (clock.pace === 'real') hdlSeek(0);
    hdlPlayTo(hit >= 0 ? hit : t.steps.length, () => {
      hdlLog('--- ' + t.steps.length + ' instructions, ' + uart.txBytes.length + ' UART bytes out ---', 'sys');
      if (hdlLooksPipelined(t))
        hdlLog('This core writes registers after its PC has moved on, as a pipeline does. Step, Back, ' +
          'breakpoints and the instruction count follow the fetch PC, so they run ahead of the results; ' +
          'registers, memory, peripherals and the cross-check are unaffected.', 'warn');
      if (hit >= 0) {
        hdlStatus('stopped at a breakpoint - line ' + run.currentLine, 'ok');
        setStatus('HDL (' + hdlModeLabel() + ') stopped at breakpoint (line ' +
          run.currentLine + ', instruction ' + hit + ')', 'warn');
      } else {
        hdlStatus('done - ' + t.budget + ' cycles, LED=0x' +
          board.leds.toString(16).padStart(2, '0'), 'ok');
        setStatus('HDL ' + hdlModeLabel() + ' run finished - ' + hdlRunSummary(t, t.budget), 'success');
      }
    });
    if (hdlConfig.compareEnabled) await hdlCompareWithJs();
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
export async function hdlGrowTrace(target: number) {
  const cap = hdlConfig.simulator === 'verilator' ? Infinity : HDL_MAX_CYCLES;
  const grown = Math.min(cap, Math.max(target, hdlRecording().budget + 1));
  if (grown <= hdlRecording().budget) {
    hdlLog('Already recording the maximum of 2,000,000 cycles.', 'warn');
    return false;
  }
  const before = hdlRecording().steps.length;
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

// At Real time a recording is played back at the clock: the position
// moves to the last instruction that has begun by now.
export function hdlStepCycle(k: number) {
  const trace = hdlRecording(), steps = trace.steps;
  if (k < steps.length) return steps[k].cyc;
  return trace.final ? trace.final.cyc : (steps.length ? steps[steps.length - 1].cyc : 0);
}
export function hdlStopPlay() {
  if (!hdlActivity.play) return false;
  if (hdlActivity.play.timer !== null) clearTimeout(hdlActivity.play.timer);
  hdlActivity.play = null;
  updateToolbarButtonStates();
  updateStats();
  return true;
}
export function hdlPlayTo(to: number, done?: () => void) {
  hdlStopPlay();
  if (clock.pace !== 'real' || to <= hdlRec.idx) { hdlSeek(to); if (done) done(); return; }
  const play: HdlPlayback = hdlActivity.play = { to, trace: hdlRec.trace, wall: performance.now(), cyc0: hdlCurrentCycle(), done, timer: null };
  clock.rtRatio = 1;
  const frame = () => {
    if (hdlActivity.play !== play) return;
    if (hdlRec.trace !== play.trace) { hdlStopPlay(); return; }
    const hz = cpuHz(), elapsed = performance.now() - play.wall;
    const want = play.cyc0 + elapsed / 1000 * hz;
    let k = hdlRec.idx;
    while (k < to && hdlStepCycle(k + 1) <= want) k++;
    if (k !== hdlRec.idx) hdlSeek(k, true, hz > RT_FOLLOW_HZ);
    if (k >= to) {
      hdlActivity.play = null;
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
export async function hdlResumeRun(done?: (r: { stop: string; ran: number }) => void) {
  const steps = () => hdlRecording().steps;
  let hit = hdlBreakAt(hdlRec.idx + 1);
  if (hit < 0 && ((run.breakpoints && run.breakpoints.size) || hdlRec.idx >= steps().length)) {
    if (await hdlGrowTrace(hdlRecording().budget + hdlConfig.cycleBudget)) hit = hdlBreakAt(hdlRec.idx + 1);
  }
  const to = hit >= 0 ? hit : steps().length;
  const r = { stop: hit >= 0 ? 'breakpoint' : 'end', ran: to - hdlRec.idx };
  hdlPlayTo(to, done ? () => done(r) : undefined);
  return r;
}

// Statement Stepping is engine-agnostic: one Step should cover every
// machine instruction the current source line expands to. In HDL mode
// that is a longer seek through the recording rather than more execution.
export function hdlStatementTarget(from: number) {
  const steps = hdlRecording().steps;
  if (!run.statementStepping || from >= steps.length) return from + 1;
  const startLine = sourceLineForPc(steps[from].pc);
  if (!(startLine > 0)) return from + 1;
  let k = from + 1;
  while (k < steps.length && k - from < 10000) {
    const line = sourceLineForPc(steps[k].pc);
    if (line !== startLine || (run.breakpoints && run.breakpoints.has(line))) break;
    k++;
  }
  return k;
}

// The mirror image, so Back undoes exactly what Step did.
export function hdlStatementBackTarget(from: number) {
  const steps = hdlRecording().steps;
  if (from <= 0) return 0;
  let k = from - 1;
  if (!run.statementStepping) return k;
  const line = sourceLineForPc(steps[k].pc);
  if (!(line > 0)) return k;
  while (k > 0 && sourceLineForPc(steps[k - 1].pc) === line) k--;
  return k;
}

export async function hdlStepOnce() {
  // Without the architectural trace there is no recording to move
  // through, so say that rather than silently doing nothing.
  if (!hdlConfig.traceEnabled) {
    hdlLog('Stepping needs the architectural trace. Tick "Record the architectural ' +
      'trace" under Settings > Simulation.', 'warn');
    setStatus('HDL stepping needs the Trace option', 'warn');
    return null;
  }
  return hdlWithBusy(async () => {
    if (!hdlRec.trace) {
      // A first Step needs a recording to step through, not a whole
      // run's worth, which would take seconds to a minute to record.
      const t = await hdlStartTrace(Math.min(hdlConfig.cycleBudget, hdlConfig.simulator === 'verilator' ? 100000 : 2000));
      if (!t) return null;
      hdlSeek(0);
      setStatus('HDL stepped to line ' + (run.currentLine > 0 ? run.currentLine : '?'), 'info');
      return t;
    }
    if (hdlRec.idx >= hdlRec.trace.steps.length) {
      if (!(await hdlGrowTrace(Math.max(hdlRec.trace.budget * 4, 1000)))) {
        setStatus('End of the recorded HDL trace', 'info');
        return null;
      }
    }
    const from = hdlRec.idx;
    hdlSeek(hdlStatementTarget(from));
    const covered = hdlRec.idx - from;
    const where = 'line ' + (run.currentLine > 0 ? run.currentLine : '?');
    setStatus(covered > 1
      ? 'HDL statement step \u2014 ' + covered + ' instructions, now at ' + where
      : 'HDL stepped to ' + where, 'info');
    return hdlRec.trace;
  });
}

export function hdlStepBack() {
  if (!hdlRec.trace || hdlRec.idx <= 0) {
    setStatus('Already at the start of the HDL trace', 'info');
    return;
  }
  hdlSeek(hdlStatementBackTarget(hdlRec.idx));
  setStatus('HDL stepped back to line ' + (run.currentLine > 0 ? run.currentLine : '?'), 'info');
}
