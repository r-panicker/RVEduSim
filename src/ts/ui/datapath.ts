// ================================================================
// Datapath animation
// ================================================================
// The lecture's single-cycle datapath (Microarch.svg, embedded in
// index.html as #dpSvg), animated one phase at a time for the
// instruction at the PC, with the program's own register and memory
// values. Everything is
// computed the way the course's RV/ sources compute it - Decoder.v's
// table, Extend.v, ALU.v and PC_Logic.v - rather than taken from the
// functional model, so what the diagram shows is what that hardware
// would do. The last phase is the clock edge, and stepping past it
// executes the instruction. The pipelined drawing, the pipeline timeline
// and the strip that holds them follow, and the file ends with the
// page's boot and the functions it puts on window.

import { compileAndAssembleC } from '../c/compile';
import { cProgram } from '../c/state';
import { ABI_NAMES } from '../isa/instructions';
import { ALU_OP_NAMES, DECODER_TABLE, IMM_SRC_NAMES, aluCompute, ctlBit, extendImm, pcLogic, type AluFlags, type DecoderRow } from '../machine/control';
import { getMemByte, readMem, setMemByte, writeMem } from '../machine/memory';
import { pipeBhtIndex, pipeEvaluate, pipeline } from '../machine/pipeline';
import { cpu, layout, oled, program, run, stepHistory, ui } from '../machine/state';
import { setDisasmViewMode } from './disassembly';
import { editor, formatActiveInstructionSignature, riscvAutocomplete } from './editor';
import { editorState } from './editor-state';
import { hdlInitSources } from './engine-mode';
import { loadExample, setLanguageMode, startExampleSources, updateExampleSelectorOptions } from './examples-language';
import { closeCompilerConfigPanel, countVisit, findNextValidInstructionLine, openBpFigure, toggleBreakpoint, toggleCompilerConfigPanel } from './execution';
import { closeFindReplace, findNext, findPrev, handleFindKey, heldAxisKeys, initCodeMirrorEditor, openFindReplace, replaceAll, replaceCurrent, toggleFindCase, updateFindMatches } from './find-replace';
import { setLocalsDecSigned } from './locals';
import { memViewMode, openMemWordOverlay, setMemDecSigned, setMemViewMode, startMemWordCellEdit } from './memory-register-views';
import { RISCV_AUTOCOMPLETE_DOCS, escapeHtml, extractEditorSymbols, getAssemblyLineContext, mobileMode, mobileTab, panelDock, setMobileTab, setPanelChipShown, setPanelVisible, setRegDecSigned } from './panels';
import { bumpAccelAxis, clearOledDisplay, initPeripherals, updateAccelValues } from './peripherals';
import { restoreSettings } from './settings-store';
import { assembleOnly, resetAll, runProgram, stepBack, stepOnce, toggleRunPause, updateToolbarButtonStates } from './run-control';
import { toggleWaveDock } from './waveform';
import { byId, targetEl } from './dom';
import { redrawToolbar, toolbar } from './toolbar-state';
import { redraw } from './views.svelte';


// The instruction at the PC as the single-cycle diagram sees it: its
// fields, and, when the diagram can draw it, every value on every wire.
export interface DpFields {
  pipe?: false; pc: number; instr: number; op: number; f3: number; f7: number;
  rs1: number; rs2: number; rd: number; text: string;
}
export interface DpUnsupported extends DpFields { unsupported: string }
export type DpCtrl = DecoderRow & { ALUControl: number };
export interface DpModel extends DpFields {
  unsupported: null; ctrl: DpCtrl;
  rd1: number; rd2: number; extImm: number | null; srcA: number; srcB: number | null;
  aluResult: number | null; flags: AluFlags; readData: number; result: number | null;
  pcSrc: string; base: number; offset: number; pcIn: number;
}
export type DpEval = DpUnsupported | DpModel;

// A control signal's value as the Decoder drives it, as bits.
export function dpCtrlValue(c: DpCtrl, name: string): string {
  return String((c as unknown as Record<string, string | number>)[name]);
}

export function dpHex(v: number | null | undefined) { return '0x' + (Number(v) >>> 0).toString(16).padStart(8, '0'); }

// Why the diagram cannot show this instruction, or null when it can.
// The datapath is the lecture's: word loads and stores only, no MCycle.
export function dpUnsupported(instr: number, op: number, f3: number, f7: number) {
  if (instr === 0) return 'This word is 0, which is not an instruction. The simulator steps over it.';
  if (!DECODER_TABLE[op]) {
    return 'Opcode 0x' + op.toString(16).padStart(2, '0') + ' has no row in the decoder ' +
      'table, so this datapath does not implement it.';
  }
  if (op === 0x33 && f7 === 0x01) {
    return 'mul and div run in the MCycle unit, which this diagram does not draw.';
  }
  if (op === 0x33 && f7 !== 0x00 && f7 !== 0x20) return 'This funct7 is not an RV32I operation.';
  if ((op === 0x03 || op === 0x23) && f3 !== 0b010) {
    return 'Byte and half-word ' + (op === 0x03 ? 'loads' : 'stores') + ' need logic this ' +
      'diagram does not draw; it moves whole words only.';
  }
  if (op === 0x63 && (f3 === 0b010 || f3 === 0b011)) return 'This funct3 is not a branch.';
  return null;
}

// Every value on every wire for the instruction at the PC, from the
// current state. Reads are peeks, so looking never consumes a UART byte.
export function dpEvaluate(): DpEval {
  const pcv = cpu.pc >>> 0;
  const instr = readMem(pcv, 4, true) >>> 0;
  const op = instr & 0x7F, f3 = (instr >>> 12) & 7, f7 = instr >>> 25;
  const rs1 = (instr >>> 15) & 31, rs2 = (instr >>> 20) & 31, rd = (instr >>> 7) & 31;
  const item = program.machineCode.find(it => it.address === pcv && it.bytes);
  const fields: DpFields = {
    pc: pcv, instr, op, f3, f7, rs1, rs2, rd,
    text: item ? (item.native || item.text || '').trim() : '',
  };
  const unsupported = dpUnsupported(instr, op, f3, f7);
  if (unsupported) return { ...fields, unsupported };
  const c: DpCtrl = Object.assign({ ALUControl: 0 }, DECODER_TABLE[op]);
  if (op === 0x33) c.ALUControl = (f3 << 1) | ((f7 >>> 5) & 1);
  else if (op === 0x13) c.ALUControl = (f3 << 1) | (f3 === 5 ? (instr >>> 30) & 1 : 0);
  else if (op === 0x63) c.ALUControl = 0b0001;
  else c.ALUControl = 0b0000;
  const rd1 = cpu.regs[rs1] >>> 0;
  const rd2 = cpu.regs[rs2] >>> 0;
  const extImm = extendImm(instr, c.ImmSrc);
  const selA = ctlBit(c.ALUSrcA, 0) === '1' ? (ctlBit(c.ALUSrcA, 1) === '1' ? pcv : 0) : rd1;
  const selB = ctlBit(c.ALUSrcB, 0) === '1' ? (ctlBit(c.ALUSrcB, 1) === '1' ? extImm : 4) : rd2;
  const srcA = selA >>> 0;
  const srcB = selB === null ? null : selB >>> 0;
  const alu = aluCompute(srcA, srcB === null ? 0 : srcB, c.ALUControl);
  const aluResult = alu.result;
  const flags = alu.flags;
  const readData = readMem(aluResult === null ? 0 : aluResult, 4, true) >>> 0;
  const result = c.MemtoReg === '1' ? readData : aluResult;
  const pcSrc = pcLogic(c.PCS, f3, flags);
  const base = ctlBit(pcSrc, 1) === '1' ? rd1 : pcv;
  const offset = ctlBit(pcSrc, 0) === '1' ? (extImm === null ? 0 : extImm) : 4;
  return {
    ...fields, unsupported: null, ctrl: c, rd1, rd2, extImm, srcA, srcB, aluResult, flags, readData,
    result, pcSrc, base: base >>> 0, offset: offset >>> 0, pcIn: (base + offset) >>> 0,
  };
}

// Wires, as routes through the diagram in its own coordinates: `segs`
// are the drawn segments to light (by their data-e index), `pts` the
// path a value travels along, and `park`, where one is given, the free
// spot its value rests on - the long shared buses along the bottom and
// the control wires leaving the Decoder have no room beside them.
//
// A route runs from its source, so where a net branches, each branch
// shares the trunk's segments and a trunk is lit by whichever branch is
// used. That needs every segment to end at a junction; the lecture
// drawing's own segments run straight through ten of them (the PC out,
// RD1, RD2, ExtImm, ALUResult, funct3 and the ALUSrcA/ALUSrcB/PCSrc
// buses), so the copy in index.html splits those into `a` and `b` halves
// at the junction.
// segs: the drawing's segments (data-e); pts: the path; park: a free spot.
export interface DpWire { segs: (string | number)[]; pts: number[][]; park?: number[] }
export const DP_ROUTES: Record<string, DpWire> = {
  pcImem:     { segs: ['76a', '76b'], pts: [[553, 993], [682, 993]], park: [470, 1200] },
  instr:      { segs: [77, 95], pts: [[919, 1034], [1009, 1034]], park: [800, 1300] },
  opcode:     { segs: [180], pts: [[1009, 469], [1278, 469]] },
  funct3:     { segs: ['210a', '210b'], pts: [[1009, 328], [1276, 328]] },
  funct3PC:   { segs: ['210a', 211, 280], pts: [[1009, 328], [1149, 328], [1149, 147], [2100, 147]] },
  funct7:     { segs: [181], pts: [[1009, 601], [1278, 601]] },
  rs1:        { segs: [79], pts: [[1009, 995], [1265, 995]] },
  rs2:        { segs: [115], pts: [[1009, 1110], [1263, 1110]] },
  rd:         { segs: [80], pts: [[1009, 1232], [1264, 1232]] },
  instrImm:   { segs: [108], pts: [[1009, 1440], [1405, 1440]] },
  PCS:        { segs: [285], pts: [[1512, 260], [2098, 260]], park: [1800, 260] },
  MemtoReg:   { segs: [205], pts: [[1515, 396], [2818, 396], [2818, 1374]], park: [2400, 396] },
  MemWrite:   { segs: [204], pts: [[1511, 462], [2530, 462], [2530, 1049]], park: [2350, 462] },
  ALUControl: { segs: [203], pts: [[1509, 532], [2072, 532], [2072, 969]], park: [1960, 532] },
  ALUSrcA:    { segs: ['206a'], pts: [[1507, 599], [1806, 599]], park: [1745, 599] },
  ALUSrcA0:   { segs: ['206b'], pts: [[1806, 599], [1930, 599], [1930, 934]] },
  ALUSrcA1:   { segs: [166], pts: [[1806, 599], [1806, 882]] },
  ALUSrcB:    { segs: [202, '242a'], pts: [[1505, 670], [1731, 670], [1731, 1155], [1820, 1155]], park: [1731, 770] },
  ALUSrcB0:   { segs: ['242b', 241], pts: [[1820, 1155], [1931, 1155], [1931, 1204]] },
  ALUSrcB1:   { segs: [256], pts: [[1820, 1155], [1820, 1257]] },
  ImmSrc:     { segs: [207, 213], pts: [[1500, 741], [1651, 741], [1651, 1358], [1520, 1358], [1520, 1396]], park: [1651, 850] },
  RegWrite:   { segs: [167], pts: [[1402, 768], [1402, 876], [1481, 876], [1481, 921]], park: [1441, 876] },
  rd1ToA:     { segs: ['87a', '87b'], pts: [[1627, 1048], [1896, 1048]] },
  rd1ToBase:  { segs: ['87a', 230, 243, 244, 227], pts: [[1627, 1048], [1703, 1048], [1703, 1561], [87, 1561], [87, 1052], [163, 1052]], park: [1300, 1561] },
  rd2ToB:     { segs: ['239a', '239b'], pts: [[1628, 1218], [1897, 1218]] },
  rd2ToWD:    { segs: ['239a', 192, 262], pts: [[1628, 1218], [1873, 1218], [1873, 1378], [2405, 1378]], park: [2310, 1378] },
  extToB:     { segs: [109, '229a', 261], pts: [[1621, 1440], [1742, 1440], [1742, 1357], [1785, 1357]] },
  extToOff:   { segs: [109, '229b', 191, 198, 101], pts: [[1621, 1440], [1742, 1440], [1742, 1598], [51, 1598], [51, 925], [130, 925]], park: [800, 1598] },
  pcToA:      { segs: ['76a', 194, '195b', 196, 199], pts: [[553, 993], [625, 993], [625, 1522], [1675, 1522], [1675, 989], [1785, 989]], park: [1675, 1300] },
  pcToBase:   { segs: ['76a', 194, '195a', 197, 228], pts: [[553, 993], [625, 993], [625, 1522], [117, 1522], [117, 1128], [165, 1128]], park: [350, 1522] },
  zeroToA:    { segs: [214], pts: [[1695, 917], [1784, 917]] },
  fourToB:    { segs: [254], pts: [[1746, 1286], [1786, 1286]] },
  fourToOff:  { segs: [100], pts: [[61, 852], [128, 852]] },
  aMid:       { segs: [86], pts: [[1850, 952], [1900, 952]] },
  srcA:       { segs: [85], pts: [[1961, 999], [2014, 999]], park: [2085, 880] },
  bMid:       { segs: [240], pts: [[1850, 1313], [1895, 1313]] },
  srcB:       { segs: [238], pts: [[1958, 1265], [2011, 1265]], park: [2085, 1352] },
  aluToMem:   { segs: ['94a', '94b'], pts: [[2133, 1114], [2408, 1114]] },
  aluToRes:   { segs: ['94a', 103, 93], pts: [[2133, 1114], [2278, 1114], [2278, 1481], [2787, 1481]] },
  flags:      { segs: [165, 288], pts: [[2131, 1026], [2160, 1026], [2160, 377]] },
  readData:   { segs: [105, 104, 92], pts: [[2642, 1111], [2700, 1111], [2700, 1403], [2785, 1403]], park: [2560, 1456] },
  result:     { segs: [91, 102, 187, 111, 110], pts: [[2851, 1433], [2901, 1433], [2901, 1680], [1175, 1680], [1175, 1289], [1264, 1289]], park: [2100, 1640] },
  PCSrc:      { segs: [283, 284, 168, '169a', '169b', 246, 245], pts: [[2229, 260], [2803, 260], [2803, 70], [165, 70], [165, 823]] },
  offset:     { segs: [99], pts: [[193, 887], [269, 887]] },
  base:       { segs: [226], pts: [[230, 1090], [271, 1090]] },
  pcIn:       { segs: [193], pts: [[349, 991], [474, 991]], park: [411, 790] },
};

// Each mux: its shape, the control bit that selects it, its inputs in
// select order and its output, so the chosen path can be drawn through it.
export const DP_MUXES: Record<string, { e: number; sel: [string, number]; ins: number[][]; out: number[] }> = {
  off:  { e: 96,  sel: ['pcSrc', 0],    ins: [[129, 852], [129, 925]], out: [193, 887] },
  base: { e: 223, sel: ['pcSrc', 1],    ins: [[166, 1128], [166, 1052]], out: [230, 1090] },
  a1:   { e: 112, sel: ['ALUSrcA', 1],  ins: [[1786, 917], [1786, 989]], out: [1851, 952] },
  a0:   { e: 82,  sel: ['ALUSrcA', 0],  ins: [[1900, 1048], [1900, 952]], out: [1965, 999] },
  b1:   { e: 251, sel: ['ALUSrcB', 1],  ins: [[1785, 1286], [1785, 1357]], out: [1850, 1313] },
  b0:   { e: 235, sel: ['ALUSrcB', 0],  ins: [[1897, 1218], [1897, 1313]], out: [1962, 1265] },
  res:  { e: 88,  sel: ['MemtoReg', 0], ins: [[2787, 1481], [2787, 1403]], out: [2851, 1433] },
};

export const DP_BLOCKS: Record<string, number> = {
  pcReg: 75, imem: 74, rf: 78, dmem: 81, decoder: 171, pcLogic: 287,
  extend: 107, alu: 141, adder: 126,
};
export const DP_CLOCKS: Record<string, number[]> = { pc: [116, 117], rf: [119, 120], dmem: [122, 123] };

export const DP_REG_NAME = (i: number) => 'x' + i + (i ? ' (' + ABI_NAMES[i] + ')' : '');

export function dpSelBit(m: DpModel, name: string, bit: number) {
  const v = name === 'pcSrc' ? m.pcSrc : dpCtrlValue(m.ctrl, name);
  return ctlBit(v, bit);
}

// The phases of one instruction. Each lights routes (with a kind:
// data, field, ctrl, unused or x for don't-care), sends tokens along
// some of them, draws mux selections, glows blocks, and says what is
// happening. Everything the hardware computes is shown, including values
// no mux or enable lets through; those are drawn as unused.
// One step of the animation: the routes it lights ([route, kind, chip
// text, how]), the blocks it glows, the muxes it draws, and its caption.
export type DpRouteUse = [name: string, kind: string, text: string, how?: string];
export interface DpPhase {
  stage?: string; title: string; glow?: string[]; routes: DpRouteUse[]; muxes?: string[];
  sequential?: boolean; edge?: boolean; caption: string;
}

