// @ts-nocheck
// The optional cross-check of an HDL run against the JavaScript
// functional model.

// Off by default: it costs a second execution of the whole program, and
// the point of HDL mode is usually to run the hardware, not to grade it.
// Compared as the architecture defines a program's effect: the order in
// which registers change and data memory is written, not instruction by
// instruction. A pipeline fetches down paths it later flushes and writes
// a result cycles after fetching it, so matching fetch PCs would fail
// every correct pipelined core. Registers start at 0 on both sides, as
// the hardware's do, so a first write of 0 is no change on either.
async function hdlCompareWithJs() {
  if (!hdlTrace || !hdlTrace.steps.length) return;
  if (hdlTrace.offset) {
    hdlLog('Cross-check: the JS model runs from reset, and this recording now starts at instruction ' +
      hdlTrace.offset + ', so the two cannot be compared. Reset and run a shorter stretch to cross-check.', 'warn');
    return;
  }
  if (!hdlTrace.regBank)
    hdlLog('Cross-check: no register-file path, so only data memory writes are compared.', 'warn');
  const at = hdlIdx;
  const dmem0 = layout.dataBase >>> 0;
  const inDmem = a => a >= dmem0 && a < dmem0 + hdlDmemBytes;
  // An input changed part-way through arrives on a clock the model does
  // not have, so the comparison ends there.
  const stop = hdlStim.length ? Math.min(...hdlStim.map(e => e.cycle)) : Infinity;

  const hwReg = [], hwMem = [];
  const hwShadow = new Int32Array(32);
  for (const s of hdlTrace.steps) {
    for (const w of s.regw) {
      const cyc = w.length > 2 ? w[2] : s.cyc;
      if (cyc >= stop || (hwShadow[w[0]] | 0) === (w[1] | 0)) continue;
      hwShadow[w[0]] = w[1] | 0;
      hwReg.push({ r: w[0], v: w[1] >>> 0, cyc });
    }
    for (const w of s.memw) {
      const cyc = w.length > 3 ? w[3] : s.cyc;
      if (cyc >= stop) continue;
      const word = (w[0] & ~3) >>> 0;
      for (let i = 0; i < 4; i++)
        if ((w[1] >> i) & 1 && inDmem(word + i)) hwMem.push({ a: word + i, v: (w[2] >>> (i * 8)) & 0xFF, cyc });
    }
  }
  const lastCyc = Math.min(stop, hdlTrace.final ? hdlTrace.final.cyc : hdlTrace.steps[hdlTrace.steps.length - 1].cyc);

  // The model, from reset, with the inputs the run started with.
  const saved = [board.dip, board.buttons, accel.x, accel.y, accel.z, accel.temp, accel.dready];
  const s8 = v => ((v & 0xFF) << 24) >> 24;
  board.dip = hdlBase.dip; board.buttons = hdlBase.pb; accel.dready = hdlBase.adrdy ? 1 : 0;
  accel.temp = s8(hdlBase.accel >>> 24); accel.x = s8(hdlBase.accel >>> 16);
  accel.y = s8(hdlBase.accel >>> 8); accel.z = s8(hdlBase.accel);
  const wasJournal = stepHistory.journalEnabled;
  stepHistory.journalEnabled = false;
  loadProgram(program.machineCode);
  programFinished = false;
  const jsReg = [], jsMem = [];
  const jsShadow = new Int32Array(32);
  let curPc = 0, fault = null;
  const baseWriteMem = writeMem;
  writeMem = function (addr, val, size) {
    const u = addr >>> 0;
    for (let i = 0; i < size; i++)
      if (inDmem(u + i)) jsMem.push({ a: (u + i) >>> 0, v: (val >>> (i * 8)) & 0xFF, pc: curPc });
    return baseWriteMem(addr, val, size);
  };
  try {
    // No core retires more than one instruction a cycle.
    for (let n = 0; n <= lastCyc && !programFinished &&
         (jsReg.length < hwReg.length || jsMem.length < hwMem.length); n++) {
      curPc = cpu.pc >>> 0;
      cpu.lastExecutedRd = -1;
      executeOne();
      const rd = cpu.lastExecutedRd;
      if (rd > 0 && (cpu.regs[rd] | 0) !== jsShadow[rd]) {
        jsShadow[rd] = cpu.regs[rd] | 0;
        jsReg.push({ r: rd, v: cpu.regs[rd] >>> 0, pc: curPc });
      }
    }
  } catch (e) {
    fault = e;
  } finally {
    writeMem = baseWriteMem;
    stepHistory.journalEnabled = wasJournal;
    [board.dip, board.buttons, accel.x, accel.y, accel.z, accel.temp, accel.dready] = saved;
  }

  const firstDiff = (hw, js, same) => {
    for (let i = 0; i < hw.length; i++)
      if (i >= js.length || !same(hw[i], js[i])) return { hw: hw[i], js: js[i] || null };
    return null;
  };
  const dr = hdlTrace.regBank ? firstDiff(hwReg, jsReg, (a, b) => a.r === b.r && a.v === b.v) : null;
  const dm = firstDiff(hwMem, jsMem, (a, b) => a.a === b.a && a.v === b.v);
  const by = d => d && d.js ? ' by the instruction at 0x' + d.js.pc.toString(16) + ' (line ' + sourceLineForPc(d.js.pc) + ')' : '';
  let msg = null;
  if (dr && (!dm || dr.hw.cyc <= dm.hw.cyc)) {
    msg = 'first difference at cycle ' + dr.hw.cyc + ': the hardware set x' + dr.hw.r + ' = 0x' + hdlHex32(dr.hw.v) +
      (dr.js ? '; the model\'s next register change is x' + dr.js.r + ' = 0x' + hdlHex32(dr.js.v) + by(dr)
             : '; the model makes no further register change');
  } else if (dm) {
    msg = 'first difference at cycle ' + dm.hw.cyc + ': the hardware wrote 0x' + dm.hw.v.toString(16).padStart(2, '0') +
      ' to 0x' + hdlHex32(dm.hw.a) +
      (dm.js ? '; the model\'s next data-memory write is 0x' + dm.js.v.toString(16).padStart(2, '0') +
               ' to 0x' + hdlHex32(dm.js.a) + by(dm)
             : '; the model writes no more data memory');
  }
  if (fault && !msg) msg = 'the functional model faulted: ' + fault.message;
  const upTo = isFinite(stop) ? ' (to cycle ' + stop + ', where an input changed)' : '';
  if (!msg) {
    hdlLog('Cross-check: your hardware matches the functional model: ' + hwReg.length + ' register changes and ' +
      hwMem.length + ' data-memory byte writes' + upTo + '.', 'sys');
    setStatus('HDL matches the functional model', 'success');
  } else {
    hdlLog('Cross-check: ' + msg + '.', 'err');
    hdlLog('If the program reads UART input, expect a divergence there: the two ' +
      'engines deliver input on different schedules. Otherwise this is where to ' +
      'start debugging your RTL.', 'warn');
    setStatus('HDL diverges from the functional model at cycle ' + ((dr && dr.hw.cyc) || (dm && dm.hw.cyc) || 0), 'error');
  }
  hdlSeek(at);
}

// A core whose register writes land after its PC has moved on: a
// pipeline, or a multi-cycle core that advances the PC in Fetch. The
// trace's steps follow the fetch PC, so each write sits in a later
// instruction's step than the one that made it.
function hdlLooksPipelined(t) {
  let n = 0, off = 0;
  for (const s of t.steps) for (const w of s.regw) { n++; if (((s.instr >>> 7) & 31) !== w[0]) off++; }
  return n >= 8 && off * 2 > n;
}
