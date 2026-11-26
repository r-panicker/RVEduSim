// @ts-nocheck
// HDL mode: parsing the testbench's output into a trace, and the runs
// that build or extend it.

// ================================================================
// Trace capture
// ================================================================
// Reads the testbench's records into a trace. A live run feeds it output
// as it arrives, in pieces that need not end on a line; base continues a
// trace already recorded, which a run with +TRACEFROM extends. A step's
// write lists share one frozen empty array until the step has a write,
// since a long recording is mostly steps with none.
const HDL_NONE = Object.freeze([]);
function hdlTraceParser(base) {
  const t = base || { steps: [], pre: [], preAcks: 0, final: null, next: null, userOutput: '' };
  const userLines = [];
  const inputs = [];          // @@V / @@U: inputs a live run applied, with their cycles
  let cur = t.steps.length ? t.steps[t.steps.length - 1] : null;
  let partial = '';
  const line = l => {
    const m = /^@@([ILSTOMWFNABPUVC])\s+(.*)$/.exec(l);
    if (!m) { if (l.trim()) userLines.push(l); return; }
    const k = m[1];
    const f = m[2].trim().split(/\s+/);
    if (k !== 'V' && k !== 'U' && k !== 'N' && k !== 'F') {
      const c = parseInt(f[0], 10);
      if (c > (t.lastCyc || 0)) t.lastCyc = c;
    }
    // @@C <cycle> <PC>: how far a live run has got, and without the trace
    // the PC, which the page shows as the run goes.
    if (k === 'C') { if (!cur && f.length > 1) t.pre.push([k, f]); return; }
    if (k === 'I') {
      cur = { cyc: parseInt(f[0], 10), pc: parseInt(f[1], 16) >>> 0,
              instr: parseInt(f[2], 16) >>> 0, regw: HDL_NONE, memw: HDL_NONE, per: HDL_NONE, acks: 0 };
      t.steps.push(cur);
      return;
    }
    if (k === 'F') {
      t.final = { cyc: parseInt(f[0], 10), led: parseInt(f[1], 16) & 0xFF, ss: f[2] };
      return;
    }
    if (k === 'N') { t.next = parseInt(f[1], 16) >>> 0; return; }
    if (k === 'V') { inputs.push({ cycle: parseInt(f[0], 10), code: parseInt(f[1], 10), value: parseInt(f[2], 16) >>> 0 }); return; }
    if (k === 'U') { inputs.push({ cycle: parseInt(f[0], 10), byte: parseInt(f[1], 16) & 0xFF }); return; }
    // The hardware has taken a byte off the UART RX line. Counting these
    // is what lets the console's FIFO - and with it RX_VALID - drain as
    // the recording is stepped through.
    if (k === 'A') { if (cur) cur.acks++; else t.preAcks++; return; }
    if (k === 'W') {
      if (!cur) return;
      if (cur.regw === HDL_NONE) cur.regw = [];
      cur.regw.push([parseInt(f[1], 10), parseInt(f[2], 16) >>> 0, parseInt(f[0], 10)]);
      return;
    }
    if (k === 'M') {
      if (!cur) return;
      if (cur.memw === HDL_NONE) cur.memw = [];
      cur.memw.push([parseInt(f[1], 16) >>> 0, parseInt(f[2], 16) & 0xF, parseInt(f[3], 16) >>> 0,
                     parseInt(f[0], 10)]);
      return;
    }
    // Peripheral activity, which is also captured when the
    // architectural trace is switched off.
    if (!cur) { t.pre.push([k, f]); return; }
    if (cur.per === HDL_NONE) cur.per = [];
    cur.per.push([k, f]);
  };
  return {
    trace: t,
    feed(text) {
      const parts = (partial + text).split('\n');
      partial = parts.pop();
      for (const l of parts) line(l);
    },
    takeInputs() { return inputs.splice(0); },
    finish() {
      if (partial) line(partial);
      partial = '';
      const out = userLines.join('\n');
      t.userOutput = base && t.userOutput ? t.userOutput + (out ? '\n' + out : '') : out;
      t.newOutput = out;
      return t;
    }
  };
}

function hdlParseTrace(stdout) {
  const p = hdlTraceParser();
  p.feed(String(stdout || ''));
  return p.finish();
}