export function dpPhases(m: DpEval) {
  const hx = dpHex;
  const phases: DpPhase[] = [];
  const fetch: DpPhase = {
    stage: 'F', title: 'Fetch',
    glow: ['pcReg', 'imem'],
    routes: [['pcImem', 'data', hx(m.pc)], ['instr', 'data', hx(m.instr)]],
    sequential: true,
    caption: `The PC, <code>${hx(m.pc)}</code>, addresses the instruction memory, which ` +
      `returns <code>${hx(m.instr)}</code>${m.text ? ' - <code>' + escapeHtml(m.text) + '</code>' : ''}.`
  };
  phases.push(fetch);
  if (m.unsupported !== null) {
    phases.push({ title: 'Not in this datapath', routes: [], caption: escapeHtml(m.unsupported) +
      ' The next ▶ executes it anyway, so the program can carry on.' });
    return phases;
  }
  const c = m.ctrl;
  const fmt = ({ 0x33: 'R', 0x13: 'I', 0x03: 'I', 0x67: 'I', 0x23: 'S', 0x63: 'B', 0x6F: 'J', 0x17: 'U', 0x37: 'U' } as Record<number, string>)[m.op] ?? '';
  const uses = { rs1: 'RISB'.includes(fmt), rs2: 'RSB'.includes(fmt), rd: 'RIUJ'.includes(fmt) };
  const bin = (v: number, n: number) => v.toString(2).padStart(n, '0');
  const ctl = (name: string, text?: string): DpRouteUse => [name, /x/.test(dpCtrlValue(c, name)) ? 'x' : 'ctrl', text || dpCtrlValue(c, name)];
  // A 2-bit select bus: the trunk carries the value, and each bit's own
  // branch is a don't-care or not on its own account.
  const ctlBus = (name: string): DpRouteUse[] => [
    [name, /^x+$/.test(dpCtrlValue(c, name)) ? 'x' : 'ctrl', dpCtrlValue(c, name)],
    [name + '0', ctlBit(dpCtrlValue(c, name), 0) === 'x' ? 'x' : 'ctrl', '', 'nochip'],
    [name + '1', ctlBit(dpCtrlValue(c, name), 1) === 'x' ? 'x' : 'ctrl', '', 'nochip'],
  ];
  phases.push({
    stage: 'D', title: 'Decoder',
    glow: ['decoder'],
    routes: [
      ['opcode', 'field', 'op ' + bin(m.op, 7)],
      ['funct3', 'field', 'f3 ' + bin(m.f3, 3)],
      ['funct3PC', c.PCS === '01' ? 'field' : 'unused', bin(m.f3, 3)],
      ['funct7', 'field', 'f7 ' + bin(m.f7, 7)],
      ['rs1', uses.rs1 ? 'field' : 'unused', 'rs1 x' + m.rs1],
      ['rs2', uses.rs2 ? 'field' : 'unused', 'rs2 x' + m.rs2],
      ['rd', uses.rd ? 'field' : 'unused', 'rd x' + m.rd],
      ['instrImm', fmt === 'R' ? 'unused' : 'field', '31:7'],
      ctl('PCS'), ctl('MemtoReg'), ctl('MemWrite'),
      ['ALUControl', 'ctrl', bin(c.ALUControl, 4)],
      ...ctlBus('ALUSrcA'), ...ctlBus('ALUSrcB'),
      ctl('ImmSrc', c.ImmSrc + (IMM_SRC_NAMES[c.ImmSrc] ? ' ' + IMM_SRC_NAMES[c.ImmSrc] : '')),
      ctl('RegWrite'),
    ],
    caption: `A ${fmt}-type instruction: its fields fan out to the Decoder, the register file and Extend` +
      (fmt === 'R' ? '.' : ', and fields this format does not have are ignored (dashed).') +
      ` Opcode <code>0x${m.op.toString(16).padStart(2, '0')}</code> is the <b>${c.row}</b> row; ` +
      `ALUControl <code>${bin(c.ALUControl, 4)}</code> is <b>${ALU_OP_NAMES[c.ALUControl] || '?'}</b>. ` +
      'An x is a don\'t-care.'
  });
  const aSel0 = ctlBit(c.ALUSrcA, 0), aSel1 = ctlBit(c.ALUSrcA, 1);
  const bSel0 = ctlBit(c.ALUSrcB, 0), bSel1 = ctlBit(c.ALUSrcB, 1);
  const p0 = ctlBit(m.pcSrc, 0), p1 = ctlBit(m.pcSrc, 1);
  const used = (on: boolean) => on ? 'data' : 'unused';
  const ext = m.extImm === null ? 'x' : hx(m.extImm);
  phases.push({
    stage: 'D', title: 'Register Read',
    glow: ['rf'],
    routes: [
      ['rd1ToA', used(aSel0 === '0'), hx(m.rd1)],
      ['rd1ToBase', used(p1 === '1'), hx(m.rd1)],
      ['rd2ToB', used(bSel0 === '0'), hx(m.rd2)],
      ['rd2ToWD', used(c.MemWrite === '1'), hx(m.rd2)],
      ['pcToA', used(aSel0 === '1' && aSel1 === '1'), 'PC', 'static'],
      ['pcToBase', used(p1 !== '1'), 'PC', 'static'],
      ['zeroToA', used(aSel0 === '1' && aSel1 === '0'), '0', 'static'],
      ['fourToB', used(bSel0 === '1' && bSel1 === '0'), '4', 'static'],
      ['fourToOff', used(p0 !== '1'), '4', 'static'],
    ],
    caption: `The register file reads x${m.rs1} = <code>${hx(m.rd1)}</code> and ` +
      `x${m.rs2} = <code>${hx(m.rd2)}</code> without waiting for a clock.`
  });
  phases.push({
    stage: 'D', title: 'Extend',
    glow: ['extend'],
    routes: [
      ['extToB', m.extImm === null ? 'x' : used(bSel0 === '1' && bSel1 === '1'), ext],
      ['extToOff', m.extImm === null ? 'x' : used(p0 === '1'), ext],
    ],
    caption: 'Extend builds ' +
      (m.extImm === null ? 'nothing meaningful: ImmSrc is a don\'t-care for this row.'
        : `the ${IMM_SRC_NAMES[c.ImmSrc]}-type immediate <code>${ext}</code> (${m.extImm | 0}).`)
  });
  const aluName = ALU_OP_NAMES[c.ALUControl];
  const pcsName = ({ '00': 'not a control instruction', '01': 'a branch', '10': 'jal', '11': 'jalr' } as Record<string, string>)[c.PCS];
  phases.push({
    stage: 'E', title: 'ALU and PC Logic',
    glow: ['alu', 'pcLogic'],
    muxes: ['a1', 'a0', 'b1', 'b0'],
    routes: [
      ['aMid', used(aSel0 === '1'), '', 'nochip'],
      ['srcA', 'data', hx(m.srcA)],
      ['bMid', used(bSel0 === '1'), '', 'nochip'],
      ['srcB', 'data', m.srcB === null ? 'x' : hx(m.srcB)],
      ['aluToMem', used(c.MemWrite === '1' || c.MemtoReg === '1'), hx(m.aluResult)],
      ['aluToRes', used(c.MemtoReg === '0'), hx(m.aluResult)],
      ['flags', used(c.PCS === '01'), `eq ${m.flags.eq} lt ${m.flags.lt} ltu ${m.flags.ltu}`],
      ['PCSrc', 'ctrl', m.pcSrc],
    ],
    caption: `The ALU does <b>${aluName}</b>: <code>${hx(m.srcA)}</code> ${aluName} ` +
      `<code>${m.srcB === null ? 'x' : hx(m.srcB)}</code> = <code>${hx(m.aluResult)}</code>. ` +
      `PC Logic: PCS ${c.PCS} is ${pcsName}` +
      (c.PCS === '01' ? `, and funct3 ${bin(m.f3, 3)} with the flags {eq, lt, ltu} = ` +
        `{${m.flags.eq}, ${m.flags.lt}, ${m.flags.ltu}} make it ` + (p0 === '1' ? 'taken' : 'not taken') : '') +
      `, so PCSrc = ${m.pcSrc}.`
  });
  const isLoad = c.MemtoReg === '1', isStore = c.MemWrite === '1';
  phases.push({
    stage: 'M', title: 'Memory',
    glow: isLoad || isStore ? ['dmem'] : [],
    routes: [['readData', used(isLoad), hx(m.readData)]],
    caption: isLoad
      ? `The data memory reads the word at <code>${hx(m.aluResult)}</code>: <code>${hx(m.readData)}</code>.`
      : isStore
        ? `MemWrite is 1: the data memory will store <code>${hx(m.rd2)}</code> at ` +
          `<code>${hx(m.aluResult)}</code> - at the clock edge, not now.`
        : 'The data memory still reads whatever address the ALU produced, but MemWrite is 0 ' +
          'and MemtoReg does not pick ReadData, so nothing comes of it.'
  });
  const writes = c.RegWrite === '1';
  phases.push({
    stage: 'W', title: 'Register Write',
    muxes: c.MemtoReg === 'x' ? [] : ['res'],
    routes: [['result', writes ? 'data' : 'unused', hx(m.result)]],
    caption: writes
      ? `MemtoReg = ${c.MemtoReg} picks ${isLoad ? 'ReadData' : 'ALUResult'} as Result, ` +
        `<code>${hx(m.result)}</code>, which waits at the register file's WD for the edge` +
        (m.rd === 0 ? ' - but rd is x0, which the register file never writes.' : ' to be written to x' + m.rd + '.')
      : 'RegWrite is 0: Result reaches WD, but the register file will not take it.'
  });
  const pcExplain = ({
    '00': 'PC_IN = PC + 4.',
    '01': 'PC_IN = PC + ExtImm, the taken target.',
    '11': 'PC_IN = RD1 + ExtImm, jalr\'s target.',
  } as Record<string, string>)[m.pcSrc];
  phases.push({
    stage: 'W', title: 'PC Increment',
    glow: ['adder'],
    muxes: ['off', 'base'],
    routes: [
      ['offset', 'data', '', 'nochip'],
      ['base', 'data', '', 'nochip'],
      ['pcIn', 'data', hx(m.pcIn)],
    ],
    caption: `PCSrc ${m.pcSrc}: ${pcExplain} <code>${hx(m.base)}</code> + <code>${hx(m.offset)}</code> = ` +
      `<code>${hx(m.pcIn)}</code>.`
  });
  const edge = [`PC ← <code>${hx(m.pcIn)}</code>`];
  if (writes && m.rd !== 0) edge.push(`${DP_REG_NAME(m.rd)} ← <code>${hx(m.result)}</code>`);
  if (isStore) edge.push(`M[<code>${hx(m.aluResult)}</code>] ← <code>${hx(m.rd2)}</code>`);
  phases.push({
    stage: 'W', title: 'Retire',
    edge: true,
    routes: [],
    caption: 'At the rising clock edge, everything is written at once: ' + edge.join(', ') + '.'
  });
  return phases;
}

// ---- State and rendering --------------------------------------------
export type PdpModel = ReturnType<typeof pdpEvaluate>;
export let dpModel: DpEval | PdpModel | null = null;
export let dpPhaseList: DpPhase[] = [];
export let dpPhase = 0;             // 0 = nothing yet; k = phases 1..k shown
export let dpStamp = '';
export let dpSpeed = 1;
export let dpAnimToken = 0;         // bumped to cancel an animation in flight
export let dpBusy = false;

export const DP_OPEN_KEY = 'rvsim.dpOpen.v1';
export const DP_H_KEY = 'rvsim.dpHeight.v1';
export const DP_H_DEFAULT = 420;

export const DP_KIND_COLOUR: Record<string, string> = { data: '#e64553', field: '#8839ef', ctrl: '#1e66f5', unused: '#9ca0b0', x: '#9ca0b0' };

export function dpSvg() {
  return document.getElementById(!pipeline.on ? 'dpSvg' : pipeline.predictor.on ? 'dpPipeBpSvg' : 'dpPipeSvg') as SVGSVGElement | null;
}
export function dpOverlayEl() { const svg = dpSvg(); return svg && svg.querySelector<SVGGElement>('.dp-overlay'); }
export function dpEl(i: string | number) { const svg = dpSvg(); return svg && svg.querySelector<SVGElement>(`[data-e="${i}"]`); }
// Whether the model is a single-cycle instruction the diagram draws.
export function dpDrawable(m: typeof dpModel): m is DpModel { return !!m && m.pipe !== true && m.unsupported === null; }

export function dpActive() {
  return !!dpSvg() && ui.engine !== 'hdl' &&
    (document.body.classList.contains('dp-open') || document.body.classList.contains('dp-in-panel'));
}

// What makes the current instruction a different one: a Step, a Back, a
// reset or a reassemble.
export function dpCurrentStamp() {
  return [cpu.pc >>> 0, cpu.instructionCount, stepHistory.entries.length, program.assembled ? 1 : 0,
          program.machineCode.length, pipeline.on ? cpu.totalCycles + JSON.stringify(pipeline.hazards) + JSON.stringify(pipeline.predictor) : ''].join(':');
}

// What changes the values without changing the instruction: an edit in
// the Registers or Memory panel.
export let dpValueStamp = '';
export function dpCurrentValueStamp() {
  let h = 0;
  for (let i = 0; i < 32; i++) h = Math.imul(h ^ cpu.regs[i], 0x01000193);
  return h + ':' + (cpu.lastChangedMem.length ? cpu.lastChangedMem[0].addr + '/' + cpu.lastChangedMem[0].size : '');
}

// A new instruction starts from phase 0. The same instruction keeps its
// phase but is re-evaluated, so an edited register shows up at once.
// Nothing is drawn while the strip is hidden: showing it syncs with force.
export function dpSync(force: boolean) {
  if (!dpSvg() || !dpActive()) return;
  if (run.running) return;
  const stamp = dpCurrentStamp();
  const values = dpCurrentValueStamp();
  if (!force && stamp === dpStamp && values === dpValueStamp) return;
  dpValueStamp = values;
  if (!force && stamp === dpStamp && dpModel) {
    if (dpBusy) return;
    dpModel = pipeline.on ? pdpEvaluate() : dpEvaluate();
    dpPhaseList = dpModel.pipe ? [] : dpPhases(dpModel);
    dpPhase = Math.min(dpPhase, dpPhaseList.length);
    dpRender(false);
    return;
  }
  dpStamp = stamp;
  dpAnimToken++;
  dpBusy = false;
  dpModel = !program.assembled ? null : pipeline.on ? (run.finished ? null : pdpEvaluate()) : dpEvaluate();
  dpPhaseList = !dpModel || dpModel.pipe ? [] : dpPhases(dpModel);
  dpPhase = 0;
  dpRender(false);
}

export function dpClear() {
  const svg = dpSvg();
  if (!svg) return;
  svg.querySelectorAll<SVGElement>('.dp-lit-data, .dp-lit-field, .dp-lit-ctrl, .dp-lit-unused, .dp-lit-x, .dp-glow, .dp-glow-ctrl, .dp-edge')
    .forEach(el => {
      el.classList.remove('dp-lit-data', 'dp-lit-field', 'dp-lit-ctrl',
        'dp-lit-unused', 'dp-lit-x', 'dp-glow', 'dp-glow-ctrl', 'dp-edge');
      el.style.removeProperty('--sc');
    });
  svg.querySelectorAll<SVGElement>('.pl-lit').forEach(el => {
    el.classList.remove('pl-lit', 'pl-thin');
    el.style.removeProperty('--pl');
    delete el.dataset.pl;
  });
  const ov = dpOverlayEl();
  if (ov) ov.innerHTML = '';
}

// The colour of the pipeline stage the step being drawn belongs to, so a
// single-cycle step reads in the same colour as that stage in the
// pipeline, its timeline and the clock beside the drawing.
export let dpStageColour: string | null = null;

export function dpLight(routeName: string, kind: string) {
  const r = DP_ROUTES[routeName];
  if (!r) return;
  const used = kind !== 'unused' && kind !== 'x';
  for (const i of r.segs) {
    const el = dpEl(i);
    if (!el) continue;
    // A shared segment keeps the strongest reading, used beating unused,
    // and the colour of the step that first used it.
    const lit = el.classList.contains('dp-lit-data') || el.classList.contains('dp-lit-field') ||
      el.classList.contains('dp-lit-ctrl');
    if (!used) {
      if (lit) continue;
    } else {
      el.classList.remove('dp-lit-unused', 'dp-lit-x');
      if (!lit && dpStageColour) el.style.setProperty('--sc', dpStageColour);
    }
    el.classList.add('dp-lit-' + kind);
  }
}

export function dpGlow(names: string[] | undefined) {
  for (const n of names || []) {
    const el = dpEl(DP_BLOCKS[n]);
    if (!el) continue;
    el.classList.add('dp-glow');
    if (dpStageColour) el.style.setProperty('--sc', dpStageColour);
  }
}

export function dpNS(tag: string, attrs: Record<string, string | number>) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  return el;
}

