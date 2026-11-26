// @ts-nocheck
// ================================================================
// The 5-stage pipeline: Fetch, Decode, Execute, Memory and Writeback,
// with the D, E, M and W registers between them and a hazard unit that
// forwards, stalls and flushes. Values really travel through the stage
// registers and the hazard unit's equations are evaluated every cycle,
// so turning a switch off gives the answer that hardware would give
// rather than a warning. `pc` is PCF.
//
// The decoder is the single-cycle one: an ALUSrcA mux ahead of the ALU
// and a base mux on the target adder carry lui, auipc, jal and jalr, so
// all of RV32IM runs. mul/div take one cycle in Execute. Anything else
// (FP, atomics, ecall, fence) waits in Decode for the stages ahead to
// drain and is then executed there by the functional model, the way a
// trap would serialise it.
// ================================================================
let jsArch = 'single';      // 'single' | 'multi' | 'pipe'
let pipeMode = false;       // jsArch === 'pipe'
const PIPE_HAZ_DEFAULT = { fwdE: true, fwdD: true, fwdM: true, lwStall: true, flush: true };
let pipeHaz = Object.assign({}, PIPE_HAZ_DEFAULT);
let pipe = null;
const PIPE_TRACE_KEEP = 256;

// Branch prediction: a BHT indexed by PC[k+1:2], untagged, read in Fetch
// before anything is decoded, so every instruction gets a prediction.
// Each entry holds a predicted PCSrc (one bit, or a 2-bit saturating
// counter whose top bit is the prediction) and a predicted target. A
// second read port at PCE gives Execute the prediction its instruction
// was fetched with: the table is written only when that instruction
// mispredicts, which flushes everything younger, and a counter's step
// on a correct prediction never flips its top bit.
const PIPE_BP_DEFAULT = { on: false, bits: 1, entries: 16 };
let pipeBP = Object.assign({}, PIPE_BP_DEFAULT);

function pipeReset() {
  const n = pipeBP.entries;
  pipe = { D: null, E: null, M: null, W: null, seqF: 1, exited: false, trace: null, mispredicts: 0,
           bht: { pr: new Uint8Array(n), bta: new Uint32Array(n) } };
}

function pipeBhtIndex(addr) { return (addr >>> 2) & (pipeBP.entries - 1); }
function pipeBhtTaken(i) { return pipeBP.bits === 2 ? pipe.bht.pr[i] >= 2 : pipe.bht.pr[i] === 1; }

// Decode stage: the single-cycle decoder's row, plus what the stage
// registers carry. `serial` marks an instruction the datapath does not
// implement. MemtoReg is 0 wherever the table has x: the hazard unit
// reads it as "this is a load".
function pipeDecode(instr) {
  const op = instr & 0x7F, f3 = (instr >>> 12) & 7, f7 = instr >>> 25;
  const d = { op, f3, rs1: (instr >>> 15) & 31, rs2: (instr >>> 20) & 31, rd: (instr >>> 7) & 31 };
  const row = DP_CONTROL[op];
  const badWidth = (op === 0x03 && (f3 === 3 || f3 >= 6)) || (op === 0x23 && f3 >= 3);
  if (!row || badWidth) { d.serial = true; return d; }
  d.RegWrite = row.RegWrite === '1';
  d.MemtoReg = row.MemtoReg === '1';
  d.MemWrite = row.MemWrite === '1';
  d.PCS = row.PCS; d.ALUSrcA = row.ALUSrcA; d.ALUSrcB = row.ALUSrcB; d.ImmSrc = row.ImmSrc;
  if (op === 0x33) d.ALUControl = (f3 << 1) | ((f7 >>> 5) & 1);
  else if (op === 0x13) d.ALUControl = (f3 << 1) | (f3 === 5 ? (instr >>> 30) & 1 : 0);
  else if (op === 0x63) d.ALUControl = 0b0001;
  else d.ALUControl = 0b0000;
  if (op === 0x33 && f7 === 0x01) d.mOp = f3;
  const imm = dpExtend(instr, row.ImmSrc);
  d.extImm = imm === null ? 0 : imm;
  return d;
}

// Which source registers an instruction really reads. A store's rs2 is
// left out: the mem-mem copy (ForwardM) supplies it.
function pipeUsesRs1(d) { return d.op !== 0x37 && d.op !== 0x17 && d.op !== 0x6F; }
function pipeUsesRs2(d) { return d.op === 0x33 || d.op === 0x63; }

