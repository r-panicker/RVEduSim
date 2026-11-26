// Live runs with Verilator, in the desktop app.
// The model keeps running until Pause, a breakpoint or the cycle limit,
// taking inputs as they change. Its records stream into the recording,
// which the page follows, so the result is the same recording a replay
// of the inputs would make and everything after Pause works as usual.
// Resume restarts the model with the inputs recorded so far, from the
// newest checkpoint or from reset, and +LIVEFROM at the old end: up to
// there it takes no input and runs at full speed, and what follows joins
// onto the recording.

import { HDL_CK_VERIFY, HDL_VL_CK_EVERY, type HdlCheckpoint, hdlCheckFrom, hdlJoinCheck, hdlJoinSplit, hdlRecordList, hdlShiftVcd, hdlVcdFromBytes, hdlVlCkFailed, hdlVlCkMerge, hdlVlCkPick } from './checkpoints';
import { hdlCompareWithJs } from './compare';
import { hdlRxFile, hdlStimFile, hdlSyncRx } from './compile';
import { HDL_LIVE_PRE_KEEP, HDL_LIVE_VCD_MAX, HDL_RUN_KEEP, HDL_VCD_WINDOW, type HdlToolFiles, hdlClearConsole, hdlDecodeCk, hdlDecodeRun, hdlLog, hdlNativeJobs, hdlRunModel, hdlStatus, hdlBridge } from './engine';
import { hdlBreakAt, hdlCaptureBaseInputs, hdlWithBusy } from './run';
import { hdlApplyPer, hdlCaptureBase, hdlCutTrace, hdlSeek, hdlTrimTrace } from './seek';
import { hdlReadFolder } from './sources';
import { hdlActivity, hdlBuild, hdlCheckpoints, hdlConfig, hdlRec } from './state';
import { hdlPlusargs, hdlPrepareRun, hdlRunSummary, hdlTraceParser } from './trace';
import { hdlHash } from './verilog';
import { RT_FOLLOW_HZ, cpuHz, fmtHz } from '../machine/clock';
import { board, clock, cpu, run } from '../machine/state';
import { onClockChange } from '../ui/clock-controls';
import { setStatus } from '../ui/editor';
import { refreshDownloadMenu, updateStats } from '../ui/execution';
import { renderUartTerminal, updateOledCanvas, updatePeripherals } from '../ui/peripherals';
import { updateToolbarButtonStates } from '../ui/run-control';
import { updateWaveView, waveRevealForRun } from '../ui/waveform';

// A live run: the job id of the model running, the parser its output
// feeds, the cycle it joins on (from), where it is to stop (stopAt, -1 for
// not yet), how far breakpoints (checked) and peripheral events
// (preApplied) have been looked at, and, for a run from a checkpoint, the
// split of its output: what is to be checked against the recording (over),
// what is held back until the check passes (held), and the check itself.
export interface HdlLiveRun {
  id: number; parser: ReturnType<typeof hdlTraceParser>; from: number;
  stopAt: number; stopSent: boolean; checked: number; preApplied: number;
  ck: HdlCheckpoint | null; split: ReturnType<typeof hdlJoinSplit> | null;
  over: string[]; held: string[]; ckFailed: boolean; check?: () => void;
}

export function hdlLiveCapable() {
  return hdlConfig.simulator === 'verilator' && !!(window.rvNative && window.rvNative.vlLive);
}
export function hdlLiveHz() { return clock.pace === 'real' ? cpuHz() : 0; }
export function hdlLiveSend(line: string) { if (hdlActivity.live) hdlBridge().vlLiveSend(hdlActivity.live.id, line); }
export function hdlLiveStop() {
  if (!hdlActivity.live || hdlActivity.live.stopSent) return;
  hdlActivity.live.stopSent = true;
  hdlLiveSend('stop');
  hdlStatus('pausing...', 'busy');
}
// Inputs the model applied go onto the timeline with the cycle it chose.
export function hdlLiveTakeInputs(parser: ReturnType<typeof hdlTraceParser>) {
  for (const e of parser.takeInputs()) {
    if (e.byte !== undefined) hdlRec.rx.push({ cycle: e.cycle, byte: e.byte });
    else hdlRec.stim.push({ cycle: e.cycle, code: e.code ?? 0, value: e.value ?? 0 });
  }
}

