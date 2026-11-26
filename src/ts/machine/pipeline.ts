// The 5-stage pipeline: Fetch, Decode, Execute, Memory and Writeback, with
// the D, E, M and W registers between them and a hazard unit that forwards,
// stalls and flushes. Values really travel through the stage registers and
// the hazard unit's equations are evaluated every cycle, so turning a switch
// off gives the answer that hardware would give rather than a warning.
// cpu.pc is PCF.
//
// The decoder is the single-cycle one (control.ts): an ALUSrcA mux ahead of
// the ALU and a base mux on the target adder carry lui, auipc, jal and jalr,
// so all of RV32IM runs. mul/div take one cycle in Execute. Anything else
// (FP, atomics, ecall, fence) waits in Decode for the stages ahead to drain
// and is then executed there by the functional model, the way a trap would
// serialise it.

import { aluCompute, ctlBit, DECODER_TABLE, extendImm, pcLogic, type AluFlags } from './control';
import { decodeAndExecute, mulh, mulhsu, mulhu } from './execute';
import { host } from './host';
import { readMem, readMemSigned, writeMem } from './memory';
import { cpu, layout, run } from './state';

// An instruction as Decode sees it. A serial one is not implemented by the
// datapath and carries no control signals; every other carries all of them.
interface DecodedFields { op: number; f3: number; rs1: number; rs2: number; rd: number }
interface SerialDecoded extends DecodedFields { serial: true }
interface ControlDecoded extends DecodedFields {
  serial?: false;
  RegWrite: boolean; MemtoReg: boolean; MemWrite: boolean;
  PCS: string; ALUSrcA: string; ALUSrcB: string; ImmSrc: string;
  ALUControl: number;
  mOp?: number;          // funct3 of a mul/div
  extImm: number;
}
export type Decoded = SerialDecoded | ControlDecoded;

interface StageD { seq: number; pc: number; instr: number; dec: Decoded }
interface StageE {
  seq: number; pc: number; instr: number;
  RegWrite: boolean; MemtoReg: boolean; MemWrite: boolean; PCS: string;
  ALUControl: number; ALUSrcA: string; ALUSrcB: string; mOp?: number; f3: number;
  rs1: number; rs2: number; rd: number; rd1: number; rd2: number; extImm: number;
}
interface StageM {
  seq: number; pc: number; instr: number; RegWrite: boolean; MemtoReg: boolean; MemWrite: boolean;
  rd: number; rs2: number; f3: number; aluResult: number; writeData: number;
}
interface StageW {
  seq: number; pc: number; instr: number; RegWrite: boolean; MemtoReg: boolean;
  rd: number; aluResult: number; readData: number;
}

// One cycle of the timeline: which instruction was in each stage, and what
// the hazard unit did. Linked newest first, and cut at PIPE_TRACE_KEEP.
interface TraceNode {
  cyc: number;
  st: ({ seq: number; pc: number } | null)[];
  stall: boolean; flushD: boolean; flushE: boolean; miss: boolean; serial: boolean;
  prev: TraceNode | null; n: number;
}

export interface PipeRegs {
  D: StageD | null; E: StageE | null; M: StageM | null; W: StageW | null;
  seqF: number;          // sequence number the next fetched instruction gets
  exited: boolean;
  trace: TraceNode | null;
  mispredicts: number;
  bht: { pr: Uint8Array; bta: Uint32Array };
}

// Every signal of one cycle, as pipeEvaluate works them out.
export interface Signals {
  pcF: number; instrF: number; pcIn: number;
  resultW: number; wrW: boolean;
  forwardM: boolean; writeDataM: number; readDataM: number;
  forwardAE: string; forwardBE: string; pcSrc: string; pcSrcE: boolean; redirect: boolean;
  srcAfwd?: number; writeDataE?: number; srcA?: number; srcB?: number;
  flags?: AluFlags; aluResultE?: number | null; target?: number;
  prPCSrcF?: boolean; prBTAF?: number; pcPlus4F?: number; predPCF?: number;
  brMiss?: boolean; btaMiss?: boolean; mispredict?: boolean;
  prPCSrcE?: boolean; prBTAE?: number; pcNextE?: number;
  forward1D?: boolean; forward2D?: boolean; rd1D?: number; rd2D?: number;
  lwStall: boolean; drain: boolean; serialExec: boolean;
  stallF: boolean; stallD: boolean; flushD: boolean; flushE: boolean;
}