// The chosen path through a mux, drawn inside its shape.
export function dpDrawMux(name: string) {
  const mx = DP_MUXES[name];
  if (!dpDrawable(dpModel)) return;
  const bit = dpSelBit(dpModel, mx.sel[0], mx.sel[1]);
  const shape = dpEl(mx.e);
  if (bit !== '0' && bit !== '1') {
    if (shape) shape.classList.add('dp-lit-x');
    return;
  }
  if (shape) {
    shape.classList.add('dp-glow');
    if (dpStageColour) shape.style.setProperty('--sc', dpStageColour);
  }
  const from = mx.ins[+bit];
  const ov = dpOverlayEl();
  if (!ov) return;
  ov.appendChild(dpNS('polyline', {
    points: `${from[0]},${from[1]} ${(from[0] + mx.out[0]) / 2},${mx.out[1]} ${mx.out[0]},${mx.out[1]}`,
    fill: 'none', stroke: dpStageColour || '#e64553', 'stroke-width': 9, 'stroke-linecap': 'round'
  }));
}

export function dpChip(text: string, kind: string, parked: boolean) {
  const g = dpNS('g', { class: 'dp-chip' + (parked ? ' dp-parked' : '') });
  const fs = parked ? 26 : 34;
  const w = Math.max(40, text.length * fs * 0.6 + 22), h = fs + 16;
  g.dataset.w = String(w);
  g.dataset.h = String(h);
  const used = kind !== 'unused' && kind !== 'x';
  g.appendChild(dpNS('rect', { x: -w / 2, y: -h / 2, width: w, height: h,
    fill: (used && dpStageColour) || DP_KIND_COLOUR[kind] || '#e64553' }));
  const t = dpNS('text', { x: 0, y: 0, 'text-anchor': 'middle' });
  t.textContent = text;
  g.appendChild(t);
  return g;
}

export function dpRouteLength(pts: number[][]) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return len;
}

export function dpPointAt(pts: number[][], frac: number) {
  const total = dpRouteLength(pts);
  let want = total * frac;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (want <= seg || i === pts.length - 1) {
      const f = seg ? Math.min(1, want / seg) : 0;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
    }
    want -= seg;
  }
  return pts[pts.length - 1];
}

// Where a finished value sits: beside the middle of its wire's longest
// straight run - below a horizontal run, right of a vertical one - which
// keeps it off the blocks at either end and off the diagram's own labels,
// which sit above and to the left of their wires.
export function dpParkPoint(route: DpWire, chip?: SVGElement | null) {
  const pts = route.pts;
  let best = 1, bestLen = -1;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (l > bestLen) { bestLen = l; best = i; }
  }
  if (route.park) return route.park;
  const a = pts[best - 1], b = pts[best];
  const x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2;
  if (!chip) return [x, y];
  const w = Number(chip.dataset.w), h = Number(chip.dataset.h);
  return Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]) ? [x + w / 2 + 8, y] : [x, y + h / 2 + 8];
}

export function dpPlace(g: Element, xy: number[]) { g.setAttribute('transform', `translate(${xy[0]},${xy[1]})`); }

// Everything phases 1..k leave on the diagram, drawn at rest. The latest
// phase's values are full size; earlier ones shrink to tags.
export function dpDrawStatic(k: number) {
  dpClear();
  const ov = dpOverlayEl();
  if (!ov) return;
  for (let p = 1; p <= k; p++) {
    const ph = dpPhaseList[p - 1];
    if (!ph) continue;
    dpStageColour = ph.stage ? PDP_COLOUR[ph.stage] : null;
    for (const [name, kind, text, how] of ph.routes) {
      dpLight(name, kind);
      if (how === 'nochip' || (kind === 'unused' && p < k)) continue;
      const chip = dpChip(text, kind, p < k);
      dpPlace(chip, dpParkPoint(DP_ROUTES[name], chip));
      ov.appendChild(chip);
    }
    if (p === k) dpGlow(ph.glow);
    for (const mx of ph.muxes || []) dpDrawMux(mx);
    if (ph.edge && p === k && dpDrawable(dpModel)) {
      const c = dpModel.ctrl;
      const edgeEls = [DP_BLOCKS.pcReg, ...DP_CLOCKS.pc];
      if (c && c.RegWrite === '1' && dpModel.rd !== 0) edgeEls.push(DP_BLOCKS.rf, ...DP_CLOCKS.rf);
      if (c && c.MemWrite === '1') edgeEls.push(DP_BLOCKS.dmem, ...DP_CLOCKS.dmem);
      edgeEls.forEach(i => {
        const el = dpEl(i);
        if (!el) return;
        el.classList.add('dp-edge');
        if (dpStageColour) el.style.setProperty('--sc', dpStageColour);
      });
    }
  }
}


// ---- The instruction's encoding -------------------------------------
// The instruction's 32 bits, split the way its format splits them, and
// what each field means. The Instr bus slices the word the same way for
// every instruction; the format is what says which slices are an
// immediate. HTML rather than part of the drawing, so it stays readable
// at any zoom: dpPlaceEncoding() finds it room.
// Each format's fields: [high bit, low bit, name, kind].
export const DP_FORMATS: Record<string, [number, number, string, string][]> = {
  R:   [[31, 25, 'funct7', 'ctl'], [24, 20, 'rs2', 'reg'], [19, 15, 'rs1', 'reg'], [14, 12, 'funct3', 'ctl'], [11, 7, 'rd', 'reg'], [6, 0, 'opcode', 'ctl']],
  I:   [[31, 20, 'imm[11:0]', 'imm'], [19, 15, 'rs1', 'reg'], [14, 12, 'funct3', 'ctl'], [11, 7, 'rd', 'reg'], [6, 0, 'opcode', 'ctl']],
  Ish: [[31, 25, 'funct7', 'ctl'], [24, 20, 'shamt', 'imm'], [19, 15, 'rs1', 'reg'], [14, 12, 'funct3', 'ctl'], [11, 7, 'rd', 'reg'], [6, 0, 'opcode', 'ctl']],
  S:   [[31, 25, 'imm[11:5]', 'imm'], [24, 20, 'rs2', 'reg'], [19, 15, 'rs1', 'reg'], [14, 12, 'funct3', 'ctl'], [11, 7, 'imm[4:0]', 'imm'], [6, 0, 'opcode', 'ctl']],
  B:   [[31, 25, 'imm[12|10:5]', 'imm'], [24, 20, 'rs2', 'reg'], [19, 15, 'rs1', 'reg'], [14, 12, 'funct3', 'ctl'], [11, 7, 'imm[4:1|11]', 'imm'], [6, 0, 'opcode', 'ctl']],
  U:   [[31, 12, 'imm[31:12]', 'imm'], [11, 7, 'rd', 'reg'], [6, 0, 'opcode', 'ctl']],
  J:   [[31, 12, 'imm[20|10:1|11|19:12]', 'imm'], [11, 7, 'rd', 'reg'], [6, 0, 'opcode', 'ctl']],
  raw: [[31, 0, 'no RV32I format', 'ctl']],
};
export const DP_FORMAT_IMMSRC: Record<string, string> = { I: '011', S: '110', B: '111', U: '000', J: '010' };
export const DP_BRANCH_NAMES: Record<number, string> = { 0: 'beq', 1: 'bne', 4: 'blt', 5: 'bge', 6: 'bltu', 7: 'bgeu' };

export function dpFormatOf(op: number, f3: number) {
  switch (op) {
    case 0x33: return 'R';
    case 0x13: return (f3 === 1 || f3 === 5) ? 'Ish' : 'I';
    case 0x03: case 0x67: case 0x73: case 0x0F: return 'I';
    case 0x23: return 'S';
    case 0x63: return 'B';
    case 0x6F: return 'J';
    case 0x17: case 0x37: return 'U';
    default: return null;
  }
}

// What one field says about this instruction; '' when its bits are
// only a slice of the immediate, which the last row gathers.
export function dpFieldMeaning(m: DpEval, fmt: string | null, name: string) {
  if (name === 'opcode') {
    const row = DECODER_TABLE[m.op];
    return '0x' + m.op.toString(16).padStart(2, '0') + ' · ' + (row ? row.row : 'no decoder row');
  }
  if (name === 'rd') return DP_REG_NAME(m.rd);
  if (name === 'rs1') return DP_REG_NAME(m.rs1);
  if (name === 'rs2') return DP_REG_NAME(m.rs2);
  if (name === 'shamt') return 'shift by ' + m.rs2;
  if (name === 'funct3') {
    if (m.op === 0x63) return DP_BRANCH_NAMES[m.f3] || 'not a branch';
    if (m.unsupported === null && (m.op === 0x33 || m.op === 0x13)) return 'ALU ' + (ALU_OP_NAMES[m.ctrl.ALUControl] || '?');
    if (m.op === 0x03 || m.op === 0x23) return m.f3 === 2 ? 'word' : 'byte/half';
    return '';
  }
  if (name === 'funct7') return (m.op === 0x33 || fmt === 'Ish') ? 'bit 30 → ALUControl[0]' : '';
  return '';
}

// The Decoder's truth table as the lecture gives it, with the row this
// instruction selects picked out.
export const DP_ALUCTL_TEXT: Record<string, string[]> = {
  'DP Reg': ['{funct3, funct7[5]}'], 'DP Imm': ["{funct3, 1'b0 /", 'imm[10]#}'], branch: ['0001 (sub)'],
};
// The lecture's row order; an object's numeric keys would come out sorted.
export const DP_CONTROL_ORDER = [0x33, 0x13, 0x03, 0x23, 0x63, 0x6F, 0x17, 0x37, 0x67];
export interface DpCtlRow { op: string; name: string; cells: string[]; imm: string; alu: string[]; on: boolean }
export function dpControlTable(m: DpEval): DpCtlRow[] {
  const ctrl = m.unsupported === null ? m.ctrl : null;
  const cur = ctrl && ctrl.row;
  return DP_CONTROL_ORDER.map(op => {
    const c = DECODER_TABLE[op];
    const on = c.row === cur;
    const alu = (DP_ALUCTL_TEXT[c.row] || ['0000 (add)']).slice();
    if (ctrl && on && (c.row === 'DP Reg' || c.row === 'DP Imm')) {
      alu.push(`= ${ctrl.ALUControl.toString(2).padStart(4, '0')} (${ALU_OP_NAMES[ctrl.ALUControl] || '?'})`);
    }
    return {
      op: op.toString(16).toUpperCase().padStart(2, '0'), name: c.row, on, alu,
      cells: [c.PCS, c.MemtoReg, c.RegWrite, c.MemWrite, c.ALUSrcA, c.ALUSrcB].map(String),
      imm: c.ImmSrc + ' (' + (IMM_SRC_NAMES[c.ImmSrc] || 'R') + ')',
    };
  });
}

// What the encoding column shows (DpEncoding.svelte): one instruction's
// fields, its immediate and the Decoder's table when single-cycle; the
// five stages' fields and the branch predictor's table when pipelined.
export interface DpEncField { hi: number; lo: number; name: string; kind: string; meaning?: string }
export interface DpBhtRow { index: number; f: boolean; e: boolean; pr: string; bta: string }
export type DpEncView =
  | { pipe: false; format: string; text: string; instr: number; fields: DpEncField[];
      imm: { src: string; hex: string; dec: number } | null; control: DpCtlRow[] }
  | { pipe: true; stages: { stage: string; colour: string; text: string | null; instr: number; fields: DpEncField[] }[];
      bht: { entries: number; bits: number; k: number; inUse: boolean; rows: DpBhtRow[] } | null };

export function dpDrawEncoding(m: DpEval | null) {
  if (!m) { setDpPanel({ enc: null }); return; }
  const fmt = dpFormatOf(m.op, m.f3);
  const immSrc = !fmt || fmt === 'Ish' ? null : DP_FORMAT_IMMSRC[fmt];
  const imm = immSrc ? extendImm(m.instr, immSrc) : null;
  setDpPanel({ enc: {
    pipe: false, format: fmt ? (fmt === 'Ish' ? 'I' : fmt) + '-type' : 'Encoding', text: m.text || dpHex(m.instr), instr: m.instr >>> 0,
    fields: DP_FORMATS[fmt || 'raw'].map(([hi, lo, name, kind]) => ({ hi, lo, name, kind, meaning: dpFieldMeaning(m, fmt, name) })),
    imm: imm === null || !immSrc ? null : { src: immSrc, hex: dpHex(imm), dec: imm | 0 },
    control: dpControlTable(m),
  } });
  dpPlaceEncoding();
}

// The encoding (and, single-cycle, the control table) is a column of its
// own: beside the drawing where the strip is wide, below it where not,
// since the drawing matters more.
export function dpPlaceEncoding() {
  const body = byId('dpBody');
  if (!body || !dpPanel.enc || !dpActive()) return;
  body.classList.remove('dp-enc-below', 'dp-enc-side');
  body.classList.add(body.clientWidth >= 900 ? 'dp-enc-side' : 'dp-enc-below');
}

// One clock period down the single-cycle drawing's left margin: the nine
// steps, each in the colour of the pipeline stage it belongs to, all
// inside a single cycle; the rising edge at the bottom starts the next.
export const DP_STAGE_NAME: Record<string, string> = { F: 'Fetch', D: 'Decode', E: 'Execute', M: 'Memory', W: 'Writeback' };
export const DP_CLK = { left: 320, y0: 120, y1: 1640, wLow: -300, wHigh: -195, bx0: -165, bx1: -25 };
export function dpClockInit() {
  const svg = byId<SVGSVGElement>('dpSvg');
  if (!svg || svg.querySelector('#dpClock')) return;
  const [vx, vy, vw, vh] = (svg.getAttribute('viewBox') ?? '0 0 0 0').split(/[\s,]+/).map(Number);
  svg.setAttribute('viewBox', `${vx - DP_CLK.left} ${vy} ${vw + DP_CLK.left} ${vh}`);
  const { y0, y1, wLow, wHigh, bx0, bx1 } = DP_CLK, mid = (y0 + y1) / 2;
  const NS = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(NS, 'g');
  g.id = 'dpClock';
  const arrow = (y: number, cls: string) => `<path class="${cls}" d="M${(wLow + wHigh) / 2 - 18} ${y - 16}L${(wLow + wHigh) / 2 + 18} ${y}L${(wLow + wHigh) / 2 - 18} ${y + 16}Z"/>`;
  g.innerHTML =
    '<title>One clock period: in a single-cycle processor every stage happens within it</title>' +
    `<text class="dp-clk-label" x="${(wLow + wHigh) / 2}" y="${y0 - 50}" text-anchor="middle">CLK</text>` +
    `<path class="dp-clk-wave" d="M${wLow} ${y0 - 30}V${y0}H${wHigh}V${mid}H${wLow}V${y1}"/>` +
    arrow(y0, 'dp-clk-arrow') +
    `<path class="dp-clk-next" d="M${wLow} ${y1}H${wHigh}V${y1 + 50}"/>` +
    arrow(y1, 'dp-clk-arrow dp-clk-next-arrow');
  svg.appendChild(g);
}
export function dpClockUpdate() {
  const g = document.getElementById('dpClock');
  if (!g) return;
  const steps = dpPhaseList.filter(p => p.stage);
  const { y0, y1, bx0, bx1 } = DP_CLK, h = (y1 - y0) / Math.max(steps.length, 1);
  g.querySelectorAll('.dp-clk-step').forEach(el => el.remove());
  steps.forEach((p, i) => {
    const state = i + 1 === dpPhase ? ' now' : i + 1 < dpPhase ? ' done' : '';
    const y = y0 + i * h;
    g.insertAdjacentHTML('beforeend',
      `<g class="dp-clk-step${state}" style="--sc:${PDP_COLOUR[p.stage ?? '']}">` +
      `<rect x="${bx0}" y="${y + 6}" width="${bx1 - bx0}" height="${h - 12}" rx="12"/>` +
      `<text x="${(bx0 + bx1) / 2}" y="${y + h / 2 + 24}" text-anchor="middle">${p.stage}</text></g>`);
  });
  g.classList.toggle('dp-clk-edge', steps.length > 0 && dpPhase === steps.length);
}

// What the strip's header shows (DatapathHeader.svelte).
export type DpHeaderPhase = { n: string; stage: string; colour: string; title: string };
export let dpHeader = {
  instr: null as { addr: string; text: string } | null,
  phase: null as DpHeaderPhase | null,
  pipe: false,
  view: 'diagram',
  prev: { on: true, title: 'Previous phase' },
  next: { on: true, title: 'Next phase; at the clock edge, execute the instruction' },
  play: { on: true, title: 'Play every phase of this instruction, then execute it', label: '▶▶' },
  // The strip's height while it is open at the bottom; null leaves it to
  // the stylesheet.
  dockFlex: null as string | null,
};
// The caption (authored markup), the encoding column and the timeline
// (DatapathDock.svelte and its parts).
export let dpPanel = { caption: '', enc: null as DpEncView | null, tl: null as DpTlView | null };
function setDpPanel(part: Partial<typeof dpPanel>) {
  dpPanel = { ...dpPanel, ...part };
  redraw('dpPanel');
}

function setDpHeader(part: Partial<typeof dpHeader>) {
  dpHeader = { ...dpHeader, ...part };
  redraw('datapath');
}