export async function hdlRunLive() {
  return hdlWithBusy(async () => {
    // Without the architectural trace the recording is the peripheral
    // events and the snapshot they fold into, which carries on just as well;
    // one made with the trace, though, is not continued without it.
    const resume = !!hdlRec.trace && (hdlConfig.traceEnabled || !hdlRec.trace.steps.length);
    if (resume) {
      // A breakpoint still ahead in what is already recorded is reached
      // without running anything.
      const hit = hdlBreakAt(hdlRec.idx + 1);
      if (hit >= 0) {
        hdlSeek(hit);
        hdlStatus('stopped at a breakpoint - line ' + run.currentLine, 'ok');
        setStatus('HDL stopped at breakpoint (line ' + run.currentLine + ', instruction ' + hit + ')', 'warn');
        return hdlRec.trace;
      }
    } else {
      hdlClearConsole();
      await hdlReadFolder();
      hdlRec.stim = [];
      hdlRec.rx = [];
      hdlRec.idx = 0;
      hdlCaptureBaseInputs();
      hdlSyncRx();
    }
    const epoch = hdlRec.epoch;
    const prior = resume ? hdlRec.trace : null;
    const from = prior ? prior.budget : 0;
    const budget = from + hdlConfig.cycleBudget;
    const prep = await hdlPrepareRun({ quiet: resume });
    if (!prep || epoch !== hdlRec.epoch) return null;
    const { mem, compiled } = prep;

    const liveWave = hdlConfig.dumpVcd && hdlConfig.liveWave === 'live';
    const lvl = hdlConfig.traceEnabled ? 2 : 1;
    const joinKey = hdlHash([compiled.key, lvl, JSON.stringify(hdlRec.base)].concat(Object.values(mem.files)).join('|'));
    const ckOn = () => !!(compiled.vlCk && hdlCheckpoints.vlOff !== compiled.key);
    const plus = hdlPlusargs(budget, lvl).filter(a => !/^\+VCD/.test(a));
    if (liveWave) {
      plus.push('+VCD', '+LIVEVCD');
      if (hdlConfig.waveTop) plus.push('+VCDTOP');
      if (from > HDL_VCD_WINDOW) plus.push('+VCDFROM=' + (from - HDL_VCD_WINDOW));
    }
    plus.push('+LIVE', '+LIVEFROM=' + from, '+HZ=' + hdlLiveHz());
    const files: HdlToolFiles = Object.assign({}, mem.files, { 'stim.mem': hdlStimFile(), 'uart_rx.mem': hdlRxFile() });

    // Resume starts from the newest checkpoint that leaves some of the
    // recording to check the replay against and, with a live waveform,
    // comes before the waveform's window.
    let ck = prior && ckOn() ? hdlVlCkPick(prior, joinKey, from - (liveWave ? HDL_VCD_WINDOW : HDL_CK_VERIFY)) : null;
    const kept = prior && prior.joinKey === joinKey && prior.vlCks ? prior.vlCks : [];
    const checkLo = ck && prior ? hdlCheckFrom(prior, ck.k) : 0;
    const oldRecs = ck && prior ? hdlRecordList(prior, checkLo, from - 2) : [];

    if (prior) hdlSeek(hdlCutTrace(prior, from).steps.length);
    const parser = hdlTraceParser(prior ?? undefined);
    const t = parser.trace;
    if (!resume) {
      t.budget = 0;
      hdlRec.trace = t;
      hdlSeek(0);
    }
    const live: HdlLiveRun = hdlActivity.live = { id: 0, parser, from, stopAt: -1, stopSent: false, checked: resume ? t.steps.length : 0,
                             preApplied: resume ? t.pre.length : 0, ck: null, split: null, over: [], held: [], ckFailed: false };
    updateToolbarButtonStates();
    // A run from a checkpoint holds back what it prints until the stretch
    // before `from` has been checked against the recording.
    const launch = (c: HdlCheckpoint | null): Promise<{ cancelled?: boolean; files: Record<string, Uint8Array> }> => {
      const id = live.id = ++hdlActivity.jobSeq;
      hdlNativeJobs.add(id);
      const p = plus.concat('+TRACEFROM=' + (c ? c.k : from), ckOn() ? ['+CKEVERY=' + HDL_VL_CK_EVERY] : []);
      const f: HdlToolFiles = Object.assign({}, files);
      if (c) {
        p.push('+CKLOAD=' + c.k);
        f['ck_load.txt'] = c.txt;
        c.mem.forEach((m, i) => { f['ck_load_m' + i + '.mem'] = m; });
      }
      live.ck = c;
      live.split = c ? hdlJoinSplit(from) : null;
      live.over = [];
      live.held = [];
      const run = hdlBridge().vlLive(id, compiled.model, f, p, { keep: HDL_RUN_KEEP.source });
      if (live.stopSent) hdlLiveSend('stop');
      return run.finally(() => hdlNativeJobs.delete(id));
    };
    const check = live.check = () => {
      const ok = hdlJoinCheck(oldRecs, live.over.join(''), checkLo, from - 2);
      const held = live.held.join('') + (live.split ? live.split.take() : '');
      live.split = null;
      live.over = live.held = [];
      if (ok) parser.feed(held);
      else {
        // Its output is ignored from here on, though some may still arrive.
        const dead = live.id;
        live.ckFailed = true;
        live.id = 0;
        hdlBridge().hdlKill(dead);
      }
    };

    let waveBusy = false, lastWave = 0, waveStopped = false;
    let rtWall = 0, rtCyc = -1;
    clock.rtRatio = 1;
    const tick = () => {
      if (hdlActivity.live !== live) return;
      hdlLiveTakeInputs(parser);
      const cut = hdlTrimTrace(t);
      if (cut) {
        live.checked = Math.max(0, live.checked - cut);
        if (live.stopAt >= 0) live.stopAt = Math.max(0, live.stopAt - cut);
      }
      const steps = t.steps;
      if (live.stopAt < 0) {
        const hit = hdlBreakAt(live.checked);
        live.checked = steps.length;
        if (hit >= 0) { live.stopAt = hit; hdlLiveStop(); }
      }
      const target = live.stopAt >= 0 ? Math.min(live.stopAt, steps.length) : steps.length;
      const hz = hdlLiveHz();
      const nowCyc = steps.length ? steps[steps.length - 1].cyc : (t.lastCyc || from);
      if (target > hdlRec.idx) {
        hdlSeek(target, true, !(hz && hz <= RT_FOLLOW_HZ));
      } else if (!steps.length) {
        // No architectural trace: nothing but peripheral events, applied as
        // they arrive and, past HDL_LIVE_PRE_KEEP, folded into a snapshot.
        if (t.pre.length > live.preApplied) {
          for (let i = live.preApplied; i < t.pre.length; i++) hdlApplyPer(t.pre[i][0], t.pre[i][1]);
          live.preApplied = t.pre.length;
          if (t.pre.length > HDL_LIVE_PRE_KEEP) {
            t.base = hdlCaptureBase(nowCyc, (t.base ? t.base.acks : 0) + (t.preAcks || 0));
            t.pre = [];
            t.preAcks = 0;
            live.preApplied = 0;
          }
          renderUartTerminal();
          updatePeripherals();
          if (typeof updateOledCanvas === 'function') updateOledCanvas();
          updateWaveView();
        }
        cpu.totalCycles = nowCyc;
        updateStats();
      }
      // The fraction of real time reached, measured as the JS engine does.
      const nowWall = performance.now();
      if (!hz) { clock.rtRatio = 1; rtCyc = -1; }
      else if (rtCyc < 0 || nowCyc < rtCyc) { rtWall = nowWall; rtCyc = nowCyc; }
      else if (nowWall - rtWall >= Math.max(500, 50000 / hz)) {
        clock.rtRatio = Math.min(1, (nowCyc - rtCyc) / ((nowWall - rtWall) / 1000 * hz));
        rtWall = nowWall; rtCyc = nowCyc;
        updateStats();
      }
      if (!live.stopSent) {
        const cyc = nowCyc;
        hdlStatus('running live - cycle ' + cyc.toLocaleString() + ' of ' + budget.toLocaleString() +
          (clock.pace === 'real' ? ', paced to ' + fmtHz(cpuHz()) : ''), 'busy');
      }
      if (liveWave && !waveStopped && !waveBusy && performance.now() - lastWave > 500) {
        waveBusy = true;
        lastWave = performance.now();
        hdlBridge().vlLiveRead(live.id, 'dump.vcd', HDL_LIVE_VCD_MAX).then(b => {
          waveBusy = false;
          if (!b || hdlActivity.live !== live) return;
          // Running faster than a waveform can be followed: the model
          // stops writing it, and it is built for the end when the run stops.
          if (!b.data) {
            waveStopped = true;
            hdlLiveSend('in 8 0');
            hdlLiveSend('vcd 0');
            hdlLog('The waveform passed ' + (HDL_LIVE_VCD_MAX / 1e6) + ' MB, too fast to follow, so it ' +
              'stopped; it is built for the last ' + HDL_VCD_WINDOW.toLocaleString() +
              ' cycles when the run stops. A slower Real time clock lets it follow.', 'sys');
            return;
          }
          hdlBuild.lastVcd = hdlShiftVcd(hdlVcdFromBytes(b.data), live.ck ? live.ck.k : 0);
          updateWaveView();
        }, () => { waveBusy = false; });
      }
    };
    const replaying = (c: HdlCheckpoint | null) => hdlStatus(!resume ? 'starting live...' : c
      ? 'replaying cycles ' + c.k.toLocaleString() + ' to ' + from.toLocaleString() + '...'
      : 'replaying to cycle ' + from.toLocaleString() + '...', 'busy');
    replaying(ck);
    const timer = setInterval(tick, 100);
    let r: Awaited<ReturnType<typeof launch>>;
    try {
      r = await launch(ck);
      if (live.split && !r.cancelled) {
        const s = live.split.end();
        if (s.over) live.over.push(s.over);
        if (s.main) live.held.push(s.main);
        check();
      }
      if (live.ckFailed && ck && epoch === hdlRec.epoch) {
        hdlVlCkFailed(ck.k, compiled.key);
        ck = null;
        live.ckFailed = false;
        replaying(null);
        r = await launch(null);
      }
    } finally {
      clearInterval(timer);
      if (hdlActivity.live === live) hdlActivity.live = null;
    }
    if (r.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
    if (epoch !== hdlRec.epoch) return null;
    parser.finish();
    hdlLiveTakeInputs(parser);

    t.budget = t.final ? t.final.cyc : budget;
    t.regBank = compiled.regBank;
    t.joinKey = joinKey;
    t.vlCks = ckOn() ? hdlVlCkMerge(kept, hdlDecodeCk(r.files)) : null;
    const cutEnd = hdlTrimTrace(t);
    if (cutEnd && live.stopAt >= 0) live.stopAt = Math.max(0, live.stopAt - cutEnd);
    t.timeline = { stim: hdlRec.stim.slice(), rx: hdlRec.rx.slice() };
    hdlBuild.lastRtlOut = null;
    const noise = /\$readmemh\(AA_(IROM|DMEM)\.mem\): Not enough words|^- (cg3207_hdl_tb\.v:\d+: Verilog \$finish|S i m u l a t i o n|Verilator: )/;
    const said = String(t.newOutput || '').split('\n').filter(l => l.trim() && !noise.test(l));
    if (said.length) hdlLog(said.slice(-200).join('\n'), 'out');

    if (!hdlConfig.dumpVcd) {
      hdlBuild.lastVcd = null;
    } else if (liveWave && !waveStopped && r.files && r.files['dump.vcd']) {
      hdlBuild.lastVcd = hdlShiftVcd(hdlVcdFromBytes(r.files['dump.vcd']), live.ck ? live.ck.k : 0);
      t.vcdScope = hdlConfig.waveTop ? 'top' : 'all';
    } else {
      hdlStatus('building the waveform...', 'busy');
      const wf: HdlToolFiles = Object.assign({}, mem.files, { 'stim.mem': hdlStimFile(), 'uart_rx.mem': hdlRxFile() });
      // From the newest checkpoint before the window, printing the stretch
      // up to the end, which is checked against the recording.
      const c = ckOn() && t.budget > HDL_VCD_WINDOW ? hdlVlCkPick(t, joinKey, t.budget - HDL_VCD_WINDOW) : null;
      let s: ReturnType<typeof hdlDecodeRun> | null = null;
      if (c) {
        c.mem.forEach((m, i) => { wf['ck_load_m' + i + '.mem'] = m; });
        s = await hdlRunModel(compiled.model, Object.assign({ 'ck_load.txt': c.txt }, wf),
          hdlPlusargs(t.budget, lvl).concat('+TRACEFROM=' + c.k, '+CKLOAD=' + c.k));
        if (epoch !== hdlRec.epoch) return null;
        const lo = hdlCheckFrom(t, c.k), hi = t.budget - 2;
        if (hdlJoinCheck(hdlRecordList(t, lo, hi), s.out, lo, hi)) s.vcd = s.vcd && hdlShiftVcd(s.vcd, c.k);
        else { hdlVlCkFailed(c.k, compiled.key); t.vlCks = null; s = null; }
      }
      if (!s) s = await hdlRunModel(compiled.model, wf, hdlPlusargs(t.budget, 0));
      if (epoch !== hdlRec.epoch) return null;
      hdlBuild.lastVcd = s.vcd || null;
      t.vcdScope = hdlConfig.waveTop ? 'top' : 'all';
    }
    refreshDownloadMenu();

    hdlSeek(live.stopAt >= 0 ? live.stopAt : t.steps.length);
    if (live.stopAt >= 0) {
      hdlStatus('stopped at a breakpoint - line ' + run.currentLine, 'ok');
      setStatus('HDL stopped at breakpoint (line ' + run.currentLine + ', instruction ' + live.stopAt + ')', 'warn');
    } else if (live.stopSent) {
      hdlStatus('paused at cycle ' + t.budget.toLocaleString(), 'ok');
      setStatus('HDL paused - ' + hdlRunSummary(t, t.budget), 'info');
    } else {
      hdlStatus('done - ' + t.budget.toLocaleString() + ' cycles, LED=0x' + board.leds.toString(16).padStart(2, '0'), 'ok');
      setStatus('HDL live run finished - ' + hdlRunSummary(t, t.budget), 'success');
    }
    if (hdlConfig.compareEnabled) await hdlCompareWithJs();
    waveRevealForRun();
    return t;
  });
}

// Run once the page has loaded every module (main.ts), in page order.
export function onLiveLoad() {
  if (window.rvNative && window.rvNative.onVlLiveData) {
    window.rvNative.onVlLiveData((id: number, text: string) => {
      const live = hdlActivity.live;
      if (!live || live.id !== id) return;
      if (!live.split) { live.parser.feed(text); return; }
      const s = live.split.feed(text);
      if (s.over) live.over.push(s.over);
      if (s.main) live.held.push(s.main);
      if (s.seen >= live.from + 2) live.check?.();
    });
  }
  onClockChange(() => hdlLiveSend('hz ' + hdlLiveHz()));
}