export const PIPE_HAZ_DEFAULT = { fwdE: true, fwdD: true, fwdM: true, lwStall: true, flush: true };

export const PIPE_TRACE_KEEP = 256;

// Branch prediction: a BHT indexed by PC[k+1:2], untagged, read in Fetch
// before anything is decoded, so every instruction gets a prediction.
// Each entry holds a predicted PCSrc (one bit, or a 2-bit saturating
// counter whose top bit is the prediction) and a predicted target. A
// second read port at PCE gives Execute the prediction its instruction
// was fetched with: the table is written only when that instruction
// mispredicts, which flushes everything younger, and a counter's step
// on a correct prediction never flips its top bit.
export const PIPE_BP_DEFAULT = { on: false, bits: 1, entries: 16 };

// The microarchitecture the JS engine models and the pipeline's state.
export const pipeline = {
  arch: 'single' as 'single' | 'multi' | 'pipe',
  on: false,                                   // arch === 'pipe'
  hazards: { ...PIPE_HAZ_DEFAULT } as Record<keyof typeof PIPE_HAZ_DEFAULT, boolean>,
  predictor: { ...PIPE_BP_DEFAULT },
  regs: null as unknown as PipeRegs,           // set by pipeReset
  stmtLine: -1,                                // the statement a pipelined Step is finishing
};

export function pipeReset(): void {
  const n = pipeline.predictor.entries;
  pipeline.regs = { D: null, E: null, M: null, W: null, seqF: 1, exited: false, trace: null, mispredicts: 0,
           bht: { pr: new Uint8Array(n), bta: new Uint32Array(n) } };
}

export function pipeBhtIndex(addr: number): number { return (addr >>> 2) & (pipeline.predictor.entries - 1); }
export function pipeBhtTaken(i: number): boolean { return pipeline.predictor.bits === 2 ? pipeline.regs.bht.pr[i] >= 2 : pipeline.regs.bht.pr[i] === 1; }

// Decode stage: the single-cycle decoder's row, plus what the stage
// registers carry. `serial` marks an instruction the datapath does not
// implement. MemtoReg is 0 wherever the table has x: the hazard unit
// reads it as "this is a load".
export function pipeDecode(instr: number): Decoded {
  const op = instr & 0x7F, f3 = (instr >>> 12) & 7, f7 = instr >>> 25;
  const base = { op, f3, rs1: (instr >>> 15) & 31, rs2: (instr >>> 20) & 31, rd: (instr >>> 7) & 31 };
  const row = DECODER_TABLE[op];
  const badWidth = (op === 0x03 && (f3 === 3 || f3 >= 6)) || (op === 0x23 && f3 >= 3);
  if (!row || badWidth) return { ...base, serial: true };
  let ALUControl: number;
  if (op === 0x33) ALUControl = (f3 << 1) | ((f7 >>> 5) & 1);
  else if (op === 0x13) ALUControl = (f3 << 1) | (f3 === 5 ? (instr >>> 30) & 1 : 0);
  else if (op === 0x63) ALUControl = 0b0001;
  else ALUControl = 0b0000;
  const imm = extendImm(instr, row.ImmSrc);
  return {
    ...base,
    RegWrite: row.RegWrite === '1', MemtoReg: row.MemtoReg === '1', MemWrite: row.MemWrite === '1',
    PCS: row.PCS, ALUSrcA: row.ALUSrcA, ALUSrcB: row.ALUSrcB, ImmSrc: row.ImmSrc,
    ALUControl,
    mOp: op === 0x33 && f7 === 0x01 ? f3 : undefined,
    extImm: imm === null ? 0 : imm,
  };
}

// Which source registers an instruction really reads. A store's rs2 is
// left out: the mem-mem copy (ForwardM) supplies it.
export function pipeUsesRs1(d: Decoded): boolean { return d.op !== 0x37 && d.op !== 0x17 && d.op !== 0x6F; }
export function pipeUsesRs2(d: Decoded): boolean { return d.op === 0x33 || d.op === 0x63; }