export function dpRender(animate: boolean) {
  const total = dpPhaseList.length;
  if (pipeline.on) {
    pdpRenderTimeline();
    pdpDrawEncodings(dpModel && dpModel.pipe ? dpModel : null);
  } else {
    dpDrawEncoding(dpModel && !dpModel.pipe ? dpModel : null);
  }
  if (!dpModel) {
    dpClear();
    setDpHeader({ instr: null, phase: null });
    setDpPanel({ caption: program.assembled
      ? 'The program has finished.'
      : 'Assemble a program to follow its instructions through the datapath.' });
    dpUpdateButtons();
    return;
  }
  if (dpModel.pipe) {
    // The cycle count is the status line's and the log's, which number
    // the cycle just clocked; this header would be one ahead of them.
    setDpHeader({ instr: null, phase: null });
    setDpPanel({ caption: pdpCaption(dpModel) });
    pdpDraw(dpModel);
    dpUpdateButtons();
    return;
  }
  // The phase as n/total, then its stage in the stage's colour and, when
  // it says more than the stage's name, its title.
  const ph = dpPhase ? dpPhaseList[dpPhase - 1] : null;
  setDpHeader({
    instr: { addr: dpHex(dpModel.pc), text: dpModel.text || dpHex(dpModel.instr) },
    phase: ph ? { n: `${dpPhase}/${total}`, stage: ph.stage ? DP_STAGE_NAME[ph.stage] : '',
      colour: PDP_COLOUR[ph.stage ?? ''], title: ph.title } : null,
  });
  dpClockUpdate();
  setDpPanel({ caption: dpPhase ? dpPhaseList[dpPhase - 1].caption : '' });
  if (!animate || !dpPhase) { dpDrawStatic(dpPhase); dpUpdateButtons(); return; }
  dpAnimatePhase(dpPhase);
}

export function dpUpdateButtons() {
  dpUpdateOwnButtons();
  updateFloatSteps();
}

export function dpUpdateOwnButtons() {
  const pipe = pipeline.on;
  let prev: boolean, next: boolean, play: boolean;
  if (pipe) {
    const ok = program.assembled && !run.running && ui.engine !== 'hdl';
    prev = ok && !pdpPlaying && stepHistory.entries.length > 0;
    next = ok && !run.finished;
    play = ok && (pdpPlaying || !run.finished);
  } else {
    const ok = !!dpModel && !run.running && ui.engine !== 'hdl';
    prev = ok && (dpPhase > 0 || stepHistory.entries.length > 0);
    next = play = ok && !run.finished;
  }
  setDpHeader({
    prev: { on: prev, title: pipe ? 'Back one clock cycle' : 'Previous phase' },
    next: { on: next, title: pipe ? 'Next clock cycle' : 'Next phase; at the clock edge, execute the instruction' },
    play: { on: play, label: pdpPlaying ? '⏸' : '▶▶',
      title: pipe ? 'Clock one cycle after another; press again to pause' : 'Play every phase of this instruction, then execute it' },
  });
}

// Tokens for phase k fly along their routes; everything before k is
// already at rest. A phase marked sequential sends its tokens one after
// another (the PC must reach the memory before the instruction leaves it).
export function dpAnimatePhase(k: number) {
  const my = ++dpAnimToken;
  dpDrawStatic(k - 1);
  const ph = dpPhaseList[k - 1];
  dpStageColour = ph.stage ? PDP_COLOUR[ph.stage] : null;
  dpGlow(ph.glow);
  for (const mx of ph.muxes || []) dpDrawMux(mx);
  const ov = dpOverlayEl();
  if (!ov) return Promise.resolve(false);
  ph.routes.filter(r => r[3] === 'nochip').forEach(([name, kind]) => dpLight(name, kind));
  const moving = ph.routes.filter(r => r[3] !== 'static' && r[3] !== 'nochip');
  ph.routes.filter(r => r[3] === 'static').forEach(([name, kind, text]) => {
    dpLight(name, kind);
    const chip = dpChip(text, kind, false);
    dpPlace(chip, dpParkPoint(DP_ROUTES[name], chip));
    ov.appendChild(chip);
  });
  const dur = 900 / dpSpeed;
  const tokens = moving.map(([name, kind, text], i) => {
    const chip = dpChip(text, kind, false);
    const pts = DP_ROUTES[name].pts;
    dpPlace(chip, pts[0]);
    chip.style.opacity = '0';
    ov.appendChild(chip);
    return { chip, pts, name, kind, delay: ph.sequential ? i * dur : 0, lit: false };
  });
  dpBusy = true;
  dpUpdateButtons();
  const start = performance.now();
  const end = Math.max(...tokens.map(t => t.delay + dur), 0);
  return new Promise(resolve => {
    const frame = (now: number) => {
      if (my !== dpAnimToken) { resolve(false); return; }
      const t = now - start;
      for (const tk of tokens) {
        const f = Math.max(0, Math.min(1, (t - tk.delay) / dur));
        if (f <= 0) continue;
        tk.chip.style.opacity = '1';
        // All the way to the input it feeds; the phase's static drawing
        // then parks it beside its wire.
        dpPlace(tk.chip, dpPointAt(tk.pts, f));
        if (f >= 1 && !tk.lit) { tk.lit = true; dpLight(tk.name, tk.kind); }
      }
      if (t < end) requestAnimationFrame(frame);
      else { dpBusy = false; dpDrawStatic(k); dpUpdateButtons(); resolve(true); }
    };
    requestAnimationFrame(frame);
  });
}

// Past the last phase is the clock edge: the instruction executes, one
// instruction exactly, whatever Statement Stepping is set to.
export function dpCommit() {
  const saved = run.statementStepping;
  run.statementStepping = false;
  try { stepOnce(); } finally { run.statementStepping = saved; }
  dpSync(true);
}

export function dpNext() {
  if (pipeline.on) { pdpPlaying = false; if (!run.running && !run.finished && program.assembled) dpCommit(); return; }
  if (!dpModel || run.running || ui.engine === 'hdl') return;
  if (dpBusy) { dpAnimToken++; dpBusy = false; dpDrawStatic(dpPhase); dpUpdateButtons(); return; }
  if (dpPhase >= dpPhaseList.length) { dpCommit(); return; }
  dpPhase++;
  dpRender(true);
}

export function dpPrev() {
  if (pipeline.on) { pdpPlaying = false; if (!run.running && stepHistory.entries.length) { stepBack(); dpSync(true); } return; }
  if (!dpModel || run.running) return;
  dpAnimToken++;
  dpBusy = false;
  if (dpPhase > 0) {
    dpPhase--;
    dpRender(false);
    return;
  }
  // Back past the first phase: the instruction before, at its last.
  if (!stepHistory.entries.length) return;
  stepBack();
  dpSync(true);
  dpPhase = dpPhaseList.length;
  dpRender(false);
}

// Plays the rest of this instruction's phases, then lets the edge happen.
export async function dpPlay() {
  if (pipeline.on) { pdpPlay(); return; }
  if (!dpModel || run.running || ui.engine === 'hdl') return;
  const stamp = dpStamp;
  while (dpPhase < dpPhaseList.length) {
    dpPhase++;
    dpRender(false);
    const done = await dpAnimatePhase(dpPhase);
    if (!done || stamp !== dpStamp) return;
    await new Promise(r => setTimeout(r, 350 / dpSpeed));
    if (stamp !== dpStamp) return;
  }
  dpCommit();
}

export function dpSetSpeed(v: string) {
  const n = parseFloat(v);
  dpSpeed = Number.isFinite(n) && n > 0 ? n : 1;
}

