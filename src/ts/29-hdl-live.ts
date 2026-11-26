// @ts-nocheck
// Live runs with Verilator, in the desktop app.
// The model keeps running until Pause, a breakpoint or the cycle limit,
// taking inputs as they change. Its records stream into the recording,
// which the page follows, so the result is the same recording a replay
// of the inputs would make and everything after Pause works as usual.
// Resume restarts the model with the inputs recorded so far, from the
// newest checkpoint or from reset, and +LIVEFROM at the old end: up to
// there it takes no input and runs at full speed, and what follows joins
// onto the recording.
let hdlLive = null;   // { id, parser, stopAt, stopSent, checked } during a live run

function hdlLiveCapable() {
  return hdlSimulator === 'verilator' && !!(window.rvNative && window.rvNative.vlLive);
}
function hdlLiveHz() { return clock.pace === 'real' ? cpuHz() : 0; }
function hdlLiveSend(line) { if (hdlLive) window.rvNative.vlLiveSend(hdlLive.id, line); }
function hdlLiveStop() {
  if (!hdlLive || hdlLive.stopSent) return;
  hdlLive.stopSent = true;
  hdlLiveSend('stop');
  hdlStatus('pausing...', 'busy');
}
if (window.rvNative && window.rvNative.onVlLiveData) {
  window.rvNative.onVlLiveData((id, text) => {
    const live = hdlLive;
    if (!live || live.id !== id) return;
    if (!live.split) { live.parser.feed(text); return; }
    const s = live.split.feed(text);
    if (s.over) live.over.push(s.over);
    if (s.main) live.held.push(s.main);
    if (s.seen >= live.from + 2) live.check();
  });
}
// Inputs the model applied go onto the timeline with the cycle it chose.
function hdlLiveTakeInputs(parser) {
  for (const e of parser.takeInputs()) {
    if ('byte' in e) hdlRx.push(e);
    else hdlStim.push(e);
  }
}