function pipeMulDiv(a, b, f3) {
  const sa = a | 0, sb = b | 0;
  switch (f3) {
    case 0: return Math.imul(sa, sb) >>> 0;
    case 1: return mulh(sa, sb) >>> 0;
    case 2: return mulhsu(sa, sb) >>> 0;
    case 3: return mulhu(a, b) >>> 0;
    case 4: return (sb === 0 ? -1 : Math.trunc(sa / sb) | 0) >>> 0;
    case 5: return (b === 0 ? -1 : Math.trunc(a / b)) >>> 0;
    case 6: return (sb === 0 ? sa : (sa % sb) | 0) >>> 0;
    default: return (b === 0 ? a : a % b) >>> 0;
  }
}

function pipeLoad(addr, f3, peek) {
  switch (f3) {
    case 0: return readMemSigned(addr, 1, peek) >>> 0;
    case 1: return readMemSigned(addr, 2, peek) >>> 0;
    case 4: return readMem(addr, 1, peek) >>> 0;
    case 5: return readMem(addr, 2, peek) >>> 0;
    default: return readMem(addr, 4, peek) >>> 0;
  }
}

function pipeStore(addr, val, f3) {
  if (f3 === 0) writeMem(addr, val & 0xFF, 1);
  else if (f3 === 1) writeMem(addr, val & 0xFFFF, 2);
  else writeMem(addr, val | 0, 4);
}

// Every signal of the cycle about to be clocked, from the stage
// registers as they stand. Nothing here changes state: a load's data is
// peeked, and read for real by pipeClock.
function pipeEvaluate() {
  const H = pipeHaz, { D, E, M, W } = pipe;
  const s = { pcF: pc >>> 0 };
  s.instrF = readMem(s.pcF, 4, true) >>> 0;

  s.resultW = W ? (W.MemtoReg ? W.readData : W.aluResult) : 0;
  s.wrW = !!(W && W.RegWrite && W.rd !== 0);

  s.forwardM = !!(H.fwdM && M && W && M.MemWrite && W.MemtoReg && W.rd !== 0 && M.rs2 === W.rd);
  s.writeDataM = M ? (s.forwardM ? s.resultW : M.writeData) : 0;
  s.readDataM = M && M.MemtoReg ? pipeLoad(M.aluResult, M.f3, true) : 0;

  const fwd = rs => {
    if (!H.fwdE) return '00';
    if (M && M.RegWrite && M.rd !== 0 && rs === M.rd) return '10';
    if (s.wrW && rs === W.rd) return '01';
    return '00';
  };
  s.forwardAE = s.forwardBE = '00';
  s.pcSrc = '00';
  if (E) {
    s.forwardAE = fwd(E.rs1);
    s.forwardBE = fwd(E.rs2);
    const pick = (sel, rf) => sel === '10' ? M.aluResult : sel === '01' ? s.resultW : rf;
    s.srcAfwd = pick(s.forwardAE, E.rd1) >>> 0;
    s.writeDataE = pick(s.forwardBE, E.rd2) >>> 0;
    s.srcA = (dpBit(E.ALUSrcA, 0) === '1' ? (dpBit(E.ALUSrcA, 1) === '1' ? E.pc : 0) : s.srcAfwd) >>> 0;
    s.srcB = (dpBit(E.ALUSrcB, 0) === '1' ? (dpBit(E.ALUSrcB, 1) === '1' ? E.extImm : 4) : s.writeDataE) >>> 0;
    const alu = dpAlu(s.srcA, s.srcB, E.ALUControl);
    s.flags = alu.flags;
    s.aluResultE = E.mOp !== undefined ? pipeMulDiv(s.srcA, s.srcB, E.mOp) : alu.result;
    s.pcSrc = dpPcSrc(E.PCS, E.f3, alu.flags);
    const target = ((s.pcSrc === '11' ? s.srcAfwd : E.pc) + E.extImm) >>> 0;
    s.target = s.pcSrc === '11' ? (target & ~1) >>> 0 : target;
  }
  s.pcSrcE = s.pcSrc !== '00';

  // Prediction in Fetch, and in Execute whether it was right. PCNextE is
  // what the adder makes of E's instruction: its target if it jumps, its
  // PC + 4 if not, so it is also the PC to recover to.
  s.redirect = s.pcSrcE;
  if (pipeBP.on) {
    const iF = pipeBhtIndex(s.pcF);
    s.prPCSrcF = pipeBhtTaken(iF);
    s.prBTAF = pipe.bht.bta[iF];
    s.pcPlus4F = (s.pcF + 4) >>> 0;
    s.predPCF = s.prPCSrcF ? s.prBTAF : s.pcPlus4F;
    s.brMiss = s.btaMiss = s.mispredict = false;
    if (E) {
      const iE = pipeBhtIndex(E.pc);
      s.prPCSrcE = pipeBhtTaken(iE);
      s.prBTAE = pipe.bht.bta[iE];
      s.pcNextE = s.pcSrcE ? s.target : (E.pc + 4) >>> 0;
      s.brMiss = s.prPCSrcE !== s.pcSrcE;
      s.btaMiss = s.pcSrcE && s.prBTAE !== s.target;
      s.mispredict = s.brMiss || s.btaMiss;
    }
    s.redirect = s.mispredict;
  }

  if (D) {
    const d = D.dec;
    s.forward1D = !!(H.fwdD && s.wrW && d.rs1 === W.rd);
    s.forward2D = !!(H.fwdD && s.wrW && d.rs2 === W.rd);
    s.rd1D = s.forward1D ? s.resultW : regs[d.rs1] >>> 0;
    s.rd2D = s.forward2D ? s.resultW : regs[d.rs2] >>> 0;
  }

  // Hazard unit.
  s.lwStall = !!(H.lwStall && E && E.MemtoReg && E.rd !== 0 && D && !D.dec.serial &&
    ((pipeUsesRs1(D.dec) && D.dec.rs1 === E.rd) || (pipeUsesRs2(D.dec) && D.dec.rs2 === E.rd)));
  // A serial instruction about to be flushed has nothing to wait for.
  s.drain = !!(D && D.dec.serial && (E || M || W) && !(H.flush && s.redirect));
  s.serialExec = !!(D && D.dec.serial && !E && !M && !W);
  s.stallF = s.stallD = s.lwStall || s.drain;
  s.flushD = H.flush && s.redirect;
  s.flushE = s.lwStall || s.drain || (H.flush && s.redirect);
  if (pipeBP.on) s.pcIn = s.mispredict ? s.pcNextE : s.predPCF;
  else s.pcIn = s.pcSrcE ? s.target : (s.pcF + 4) >>> 0;
  return s;
}