// ---- The pipelined datapath -----------------------------------------
// The pipelined microarchitecture (Microarch_pipelined_full.svg), one
// clock cycle per step: every stage's wires in that stage's colour, with
// the hazard unit's signals and each stage's instruction above it. A
// forwarded value keeps the colour of the stage it came from. The values
// are the pipeline's own (pipeEvaluate), so the drawing shows what the
// model is about to clock.
export const PDP_DRAW = {"full":{"width":3460,"routes":{"f_pc":{"segs":["2.0","2.1"],"pts":[[501.5,903.5],[622,903.5]]},"f_pcf_mux":{"segs":["2.0","106.0","126.0","127.0","206.0"],"pts":[[501.5,903.5],[554.5,903.5],[554.5,1151.5],[138.5,1151.5],[138.5,1039.5],[170.6,1039.5]]},"f_pcf_d":{"segs":["2.0","106.0","106.1","201.0"],"pts":[[501.5,903.5],[554.5,903.5],[554.5,1496.5],[911,1496.5]]},"f_four":{"segs":["20.0"],"pts":[[56.5,762.5],[123.6,762.5]]},"f_addA":{"segs":["19.0"],"pts":[[187.5,797.5],[265.5,797.5]]},"f_addB":{"segs":["117.0"],"pts":[[232.5,998.5],[264.8,998.5]]},"f_pcin":{"segs":["105.0"],"pts":[[339.5,901.5],[426.5,901.5]]},"f_instr":{"segs":["3.0"],"pts":[[853.5,944.5],[911,944.5]]},"d_funct3":{"segs":["3.2","15.1","15.2","15.3","15.4","113.0","113.1"],"pts":[[965,944.5],[1026,944.5],[1026,238.5],[1219.7,238.5]]},"d_op":{"segs":["3.2","15.2","15.3","15.4","94.0"],"pts":[[965,944.5],[1026,944.5],[1026,379.5],[1219.9,379.5]]},"d_funct7":{"segs":["3.2","15.3","15.4","95.0"],"pts":[[965,944.5],[1026,944.5],[1026,511.5],[1219.9,511.5]]},"d_rs1":{"segs":["3.2","5.0","15.4"],"pts":[[965,944.5],[1026,944.5],[1026,905.5],[1209.5,905.5]]},"d_rs2":{"segs":["3.2","15.5","162.0"],"pts":[[965,944.5],[1026,944.5],[1026,1020.5],[1205,1020.5]]},"d_rd":{"segs":["3.2","6.0","15.5","15.6","197.0","199.0","199.1"],"pts":[[965,944.5],[1026,944.5],[1026,1143.5],[1081.5,1143.5],[1081.5,1447.5],[1768,1447.5]]},"d_imm":{"segs":["3.2","15.5","15.6","15.7","27.0"],"pts":[[965,944.5],[1026,944.5],[1026,1350.5],[1352,1350.5]]},"d_immsrc":{"segs":["110.0","110.1","110.2","115.0","115.1"],"pts":[[1445.5,656.5],[1445.5,651.6],[1596.5,651.6],[1596.5,1268.5],[1465.5,1268.5],[1465.5,1306.4]]},"d_ext":{"segs":["28.0"],"pts":[[1561.5,1350.5],[1768,1350.5]]},"d_rd1":{"segs":["153.0"],"pts":[[1569.5,946.5],[1648,946.5]]},"d_rd2":{"segs":["160.0"],"pts":[[1569.5,1128.5],[1648,1128.5]]},"d_rd1_e":{"segs":["141.0","152.0","169.0"],"pts":[[1713.5,992.5],[1743.5,992.5],[1743.5,899.5],[1768,899.5]]},"d_rd2_e":{"segs":["147.0","159.0","170.0"],"pts":[[1712.5,1175.5],[1746.5,1175.5],[1746.5,1080.5],[1768,1080.5]]},"d_pcd":{"segs":["201.2"],"pts":[[965,1496.5],[1768,1496.5]]},"d_pcs":{"segs":["109.0"],"pts":[[1451,170.5],[1768,170.5]]},"d_funct3_pc":{"segs":["3.2","15.1","15.2","15.3","15.4","113.0","x.25","x.26","x.27","x.28"],"pts":[[965,944.5],[1026,944.5],[1026,238.5],[1188,238.5],[1188,86.5],[1600,86.5],[1600,240.5],[1768,240.5]]},"d_regwrite":{"segs":["189.0"],"pts":[[1451,311.5],[1768,311.5]]},"d_memtoreg":{"segs":["188.0"],"pts":[[1451,372.5],[1768,372.5]]},"d_memwrite":{"segs":["186.0"],"pts":[[1451,435.5],[1768,435.5]]},"d_aluctl":{"segs":["184.0"],"pts":[[1454.5,506.5],[1768,506.5]]},"d_alusrcb":{"segs":["x.11"],"pts":[[1451,612],[1768,612]]},"e_rd1":{"segs":["141.2"],"pts":[[1823,899.5],[2077.9,899.5]]},"e_rd2":{"segs":["147.2"],"pts":[[1823,1080.5],[1994.4,1080.5]]},"e_srca":{"segs":["x.0","x.1"],"pts":[[2143.5,946.5],[2300,946.5]]},"e_fwdb":{"segs":["123.0","123.1"],"pts":[[2056.5,1128.5],[2304.2,1128.5]]},"e_wd":{"segs":["104.0","104.1","123.0","134.0"],"pts":[[2056.5,1128.5],[2078.5,1128.5],[2078.5,1278.5],[2628,1278.5]]},"e_ext":{"segs":["28.2","118.0","124.0"],"pts":[[1823,1350.5],[1868.5,1350.5],[1868.5,1223.5],[2304,1223.5]]},"e_ext_pc":{"segs":["21.0","21.1","28.2","107.0","118.1","208.0","208.1"],"pts":[[1823,1350.5],[1868.5,1350.5],[1868.5,1600.5],[42.5,1600.5],[42.5,835.5],[123.9,835.5]]},"e_pce":{"segs":["201.4","207.0","209.0","209.1","x.21","x.22"],"pts":[[1823,1496.5],[1837.5,1496.5],[1837.5,1551.5],[102.5,1551.5],[102.5,944],[169.5,944]]},"e_srcb":{"segs":["122.0"],"pts":[[2361.5,1175.5],[2392.6,1175.5]]},"e_alu":{"segs":["14.0"],"pts":[[2509.5,1024.5],[2628,1024.5]]},"e_flags":{"segs":["79.0","83.0"],"pts":[[2508.5,936.5],[2537.5,936.5],[2537.5,279.5]]},"e_rd":{"segs":["197.2"],"pts":[[1823,1447.5],[2628,1447.5]]},"e_pcs":{"segs":["109.2"],"pts":[[1823,170.5],[2433,170.5]]},"e_funct3":{"segs":["x.30"],"pts":[[1823,240.5],[2433,240.5]]},"e_regwrite":{"segs":["189.2"],"pts":[[1823,311.5],[2628,311.5]]},"e_memtoreg":{"segs":["188.2"],"pts":[[1823,372.5],[2628,372.5]]},"e_memwrite":{"segs":["186.2"],"pts":[[1823,435.5],[2628,435.5]]},"e_aluctl":{"segs":["183.0","184.2"],"pts":[[1823,506.5],[2452.5,506.5],[2452.5,881.6]]},"e_alusrcb":{"segs":["x.13","x.14","x.15","x.16"],"pts":[[1823,612],[2230,612],[2230,1062],[2333,1062],[2333,1111.6]]},"e_pcsrc_top":{"segs":["84.0","85.0","85.1","136.0","137.0"],"pts":[[2561.5,170.5],[2610.5,170.5],[2610.5,57.5],[158.5,57.5],[158.5,733.8]]},"e_pcsrc_low":{"segs":["84.0","85.0","136.0","137.0","226.0","sel.0"],"pts":[[2561.5,170.5],[2610.5,170.5],[2610.5,57.5],[158.5,57.5],[158.5,638.5],[209.5,638.5],[209.5,933.4]]},"m_addr":{"segs":["14.2","14.3"],"pts":[[2682,1024.5],[2876.4,1024.5]]},"m_alu_w":{"segs":["13.0","14.2","164.0"],"pts":[[2682,1024.5],[2715.5,1024.5],[2715.5,1408.5],[3167,1408.5]]},"m_fwd_ae":{"segs":["14.2","128.0","128.1","142.0","164.0","164.1","165.0","165.1"],"pts":[[2682,1024.5],[2715.5,1024.5],[2715.5,1560.5],[1944.5,1560.5],[1944.5,994.5],[2078.8,994.5]]},"m_fwd_be":{"segs":["14.2","128.0","128.1","148.0","164.0","164.1","165.1"],"pts":[[2682,1024.5],[2715.5,1024.5],[2715.5,1560.5],[1944.5,1560.5],[1944.5,1174.5],[1991.2,1174.5]]},"m_wd":{"segs":["134.2"],"pts":[[2682,1278.5],[2784.2,1278.5]]},"m_dmwd":{"segs":["133.0"],"pts":[[2846.5,1307.5],[2879.2,1307.5]]},"m_rdata":{"segs":["24.0"],"pts":[[3111.5,1021.5],[3167,1021.5]]},"m_rd":{"segs":["197.4"],"pts":[[2682,1447.5],[3167,1447.5]]},"m_regwrite":{"segs":["189.4"],"pts":[[2682,311.5],[3167,311.5]]},"m_memtoreg":{"segs":["188.4"],"pts":[[2682,372.5],[3167,372.5]]},"m_memwrite":{"segs":["185.0","186.4","186.5"],"pts":[[2682,435.5],[2998.5,435.5],[2998.5,961.2]]},"w_rdata":{"segs":["12.0","23.0","24.2"],"pts":[[3221,1021.5],[3274.5,1021.5],[3274.5,1330.5],[3325.8,1330.5]]},"w_alu":{"segs":["13.2"],"pts":[[3221,1408.5],[3329.1,1408.5]]},"w_memtoreg":{"segs":["187.0","188.6"],"pts":[[3221,372.5],[3362.5,372.5],[3362.5,1303]]},"w_result":{"segs":["11.0","11.1","22.0"],"pts":[[3393.5,1360.5],[3439.5,1360.5],[3439.5,1650.5]]},"w_rf":{"segs":["11.0","11.1","22.0","29.0","30.0","30.1","100.0","100.1","100.2","100.3"],"pts":[[3393.5,1360.5],[3439.5,1360.5],[3439.5,1650.5],[1164.5,1650.5],[1164.5,1199.5],[1213.1,1199.5]]},"w_fwd_1d":{"segs":["11.0","11.1","22.0","100.1","100.2","100.3","154.0","171.0","171.1"],"pts":[[3393.5,1360.5],[3439.5,1360.5],[3439.5,1650.5],[1613.5,1650.5],[1613.5,1040.5],[1649,1040.5]]},"w_fwd_2d":{"segs":["11.0","11.1","22.0","100.1","100.2","100.3","161.0","171.1"],"pts":[[3393.5,1360.5],[3439.5,1360.5],[3439.5,1650.5],[1613.5,1650.5],[1613.5,1222.5],[1647.5,1222.5]]},"w_fwd_ae":{"segs":["11.0","11.1","22.0","100.2","100.3","166.1","166.2","167.0"],"pts":[[3393.5,1360.5],[3439.5,1360.5],[3439.5,1650.5],[1905.5,1650.5],[1905.5,947.5],[2078.6,947.5]]},"w_fwd_be":{"segs":["11.0","11.1","22.0","100.2","100.3","166.2","168.0"],"pts":[[3393.5,1360.5],[3439.5,1360.5],[3439.5,1650.5],[1905.5,1650.5],[1905.5,1129.5],[1992.7,1129.5]]},"w_fwd_m":{"segs":["11.0","11.1","22.0","100.3","135.0","163.0"],"pts":[[3393.5,1360.5],[3439.5,1360.5],[3439.5,1650.5],[2747.5,1650.5],[2747.5,1341.5],[2786.7,1341.5]]},"w_rd":{"segs":["195.0","196.0","197.6","198.1","200.0"],"pts":[[3221,1447.5],[3250.5,1447.5],[3250.5,1704.5],[1124.5,1704.5],[1124.5,1142.5],[1209.7,1142.5]]},"w_regwrite":{"segs":["189.6","189.7","190.0","191.0","192.0","193.0","194.0","194.1"],"pts":[[3221,311.5],[3364.5,311.5],[3364.5,4.5],[1156.5,4.5],[1156.5,730.5],[1428.5,730.5],[1428.5,831.7]]},"h_stallf":{"segs":["264.0"],"pts":[[463.5,1948.4],[463.5,1013.5]]},"h_stalld":{"segs":["263.0"],"pts":[[927.5,1945.8],[927.5,1522.5]]},"h_flushd":{"segs":["262.0"],"pts":[[956.5,1949.6],[956.5,1513.5]]},"h_flushe":{"segs":["261.0"],"pts":[[1797.5,1947.6],[1797.5,1511.5]]},"h_fwd_1d":{"segs":["155.0","256.0","257.0"],"pts":[[1730.5,1951.1],[1730.5,1081.5],[1683.5,1081.5],[1683.5,1051.5]]},"h_fwd_2d":{"segs":["255.0"],"pts":[[1678.5,1950],[1678.5,1233.5]]},"h_fwd_ae":{"segs":["259.0"],"pts":[[2113.5,1946.8],[2113.5,1002.5]]},"h_fwd_be":{"segs":["258.0"],"pts":[[2028.5,1950.5],[2028.5,1185.5]]},"h_fwd_m":{"segs":["260.0"],"pts":[[2820.5,1953.7],[2820.5,1361.5]]},"e_srca_alu":{"segs":["x.2"],"pts":[[2365,946.5],[2384.6,946.5]]},"e_zero":{"segs":["x.3"],"pts":[[2280,899.5],[2300,899.5]]},"e_pce_a":{"segs":["201.4","209.0","x.4","x.5","x.6"],"pts":[[1823,1496.5],[1837.5,1496.5],[1837.5,1525],[2205,1525],[2205,994.5],[2300,994.5]]},"e_rd1_pc":{"segs":["x.0","x.17","x.18","x.19","x.20"],"pts":[[2143.5,946.5],[2155,946.5],[2155,1740],[72,1740],[72,992],[169.5,992]]},"d_alusrca":{"segs":["x.7"],"pts":[[1454.5,573.5],[1768,573.5]]},"e_alusrca":{"segs":["x.9","x.10"],"pts":[[1823,573.5],[2332.5,573.5],[2332.5,883.6]]},"e_four":{"segs":["x.24"],"pts":[[2281,1175.5],[2300.5,1175.5]]}},"muxes":{"pcTop":{"e":"16","ins":{"0":[124.5,762.5],"1":[124.5,835.5]},"out":[189.5,797.5]},"fwd1D":{"e":"149","ins":{"0":[1648.5,946.5],"1":[1648.5,1040.5]},"out":[1713.5,992.5]},"fwd2D":{"e":"156","ins":{"0":[1648.5,1128.5],"1":[1648.5,1222.5]},"out":[1713.5,1175.5]},"fwdAE":{"e":"139","ins":{"00":[2076.5,899.5],"01":[2076.5,947.5],"10":[2076.5,994.5]},"out":[2141.5,946.5]},"fwdBE":{"e":"143","ins":{"00":[1992.5,1080.5],"01":[1992.5,1129.5],"10":[1992.5,1174.5]},"out":[2057.5,1128.5]},"fwdM":{"e":"130","ins":{"0":[2784.5,1278.5],"1":[2784.5,1341.5]},"out":[2848.5,1307.5]},"result":{"e":"8","ins":{"1":[3327.5,1330.5],"0":[3327.5,1408.5]},"out":[3392.5,1360.5]},"pcLow":{"e":"muxPC","ins":{"00":[169.5,1039.5],"01":[169.5,944],"11":[169.5,992]},"out":[234.5,998.5]},"aluSrcA":{"e":"muxA","ins":{"01":[2300,899.5],"x0":[2300,946.5],"11":[2300,994.5]},"out":[2365,946.5]},"aluSrcB":{"e":"119","ins":{"x0":[2300.5,1128.5],"01":[2300.5,1175.5],"11":[2300.5,1223.5]},"out":[2365.5,1175.5]}},"blocks":{"pc":"1","im":"0","rf":"4","decoder":"86","extend":"26","alu":"55","pcLogic":"82","dm":"7","regD":"223","regE":"224","regM":"225","regW":"217","hazard":"242","adder":"41"}},"bp":{"width":3460,"routes":{"f_pc":{"segs":["2.0","2.1"],"pts":[[541.5,903.5],[622,903.5]]},"f_pcf_d":{"segs":["2.0","106.0","106.1","201.0"],"pts":[[541.5,903.5],[554.5,903.5],[554.5,1496.5],[911,1496.5]]},"f_four":{"segs":["20.0"],"pts":[[56.5,762.5],[123.6,762.5]]},"f_addA":{"segs":["19.0"],"pts":[[187.5,797.5],[265.5,797.5]]},"f_addB":{"segs":["b.0"],"pts":[[234.5,998.5],[264.8,998.5]]},"f_pcin":{"segs":["b.4"],"pts":[[433,922.5],[462,922.5]]},"f_instr":{"segs":["3.0"],"pts":[[853.5,944.5],[911,944.5]]},"d_funct3":{"segs":["3.2","15.1","15.2","15.3","15.4","113.0","113.1"],"pts":[[965,944.5],[1026,944.5],[1026,238.5],[1219.7,238.5]]},"d_op":{"segs":["3.2","15.2","15.3","15.4","94.0"],"pts":[[965,944.5],[1026,944.5],[1026,379.5],[1219.9,379.5]]},"d_funct7":{"segs":["3.2","15.3","15.4","95.0"],"pts":[[965,944.5],[1026,944.5],[1026,511.5],[1219.9,511.5]]},"d_rs1":{"segs":["3.2","5.0","15.4"],"pts":[[965,944.5],[1026,944.5],[1026,905.5],[1209.5,905.5]]},"d_rs2":{"segs":["3.2","15.5","162.0"],"pts":[[965,944.5],[1026,944.5],[1026,1020.5],[1205,1020.5]]},"d_rd":{"segs":["3.2","6.0","15.5","15.6","197.0","199.0","199.1"],"pts":[[965,944.5],[1026,944.5],[1026,1143.5],[1081.5,1143.5],[1081.5,1447.5],[1768,1447.5]]},"d_imm":{"segs":["3.2","15.5","15.6","15.7","27.0"],"pts":[[965,944.5],[1026,944.5],[1026,1350.5],[1352,1350.5]]},"d_immsrc":{"segs":["110.0","110.1","110.2","115.0","115.1"],"pts":[[1445.5,656.5],[1445.5,651.6],[1596.5,651.6],[1596.5,1268.5],[1465.5,1268.5],[1465.5,1306.4]]},"d_ext":{"segs":["28.0"],"pts":[[1561.5,1350.5],[1768,1350.5]]},"d_rd1":{"segs":["153.0"],"pts":[[1569.5,946.5],[1648,946.5]]},"d_rd2":{"segs":["160.0"],"pts":[[1569.5,1128.5],[1648,1128.5]]},"d_rd1_e":{"segs":["141.0","152.0","169.0"],"pts":[[1713.5,992.5],[1743.5,992.5],[1743.5,899.5],[1768,899.5]]},"d_rd2_e":{"segs":["147.0","159.0","170.0"],"pts":[[1712.5,1175.5],[1746.5,1175.5],[1746.5,1080.5],[1768,1080.5]]},"d_pcd":{"segs":["201.2"],"pts":[[965,1496.5],[1768,1496.5]]},"d_pcs":{"segs":["109.0"],"pts":[[1451,170.5],[1768,170.5]]},"d_funct3_pc":{"segs":["3.2","15.1","15.2","15.3","15.4","113.0","x.25","x.26","x.27","x.28"],"pts":[[965,944.5],[1026,944.5],[1026,238.5],[1188,238.5],[1188,86.5],[1600,86.5],[1600,240.5],[1768,240.5]]},"d_regwrite":{"segs":["189.0"],"pts":[[1451,311.5],[1768,311.5]]},"d_memtoreg":{"segs":["188.0"],"pts":[[1451,372.5],[1768,372.5]]},"d_memwrite":{"segs":["186.0"],"pts":[[1451,435.5],[1768,435.5]]},"d_aluctl":{"segs":["184.0"],"pts":[[1454.5,506.5],[1768,506.5]]},"d_alusrcb":{"segs":["x.11"],"pts":[[1451,612],[1768,612]]},"e_rd1":{"segs":["141.2"],"pts":[[1823,899.5],[2077.9,899.5]]},"e_rd2":{"segs":["147.2"],"pts":[[1823,1080.5],[1994.4,1080.5]]},"e_srca":{"segs":["x.0","x.1"],"pts":[[2143.5,946.5],[2300,946.5]]},"e_fwdb":{"segs":["123.0","123.1"],"pts":[[2056.5,1128.5],[2304.2,1128.5]]},"e_wd":{"segs":["104.0","104.1","123.0","134.0"],"pts":[[2056.5,1128.5],[2078.5,1128.5],[2078.5,1278.5],[2628,1278.5]]},"e_ext":{"segs":["28.2","118.0","124.0"],"pts":[[1823,1350.5],[1868.5,1350.5],[1868.5,1223.5],[2304,1223.5]]},"e_ext_pc":{"segs":["21.0","21.1","28.2","107.0","118.1","208.0","208.1"],"pts":[[1823,1350.5],[1868.5,1350.5],[1868.5,1600.5],[42.5,1600.5],[42.5,835.5],[123.9,835.5]]},"e_pce":{"segs":["201.4","207.0","207.1","209.0","209.1","x.21","x.22"],"pts":[[1823,1496.5],[1837.5,1496.5],[1837.5,1551.5],[102.5,1551.5],[102.5,957],[169.5,957]]},"e_srcb":{"segs":["122.0"],"pts":[[2361.5,1175.5],[2392.6,1175.5]]},"e_alu":{"segs":["14.0"],"pts":[[2509.5,1024.5],[2628,1024.5]]},"e_flags":{"segs":["79.0","83.0"],"pts":[[2508.5,936.5],[2537.5,936.5],[2537.5,279.5]]},"e_rd":{"segs":["197.2"],"pts":[[1823,1447.5],[2628,1447.5]]},"e_pcs":{"segs":["109.2"],"pts":[[1823,170.5],[2433,170.5]]},"e_funct3":{"segs":["x.30"],"pts":[[1823,240.5],[2433,240.5]]},"e_regwrite":{"segs":["189.2"],"pts":[[1823,311.5],[2628,311.5]]},"e_memtoreg":{"segs":["188.2"],"pts":[[1823,372.5],[2628,372.5]]},"e_memwrite":{"segs":["186.2"],"pts":[[1823,435.5],[2628,435.5]]},"e_aluctl":{"segs":["183.0","184.2"],"pts":[[1823,506.5],[2452.5,506.5],[2452.5,881.6]]},"e_alusrcb":{"segs":["x.13","x.14","x.15","x.16"],"pts":[[1823,612],[2230,612],[2230,1062],[2333,1062],[2333,1111.6]]},"e_pcsrc_top":{"segs":["84.0","84.1","85.0","85.1","136.0","137.0"],"pts":[[2561.5,170.5],[2610.5,170.5],[2610.5,57.5],[158.5,57.5],[158.5,733.8]]},"e_pcsrc_low":{"segs":["84.0","84.1","85.0","136.0","137.0","226.0","b.1"],"pts":[[2561.5,170.5],[2610.5,170.5],[2610.5,57.5],[158.5,57.5],[158.5,638.5],[209.5,638.5],[209.5,933.4]]},"m_addr":{"segs":["14.2","14.3"],"pts":[[2682,1024.5],[2876.4,1024.5]]},"m_alu_w":{"segs":["13.0","14.2","164.0"],"pts":[[2682,1024.5],[2715.5,1024.5],[2715.5,1408.5],[3167,1408.5]]},"m_fwd_ae":{"segs":["14.2","128.0","128.1","142.0","164.0","164.1","165.0","165.1"],"pts":[[2682,1024.5],[2715.5,1024.5],[2715.5,1560.5],[1944.5,1560.5],[1944.5,994.5],[2078.8,994.5]]},"m_fwd_be":{"segs":["14.2","128.0","128.1","148.0","164.0","164.1","165.1"],"pts":[[2682,1024.5],[2715.5,1024.5],[2715.5,1560.5],[1944.5,1560.5],[1944.5,1174.5],[1991.2,1174.5]]},"m_wd":{"segs":["134.2"],"pts":[[2682,1278.5],[2784.2,1278.5]]},"m_dmwd":{"segs":["133.0"],"pts":[[2846.5,1307.5],[2879.2,1307.5]]},"m_rdata":{"segs":["24.0"],"pts":[[3111.5,1021.5],[3167,1021.5]]},"m_rd":{"segs":["197.4"],"pts":[[2682,1447.5],[3167,1447.5]]},"m_regwrite":{"segs":["189.4"],"pts":[[2682,311.5],[3167,311.5]]},"m_memtoreg":{"segs":["188.4"],"pts":[[2682,372.5],[3167,372.5]]},"m_memwrite":{"segs":["185.0","186.4","186.5"],"pts":[[2682,435.5],[2998.5,435.5],[2998.5,961.2]]},"w_rdata":{"segs":["12.0","23.0","24.2"],"pts":[[3221,1021.5],[3274.5,1021.5],[3274.5,1330.5],[3325.8,1330.5]]},"w_alu":{"segs":["13.2"],"pts":[[3221,1408.5],[3329.1,1408.5]]},"w_memtoreg":{"segs":["187.0","188.6"],"pts":[[3221,372.5],[3362.5,372.5],[3362.5,1303]]},"w_result":{"segs":["11.0","11.1","22.0"],"pts":[[3393.5,1360.5],[3439.5,1360.5],[3439.5,1650.5]]},"w_rf":{"segs":["11.0","11.1","22.0","29.0","30.0","30.1","100.0","100.1","100.2","100.3"],"pts":[[3393.5,1360.5],[3439.5,1360.5],[3439.5,1650.5],[1164.5,1650.5],[1164.5,1199.5],[1213.1,1199.5]]},"w_fwd_1d":{"segs":["11.0","11.1","22.0","100.1","100.2","100.3","154.0","171.0","171.1"],"pts":[[3393.5,1360.5],[3439.5,1360.5],[3439.5,1650.5],[1613.5,1650.5],[1613.5,1040.5],[1649,1040.5]]},"w_fwd_2d":{"segs":["11.0","11.1","22.0","100.1","100.2","100.3","161.0","171.1"],"pts":[[3393.5,1360.5],[3439.5,1360.5],[3439.5,1650.5],[1613.5,1650.5],[1613.5,1222.5],[1647.5,1222.5]]},"w_fwd_ae":{"segs":["11.0","11.1","22.0","100.2","100.3","166.1","166.2","167.0"],"pts":[[3393.5,1360.5],[3439.5,1360.5],[3439.5,1650.5],[1905.5,1650.5],[1905.5,947.5],[2078.6,947.5]]},"w_fwd_be":{"segs":["11.0","11.1","22.0","100.2","100.3","166.2","168.0"],"pts":[[3393.5,1360.5],[3439.5,1360.5],[3439.5,1650.5],[1905.5,1650.5],[1905.5,1129.5],[1992.7,1129.5]]},"w_fwd_m":{"segs":["11.0","11.1","22.0","100.3","135.0","163.0"],"pts":[[3393.5,1360.5],[3439.5,1360.5],[3439.5,1650.5],[2747.5,1650.5],[2747.5,1341.5],[2786.7,1341.5]]},"w_rd":{"segs":["195.0","196.0","197.6","198.1","200.0"],"pts":[[3221,1447.5],[3250.5,1447.5],[3250.5,1704.5],[1124.5,1704.5],[1124.5,1142.5],[1209.7,1142.5]]},"w_regwrite":{"segs":["189.6","189.7","190.0","191.0","192.0","193.0","194.0","194.1"],"pts":[[3221,311.5],[3364.5,311.5],[3364.5,4.5],[1156.5,4.5],[1156.5,730.5],[1428.5,730.5],[1428.5,831.7]]},"h_stallf":{"segs":["264.0"],"pts":[[503.5,1948.4],[503.5,1013.5]]},"h_stalld":{"segs":["263.0"],"pts":[[927.5,1945.8],[927.5,1522.5]]},"h_flushd":{"segs":["262.0"],"pts":[[956.5,1949.6],[956.5,1513.5]]},"h_flushe":{"segs":["261.0"],"pts":[[1797.5,1947.6],[1797.5,1511.5]]},"h_fwd_1d":{"segs":["155.0","256.0","257.0"],"pts":[[1730.5,1951.1],[1730.5,1081.5],[1683.5,1081.5],[1683.5,1051.5]]},"h_fwd_2d":{"segs":["255.0"],"pts":[[1678.5,1950],[1678.5,1233.5]]},"h_fwd_ae":{"segs":["259.0"],"pts":[[2113.5,1946.8],[2113.5,1002.5]]},"h_fwd_be":{"segs":["258.0"],"pts":[[2028.5,1950.5],[2028.5,1185.5]]},"h_fwd_m":{"segs":["260.0"],"pts":[[2820.5,1953.7],[2820.5,1361.5]]},"e_srca_alu":{"segs":["x.2"],"pts":[[2365,946.5],[2384.6,946.5]]},"e_zero":{"segs":["x.3"],"pts":[[2280,899.5],[2300,899.5]]},"e_pce_a":{"segs":["201.4","209.0","x.4","x.5","x.6"],"pts":[[1823,1496.5],[1837.5,1496.5],[1837.5,1525],[2205,1525],[2205,994.5],[2300,994.5]]},"e_rd1_pc":{"segs":["x.0","x.17","x.18","x.19","x.20"],"pts":[[2143.5,946.5],[2155,946.5],[2155,1740],[72,1740],[72,1030],[169.5,1030]]},"d_alusrca":{"segs":["x.7"],"pts":[[1454.5,573.5],[1768,573.5]]},"e_alusrca":{"segs":["x.9","x.10"],"pts":[[1823,573.5],[2332.5,573.5],[2332.5,883.6]]},"e_four":{"segs":["x.24"],"pts":[[2281,1175.5],[2300.5,1175.5]]},"e_nextpc":{"segs":["b.2","b.3"],"pts":[[339.5,901.5],[398,901.5]]},"e_nextpc_bp":{"segs":["b.2","b.5","b.6","b.7"],"pts":[[339.5,901.5],[362,901.5],[362,1455],[640,1455],[640,1435]]},"bp_pred":{"segs":["b.8","b.9","b.10"],"pts":[[575,1305],[380,1305],[380,945],[398,945]]},"bp_miss":{"segs":["b.11","b.12"],"pts":[[575,1250],[415.5,1250],[415.5,970]]},"bp_pcf":{"segs":["2.0","106.0","b.13"],"pts":[[541.5,903.5],[554.5,903.5],[554.5,1390],[575,1390]]},"bp_pcsrc":{"segs":["84.1","136.0","137.0","b.14","b.15","b.16"],"pts":[[2561.5,170.5],[2610.5,170.5],[2610.5,57.5],[605,57.5],[605,1195],[800,1195],[800,1215]]},"bp_pce":{"segs":["201.4","207.1","209.0","209.1","b.17"],"pts":[[1823,1496.5],[1837.5,1496.5],[1837.5,1551.5],[760,1551.5],[760,1435]]}},"muxes":{"pcTop":{"e":"16","ins":{"0":[124.5,762.5],"1":[124.5,835.5]},"out":[189.5,797.5]},"fwd1D":{"e":"149","ins":{"0":[1648.5,946.5],"1":[1648.5,1040.5]},"out":[1713.5,992.5]},"fwd2D":{"e":"156","ins":{"0":[1648.5,1128.5],"1":[1648.5,1222.5]},"out":[1713.5,1175.5]},"fwdAE":{"e":"139","ins":{"00":[2076.5,899.5],"01":[2076.5,947.5],"10":[2076.5,994.5]},"out":[2141.5,946.5]},"fwdBE":{"e":"143","ins":{"00":[1992.5,1080.5],"01":[1992.5,1129.5],"10":[1992.5,1174.5]},"out":[2057.5,1128.5]},"fwdM":{"e":"130","ins":{"0":[2784.5,1278.5],"1":[2784.5,1341.5]},"out":[2848.5,1307.5]},"result":{"e":"8","ins":{"1":[3327.5,1330.5],"0":[3327.5,1408.5]},"out":[3392.5,1360.5]},"pcLow":{"e":"muxPC","ins":{"0":[169.5,957],"1":[169.5,1030]},"out":[234.5,998.5]},"aluSrcA":{"e":"muxA","ins":{"01":[2300,899.5],"x0":[2300,946.5],"11":[2300,994.5]},"out":[2365,946.5]},"aluSrcB":{"e":"119","ins":{"x0":[2300.5,1128.5],"01":[2300.5,1175.5],"11":[2300.5,1223.5]},"out":[2365.5,1175.5]},"pcM":{"e":"muxM","ins":{"1":[398,901.5],"0":[398,945]},"out":[433,922.5]}},"blocks":{"pc":"1","im":"0","rf":"4","decoder":"86","extend":"26","alu":"55","pcLogic":"82","dm":"7","regD":"223","regE":"224","regM":"225","regW":"217","hazard":"242","adder":"41","bp":"bp"}}};
export const PDP_COLOUR: Record<string, string> = { F: '#209fb5', D: '#40a02b', E: '#fe640b', M: '#8839ef', W: '#d20f39', H: '#1e66f5' };
export const PDP_STAGE_NAMES: Record<string, string> = { F: 'Fetch', D: 'Decode', E: 'Execute', M: 'Memory', W: 'Writeback' };
export const PDP_FWD_FROM: Record<string, string> = { '00': 'E', '01': 'W', '10': 'M' };