async function hdlRunLive() {
  return hdlWithBusy(async () => {
    // Without the architectural trace the recording is the peripheral
    // events and the snapshot they fold into, which carries on just as well;
    // one made with the trace, though, is not continued without it.
    const resume = !!hdlTrace && (hdlTraceEnabled || !hdlTrace.steps.length);
    if (resume) {
      // A breakpoint still ahead in what is already recorded is reached
      // without running anything.
      const hit = hdlBreakAt(hdlIdx + 1);
      if (hit >= 0) {
        hdlSeek(hit);
        hdlStatus('stopped at a breakpoint - line ' + run.currentLine, 'ok');
        setStatus('HDL stopped at breakpoint (line ' + run.currentLine + ', instruction ' + hit + ')', 'warn');
        return hdlTrace;
      }
    } else {
      hdlClearConsole();
      await hdlReadFolder();
      hdlStim = [];
      hdlRx = [];
      hdlIdx = 0;
      hdlCaptureBaseInputs();
      hdlSyncRx();
    }
    const epoch = hdlEpoch;
    const from = resume ? hdlTrace.budget : 0;
    const budget = from + hdlCycleBudget;
    const prep = await hdlPrepareRun({ quiet: resume });
    if (!prep || epoch !== hdlEpoch) return null;
    const { mem, compiled } = prep;

    const liveWave = hdlDumpVcd && hdlLiveWave === 'live';
    const lvl = hdlTraceEnabled ? 2 : 1;
    const joinKey = hdlHash([compiled.key, lvl, JSON.stringify(hdlBase)].concat(Object.values(mem.files)).join('|'));
    const ckOn = () => !!(compiled.vlCk && hdlVlCkOff !== compiled.key);
    const plus = hdlPlusargs(budget, lvl).filter(a => !/^\+VCD/.test(a));
    if (liveWave) {
      plus.push('+VCD', '+LIVEVCD');
      if (hdlWaveTop) plus.push('+VCDTOP');
      if (from > HDL_VCD_WINDOW) plus.push('+VCDFROM=' + (from - HDL_VCD_WINDOW));
    }
    plus.push('+LIVE', '+LIVEFROM=' + from, '+HZ=' + hdlLiveHz());
    const files = Object.assign({}, mem.files, { 'stim.mem': hdlStimFile(), 'uart_rx.mem': hdlRxFile() });

    // Resume starts from the newest checkpoint that leaves some of the
    // recording to check the replay against and, with a live waveform,
    // comes before the waveform's window.
    let ck = resume && ckOn() ? hdlVlCkPick(hdlTrace, joinKey, from - (liveWave ? HDL_VCD_WINDOW : HDL_CK_VERIFY)) : null;
    const kept = resume && hdlTrace.joinKey === joinKey && hdlTrace.vlCks ? hdlTrace.vlCks : [];
    const checkLo = ck ? hdlCheckFrom(hdlTrace, ck.k) : 0;
    const oldRecs = ck ? hdlRecordList(hdlTrace, checkLo, from - 2) : null;

    if (resume) hdlSeek(hdlCutTrace(hdlTrace, from).steps.length);
    const parser = hdlTraceParser(resume ? hdlTrace : null);
    const t = parser.trace;
    if (!resume) {
      t.budget = 0;
      hdlTrace = t;
      hdlSeek(0);
    }
    const live = hdlLive = { id: 0, parser, from, stopAt: -1, stopSent: false, checked: resume ? t.steps.length : 0,
                             preApplied: resume ? t.pre.length : 0, ck: null, split: null, over: [], held: [] };
    updateToolbarButtonStates();
    // A run from a checkpoint holds back what it prints until the stretch
    // before `from` has been checked against the recording.
    const launch = c => {
      const id = live.id = ++hdlWorkerSeq;
      hdlNativeJobs.add(id);
      const p = plus.concat('+TRACEFROM=' + (c ? c.k : from), ckOn() ? ['+CKEVERY=' + HDL_VL_CK_EVERY] : []);
      const f = Object.assign({}, files);
      if (c) {
        p.push('+CKLOAD=' + c.k);
        f['ck_load.txt'] = c.txt;
        c.mem.forEach((m, i) => { f['ck_load_m' + i + '.mem'] = m; });
      }
      live.ck = c;
      live.split = c ? hdlJoinSplit(from) : null;
      live.over = [];
      live.held = [];
      const run = window.rvNative.vlLive(id, compiled.model, f, p, { keep: HDL_RUN_KEEP.source });
      if (live.stopSent) hdlLiveSend('stop');
      return run.finally(() => hdlNativeJobs.delete(id));
    };
    live.check = () => {
      const ok = hdlJoinCheck(oldRecs, live.over.join(''), checkLo, from - 2);
      const held = live.held.join('') + live.split.take();
      live.split = null;
      live.over = live.held = [];
      if (ok) parser.feed(held);
      else {
        // Its output is ignored from here on, though some may still arrive.
        const dead = live.id;
        live.ckFailed = true;
        live.id = 0;
        window.rvNative.hdlKill(dead);
      }
    };

    let waveBusy = false, lastWave = 0, waveStopped = false;
    let rtWall = 0, rtCyc = -1;
    clock.rtRatio = 1;
    const tick = () => {
      if (hdlLive !== live) return;
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
      if (target > hdlIdx) {
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
        window.rvNative.vlLiveRead(live.id, 'dump.vcd', HDL_LIVE_VCD_MAX).then(b => {
          waveBusy = false;
          if (!b || hdlLive !== live) return;
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
          hdlLastVcd = hdlShiftVcd(hdlVcdFromBytes(b.data), live.ck ? live.ck.k : 0);
          updateWaveView();
        }, () => { waveBusy = false; });
      }
    };
    const replaying = c => hdlStatus(!resume ? 'starting live...' : c
      ? 'replaying cycles ' + c.k.toLocaleString() + ' to ' + from.toLocaleString() + '...'
      : 'replaying to cycle ' + from.toLocaleString() + '...', 'busy');
    replaying(ck);
    const timer = setInterval(tick, 100);
    let r;
    try {
      r = await launch(ck);
      if (live.split && !r.cancelled) {
        const s = live.split.end();
        if (s.over) live.over.push(s.over);
        if (s.main) live.held.push(s.main);
        live.check();
      }
      if (live.ckFailed && epoch === hdlEpoch) {
        hdlVlCkFailed(ck.k, compiled.key);
        ck = null;
        live.ckFailed = false;
        replaying(null);
        r = await launch(null);
      }
    } finally {
      clearInterval(timer);
      if (hdlLive === live) hdlLive = null;
    }
    if (r.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
    if (epoch !== hdlEpoch) return null;
    parser.finish();
    hdlLiveTakeInputs(parser);

    t.budget = t.final ? t.final.cyc : budget;
    t.regBank = compiled.regBank;
    t.raw = null;
    t.ckKey = null;
    t.joinKey = joinKey;
    t.vlCks = ckOn() ? hdlVlCkMerge(kept, hdlDecodeCk(r.files)) : null;
    const cutEnd = hdlTrimTrace(t);
    if (cutEnd && live.stopAt >= 0) live.stopAt = Math.max(0, live.stopAt - cutEnd);
    t.timeline = { stim: hdlStim.slice(), rx: hdlRx.slice() };
    hdlLastRtlOut = null;
    const noise = /\$readmemh\(AA_(IROM|DMEM)\.mem\): Not enough words|^- (cg3207_hdl_tb\.v:\d+: Verilog \$finish|S i m u l a t i o n|Verilator: )/;
    const said = String(t.newOutput || '').split('\n').filter(l => l.trim() && !noise.test(l));
    if (said.length) hdlLog(said.slice(-200).join('\n'), 'out');

    if (!hdlDumpVcd) {
      hdlLastVcd = null;
    } else if (liveWave && !waveStopped && r.files && r.files['dump.vcd']) {
      hdlLastVcd = hdlShiftVcd(hdlVcdFromBytes(r.files['dump.vcd']), live.ck ? live.ck.k : 0);
      t.vcdScope = hdlWaveTop ? 'top' : 'all';
    } else {
      hdlStatus('building the waveform...', 'busy');
      const wf = Object.assign({}, mem.files, { 'stim.mem': hdlStimFile(), 'uart_rx.mem': hdlRxFile() });
      // From the newest checkpoint before the window, printing the stretch
      // up to the end, which is checked against the recording.
      const c = ckOn() && t.budget > HDL_VCD_WINDOW ? hdlVlCkPick(t, joinKey, t.budget - HDL_VCD_WINDOW) : null;
      let s = null;
      if (c) {
        c.mem.forEach((m, i) => { wf['ck_load_m' + i + '.mem'] = m; });
        s = await hdlRunModel(compiled.model, Object.assign({ 'ck_load.txt': c.txt }, wf),
          hdlPlusargs(t.budget, lvl).concat('+TRACEFROM=' + c.k, '+CKLOAD=' + c.k));
        if (epoch !== hdlEpoch) return null;
        const lo = hdlCheckFrom(t, c.k), hi = t.budget - 2;
        if (hdlJoinCheck(hdlRecordList(t, lo, hi), s.out, lo, hi)) s.vcd = hdlShiftVcd(s.vcd, c.k);
        else { hdlVlCkFailed(c.k, compiled.key); t.vlCks = null; s = null; }
      }
      if (!s) s = await hdlRunModel(compiled.model, wf, hdlPlusargs(t.budget, 0));
      if (epoch !== hdlEpoch) return null;
      hdlLastVcd = s.vcd || null;
      t.vcdScope = hdlWaveTop ? 'top' : 'all';
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
    if (hdlCompareEnabled) await hdlCompareWithJs();
    waveRevealForRun();
    return t;
  });
}

onClockChange(() => hdlLiveSend('hz ' + hdlLiveHz()));
