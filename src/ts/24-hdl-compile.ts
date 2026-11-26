// @ts-nocheck
// HDL mode: the files and plusargs a run is given, and compiling the
// sources once per set.

// ================================================================
// Runtime environment handed to vvp
// ================================================================
// Input codes shared with the testbench's stim.mem decoder.
const HDL_STIM_DIP = 1, HDL_STIM_PB = 2, HDL_STIM_ACCEL = 3, HDL_STIM_ADRDY = 4;

function hdlHex32(v) { return (v >>> 0).toString(16).padStart(8, '0'); }

function hdlAccelWord() {
  return ((accelTemp & 0xFF) << 24 | (accelX & 0xFF) << 16 |
          (accelY & 0xFF) << 8 | (accelZ & 0xFF)) >>> 0;
}

// stim.mem: <cycle> <code> <value> triples, in cycle order.
function hdlStimFile() {
  const ev = hdlStim.slice().sort((a, b) => a.cycle - b.cycle);
  return ev.map(e => hdlHex32(e.cycle) + '\n' + hdlHex32(e.code) + '\n' +
                     hdlHex32(e.value)).join('\n') + (ev.length ? '\n' : '');
}

// uart_rx.mem: <cycle> <byte> pairs. A byte typed while paused carries
// the cycle it was typed at, so it arrives at that point in the run.
function hdlRxFile() {
  return hdlRx.map(e => hdlHex32(e.cycle) + '\n' + hdlHex32(e.byte & 0xFF)).join('\n') +
         (hdlRx.length ? '\n' : '');
}

// Anything waiting when a run starts is put on the timeline the testbench
// reads: the byte already in the holding register at cycle 0, then the
// PC's remaining bytes one character time apart, as they would actually
// arrive. Bytes typed later are appended by the send hook with the cycle
// they were typed at, and hdlSeek rebuilds both sides from this list -
// which is why this, not the live state, is the master record.
function hdlSyncRx() {
  const gap = uartGapInstr();
  hdlRx = [];
  if (uartRxFull) hdlRx.push({ cycle: 0, byte: uartRxByte & 0xFF });
  uartPending.forEach((b, i) => {
    hdlRx.push({ cycle: (i + (uartRxFull ? 1 : 0)) * gap, byte: b & 0xFF });
  });
}

function hdlHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

// ================================================================
// Compile, once per set of sources
// ================================================================
// Nothing program-specific reaches the Verilog, so the compiled
// binary only has to be rebuilt when the sources themselves change. Runs, steps and input edits all reuse it.
async function hdlEnsureCompiled(quiet) {
  const gen = (document.getElementById('hdlGeneration') || {}).value || '2005';
  let rb = hdlRegBankPath();
  const dbuf = hdlHasDoubleBuffer();
  const state = hdlCkState(hdlSimulator === 'verilator');
  const vl = hdlSimulator === 'verilator';
  let ck = state.off ? null : state;
  const build = () => ({
    tb: hdlBuildTestbench({ regBankPath: rb }),
    ck: ck ? hdlBuildCkModule(ck, rb, dbuf, vl) : ''
  });
  let src = build();
  const key = hdlHash(hdlSimulator + (vl && hdlWaveTop ? ' top ' : ' ') + gen + ' ' + hdlAllSources() + ' ' + src.tb + ' ' + src.ck);
  if (hdlVvpCache && hdlVvpCache.key === key) {
    if (!quiet) hdlLog('Reusing the compiled design (sources unchanged).', 'sys');
    return hdlVvpCache;
  }
  if (state.off) hdlLog('Checkpoints are off for these sources (' + state.off +
    '), so an input change replays the run from reset.', 'sys');

  if (vl) {
    for (;;) {
      const c = await hdlVerilate(src.tb, gen, src.ck);
      if (c.ok) {
        hdlReportVerilator(c.log);
        hdlVvpCache = { key: key, vvp: null, model: c.model, regBank: rb, ck: false, vlCk: !!src.ck };
        return hdlVvpCache;
      }
      if (ck && /cg3207_hdl_ck\.v/.test(c.log)) {
        hdlLog('Checkpoints could not be compiled for these sources, so an input change ' +
          'replays the run from reset.', 'sys');
        ck = null;
        src = build();
        continue;
      }
      if (rb && /cg3207_hdl_tb\.v/.test(c.log)) {
        hdlLog('Could not resolve the register-file path `' + rb + '`. ' +
          'Retrying without the architectural register view - set the path ' +
          'explicitly under Settings > Simulation to restore it.', 'warn');
        rb = null;
        src = build();
        continue;
      }
      hdlReportVerilator(c.log);
      // A failure before Verilator ran (no compiler, a failed download)
      // has no %Error line to report.
      if (!/^%Error/m.test(c.log) && !/C\+\+ compilation failed|Linking failed|No C\+\+20 compiler/.test(c.log))
        hdlLog(c.log.trim() || 'The Verilator build failed without a message.', 'err');
      hdlStatus('compile error', 'err');
      return null;
    }
  }

  for (;;) {
    hdlStatus('preprocessing...', 'busy');
    const t0 = performance.now();
    const files = hdlFiles.concat([{ name: 'cg3207_hdl_tb.v', src: src.tb }]);
    if (src.ck) files.push({ name: 'cg3207_hdl_ck.v', src: src.ck });
    const pp = await hdlPreprocess(files);
    if (pp.err && pp.err.trim()) hdlLog(pp.err, 'warn');
    hdlStatus('compiling...', 'busy');
    const t1 = performance.now();
    const c = await hdlCompile(pp.src, gen);
    const t2 = performance.now();
    if (c.vvp) {
      if (c.err && c.err.trim()) hdlLog(c.err, 'warn');
      hdlLog('preprocess ' + (t1 - t0).toFixed(0) + ' ms, compile ' + (t2 - t1).toFixed(0) + ' ms', 'sys');
      hdlVvpCache = { key: key, vvp: c.vvp, regBank: rb, ck: !!src.ck };
      return hdlVvpCache;
    }
    // The checkpoint module and the register-file path both name things
    // inside code we do not control. If either is what failed, drop it
    // and keep the design runnable rather than failing the whole run.
    if (ck && /cg3207_hdl_ck\.v/.test(c.err || '')) {
      hdlLog('Checkpoints could not be compiled for these sources, so an input change ' +
        'replays the run from reset.', 'sys');
      ck = null;
      src = build();
      continue;
    }
    if (rb) {
      hdlLog('Could not resolve the register-file path `' + rb + '`. ' +
        'Retrying without the architectural register view - set the path ' +
        'explicitly under Settings > Simulation to restore it.', 'warn');
      rb = null;
      src = build();
      continue;
    }
    hdlLog(c.err || 'Compilation failed.', 'err');
    hdlStatus('compile error', 'err');
    return null;
  }
}