// A pipelined drawing (tools/pdp_build.py writes PDP_DRAW): its wires, its
// muxes (shape, inputs by select value, output) and its blocks.
export interface PdpTable {
  width: number; routes: Record<string, DpWire>;
  muxes: Record<string, { e: string; ins: Record<string, number[]>; out: number[] }>;
  blocks: Record<string, string>;
}
export function pdpTable(): PdpTable { return PDP_DRAW[pipeline.predictor.on ? 'bp' : 'full']; }

export function pdpText(addr: number) {
  const item = program.machineCode.find(it => it.address === (addr >>> 0) && it.bytes);
  return item ? (item.native || item.text || '').trim() : dpHex(readMem(addr >>> 0, 4, true));
}

export function pdpEvaluate() {
  const s = pipeEvaluate();
  return {
    pipe: true as const, s, cycle: cpu.totalCycles,
    st: { F: s.instrF ? { pc: s.pcF, instr: s.instrF } : null, D: pipeline.regs.D, E: pipeline.regs.E, M: pipeline.regs.M, W: pipeline.regs.W },
  };
}

// Every wire this cycle uses, as [route, stage or 'off', chip text].
export function pdpRoutes(m: PdpModel) {
  const s = m.s, st = m.st, out: [route: string, stage: string, chip: string | null][] = [];
  const on = (r: string, stage: string, chip?: string | null | undefined) => out.push([r, stage, chip === undefined ? null : chip]);
  const off = (r: string) => out.push([r, 'off', null]);
  const hex = dpHex;

  on('f_pc', 'F', hex(s.pcF));
  on('f_pcf_d', 'F');
  if (st.F) on('f_instr', 'F', hex(s.instrF));
  if (pipeline.predictor.on) {
    // The adder only ever works out PCNextE, for the instruction in E.
    on('bp_pcf', 'F');
    if (st.E) {
      if (s.pcSrcE) {
        on('e_ext_pc', 'E'); off('f_four');
        on('e_pcsrc_top', 'E'); on('bp_pcsrc', 'E');
        if (s.pcSrc === '11') on('e_pcsrc_low', 'E');
      } else {
        on('f_four', 'E'); off('e_ext_pc');
      }
      if (s.pcSrc === '11') on('e_rd1_pc', PDP_FWD_FROM[s.forwardAE]); else on('e_pce', 'E');
      on('f_addA', 'E'); on('f_addB', 'E');
      on('e_nextpc', 'E'); on('e_nextpc_bp', 'E', hex(s.pcNextE)); on('bp_pce', 'E');
    }
    on('bp_pred', 'F', hex(s.predPCF));
    if (s.mispredict) on('bp_miss', 'E');
    // PC' is PCNextE or PrPCF, both already on show.
    on('f_pcin', s.mispredict ? 'E' : 'F');
  } else {
    if (s.pcSrcE) {
      off('f_four'); off('f_pcf_mux');
      on('e_ext_pc', 'E');
      if (s.pcSrc === '11') on('e_rd1_pc', PDP_FWD_FROM[s.forwardAE]); else on('e_pce', 'E');
      on('e_pcsrc_top', 'E'); on('e_pcsrc_low', 'E');
    } else {
      on('f_four', 'F'); on('f_pcf_mux', 'F');
    }
    const nextBy = s.pcSrcE ? 'E' : 'F';
    on('f_addA', nextBy); on('f_addB', nextBy); on('f_pcin', nextBy, hex(s.pcIn));
  }

  if (st.D) {
    const d = st.D.dec;
    ['d_op', 'd_funct3', 'd_funct7', 'd_rs1', 'd_rs2'].forEach(r => on(r, 'D'));
    on('d_rd', 'D', 'x' + d.rd);
    on('d_pcd', 'D');
    if (!d.serial) {
      if (d.ImmSrc !== 'xxx') { on('d_imm', 'D'); on('d_immsrc', 'D'); on('d_ext', 'D', hex(d.extImm)); }
      else { off('d_imm'); off('d_ext'); }
      if (s.forward1D) off('d_rd1'); else on('d_rd1', 'D');
      if (s.forward2D) off('d_rd2'); else on('d_rd2', 'D');
      on('d_rd1_e', s.forward1D ? 'W' : 'D', hex(s.rd1D));
      on('d_rd2_e', s.forward2D ? 'W' : 'D', hex(s.rd2D));
      if (d.PCS !== '00') on('d_pcs', 'D');
      if (d.PCS === '01') on('d_funct3_pc', 'D');
      if (d.RegWrite) on('d_regwrite', 'D');
      if (d.MemtoReg) on('d_memtoreg', 'D');
      if (d.MemWrite) on('d_memwrite', 'D');
      on('d_aluctl', 'D');
      if (ctlBit(d.ALUSrcB, 0) === '1') on('d_alusrcb', 'D');
      if (ctlBit(d.ALUSrcA, 0) === '1') on('d_alusrca', 'D');
    }
  }

  if (st.E) {
    const e = st.E;
    const fromA = PDP_FWD_FROM[s.forwardAE], fromB = PDP_FWD_FROM[s.forwardBE];
    if (s.forwardAE === '00') on('e_rd1', 'E'); else off('e_rd1');
    if (s.forwardBE === '00') on('e_rd2', 'E'); else off('e_rd2');
    const aRD1 = ctlBit(e.ALUSrcA, 0) !== '1';
    if (aRD1 || s.pcSrc === '11') on('e_srca', fromA, aRD1 ? hex(s.srcAfwd) : null); else off('e_srca');
    on('e_srca_alu', 'E', hex(s.srcA));
    if (e.ALUSrcA === '01') on('e_zero', 'E'); else off('e_zero');
    if (e.ALUSrcA === '11') on('e_pce_a', 'E'); else off('e_pce_a');
    if (!aRD1) on('e_alusrca', 'E');
    const bRD2 = ctlBit(e.ALUSrcB, 0) !== '1';
    if (bRD2) on('e_fwdb', fromB); else off('e_fwdb');
    if (e.MemWrite) on('e_wd', fromB, hex(s.writeDataE)); else off('e_wd');
    if (e.ALUSrcB === '11') on('e_ext', 'E', hex(e.extImm)); else off('e_ext');
    if (e.ALUSrcB === '01') on('e_four', 'E'); else off('e_four');
    on('e_srcb', 'E', hex(s.srcB));
    on('e_alu', 'E', hex(s.aluResultE === null ? 0 : s.aluResultE));
    if (e.PCS === '01') on('e_flags', 'E'); else off('e_flags');
    on('e_rd', 'E');
    if (e.PCS !== '00') on('e_pcs', 'E');
    if (e.PCS === '01') on('e_funct3', 'E');
    if (e.RegWrite) on('e_regwrite', 'E');
    if (e.MemtoReg) on('e_memtoreg', 'E');
    if (e.MemWrite) on('e_memwrite', 'E');
    on('e_aluctl', 'E');
    if (!bRD2) on('e_alusrcb', 'E');
  }

  if (st.M) {
    const mm = st.M, memOp = mm.MemWrite || mm.MemtoReg;
    if (memOp) on('m_addr', 'M', hex(mm.aluResult)); else off('m_addr');
    on('m_alu_w', 'M', memOp ? null : hex(mm.aluResult));
    if (mm.MemWrite) {
      if (s.forwardM) off('m_wd'); else on('m_wd', 'M');
      on('m_dmwd', s.forwardM ? 'W' : 'M', hex(s.writeDataM));
    } else { off('m_wd'); off('m_dmwd'); }
    if (mm.MemtoReg) on('m_rdata', 'M', hex(s.readDataM)); else off('m_rdata');
    on('m_rd', 'M');
    if (mm.RegWrite) on('m_regwrite', 'M');
    if (mm.MemtoReg) on('m_memtoreg', 'M');
    if (mm.MemWrite) on('m_memwrite', 'M');
    if (s.forwardAE === '10') on('m_fwd_ae', 'M');
    if (s.forwardBE === '10') on('m_fwd_be', 'M');
  }

  if (st.W) {
    const w = st.W;
    if (w.MemtoReg) { on('w_rdata', 'W'); off('w_alu'); on('w_memtoreg', 'W'); }
    else { off('w_rdata'); on('w_alu', 'W'); }
    on('w_result', 'W', hex(s.resultW));
    if (w.RegWrite) {
      on('w_regwrite', 'W');
      on('w_rd', 'W', 'x' + w.rd);
      if (s.wrW) on('w_rf', 'W');
    }
    if (s.forward1D) on('w_fwd_1d', 'W');
    if (s.forward2D) on('w_fwd_2d', 'W');
    if (s.forwardAE === '01') on('w_fwd_ae', 'W');
    if (s.forwardBE === '01') on('w_fwd_be', 'W');
    if (s.forwardM) on('w_fwd_m', 'W');
  }
  return out;
}

// Which input each mux passes, and whose value it is.
export function pdpMuxes(m: PdpModel) {
  const s = m.s, st = m.st, out: [mux: string, sel: string, stage: string][] = [];
  if (pipeline.predictor.on) {
    if (st.E) {
      out.push(['pcTop', s.pcSrcE ? '1' : '0', 'E']);
      out.push(['pcLow', s.pcSrc === '11' ? '1' : '0', s.pcSrc === '11' ? PDP_FWD_FROM[s.forwardAE] : 'E']);
    }
    out.push(['pcM', s.mispredict ? '1' : '0', s.mispredict ? 'E' : 'F']);
  } else {
    out.push(['pcTop', s.pcSrcE ? '1' : '0', s.pcSrcE ? 'E' : 'F']);
    out.push(['pcLow', s.pcSrc === '00' ? '00' : s.pcSrc === '11' ? '11' : '01', s.pcSrcE ? 'E' : 'F']);
  }
  if (st.D && !st.D.dec.serial) {
    out.push(['fwd1D', s.forward1D ? '1' : '0', s.forward1D ? 'W' : 'D']);
    out.push(['fwd2D', s.forward2D ? '1' : '0', s.forward2D ? 'W' : 'D']);
  }
  if (st.E) {
    const e = st.E;
    out.push(['fwdAE', s.forwardAE, PDP_FWD_FROM[s.forwardAE]]);
    out.push(['fwdBE', s.forwardBE, PDP_FWD_FROM[s.forwardBE]]);
    out.push(['aluSrcA', ctlBit(e.ALUSrcA, 0) === '1' ? e.ALUSrcA : 'x0', ctlBit(e.ALUSrcA, 0) === '1' ? 'E' : PDP_FWD_FROM[s.forwardAE]]);
    out.push(['aluSrcB', ctlBit(e.ALUSrcB, 0) === '1' ? e.ALUSrcB : 'x0', ctlBit(e.ALUSrcB, 0) === '1' ? 'E' : PDP_FWD_FROM[s.forwardBE]]);
  }
  if (st.M && st.M.MemWrite) out.push(['fwdM', s.forwardM ? '1' : '0', s.forwardM ? 'W' : 'M']);
  if (st.W) out.push(['result', st.W.MemtoReg ? '1' : '0', 'W']);
  return out;
}