// The clock edge: the register file, the data memory and every stage
// register take their new values together.
function pipeClock(s) {
  const p = pipe, { D, E, M, W } = p;
  const stage = r => r ? { seq: r.seq, pc: r.pc } : null;
  const node = {
    cyc: totalCycles,
    st: [s.instrF ? { seq: p.seqF, pc: s.pcF } : null, stage(D), stage(E), stage(M), stage(W)],
    stall: s.stallD, flushD: s.flushD, flushE: s.flushE && !s.stallD, miss: !!s.mispredict,
    serial: !!s.serialExec, prev: p.trace, n: p.trace ? p.trace.n + 1 : 1,
  };
  p.trace = node;
  if (node.n % PIPE_TRACE_KEEP === 0) {
    let t = node;
    for (let i = 1; i < PIPE_TRACE_KEEP && t.prev; i++) t = t.prev;
    t.prev = null;
  }

  totalCycles++;
  lastChangedReg = -1;
  if (s.wrW) { regs[W.rd] = s.resultW | 0; lastChangedReg = W.rd; }
  if (W) instructionCount++;

  if (pipeBP.on && E) {
    const i = pipeBhtIndex(E.pc), bht = p.bht;
    if (pipeBP.bits === 2) bht.pr[i] = s.pcSrcE ? Math.min(3, bht.pr[i] + 1) : Math.max(0, bht.pr[i] - 1);
    else if (s.brMiss) bht.pr[i] = s.pcSrcE ? 1 : 0;
    if (s.btaMiss) bht.bta[i] = s.target;
    if (s.mispredict) p.mispredicts++;
  }

  let readData = 0;
  if (M && M.MemtoReg) readData = pipeLoad(M.aluResult, M.f3, false);
  if (M && M.MemWrite) pipeStore(M.aluResult, s.writeDataM, M.f3);

  let redirect = null;
  if (s.serialExec) {
    const instr = D.instr;
    const exiting = D.dec.op === 0x73 && D.dec.f3 === 0 && (instr >>> 20) === 0 &&
      (regs[17] === 10 || regs[17] === 93);
    lastExecutedRd = -1;
    const next = decodeAndExecute(instr, D.pc) >>> 0;
    regs[0] = 0;
    instructionCount++;
    if (lastExecutedRd > 0) lastChangedReg = lastExecutedRd;
    if (exiting) p.exited = true;
    // Predicted, the instruction behind it may be on a wrong path that
    // Execute will never check, since this one does not get there.
    if (next !== ((D.pc + 4) >>> 0) || pipeBP.on) redirect = next;
  }

  const newW = M ? { seq: M.seq, pc: M.pc, instr: M.instr, RegWrite: M.RegWrite, MemtoReg: M.MemtoReg,
    rd: M.rd, aluResult: M.aluResult, readData } : null;
  const newM = E ? { seq: E.seq, pc: E.pc, instr: E.instr, RegWrite: E.RegWrite, MemtoReg: E.MemtoReg,
    MemWrite: E.MemWrite, rd: E.rd, rs2: E.rs2, f3: E.f3,
    aluResult: s.aluResultE === null ? 0 : s.aluResultE, writeData: s.writeDataE } : null;
  let newE = null;
  if (D && !s.flushE && !D.dec.serial) {
    const d = D.dec;
    newE = { seq: D.seq, pc: D.pc, instr: D.instr,
      RegWrite: d.RegWrite, MemtoReg: d.MemtoReg, MemWrite: d.MemWrite, PCS: d.PCS,
      ALUControl: d.ALUControl, ALUSrcA: d.ALUSrcA, ALUSrcB: d.ALUSrcB, mOp: d.mOp, f3: d.f3,
      rs1: d.rs1, rs2: d.rs2, rd: d.rd, rd1: s.rd1D, rd2: s.rd2D, extImm: d.extImm };
  }
  let newD;
  if (s.stallD) newD = D;
  else if (s.flushD || redirect !== null) newD = null;
  else newD = s.instrF ? { seq: p.seqF, pc: s.pcF, instr: s.instrF, dec: pipeDecode(s.instrF) } : null;
  // Only a drain can stall alongside a redirect (with the flush switch
  // off); the redirect still wins the PC.
  const loadPC = !s.stallF || s.redirect;
  if (loadPC) p.seqF++;
  if (redirect !== null) pc = redirect;
  else if (loadPC) pc = s.pcIn;

  p.D = newD; p.E = newE; p.M = newM; p.W = newW;
}