// The run environment, shared by the RTL run and the post-synthesis run.
function hdlPlusargs(budget, traceLvl) {
  const plus = [
    '+CYCLES=' + budget,
    '+TRACE=' + traceLvl,
    '+DIP=' + (hdlBase.dip & 0xFFFF).toString(16),
    '+PB=' + (hdlBase.pb & 0x7).toString(16),
    '+ACCEL=' + hdlHex32(hdlBase.accel),
    '+ADRDY=' + (hdlBase.adrdy ? '1' : '0'),
    '+NSTIM=' + hdlStim.length,
    '+NRX=' + hdlRx.length
  ];
  if (hdlDumpVcd) plus.push('+VCD');
  if (hdlDumpVcd && hdlWaveTop) plus.push('+VCDTOP');
  if (traceLvl === 1 && hdlSimulator !== 'verilator' && clock.pace === 'real' && cpuHz() <= RT_FOLLOW_HZ)
    plus.push('+PCLOG');
  if (hdlDumpVcd && hdlSimulator === 'verilator' && budget > HDL_VCD_WINDOW)
    plus.push('+VCDFROM=' + (budget - HDL_VCD_WINDOW));
  return plus;
}

// Run the cached binary with the current environment. Only the
// simulation runs; preprocessing and compilation are already done.
// With `from` ({ k, txt, mem }), the run starts from that checkpoint.
async function hdlRunVvp(budget, traceLvl, memFiles, from, extra) {
  const plus = hdlPlusargs(budget, traceLvl).concat(extra || []);
  const files = Object.assign({}, memFiles, {
    'stim.mem': hdlStimFile(),
    'uart_rx.mem': hdlRxFile()
  });
  // One more checkpoint near the end, where a Resume starts: the replay
  // has to reproduce HDL_CK_VERIFY cycles of the old recording, which
  // ends at budget - 1, before it is joined on.
  if (hdlCk) plus.push('+CKEVERY=' + hdlCk.every, '+CKAT=' + (budget - HDL_CK_VERIFY - 1));
  if (from) {
    plus.push('+CKLOAD=' + from.k);
    files['ck_load.txt'] = from.txt;
    from.mem.forEach((m, i) => { files['ck_load_m' + i + '.mem'] = m; });
  }
  const s = hdlVvpCache.model
    ? await hdlRunModel(hdlVvpCache.model, files, plus)
    : await hdlSimulate(hdlVvpCache.vvp, files, plus);
  // $writememb warns about every memory declared high-to-low, at every
  // checkpoint; saving and restoring read it the same way, so it is noise.
  s.out = s.out.split('\n').filter(l => !/\/cg3207_hdl_ck\.v:\d+:/.test(l) &&
    !/^- (cg3207_hdl_tb\.v:\d+: Verilog \$finish|S i m u l a t i o n|Verilator: )/.test(l) &&
    !/^(\S*\/)?cg3207_hdl_tb\.v:\d+: \$finish called at /.test(l)).join('\n');
  return s;
}

// What every run needs before it starts: the memory images from a
// pristine program, a refusal if the program does not fit the Wrapper,
// and the compiled design.
async function hdlPrepareRun(opts) {
  opts = opts || {};
  const wrapper = hdlFindWrapper();
  if (!wrapper) throw new Error('No `module Wrapper` found among the loaded sources.');
  if (!program.machineCode || !program.machineCode.length)
    throw new Error('Assemble a program first - the Wrapper loads it via $readmemh.');

  // Build the memory images from a pristine program image: seeking has
  // been writing into `memory`, and those writes must not be handed back
  // to the hardware as if they were initial contents. Done before the
  // engine loads, so a program that cannot fit is refused in a moment
  // rather than after a minute of compiling. Loading the image resets
  // what the page shows, so it is done once per program and Wrapper: a
  // run recorded in chunks carries on from what it last showed.
  hdlSyncReferenceWrapperDepths();
  const memKey = [program.machineCode, layout.baseAddress, layout.dataBase, wrapper.src];
  let mem;
  if (hdlMemCache && hdlMemCache.key.every((v, i) => v === memKey[i])) {
    mem = hdlMemCache.mem;
  } else {
    loadProgram(program.machineCode);
    mem = hdlMemFiles(wrapper.src);
    hdlMemCache = { key: memKey, mem };
  }
  hdlDmemBytes = Math.pow(2, mem.dmemBits);
  if (!opts.quiet) {
    hdlLog('Program image: ' + mem.codeWords + ' instruction words into an IROM of ' +
      mem.iromCapacity + ' (IROM_DEPTH_BITS=' + mem.iromBits +
      ', DMEM_DEPTH_BITS=' + mem.dmemBits + ')', 'sys');
  }
  // A program that does not fit is refused rather than half-loaded: the
  // image would stop at the end of the memory and the core would fetch
  // whatever lay past it, which looks like a bug in the processor.
  const tooBig = [];
  if (mem.codeWords > mem.iromCapacity) {
    tooBig.push('IROM_DEPTH_BITS is ' + mem.iromBits + ', holding ' + mem.iromCapacity +
      ' instruction words; this program needs ' + mem.codeWords);
  }
  if (mem.dataWords > mem.dmemCapacity) {
    tooBig.push('DMEM_DEPTH_BITS is ' + mem.dmemBits + ', holding ' + mem.dmemCapacity +
      ' data words; this program needs ' + mem.dataWords);
  }
  if (tooBig.length) {
    const need = hdlRequiredDepths();
    hdlLog('This program does not fit the Wrapper you loaded, so it was not run. ' +
      tooBig.join('. ') + '. Raise them in your Wrapper to at least ' + need.irom +
      ' and ' + need.dmem + ' (each +1 doubles that memory) and load it again.', 'err');
    setStatus('Program does not fit this Wrapper — raise its depth bits, see the console', 'error');
    return null;
  }

  await loadHdlEngine();
  const compiled = await hdlEnsureCompiled(opts.chunk && opts.quiet);
  if (!compiled) return null;
  return { mem, compiled };
}