export function pdpHazardNotes(m: PdpModel) {
  const s = m.s, st = m.st, H = pipeline.hazards, notes: string[] = [];
  const reg = (i: number) => 'x' + i;
  if (s.forwardAE !== '00') notes.push(`ForwardAE = ${s.forwardAE}: rs1E (${reg(st.E!.rs1)}) is ${s.forwardAE === '10' ? 'rdM' : 'rdW'}, so SrcA takes ${s.forwardAE === '10' ? 'ALUResultM' : 'ResultW'}`);
  if (s.forwardBE !== '00') notes.push(`ForwardBE = ${s.forwardBE}: rs2E (${reg(st.E!.rs2)}) is ${s.forwardBE === '10' ? 'rdM' : 'rdW'}, so it takes ${s.forwardBE === '10' ? 'ALUResultM' : 'ResultW'}`);
  if (s.forward1D) notes.push(`Forward1D: rs1D (${reg(st.D!.dec.rs1)}) is being written this edge, so RD1 takes ResultW`);
  if (s.forward2D) notes.push(`Forward2D: rs2D (${reg(st.D!.dec.rs2)}) is being written this edge, so RD2 takes ResultW`);
  if (s.forwardM) notes.push(`ForwardM: the store's data (${reg(st.M!.rs2)}) is the load in W, so WriteDataM takes ResultW`);
  if (s.lwStall) notes.push(`lwStall: the load in E writes ${reg(st.E!.rd)}, which Decode reads. StallF and StallD hold F and D, FlushE puts a bubble in E`);
  if (s.drain) notes.push('the instruction in Decode is not a datapath instruction: F and D hold until E, M and W are empty');
  if (s.serialExec) notes.push('the pipeline behind it is empty, so the functional model executes it now, in Decode');
  if (pipeline.predictor.on) {
    const hx = (v: number | undefined) => '<code>' + dpHex(v) + '</code>';
    if (s.mispredict) {
      const why = s.brMiss
        ? `predicted ${s.prPCSrcE ? 'taken' : 'not taken'}, but PCSrcE is ${s.pcSrcE ? 1 : 0}`
        : `predicted target ${hx(s.prBTAE)}, but the target is ${hx(s.target)}`;
      notes.push(`Mispredicted: ${why}. The PC goes to PCNextE, ${hx(s.pcNextE)}` +
        (H.flush ? ', and FlushD and FlushE squash the two instructions fetched after it' : '; flushing is switched off, so the two behind it carry on'));
    } else if (st.E && s.pcSrcE) {
      notes.push('The jump in E was predicted, target and all: nothing to flush');
    }
    if (s.prPCSrcF) notes.push(`The BHT predicts F's instruction taken: fetch goes on at PrBTAF, ${hx(s.prBTAF)}`);
  } else if (s.pcSrcE) {
    notes.push(H.flush
      ? 'PCSrcE: the jump or taken branch in E redirects the PC, and FlushD and FlushE squash the two instructions behind it'
      : 'PCSrcE redirects the PC, but branch flushing is switched off: the two instructions behind it carry on');
  }
  const off: string[] = [];
  if (!H.fwdE) off.push('M/W to E forwarding');
  if (!H.fwdD) off.push('W to D forwarding');
  if (!H.fwdM) off.push('the mem-mem copy');
  if (!H.lwStall) off.push('the load-use stall');
  if (!H.flush) off.push('branch flushing');
  if (!notes.length) notes.push('No hazard this cycle: nothing forwarded, stalled or flushed.');
  if (off.length) notes.push('<i>Switched off: ' + off.join(', ') + '.</i>');
  return notes;
}

export function pdpLight(name: string, stage: string) {
  const r = pdpTable().routes[name];
  if (!r) return;
  for (const i of r.segs) {
    const el = dpEl(i);
    if (!el) continue;
    if (stage === 'off') {
      if (el.dataset.pl) continue;
      el.classList.add('dp-lit-unused');
      continue;
    }
    el.classList.remove('dp-lit-unused');
    el.dataset.pl = stage;
    el.style.setProperty('--pl', PDP_COLOUR[stage]);
    el.classList.add('pl-lit');
    if (parseFloat(el.getAttribute('stroke-width') ?? '') < 5) el.classList.add('pl-thin');
  }
}

export function pdpChip(text: string, stage: string) {
  const g = dpNS('g', { class: 'dp-chip dp-parked' });
  const fs = 26;
  const w = Math.max(40, text.length * fs * 0.6 + 18), h = fs + 14;
  g.dataset.w = String(w);
  g.dataset.h = String(h);
  g.appendChild(dpNS('rect', { x: -w / 2, y: -h / 2, width: w, height: h, fill: PDP_COLOUR[stage] }));
  const t = dpNS('text', { x: 0, y: 0, 'text-anchor': 'middle' });
  t.textContent = text;
  g.appendChild(t);
  return g;
}

export function pdpDrawMux(name: string, sel: string, stage: string) {
  const mx = pdpTable().muxes[name];
  if (!mx) return;
  const shape = dpEl(mx.e);
  if (shape) { shape.classList.add('pl-lit'); shape.style.setProperty('--pl', PDP_COLOUR[stage]); }
  const from = mx.ins[sel];
  const ov = dpOverlayEl();
  if (!from || !ov) return;
  ov.appendChild(dpNS('polyline', {
    points: `${from[0]},${from[1]} ${(from[0] + mx.out[0]) / 2},${mx.out[1]} ${mx.out[0]},${mx.out[1]}`,
    fill: 'none', stroke: PDP_COLOUR[stage], 'stroke-width': 9, 'stroke-linecap': 'round'
  }));
}

export function pdpHazardRoutes(m: PdpModel) {
  const s = m.s, out: [route: string, label: string][] = [];
  if (s.stallF) out.push(['h_stallf', 'StallF']);
  if (s.stallD) out.push(['h_stalld', 'StallD']);
  if (s.flushD) out.push(['h_flushd', 'FlushD']);
  if (s.flushE) out.push(['h_flushe', 'FlushE']);
  if (s.forward1D) out.push(['h_fwd_1d', '1']);
  if (s.forward2D) out.push(['h_fwd_2d', '1']);
  if (s.forwardAE !== '00') out.push(['h_fwd_ae', s.forwardAE]);
  if (s.forwardBE !== '00') out.push(['h_fwd_be', s.forwardBE]);
  if (s.forwardM) out.push(['h_fwd_m', '1']);
  return out;
}

// Where each stage lies across the drawing, for its instruction's label.
export const PDP_STAGE_X: Record<string, number[]> = { F: [0, 911], D: [965, 1768], E: [1823, 2628], M: [2682, 3167], W: [3221, 3460] };

export function pdpCaption(m: PdpModel) {
  const notes = pdpHazardNotes(m);
  return notes.join('. ').replace(/\.\./g, '.') + (/[.>]$/.test(notes[notes.length - 1]) ? '' : '.');
}

// Each stage's instruction above it, alternating rows so neighbours
// do not collide.
export function pdpStageLabels(m: PdpModel) {
  const ov = dpOverlayEl(), width = pdpTable().width, xs = PDP_STAGE_X;
  if (!ov) return;
  const fs = 50;
  (['F', 'D', 'E', 'M', 'W'] as const).forEach((k, i) => {
    const r = m.st[k];
    const text = r ? pdpText(r.pc) : 'bubble';
    const w = (text.length + 2) * fs * 0.56;
    const mid = (xs[k][0] + xs[k][1]) / 2;
    const x = Math.max(w / 2 + 6, Math.min(width - w / 2 - 6, mid));
    const t = dpNS('text', { x, y: i % 2 ? -22 : -74, 'text-anchor': 'middle', class: 'pdp-stage-label' + (r ? '' : ' pdp-bubble') });
    t.style.fill = PDP_COLOUR[k];
    const b = dpNS('tspan', { 'font-weight': 700 });
    b.textContent = k + '  ';
    t.appendChild(b);
    t.appendChild(document.createTextNode(text));
    ov.appendChild(t);
  });
}

// One clock cycle, drawn whole: every stage's wires, the mux choices, the
// hazard unit's signals and the values.
export function pdpDraw(m: PdpModel) {
  dpClear();
  const ov = dpOverlayEl(), t = pdpTable().routes;
  if (!ov) return;
  const routes = pdpRoutes(m);
  routes.filter(r => r[1] === 'off').forEach(([n]) => pdpLight(n, 'off'));
  routes.filter(r => r[1] !== 'off').forEach(([n, st]) => pdpLight(n, st));
  const hz = pdpHazardRoutes(m);
  hz.forEach(([n]) => pdpLight(n, 'H'));
  pdpMuxes(m).forEach(([n, sel, st]) => pdpDrawMux(n, sel, st));
  if (hz.length) { const el = dpEl(pdpTable().blocks.hazard); if (el) el.classList.add('dp-glow-ctrl'); }
  if (m.s.mispredict) { const el = dpEl(pdpTable().blocks.bp); if (el) el.classList.add('dp-glow-ctrl'); }
  for (const [n, st, chip] of routes) {
    if (chip === null || st === 'off') continue;
    const g = pdpChip(chip, st);
    dpPlace(g, dpParkPoint(t[n], g));
    ov.appendChild(g);
  }
  for (const [n, label] of hz) {
    const g = pdpChip(label, 'H');
    dpPlace(g, dpParkPoint(t[n], g));
    ov.appendChild(g);
  }
  pdpStageLabels(m);
}

// The five instructions' encodings beside the drawing, in program order:
// the oldest, in Writeback, first.
export function pdpDrawEncodings(m: PdpModel | null) {
  if (!m) { setDpPanel({ enc: null }); return; }
  const stages = (['W', 'M', 'E', 'D', 'F'] as const).map(k => {
    const r = m.st[k];
    const instr = r ? r.instr >>> 0 : 0;
    const fmt = dpFormatOf(instr & 0x7F, (instr >>> 12) & 7);
    return { stage: k, colour: PDP_COLOUR[k], text: r ? pdpText(r.pc) : null, instr,
             fields: r ? DP_FORMATS[fmt || 'raw'].map(([hi, lo, name, kind]) => ({ hi, lo, name, kind })) : [] };
  });
  setDpPanel({ enc: { pipe: true, stages, bht: pipeline.predictor.on ? pdpBhtTable(m) : null } });
  dpPlaceEncoding();
}

// The BHT's entries: every one when the table is small, otherwise those
// in use. The entries Fetch and Execute read this cycle are marked.
export function pdpBhtTable(m: PdpModel) {
  const s = m.s, n = pipeline.predictor.entries, bht = pipeline.regs.bht;
  const iF = pipeBhtIndex(s.pcF), iE = m.st.E ? pipeBhtIndex(m.st.E.pc) : -1;
  const rows: DpBhtRow[] = [];
  for (let i = 0; i < n; i++) {
    if (n > 16 && i !== iF && i !== iE && !bht.pr[i] && !bht.bta[i]) continue;
    const pr = pipeline.predictor.bits === 2 ? bht.pr[i].toString(2).padStart(2, '0') : String(bht.pr[i]);
    rows.push({ index: i, f: i === iF, e: i === iE, pr, bta: dpHex(bht.bta[i]) });
  }
  return { entries: n, bits: pipeline.predictor.bits, k: Math.log2(n) + 1, inUse: n > 16, rows };
}

// ▶▶ when pipelined: clock one cycle after another until paused.
export let pdpPlaying = false;
export async function pdpPlay() {
  if (pdpPlaying) { pdpPlaying = false; dpUpdateButtons(); return; }
  pdpPlaying = true;
  dpUpdateButtons();
  while (pdpPlaying && pipeline.on && program.assembled && !run.finished && !run.running && ui.engine !== 'hdl') {
    dpCommit();
    await new Promise(r => setTimeout(r, 900 / dpSpeed));
  }
  pdpPlaying = false;
  dpUpdateButtons();
}

// ---- The pipeline timeline ------------------------------------------
// The textbook chart: one row per instruction, one column per cycle,
// each cell the stage it was in. The last column is the cycle about to
// be clocked, the one the diagram shows.
export const PDP_TL_COLS = 18;
export let dpView = 'diagram';

export function dpSetView(v: string) {
  dpView = v === 'timeline' && pipeline.on ? 'timeline' : 'diagram';
  document.body.classList.toggle('dp-view-timeline', dpView === 'timeline');
  setDpHeader({ view: dpView });
  if (dpView === 'timeline') pdpRenderTimeline();
  else dpPlaceEncoding();
  dpUpdateButtons();
}
export function dpToggleView() { dpSetView(dpView === 'timeline' ? 'diagram' : 'timeline'); }

// The timeline: each cycle's column (the instruction in each stage, by
// sequence number, and what the hazard unit did), each instruction's row,
// and a cell where the two meet.
export type TlRec = { seq: number; pc: number };
export interface TlCol { cyc: number; live?: boolean; st: (TlRec | null)[]; stall?: boolean; flushD?: boolean; flushE?: boolean; miss?: boolean; serial?: boolean }
export interface TlCell { k: number; bub?: boolean; stall?: boolean; flush?: boolean; miss?: boolean }
export interface TlRow { pc: number; nop: boolean; quashed?: boolean; cells: Record<number, TlCell> }

// What the timeline shows (DpTimeline.svelte): the cycles across, and an
// instruction per row with the stage it was in at each.
export interface DpTlCell { L: string; cls: string; tip: string; colour: string | null }
export interface DpTlView {
  empty: boolean;
  cols: { label: string; live: boolean }[];
  rows: { gone: boolean; nop: boolean; addr: string | null; text: string; quashed: boolean; cells: (DpTlCell | null)[] }[];
}