function pipeStep() {
  const s = pipeEvaluate();
  pipeClock(s);
  uartClockTick();
  return s;
}

function pipeEmpty() { return !pipe.D && !pipe.E && !pipe.M && !pipe.W; }

// Statement Stepping, pipelined: clock until every instruction of the
// current statement has left Write-back, which is when its results show.
// The statement is the oldest instruction's. After that only W, M and E
// are looked at, since whatever is in D or F may yet be flushed.
let pipeStmtLine = -1;
function pipeStatementStep() {
  const lineOf = r => r ? sourceLineForPc(r.pc) : -1;
  const oldest = () => pipe.W || pipe.M || pipe.E;
  const first = oldest() || pipe.D;
  pipeStmtLine = first ? lineOf(first) : sourceLineForPc(pc);
  if (pipeStmtLine <= 0) return pipeStep();
  let sig = null, retired = false;
  for (let n = 0; n < 10000; n++) {
    if (lineOf(pipe.W) === pipeStmtLine) retired = true;
    sig = pipeStep();
    if (pipeDone()) break;
    const next = oldest();
    if (retired && next && lineOf(next) !== pipeStmtLine) break;
    const e = lineOf(pipe.E);
    if (e > 0 && e !== pipeStmtLine && breakpoints.has(e)) break;
  }
  return sig;
}

// Finished once the exit call has run, or once everything in flight has
// left and the PC points at no instruction.
function pipeDone() {
  if (pipe.exited) return true;
  if (!pipeEmpty()) return false;
  const u = pc >>> 0;
  if (u < (baseAddress >>> 0) || u >= (mmioBase >>> 0)) return true;
  return sourceLineForPc(pc) === -1 && readMem(u, 4, true) === 0;
}

// Switching microarchitecture starts the program again: a pipeline
// cannot be conjured from the middle of a single-cycle run, and the
// cycle count so far would belong to the other model.
const JS_ARCH_LOG = {
  single: 'Single-cycle: one cycle per instruction.',
  multi: 'Multi-cycle: cycles per instruction from the table in Settings.',
  pipe: '5-stage pipeline: Step and Back move one clock cycle.'
};
function setJsArch(a) {
  if (!JS_ARCH_LOG[a]) a = 'single';
  if (a === jsArch) { pipeSyncControls(); return; }
  if (running) {
    running = false;
    if (runTimerId) { clearTimeout(runTimerId); runTimerId = null; }
  }
  jsArch = a;
  pipeMode = a === 'pipe';
  resetAll();
  log(JS_ARCH_LOG[a], 'info');
  pipeSyncControls();
  if (typeof dpOnModeChange === 'function') dpOnModeChange();
  if (typeof dpOnStateChange === 'function') dpOnStateChange();
}
function pipeSetMode(on) { setJsArch(on ? 'pipe' : 'single'); }