export function pipeMulDiv(a: number, b: number, f3: number): number {
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

export function pipeLoad(addr: number, f3: number, peek: boolean): number {
  switch (f3) {
    case 0: return readMemSigned(addr, 1, peek) >>> 0;
    case 1: return readMemSigned(addr, 2, peek) >>> 0;
    case 4: return readMem(addr, 1, peek) >>> 0;
    case 5: return readMem(addr, 2, peek) >>> 0;
    default: return readMem(addr, 4, peek) >>> 0;
  }
}

export function pipeStore(addr: number, val: number, f3: number): void {
  if (f3 === 0) writeMem(addr, val & 0xFF, 1);
  else if (f3 === 1) writeMem(addr, val & 0xFFFF, 2);
  else writeMem(addr, val | 0, 4);
}

// Every signal of the cycle about to be clocked, from the stage
// registers as they stand. Nothing here changes state: a load's data is
// peeked, and read for real by pipeClock.
export function pipeEvaluate(): Signals {
  const H = pipeline.hazards, { D, E, M, W } = pipeline.regs;
  const s = { pcF: cpu.pc >>> 0 } as Signals;
  s.instrF = readMem(s.pcF, 4, true) >>> 0;

  s.resultW = W ? (W.MemtoReg ? W.readData : W.aluResult) : 0;
  s.wrW = !!(W && W.RegWrite && W.rd !== 0);

  s.forwardM = !!(H.fwdM && M && W && M.MemWrite && W.MemtoReg && W.rd !== 0 && M.rs2 === W.rd);
  s.writeDataM = M ? (s.forwardM ? s.resultW : M.writeData) : 0;
  s.readDataM = M && M.MemtoReg ? pipeLoad(M.aluResult, M.f3, true) : 0;

  const fwd = (rs: number) => {
    if (!H.fwdE) return '00';
    if (M && M.RegWrite && M.rd !== 0 && rs === M.rd) return '10';
    if (s.wrW && rs === W!.rd) return '01';
    return '00';
  };
  s.forwardAE = s.forwardBE = '00';
  s.pcSrc = '00';
  if (E) {
    s.forwardAE = fwd(E.rs1);
    s.forwardBE = fwd(E.rs2);
    const pick = (sel: string, rf: number) => sel === '10' ? M!.aluResult : sel === '01' ? s.resultW : rf;
    s.srcAfwd = pick(s.forwardAE, E.rd1) >>> 0;
    s.writeDataE = pick(s.forwardBE, E.rd2) >>> 0;
    s.srcA = (ctlBit(E.ALUSrcA, 0) === '1' ? (ctlBit(E.ALUSrcA, 1) === '1' ? E.pc : 0) : s.srcAfwd) >>> 0;
    s.srcB = (ctlBit(E.ALUSrcB, 0) === '1' ? (ctlBit(E.ALUSrcB, 1) === '1' ? E.extImm : 4) : s.writeDataE) >>> 0;
    const alu = aluCompute(s.srcA, s.srcB, E.ALUControl);
    s.flags = alu.flags;
    s.aluResultE = E.mOp !== undefined ? pipeMulDiv(s.srcA, s.srcB, E.mOp) : alu.result;
    s.pcSrc = pcLogic(E.PCS, E.f3, alu.flags);
    const target = ((s.pcSrc === '11' ? s.srcAfwd : E.pc) + E.extImm) >>> 0;
    s.target = s.pcSrc === '11' ? (target & ~1) >>> 0 : target;
  }
  s.pcSrcE = s.pcSrc !== '00';

  // Prediction in Fetch, and in Execute whether it was right. PCNextE is
  // what the adder makes of E's instruction: its target if it jumps, its
  // PC + 4 if not, so it is also the PC to recover to.
  s.redirect = s.pcSrcE;
  if (pipeline.predictor.on) {
    const iF = pipeBhtIndex(s.pcF);
    s.prPCSrcF = pipeBhtTaken(iF);
    s.prBTAF = pipeline.regs.bht.bta[iF];
    s.pcPlus4F = (s.pcF + 4) >>> 0;
    s.predPCF = s.prPCSrcF ? s.prBTAF : s.pcPlus4F;
    s.brMiss = s.btaMiss = s.mispredict = false;
    if (E) {
      const iE = pipeBhtIndex(E.pc);
      s.prPCSrcE = pipeBhtTaken(iE);
      s.prBTAE = pipeline.regs.bht.bta[iE];
      s.pcNextE = s.pcSrcE ? s.target : (E.pc + 4) >>> 0;
      s.brMiss = s.prPCSrcE !== s.pcSrcE;
      s.btaMiss = s.pcSrcE && s.prBTAE !== s.target;
      s.mispredict = s.brMiss || s.btaMiss;
    }
    s.redirect = s.mispredict;
  }

  if (D) {
    const d = D.dec;
    s.forward1D = !!(H.fwdD && s.wrW && d.rs1 === W!.rd);
    s.forward2D = !!(H.fwdD && s.wrW && d.rs2 === W!.rd);
    s.rd1D = s.forward1D ? s.resultW : cpu.regs[d.rs1] >>> 0;
    s.rd2D = s.forward2D ? s.resultW : cpu.regs[d.rs2] >>> 0;
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
  if (pipeline.predictor.on) s.pcIn = s.mispredict ? s.pcNextE! : s.predPCF!;
  else s.pcIn = s.pcSrcE ? s.target! : (s.pcF + 4) >>> 0;
  return s;
}

// The clock edge: the register file, the data memory and every stage
// register take their new values together.
export function pipeClock(s: Signals): void {
  const p = pipeline.regs, { D, E, M, W } = p;
  const stage = (r: { seq: number; pc: number } | null) => r ? { seq: r.seq, pc: r.pc } : null;
  const node = {
    cyc: cpu.totalCycles,
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

  cpu.totalCycles++;
  cpu.lastChangedReg = -1;
  if (s.wrW && W) { cpu.regs[W.rd] = s.resultW | 0; cpu.lastChangedReg = W.rd; }
  if (W) cpu.instructionCount++;

  if (pipeline.predictor.on && E) {
    const i = pipeBhtIndex(E.pc), bht = p.bht;
    if (pipeline.predictor.bits === 2) bht.pr[i] = s.pcSrcE ? Math.min(3, bht.pr[i] + 1) : Math.max(0, bht.pr[i] - 1);
    else if (s.brMiss) bht.pr[i] = s.pcSrcE ? 1 : 0;
    if (s.btaMiss) bht.bta[i] = s.target!;
    if (s.mispredict) p.mispredicts++;
  }

  let readData = 0;
  if (M && M.MemtoReg) readData = pipeLoad(M.aluResult, M.f3, false);
  if (M && M.MemWrite) pipeStore(M.aluResult, s.writeDataM, M.f3);

  let redirect = null;
  if (s.serialExec && D) {
    const instr = D.instr;
    const exiting = D.dec.op === 0x73 && D.dec.f3 === 0 && (instr >>> 20) === 0 &&
      (cpu.regs[17] === 10 || cpu.regs[17] === 93);
    cpu.lastExecutedRd = -1;
    const next = decodeAndExecute(instr, D.pc) >>> 0;
    cpu.regs[0] = 0;
    cpu.instructionCount++;
    if (cpu.lastExecutedRd > 0) cpu.lastChangedReg = cpu.lastExecutedRd;
    if (exiting) p.exited = true;
    // Predicted, the instruction behind it may be on a wrong path that
    // Execute will never check, since this one does not get there.
    if (next !== ((D.pc + 4) >>> 0) || pipeline.predictor.on) redirect = next;
  }

  const newW = M ? { seq: M.seq, pc: M.pc, instr: M.instr, RegWrite: M.RegWrite, MemtoReg: M.MemtoReg,
    rd: M.rd, aluResult: M.aluResult, readData } : null;
  const newM = E ? { seq: E.seq, pc: E.pc, instr: E.instr, RegWrite: E.RegWrite, MemtoReg: E.MemtoReg,
    MemWrite: E.MemWrite, rd: E.rd, rs2: E.rs2, f3: E.f3,
    aluResult: s.aluResultE ?? 0, writeData: s.writeDataE! } : null;
  let newE: StageE | null = null;
  if (D && !s.flushE && !D.dec.serial) {
    const d = D.dec;
    newE = { seq: D.seq, pc: D.pc, instr: D.instr,
      RegWrite: d.RegWrite, MemtoReg: d.MemtoReg, MemWrite: d.MemWrite, PCS: d.PCS,
      ALUControl: d.ALUControl, ALUSrcA: d.ALUSrcA, ALUSrcB: d.ALUSrcB, mOp: d.mOp, f3: d.f3,
      rs1: d.rs1, rs2: d.rs2, rd: d.rd, rd1: s.rd1D!, rd2: s.rd2D!, extImm: d.extImm };
  }
  let newD: StageD | null;
  if (s.stallD) newD = D;
  else if (s.flushD || redirect !== null) newD = null;
  else newD = s.instrF ? { seq: p.seqF, pc: s.pcF, instr: s.instrF, dec: pipeDecode(s.instrF) } : null;
  // Only a drain can stall alongside a redirect (with the flush switch
  // off); the redirect still wins the PC.
  const loadPC = !s.stallF || s.redirect;
  if (loadPC) p.seqF++;
  if (redirect !== null) cpu.pc = redirect;
  else if (loadPC) cpu.pc = s.pcIn;

  p.D = newD; p.E = newE; p.M = newM; p.W = newW;
}

export function pipeStep(): Signals {
  const s = pipeEvaluate();
  pipeClock(s);
  host.clockTicked();
  return s;
}

export function pipeEmpty(): boolean { return !pipeline.regs.D && !pipeline.regs.E && !pipeline.regs.M && !pipeline.regs.W; }

// Statement Stepping, pipelined: clock until every instruction of the
// current statement has left Write-back, which is when its results show.
// The statement is the oldest instruction's. After that only W, M and E
// are looked at, since whatever is in D or F may yet be flushed.
export function pipeStatementStep(): Signals | null {
  const lineOf = (r: { pc: number } | null) => r ? host.sourceLine(r.pc) : -1;
  const oldest = () => pipeline.regs.W || pipeline.regs.M || pipeline.regs.E;
  const first = oldest() || pipeline.regs.D;
  pipeline.stmtLine = first ? lineOf(first) : host.sourceLine(cpu.pc);
  if (pipeline.stmtLine <= 0) return pipeStep();
  let sig = null, retired = false;
  for (let n = 0; n < 10000; n++) {
    if (lineOf(pipeline.regs.W) === pipeline.stmtLine) retired = true;
    sig = pipeStep();
    if (pipeDone()) break;
    const next = oldest();
    if (retired && next && lineOf(next) !== pipeline.stmtLine) break;
    const e = lineOf(pipeline.regs.E);
    if (e > 0 && e !== pipeline.stmtLine && run.breakpoints.has(e)) break;
  }
  return sig;
}

// Finished once the exit call has run, or once everything in flight has
// left and the PC points at no instruction.
export function pipeDone(): boolean {
  if (pipeline.regs.exited) return true;
  if (!pipeEmpty()) return false;
  const u = cpu.pc >>> 0;
  if (u < (layout.baseAddress >>> 0) || u >= (layout.mmioBase >>> 0)) return true;
  return host.sourceLine(cpu.pc) === -1 && readMem(u, 4, true) === 0;
}

// Stage registers are never changed once built, so a shallow copy is a
// snapshot of them; the BHT is written in place and is copied whole.
export function pipeSnapshot(): PipeRegs { return pipeCopy(pipeline.regs); }
export function pipeRestore(snap: PipeRegs): void { pipeline.regs = pipeCopy(snap); }
export function pipeCopy(p: PipeRegs): PipeRegs {
  return Object.assign({}, p, { bht: { pr: p.bht.pr.slice(), bta: p.bht.bta.slice() } });
}

// One line for the log: what the hazard unit did this cycle.
export function pipeEvents(s: Signals): string {
  const ev = [];
  if (s.lwStall) ev.push('load-use stall');
  if (s.drain) ev.push('draining for a serial instruction');
  if (s.serialExec) ev.push('serial instruction executed in Decode');
  if (pipeline.predictor.on) {
    if (s.mispredict) ev.push('mispredicted, PC to 0x' + s.pcNextE!.toString(16) + (s.flushD ? ', D and E flushed' : ', no flush'));
    if (s.prPCSrcF) ev.push('F predicted taken to 0x' + s.prBTAF!.toString(16));
  } else if (s.pcSrcE) {
    ev.push('taken to 0x' + s.target!.toString(16) + (s.flushD ? ', D and E flushed' : ', no flush'));
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