export function pdpRenderTimeline() {
  const host = byId('dpTimeline');
  if (!host || dpView !== 'timeline') return;
  if (!program.assembled || !pipeline.regs) { setDpPanel({ tl: { empty: true, cols: [], rows: [] } }); return; }
  // A few columns before the window, so bubbles already in flight at its
  // left edge are known.
  const all: TlCol[] = [];
  for (let t = pipeline.regs.trace; t && all.length < PDP_TL_COLS + 3; t = t.prev) all.unshift(t);
  if (!run.finished) {
    const s = pipeEvaluate();
    const rec = (r: { seq: number; pc: number } | null) => r ? { seq: r.seq, pc: r.pc } : null;
    all.push({
      cyc: cpu.totalCycles, live: true,
      st: [s.instrF ? { seq: pipeline.regs.seqF, pc: s.pcF } : null, rec(pipeline.regs.D), rec(pipeline.regs.E), rec(pipeline.regs.M), rec(pipeline.regs.W)],
      stall: s.stallD, flushD: s.flushD, flushE: s.flushE && !s.stallD, miss: !!s.mispredict,
      serial: !!s.serialExec,
    });
  }
  // An empty stage is a bubble when the one behind it held an instruction
  // last cycle: a nop of its own if that instruction was held there, the
  // instruction itself if it was quashed. A serial instruction leaves D
  // by executing, and the pipeline starting up or running dry is just
  // empty.
  const bubs = all.map((): (number | null)[] => [null, null, null, null, null]);
  const info = new Map<number, { nop?: boolean; pc?: number }>();
  for (let ci = 1; ci < all.length; ci++) {
    const a = all[ci - 1], b = all[ci];
    for (let k = 1; k < 5; k++) {
      if (b.st[k]) continue;
      const src = a.st[k - 1], carried = bubs[ci - 1][k - 1];
      if (carried !== null) { bubs[ci][k] = carried; continue; }
      if (!src || (k === 2 && a.serial)) continue;
      const held = b.st[k - 1];
      if (held && held.seq === src.seq) {
        const key = src.seq - 0.5 + ci * 1e-4;
        info.set(key, { nop: true });
        bubs[ci][k] = key;
      } else {
        info.set(src.seq, { pc: src.pc });
        bubs[ci][k] = src.seq;
      }
    }
  }
  const lastCol = all[all.length - 1];
  const live = lastCol && lastCol.live ? new Set(lastCol.st.filter((r): r is TlRec => !!r).map(r => r.seq)
    .concat(bubs[all.length - 1].filter(key => key !== null))) : null;
  // A phone has room only for what is in flight, and not for addresses.
  const phone = mobileMode(), onlyLive = phone && !!live;
  const letters = ['F', 'D', 'E', 'M', 'W'];
  const render = (n: number) => {
    let cols = all.slice(-n), off = all.length - cols.length;
    const rows = new Map<number, TlRow>();
    const rowAt = (key: number, pc: number | undefined) => {
      let row = rows.get(key);
      if (!row) rows.set(key, row = { pc: pc ?? 0, nop: !!(info.get(key) || {}).nop, cells: {} });
      return row;
    };
    cols.forEach((c, ci) => {
      c.st.forEach((r, k) => {
        if (!r) return;
        const cell: TlCell = { k };
        if (c.stall && k <= 1) cell.stall = true;
        if ((c.flushD && k === 0) || (c.flushE && k === 1)) cell.flush = true;
        if (c.miss && k === 2) cell.miss = true;
        rowAt(r.seq, r.pc).cells[ci] = cell;
      });
      bubs[off + ci].forEach((key, k) => {
        if (key === null) return;
        const row = rowAt(key, (info.get(key) || {}).pc);
        row.cells[ci] = { k, bub: true };
        if (!row.nop) row.quashed = true;
      });
    });
    let shown = Array.from(rows.entries()).sort((x, y) => x[0] - y[0]);
    let first = 0;
    if (onlyLive) {
      shown = shown.filter(([key]) => live.has(key));
      if (shown.length) first = Math.min(...shown.map(([, row]) => Math.min(...Object.keys(row.cells).map(Number))));
    }
    const view: DpTlView = { empty: false, cols: cols.slice(first).map(c => ({ label: c.live ? 'next' : String(c.cyc + 1), live: !!c.live })), rows: [] };
    for (const [key, row] of shown) {
      view.rows.push({
        gone: !!live && !live.has(key), nop: row.nop, quashed: !!row.quashed,
        addr: row.nop || phone ? null : (row.pc >>> 0).toString(16).padStart(8, '0'),
        text: row.nop ? '' : pdpText(row.pc),
        cells: cols.slice(first).map((c, i) => {
          const cell = row.cells[first + i];
          if (!cell) return null;
          const L = letters[cell.k];
          const liveCls = c.live ? ' pdp-tl-live' : '';
          if (cell.bub) return { L, cls: 'pdp-tl-cell pdp-tl-bub' + liveCls, tip: PDP_STAGE_NAMES[L] + ', a bubble (nop)', colour: null };
          return {
            L, colour: PDP_COLOUR[L],
            cls: 'pdp-tl-cell' + liveCls + (cell.stall ? ' pdp-tl-stall' : '') + (cell.flush ? ' pdp-tl-flush' : '') + (cell.miss ? ' pdp-tl-miss' : ''),
            tip: PDP_STAGE_NAMES[L] + (cell.stall ? ', stalled' : '') + (cell.flush ? ', flushed at the end of this cycle' : '') +
              (cell.miss ? ', mispredicted' : ''),
          };
        }),
      });
    }
    setDpPanel({ tl: view });
    return cols.length - first;
  };
  // Only as many cycles as fit across, so nothing needs scrolling sideways.
  let n = render(PDP_TL_COLS);
  const room = host.clientWidth - 20;
  for (let tries = 0; tries < 3 && room > 0; tries++) {
    const table = host.firstElementChild as HTMLElement | null, th = table && table.querySelector('th');
    if (!table || !th || table.offsetWidth <= room || n <= 1) break;
    const cell = (table.offsetWidth - th.offsetWidth) / n;
    const fit = Math.max(1, Math.floor((room - th.offsetWidth) / cell));
    if (fit >= n) break;
    n = render(fit);
  }
  host.scrollTop = host.scrollHeight;
}

// ---- The strip --------------------------------------------------------
export function setDpHeight(px: number | null, persist: boolean) {
  const h = Math.max(200, Math.min(px ?? DP_H_DEFAULT, window.innerHeight - 160));
  setDpHeader({ dockFlex: '0 0 ' + h + 'px' });
  if (persist) { try { localStorage.setItem(DP_H_KEY, String(h)); } catch (e) { /* private mode */ } }
}

export function dpSavedHeight() {
  let v: number | null = null;
  try { v = parseInt(localStorage.getItem(DP_H_KEY) || '', 10); } catch (e) { v = null; }
  return Number.isFinite(v) ? v : DP_H_DEFAULT;
}

// The inline flex from a drag outranks the folded and in-panel rules, so
// it is only present while the strip is open at the bottom.
export function dpApplyDockSize() {
  const b = document.body.classList;
  if (b.contains('dp-open') && !b.contains('dp-in-panel') && !b.contains('dp-max')) setDpHeight(dpSavedHeight(), false);
  else setDpHeader({ dockFlex: null });
}

// Shown when asked for and when the program can be drawn: the diagram
// is a view of the instructions it implements, not a condition for
// running anything.
export let dpWanted = false;
export function dpApplyOpen() {
  const open = dpWanted && !dpBlocker();
  const was = document.body.classList.contains('dp-open');
  document.body.classList.toggle('dp-open', open);
  if (!open) document.body.classList.remove('dp-max');
  dpApplyDockSize();
  if (open && !was) dpSync(true);
  updateVizButton();
}

export function toggleDpDock() {
  dpWanted = !document.body.classList.contains('dp-open');
  try { localStorage.setItem(DP_OPEN_KEY, dpWanted ? '1' : '0'); } catch (e) { /* private mode */ }
  dpApplyOpen();
}

// The first instruction the diagrams do not draw, or null. The same set
// for both: no MCycle, word loads and stores only, nothing outside the
// decoder table (FP, atomics, ecall, fence, CSRs).
// Why the diagram cannot show the program: a message, or the first line it cannot draw.
export interface DpBlock { msg?: string; line?: number; text?: string; why?: string }
export let dpBlockKey: string | null = null, dpBlockVal: DpBlock | null = null;
export const DP_MULTI_BLOCK: DpBlock = { msg: 'The datapath is not available in Multi-cycle mode.' };
export function dpBlocker() {
  if (pipeline.arch === 'multi') return DP_MULTI_BLOCK;
  const key = program.assembled + ':' + program.machineCode.length + ':' + (editorState.lastAssembledCode || '').length + ':' + editorState.language;
  if (key === dpBlockKey) return dpBlockVal;
  dpBlockKey = key;
  dpBlockVal = null;
  if (!program.assembled) return null;
  for (const item of program.machineCode) {
    if (item.error || !item.bytes || (item.address >>> 0) >= (layout.dataBase >>> 0)) continue;
    for (let k = 0; k + 3 < item.bytes.length; k += 4) {
      const w = (item.bytes[k] | (item.bytes[k + 1] << 8) | (item.bytes[k + 2] << 16) | (item.bytes[k + 3] << 24)) >>> 0;
      if (!w) continue;
      const why = dpUnsupported(w, w & 0x7F, (w >>> 12) & 7, w >>> 25);
      if (why) {
        dpBlockVal = { line: editorState.language === 'c' && item.cLine ? item.cLine : item.line,
                       text: (item.native || item.text || '').trim(), why };
        return dpBlockVal;
      }
    }
  }
  return null;
}

// One toolbar button for the engine's visualisation: the datapath in JS
// mode, the waveform in HDL mode. On a phone each is a panel tab.
export function vizShown() {
  const hdl = ui.engine === 'hdl';
  if (mobileMode()) {
    const pd = panelDock[hdl ? 'waveform' : 'datapath'];
    return !!(pd && pd.visible);
  }
  return document.body.classList.contains(hdl ? 'wave-open' : 'dp-open');
}

export function toggleVisualisation() {
  const hdl = ui.engine === 'hdl';
  if (!hdl && dpBlocker()) return;
  if (mobileMode()) {
    const name = hdl ? 'waveform' : 'datapath';
    const show = !vizShown();
    setPanelVisible(name, show);
    if (show) setMobileTab(name);
    if (!hdl) dpSync(true);
  } else if (hdl) {
    toggleWaveDock();
  } else {
    toggleDpDock();
  }
  updateVizButton();
}

// On a phone the step controls float. On the datapath tab they replace
// the strip's own, which scroll away with the panel and do not fit its
// header; elsewhere they appear once the toolbar's Step scrolls out of
// view, as the toolbar's Back and Step (which covers HDL and its
// waveform), or the strip's in pipelined mode, where those step cycles.
export let floatStepsWanted = false;
export function floatOnDpTab() {
  return ui.engine !== 'hdl' && document.body.classList.contains('dp-in-panel') &&
    !!(panelDock.datapath && panelDock.datapath.visible) &&
    typeof mobileTab !== 'undefined' && mobileTab === 'datapath';
}
export function floatStepsMode() {
  if (ui.engine === 'hdl') return 'tb';
  return pipeline.on || floatOnDpTab() ? 'dp' : 'tb';
}
// What the floating step controls show (FloatSteps.svelte).
type FloatButton = { label: string; title: string; on: boolean; hidden: boolean };
export let floatView = { show: false, mode: 'tb', buttons: [] as FloatButton[] };

export function updateFloatSteps() {
  const onDp = mobileMode() && program.assembled && floatOnDpTab();
  const show = onDp || (floatStepsWanted && mobileMode() && program.assembled);
  document.body.classList.toggle('float-dp', onDp);
  if (!show) {
    if (floatView.show) { floatView = { ...floatView, show: false }; redraw('floatSteps'); }
    return;
  }
  // The datapath strip's controls, or the toolbar's Back and Step.
  const dp = floatStepsMode() === 'dp';
  const h = dpHeader, t = toolbar;
  const btn = (label: string, s: { on: boolean; title: string }, hidden = false) => ({ label, title: s.title, on: s.on, hidden });
  floatView = {
    show, mode: dp ? 'dp' : 'tb',
    buttons: dp ? [btn('◀', h.prev), btn('▶', h.next), btn(pdpPlaying ? '⏸' : '▶▶', h.play)]
      : [btn('⏮', t.back), btn('⏭', t.step), btn('', h.play, true)],
  };
  redraw('floatSteps');
}
export function floatStep(which: number) {
  const dp = floatStepsMode() === 'dp';
  if (which === 0) dp ? dpPrev() : stepBack();
  else if (which === 1) dp ? dpNext() : stepOnce();
  else if (dp) dpPlay();
  updateFloatSteps();
}
// The toolbar's Step has scrolled out of view (on a phone), so the step
// controls float.
export function setToolbarOutOfView(out: boolean) {
  floatStepsWanted = !!out;
  updateFloatSteps();
}
export function initFloatSteps() {
  const step = byId<HTMLButtonElement>('btnStep');
  if (!step || typeof IntersectionObserver === 'undefined') return;
  new IntersectionObserver(entries => {
    setToolbarOutOfView(entries[0].intersectionRatio < 0.6);
  }, { threshold: [0, 0.6, 1] }).observe(step);
  window.addEventListener('resize', updateFloatSteps);
}

export function updateVizButton() {
  const hdl = ui.engine === 'hdl';
  const block = hdl ? null : dpBlocker();
  toolbar.viz = {
    hdl, on: !block, shown: !block && vizShown(),
    title: block
      ? block.msg || `The datapath diagram cannot show this program: line ${block.line}, ${block.text}. ${block.why}`
      : hdl ? 'Show or hide the waveform of the recorded run'
            : 'Show or hide the datapath: the instruction at the PC, or the pipeline, one step at a time',
  };
  redrawToolbar();
}

export function toggleDpMax() {
  if (!document.body.classList.contains('dp-open')) toggleDpDock();
  document.body.classList.toggle('dp-max');
  dpApplyDockSize();
}

// Below the breakpoint the strip becomes a panel tab, the way the
// waveform does, so reaching it does not scroll the toolbar away.
// Below the breakpoint the strip is a panel tab, the way the waveform is,
// so reaching it does not scroll the toolbar away. Where it is drawn is
// the page's (App.svelte and Panel.svelte); this sets the in-panel styles.
export function syncDatapathPanelHost() {
  document.body.classList.toggle('dp-in-panel', mobileMode());
  if (document.body.dataset.booted) dpApplyDockSize();
}

export function updateDatapathPanelAvailability() {
  const show = mobileMode() && ui.engine !== 'hdl' && !dpBlocker();
  setPanelChipShown('datapath', show);
  if (!show && panelDock.datapath && panelDock.datapath.visible) {
    setPanelVisible('datapath', false);
  }
  syncDatapathPanelHost();
}

// Dragging the bar above the strip; it grows upwards.
export function onDpResizeStart(e: PointerEvent) {
  const bar = e.currentTarget as HTMLElement;
  const dock = byId('dpDock');
  if (!dock) return;
  const startY = e.clientY, startH = dock.getBoundingClientRect().height;
  const move = (ev: PointerEvent) => setDpHeight(startH + (startY - ev.clientY), false);
  const up = () => {
    bar.classList.remove('dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    setDpHeight(dock.getBoundingClientRect().height, true);
  };
  bar.classList.add('dragging');
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  e.preventDefault();
}

export function onDpResizeReset() {
  setDpHeight(DP_H_DEFAULT, true);
}

// The strip was mounted, at the bottom of the page or in its tab on a
// phone: draw the clock into the diagram, label the Branch Predictor, and
// once the page has booted put back what the diagram was showing.
export function dpDockMounted() {
  dpClockInit();
  const bpBlock = document.querySelector('#dpPipeBpSvg [data-e="bp"]');
  if (bpBlock && !bpBlock.querySelector('title')) {
    const tip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    tip.textContent = 'What is inside the Branch Predictor';
    bpBlock.appendChild(tip);
  }
  if (document.body.dataset.booted) {
    dpApplyDockSize();
    dpOnModeChange();
  }
}

// A click on the Branch Predictor opens the drawing of what is inside it.
export function onDpBodyClick(e: MouseEvent) {
  if (targetEl(e)?.closest('#dpPipeBpSvg [data-e="bp"]')) openBpFigure();
}

export function initDatapath() {
  try { dpWanted = localStorage.getItem(DP_OPEN_KEY) === '1'; } catch (e) { dpWanted = false; }
  initFloatSteps();
  updateDatapathPanelAvailability();
  dpApplyOpen();
  dpSync(true);
}

// Every action on the page ends in a toolbar refresh, and a register edit
// in a register refresh, so those are where the diagram learns that the
// instruction moved on or its values changed. Both are cheap when neither
// did: the stamps (dpCurrentStamp, dpCurrentValueStamp) are compared first.
export function dpOnStateChange() {
  const blocked = !!dpBlocker();
  if ((dpWanted && !blocked) !== document.body.classList.contains('dp-open')) dpApplyOpen();
  if (blocked !== dpWasBlocked) {
    dpWasBlocked = blocked;
    updateDatapathPanelAvailability();
  }
  if (dpActive()) dpSync(false);
  dpUpdateButtons();
  updateVizButton();
}
export let dpWasBlocked = false;

// The microarchitecture, the drawing or a hazard switch changed.
export function dpOnModeChange() {
  const b = document.body.classList;
  b.toggle('dp-pipe', pipeline.on);
  b.toggle('dp-bp', pipeline.predictor.on);
  setDpHeader({ pipe: pipeline.on });
  dpSetView(pipeline.on ? dpView : 'diagram');
  pdpPlaying = false;
  dpClear();
  dpSync(true);
  dpPlaceEncoding();
}

// ---- Boot and window hooks -------------------------------------------
// Starts the page once window.CM6 exists. ui/cm6-loader.ts loads it from
// the CDN, with a local fallback, and the import is asynchronous, so this
// polls for it.
export function bootSimulator() {
  if (!window.CM6) {
    setTimeout(bootSimulator, 20);
    return;
  }
  updateExampleSelectorOptions();
  // Sets the Peripherals panel's sections to their first fold state and
  // draws it, whether or not its tab is open.
  initPeripherals();
  // Before the first assembly, which the saved memory layout governs.
  restoreSettings();
  startExampleSources();
  initCodeMirrorEditor();
  // Auto-assemble the initial example so Run / Step are active on first load
  if (editorState.language === 'asm' && editor.value.trim()) {
    try { assembleOnly(); } catch (e) { }
  }
  updateToolbarButtonStates();
  hdlInitSources();
  initDatapath();
  countVisit();
  // Marks the point after which the waveform and datapath state is safe to
  // touch: the panel relayout in ui/panels.ts and ui/examples-language.ts
  // can run while the script is still loading, before the declarations in
  // ui/waveform.ts and this file have been reached.
  document.body.dataset.booted = '1';
}

// Run once the page has loaded every module (main.ts), in page order.
export function onDatapathLoad() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootSimulator);
  } else {
    bootSimulator();
  }
  // Hooks for the test suites, which read the page's state from Node.
  Object.assign(window, {
    getLanguageMode: () => editorState.language,
    getPcToCLineMap: () => cProgram.pcToLine,
    getCLineToPcsMap: () => cProgram.lineToPcs,
    getRegs: () => cpu.regs,
    getPc: () => cpu.pc,
    getMachineCode: () => program.machineCode,
    getBreakpoints: () => run.breakpoints,
    getCurrentExecLine: () => run.currentLine,
    getExecHistory: () => stepHistory.entries,
    getOledBuffer: () => oled.pages[oled.front],
    getHeldAxisKeys: () => heldAxisKeys,
    getCFunctionLocals: () => cProgram.functionLocals,
    getMemViewMode: () => memViewMode,
    getDisasmViewMode: () => ui.disasmView,
  });
  Object.defineProperty(window, 'runTimerId', { get: () => run.timerId, configurable: true });
}