function pipeInitControls() {
  const arch = document.getElementById('simMicroarch');
  if (arch) arch.onchange = () => setJsArch(arch.value);
  document.querySelectorAll('[data-haz]').forEach(el => {
    el.onchange = () => {
      pipeHaz[el.dataset.haz] = el.checked;
      if (typeof dpOnModeChange === 'function') dpOnModeChange();
    };
  });
  // A different predictor is different hardware: start the program again.
  const bp = (id, apply) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.onchange = () => {
      apply(el);
      if (pipeMode) {
        if (running) { running = false; if (runTimerId) { clearTimeout(runTimerId); runTimerId = null; } }
        resetAll();
      }
      pipeSyncControls();
      if (typeof dpOnModeChange === 'function') dpOnModeChange();
    };
  };
  bp('pipeBpOn', el => { pipeBP.on = el.checked; });
  bp('pipeBpBits', el => { pipeBP.bits = +el.value === 2 ? 2 : 1; });
  bp('pipeBpEntries', el => { pipeBP.entries = +el.value; });
  pipeSyncControls();
}

// The strip's ⚙: Settings, scrolled to the microarchitecture card.
function openPipeSettings() {
  openSettingsModal('simulator');
  const card = document.getElementById('simMicroarch').closest('.sim-card');
  let sc = card.parentElement;
  while (sc && sc.scrollHeight <= sc.clientHeight) sc = sc.parentElement;
  if (sc) sc.scrollTop += card.getBoundingClientRect().top - sc.getBoundingClientRect().top - 8;
}

function pipeSyncControls() {
  const arch = document.getElementById('simMicroarch');
  if (arch) arch.value = jsArch;
  const stripArch = document.getElementById('dpArch');
  if (stripArch) stripArch.value = pipeMode ? 'pipe' : 'single';
  document.querySelectorAll('[data-haz]').forEach(el => {
    el.checked = !!pipeHaz[el.dataset.haz];
  });
  const bpOn = document.getElementById('pipeBpOn');
  if (bpOn) bpOn.checked = pipeBP.on;
  [['pipeBpBits', pipeBP.bits], ['pipeBpEntries', pipeBP.entries]].forEach(([id, v]) => {
    const el = document.getElementById(id);
    if (el) { el.value = String(v); el.disabled = !pipeBP.on; }
  });
  const flushLbl = document.querySelector('[data-haz="flush"]');
  if (flushLbl && flushLbl.nextSibling) flushLbl.nextSibling.textContent = pipeBP.on ? ' Flush on misprediction' : ' Flush on taken branch';
  const box = document.getElementById('pipeHazBox');
  // Only the chosen model's settings are shown.
  if (box) box.style.display = pipeMode ? '' : 'none';
  const table = document.getElementById('cyclesTableBox');
  if (table) table.style.display = jsArch === 'multi' ? '' : 'none';
}

// Stage registers are never changed once built, so a shallow copy is a
// snapshot of them; the BHT is written in place and is copied whole.
function pipeSnapshot() { return pipeCopy(pipe); }
function pipeRestore(snap) { pipe = pipeCopy(snap); }
function pipeCopy(p) {
  return Object.assign({}, p, { bht: { pr: p.bht.pr.slice(), bta: p.bht.bta.slice() } });
}

// One line for the log: what the hazard unit did this cycle.
function pipeEvents(s) {
  const ev = [];
  if (s.lwStall) ev.push('load-use stall');
  if (s.drain) ev.push('draining for a serial instruction');
  if (s.serialExec) ev.push('serial instruction executed in Decode');
  if (pipeBP.on) {
    if (s.mispredict) ev.push('mispredicted, PC to 0x' + s.pcNextE.toString(16) + (s.flushD ? ', D and E flushed' : ', no flush'));
    if (s.prPCSrcF) ev.push('F predicted taken to 0x' + s.prBTAF.toString(16));
  } else if (s.pcSrcE) {
    ev.push('taken to 0x' + s.target.toString(16) + (s.flushD ? ', D and E flushed' : ', no flush'));
  }
  const f = [];
  if (s.forwardAE !== '00') f.push('ForwardAE=' + s.forwardAE);
  if (s.forwardBE !== '00') f.push('ForwardBE=' + s.forwardBE);
  if (s.forward1D) f.push('Forward1D');
  if (s.forward2D) f.push('Forward2D');
  if (s.forwardM) f.push('ForwardM');
  if (f.length) ev.push(f.join(' '));
  return ev.join('; ');
}