// Counted from reset, a trimmed recording included. Without the
// architectural trace nothing counts instructions, so only cycles are said.
function hdlRunSummary(t, cycles) {
  const n = (t.offset || 0) + t.steps.length;
  return (n ? n.toLocaleString() + ' instructions in ' : '') + Number(cycles).toLocaleString() + ' cycles';
}

// Build (or rebuild) the trace for the current program, sources and
// input timeline. Everything downstream is a view onto what this
// produces, so a run, a step and an input change all funnel through it.
async function hdlBuildTrace(budget, opts) {
  opts = opts || {};
  const epoch = hdlEpoch;
  const prep = await hdlPrepareRun(opts);
  if (!prep) return null;
  const { mem, compiled } = prep;
  const vl = hdlSimulator === 'verilator';

  const lvl = hdlTraceEnabled ? 2 : 1;
  const timeline = { stim: hdlStim.slice(), rx: hdlRx.slice() };
  // A recording belongs to one compiled design, program, starting inputs
  // and trace level; another run of the same can be joined onto it.
  const joinKey = hdlHash([compiled.key, lvl, JSON.stringify(hdlBase)].concat(Object.values(mem.files)).join('|'));
  // Icarus's checkpoints belong to the same; anything else starts a new set.
  const ckKey = !vl && compiled.ck && !(hdlCkOff && hdlCkOff.key === compiled.key) ? joinKey : null;
  if (!ckKey) hdlCk = null;
  else if (!hdlCk || hdlCk.key !== ckKey) hdlCk = { key: ckKey, every: HDL_CK_EVERY, at: new Map() };

  // A replay prints only from the first cycle its inputs differ from the
  // recording's (+TRACEFROM), and is joined on there, so only what is new
  // is parsed. Icarus's waveform is joined too, which needs the old one in
  // the same scope; Verilator's covers its own window.
  const vcdScope = hdlDumpVcd ? (hdlWaveTop ? 'top' : 'all') : null;
  let joinAt = 0;
  if (!opts.fresh && hdlTrace && hdlTrace.joinKey === joinKey && hdlTrace.timeline &&
      (vl || !hdlDumpVcd || (hdlLastVcd && hdlTrace.vcdScope === vcdScope))) {
    const diff = hdlTimelineDiff(hdlTrace.timeline, timeline);
    if (hdlCk) for (const k of [...hdlCk.at.keys()]) if (k >= diff) hdlCk.at.delete(k);
    const c = Math.min(diff, hdlTrace.budget, budget);
    if (c > (hdlTrace.base ? hdlTrace.base.cyc : 0)) joinAt = c;
  }
  // It starts from the newest checkpoint that leaves some of the recording
  // before the join to check the replay against, or from reset.
  const vlCkOn = () => !!(vl && compiled.vlCk && hdlVlCkOff !== compiled.key);
  let ck = null;
  if (joinAt && vl && vlCkOn()) {
    ck = hdlVlCkPick(hdlTrace, joinKey, Math.min(joinAt - HDL_CK_VERIFY,
      hdlDumpVcd && budget > HDL_VCD_WINDOW ? budget - HDL_VCD_WINDOW : Infinity));
  } else if (joinAt && hdlCk) {
    let best = -1;
    for (const k of hdlCk.at.keys()) if (k <= joinAt - HDL_CK_VERIFY && k < budget && k > best) best = k;
    if (best > 0) ck = Object.assign({ k: best }, hdlCk.at.get(best));
  }
  const vlKept = joinAt && vlCkOn() && hdlTrace.vlCks ? hdlTrace.vlCks.filter(c => c.k <= joinAt - HDL_CK_VERIFY) : [];
  // A run from a checkpoint prints nothing before it anyway.
  const args = c => (joinAt && !c ? ['+TRACEFROM=' + joinAt] : [])
    .concat(vlCkOn() ? ['+CKEVERY=' + HDL_VL_CK_EVERY] : []);

  if (!opts.chunk) hdlStatus(ck ? 'simulating cycles ' + ck.k + ' to ' + budget + '...'
    : 'simulating ' + budget + ' cycles...', 'busy');
  const t0 = performance.now();
  let s = await hdlRunVvp(budget, lvl, mem.files, ck, args(ck));
  if (epoch !== hdlEpoch) return null;
  if (ck) {
    const lo = hdlCheckFrom(hdlTrace, ck.k), hi = joinAt - 2;
    const a = hdlJoinSplit(joinAt).feed(s.out + '\n');
    if (hdlJoinCheck(hdlRecordList(hdlTrace, lo, hi), a.over, lo, hi)) {
      s.out = a.main;
      s.vcd = !s.vcd ? null : vl ? hdlShiftVcd(s.vcd, ck.k) : hdlVcdJoin(hdlLastVcd, s.vcd, ck.k);
    } else {
      if (vl) hdlVlCkFailed(ck.k, compiled.key);
      else {
        hdlCkOff = { key: compiled.key };
        hdlCk = null;
        hdlLog('A replay from the checkpoint at cycle ' + ck.k + ' did not match the run it ' +
          'replaced, so this design holds state the checkpoints do not save. Checkpoints are off ' +
          'for these sources; this run, and every later one, starts from reset.', 'warn');
      }
      hdlStatus('simulating ' + budget + ' cycles...', 'busy');
      ck = null;
      s = await hdlRunVvp(budget, lvl, mem.files, null, args(null));
      if (epoch !== hdlEpoch) return null;
    }
  }
  if (hdlCk) hdlCkAdd(s.ck);
  const out = s.out, vcd = s.vcd || null;
  const t1 = performance.now();

  // The post-synthesis check compares a whole run from reset.
  hdlLastRtlOut = joinAt ? null : out;
  let t;
  if (joinAt) {
    // A run following its own end goes on from where the page last
    // showed it, when that is before the join.
    const mark = hdlSeekMark && hdlSeekMark.trace === hdlTrace ? hdlSeekMark : null;
    const pre = hdlTrace.pre.length;
    const cut = hdlCutTrace(hdlTrace, joinAt);
    const ls = mark && cut.steps[mark.idx - 1];
    const keep = mark && cut.steps.length && mark.idx <= cut.steps.length && cut.pre.length === pre &&
      (!ls || !mark.tail || (ls.regw.length >= mark.tail[0] && ls.memw.length >= mark.tail[1] &&
                             ls.per.length >= mark.tail[2] && (ls.acks || 0) >= mark.tail[3]));
    const p = hdlTraceParser(cut);
    p.feed(out);
    t = p.finish();
    if (keep) hdlSeekMark = Object.assign({}, mark, { trace: t });
  } else {
    t = hdlParseTrace(out);
  }
  t.budget = budget;
  t.regBank = compiled.regBank;
  t.timeline = timeline;
  t.joinKey = joinKey;
  t.vlCks = vlCkOn() ? hdlVlCkMerge(vlKept, s.ck) : null;
  t.vcdScope = vcd ? vcdScope : null;
  hdlTrace = t;
  if (vl) hdlTrimTrace(t);
  hdlLastVcd = vl ? vcd : hdlVcdDoc(vcd);
  refreshDownloadMenu();

  if (hdlSynthEnabled && !opts.quiet && hdlLastRtlOut) {
    try {
      await hdlPostSynthCheck(out, budget, lvl, mem.files);
    } catch (e) {
      hdlLog(String(e && e.message ? e.message : e), 'err');
      setStatus('Post-synthesis check failed - see the console', 'error');
    }
  }

  if (!opts.quiet) {
    const noise = /\$readmemh\(AA_(IROM|DMEM)\.mem\): Not enough words/;
    const filtered = String(t.newOutput || '').split('\n').filter(l => l.trim() && !noise.test(l)).join('\n');
    if (filtered.trim()) hdlLog(filtered, 'out');
    hdlLog('simulate ' + (t1 - t0).toFixed(0) + ' ms, ' + hdlRunSummary(t, budget) +
      (t.regBank ? ', registers via ' + t.regBank : ', registers unavailable'), 'sys');
  }
  return t;
}
