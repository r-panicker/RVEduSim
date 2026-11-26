// ================================================================
// Seeking - the trace IS the stepping mechanism
// ================================================================
// vvp cannot be paused mid-run, so stepping does not drive the
// simulator at all: the whole run is recorded once and the UI moves
// through the recording. That makes stepping instant and, unlike a real
// simulator, makes stepping BACKWARDS possible.

import { hdlActivity, hdlBuild, hdlRec, type HdlTrace } from './state';
import { HDL_NONE } from './trace';
import { getMemByte, setMemByte } from '../machine/memory';
import { oledBlankPage, oledNotePixelWrite, oledPanelCol, oledPresent } from '../machine/oled';
import { capturePeriphState, restorePeriphState } from '../machine/peripherals';
import { loadProgram } from '../machine/reset';
import { board, cpu, layout, oled, program, run, uart } from '../machine/state';
import { updateDisassembly, updateMachineCode } from '../ui/disassembly';
import { highlightCurrentLine, sourceLineForPc, updateStats } from '../ui/execution';
import { updateMemoryView } from '../ui/memory-register-views';
import { updateRegisters } from '../ui/panels';
import { renderUartTerminal, updateOledCanvas, updatePeripherals } from '../ui/peripherals';
import { updateToolbarButtonStates } from '../ui/run-control';
import { updateWaveView } from '../ui/waveform';
export function hdlResetPeripheralState() {
  board.leds = 0;
  board.sevseg = '00000000';
  uart.txText = '';
  uart.txBytes = [];
  oled.pages.forEach(oledBlankPage);
  oled.swapUnpolled = false;
}

export function hdlApplyPer(kind: string, f: string[]) {
  if (kind === 'C') {
    cpu.pc = parseInt(f[1], 16) >>> 0;
  } else if (kind === 'L') {
    board.leds = parseInt(f[1], 16) & 0xFF;
  } else if (kind === 'S') {
    board.sevseg = (parseInt(f[1], 16) >>> 0).toString(16).padStart(8, '0');
  } else if (kind === 'T') {
    const ch = parseInt(f[1], 16) & 0xFF;
    uart.txBytes.push(ch);
    uart.txText += String.fromCharCode(ch);
  } else if (kind === 'B') {
    // The Wrapper asked for a present. The VHDL that would align it to a
    // scanout boundary is not simulated, so apply it now - the same model
    // the JS engine uses, which keeps the two engines in step.
    oledPresent();
  } else if (kind === 'P') {
    // Software read OLED_STATUS, so it is waiting the present out rather
    // than racing it.
    oled.swapUnpolled = false;
  } else if (kind === 'O') {
    oledNotePixelWrite();
    // The Wrapper has already resolved the colour mode into a 24-bit
    // value on OLED_Data, so paint straight into the frame buffer. The
    // column still needs the panel's fold, since OLED_Col is 7 bits and
    // the Wrapper passes an out-of-range one straight through.
    const col = oledPanelCol(parseInt(f[1], 10));
    const row = parseInt(f[2], 10) & 0x3F;
    const rgb = parseInt(f[3], 16) >>> 0;
    if (Number.isFinite(rgb)) {
      const idx = (row * 96 + col) * 4;
      oled.buffer[idx] = (rgb >>> 16) & 0xFF;
      oled.buffer[idx + 1] = (rgb >>> 8) & 0xFF;
      oled.buffer[idx + 2] = rgb & 0xFF;
      oled.buffer[idx + 3] = 255;
    }
  }
}

// A Verilator recording is kept to its last HDL_VL_KEEP cycles, so that a
// run need not stop. The instructions before that are folded into a
// snapshot of the state they leave, which a seek starts from instead of
// reset; offset counts them, so the instruction count stays true.
export const HDL_VL_KEEP = 2000000;
export function hdlRestoreBase(b: HdlBase) {
  loadProgram(program.machineCode);
  cpu.regs.set(b.regs);
  hdlRec.regKnown.set(b.regKnown);
  for (let i = 0; i < b.mem.length; i++) setMemByte(layout.dataBase + i, b.mem[i]);
  hdlResetPeripheralState();
  restorePeriphState(b.periph);
  uart.txBytes = b.tx.slice();
  uart.txText = b.txBuf;
  oled.pages[0].set(b.oled[0]);
  oled.pages[1].set(b.oled[1]);
  oled.buffer = oled.pages[oled.back];
}
// The state the page holds now, as a starting point for seeks.
// The machine at a cycle, to seek from: registers, data memory, peripherals, OLED pages.
export type HdlBase = ReturnType<typeof hdlCaptureBase>;

export function hdlCaptureBase(cyc: number, acks: number) {
  const mem = new Uint8Array(hdlBuild.dmemBytes);
  for (let i = 0; i < mem.length; i++) mem[i] = getMemByte(layout.dataBase + i);
  return { cyc, regs: cpu.regs.slice(), regKnown: hdlRec.regKnown.slice(), mem,
           periph: capturePeriphState(), tx: uart.txBytes.slice(), txBuf: uart.txText,
           oled: oled.pages.map(p => p.slice()), acks };
}

// Returns how many steps were folded away, 0 when it was not yet time.
export function hdlTrimTrace(t: HdlTrace) {
  const steps = t.steps;
  if (steps.length < 2) return 0;
  const last = steps[steps.length - 1].cyc;
  if (last - steps[0].cyc <= HDL_VL_KEEP * 1.25) return 0;
  const want = last - HDL_VL_KEEP;
  let lo = 0, hi = steps.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (steps[mid].cyc < want) lo = mid + 1; else hi = mid; }
  const cut = lo, was = hdlRec.idx;
  hdlSeek(cut);
  t.base = hdlCaptureBase(steps[cut].cyc, hdlRec.seekMark?.acks ?? 0);
  t.offset = (t.offset || 0) + cut;
  t.steps = steps.slice(cut);
  t.pre = [];
  t.preAcks = 0;
  hdlRec.idx = 0;
  hdlRec.seekMark = { trace: t, idx: 0, acks: t.base.acks };
  hdlSeek(Math.max(0, was - cut), true);
  return cut;
}
// Drops what a recording holds from cycle c on, so that a run printing
// from c (+TRACEFROM) can be joined onto it.
export function hdlCutTrace(t: HdlTrace, c: number) {
  let k = t.steps.length;
  while (k > 0 && t.steps[k - 1].cyc >= c) k--;
  t.steps.length = k;
  // The last step kept can hold what a long instruction did in later
  // cycles, which the run joined on prints again.
  const before = <T>(list: T[], at: (e: T) => number) => list === HDL_NONE ? list : list.filter(e => at(e) < c);
  const last = t.steps[k - 1];
  if (last) {
    last.per = before(last.per, (e) => parseInt(e[1][0], 10));
    last.regw = before(last.regw, (e) => e[2]);
    last.memw = before(last.memw, (e) => e[3]);
  }
  t.pre = before(t.pre, (e) => parseInt(e[1][0], 10));
  t.final = null;
  t.next = null;
  hdlRec.seekMark = null;
  return t;
}

// Only writes the Wrapper actually commits to DMEM belong in the memory
// image; MMIO writes at the same port are peripheral activity and arrive
// as their own events.
export function hdlApplyMemWrite(addr: number, be: number, data: number) {
  if (addr < layout.dataBase || addr >= layout.dataBase + hdlBuild.dmemBytes) return;
  const word = addr & ~3;
  for (let i = 0; i < 4; i++)
    if (be & (1 << i)) setMemByte(word + i, (data >>> (i * 8)) & 0xFF);
}

export function hdlCurrentCycle() {
  if (!hdlRec.trace) return 0;
  const s = hdlRec.trace.steps;
  if (hdlRec.idx < s.length) return s[hdlRec.idx].cyc;
  if (hdlActivity.paced && !s.length) return Math.floor(hdlActivity.paced.cyc);
  return hdlRec.trace.final ? hdlRec.trace.final.cyc : (s.length ? s[s.length - 1].cyc : 0);
}

// How many of the events of a recording without the trace are shown: all,
// or, while a run is held to the paced clock, those the clock has reached.
export function hdlPreShown() {
  const trace = hdlRec.trace;
  if (!trace) return 0;
  const pre = trace.pre;
  if (!hdlActivity.paced || trace.steps.length) return pre.length;
  let n = 0;
  while (n < pre.length && parseInt(pre[n][1][0], 10) <= hdlActivity.paced.cyc) n++;
  return hdlActivity.paced.applied = n;
}

// Position `idx` means "idx instructions have completed"; the state
// shown is the state the hardware was in just before instruction idx.
// forward: carry on from the last seek instead of replaying from cycle 0,
// which is how a live run follows its own end. Only valid when nothing
// else has touched the state since that seek, so only the live run asks.
// light: only what a running simulation shows (peripherals, stats, the
// waveform), not the line, registers and memory, which catch up when it stops.
export function hdlSeek(idx: number, forward?: boolean | undefined, light?: boolean | undefined) {
  if (!hdlRec.trace) return;
  const steps = hdlRec.trace.steps;
  idx = Math.max(0, Math.min(idx, steps.length));

  let k0 = 0, acks: number;
  const mark = hdlRec.seekMark;
  if (forward && mark && mark.trace === hdlRec.trace && mark.idx === hdlRec.idx && idx >= hdlRec.idx) {
    k0 = hdlRec.idx;
    acks = mark.acks;
    // The last step shown can have gained what the run joined on added
    // to it.
    const tail = mark.tail;
    const ls = tail && steps[k0 - 1];
    if (tail && ls) {
      for (const w of ls.regw.slice(tail[0])) { cpu.regs[w[0]] = w[1] | 0; hdlRec.regKnown[w[0]] = 1; }
      for (const w of ls.memw.slice(tail[1])) hdlApplyMemWrite(w[0], w[1], w[2]);
      for (const e of ls.per.slice(tail[2])) hdlApplyPer(e[0], e[1]);
      acks += (ls.acks || 0) - tail[3];
    }
  } else if (hdlRec.trace.base) {
    // Without the architectural trace, the events after the snapshot
    // are all in pre.
    hdlRestoreBase(hdlRec.trace.base);
    const n = hdlPreShown();
    for (let i = 0; i < n; i++) hdlApplyPer(hdlRec.trace.pre[i][0], hdlRec.trace.pre[i][1]);
    acks = hdlRec.trace.base.acks + (hdlRec.trace.preAcks || 0);
  } else {
    loadProgram(program.machineCode);
    hdlRec.regKnown.fill(0);
    hdlResetPeripheralState();
    const n = hdlPreShown();
    for (let i = 0; i < n; i++) hdlApplyPer(hdlRec.trace.pre[i][0], hdlRec.trace.pre[i][1]);
    acks = hdlRec.trace.preAcks || 0;
  }

  let changed = -1;
  for (let k = k0; k < idx; k++) {
    const s = steps[k];
    for (const w of s.regw) { cpu.regs[w[0]] = w[1] | 0; hdlRec.regKnown[w[0]] = 1; }
    if (k === idx - 1 && s.regw.length) changed = s.regw[s.regw.length - 1][0];
    for (const w of s.memw) hdlApplyMemWrite(w[0], w[1], w[2]);
    for (const e of s.per) hdlApplyPer(e[0], e[1]);
    acks += s.acks || 0;
  }

  hdlRec.idx = idx;
  const ls = steps[idx - 1];
  hdlRec.seekMark = { trace: hdlRec.trace, idx, acks,
                  tail: ls ? [ls.regw.length, ls.memw.length, ls.per.length, ls.acks || 0] : null };
  cpu.lastChangedReg = changed;
  cpu.pc = idx < steps.length ? steps[idx].pc
     : hdlActivity.paced && !steps.length ? cpu.pc
     : (hdlRec.trace.next !== null && hdlRec.trace.next !== undefined ? hdlRec.trace.next
     : (steps.length ? steps[steps.length - 1].pc : layout.baseAddress));
  cpu.instructionCount = (hdlRec.trace.offset || 0) + idx;
  cpu.totalCycles = hdlCurrentCycle();
  run.currentLine = sourceLineForPc(cpu.pc);

  // Rebuild both sides of the receive path from the recording: what has
  // arrived by this cycle, minus what the program has already taken. The
  // hardware holds one byte, so the first un-acked arrival is the held
  // one and the rest are still on the PC's side. This is what makes
  // RX_VALID fall back to 0 once a byte is read, and come back when you
  // step backwards over that read.
  const arrived = hdlRec.rx.filter(e => e.cycle <= cpu.totalCycles).slice(acks);
  uart.rxFull = arrived.length > 0;
  uart.rxByte = uart.rxFull ? (arrived[0].byte & 0xFF) : 0;
  uart.pending = arrived.slice(1).map(e => e.byte & 0xFF);

  if (!light) {
    highlightCurrentLine();
    updateRegisters();
    updateMemoryView();
    updateMachineCode();
    updateDisassembly();
  }
  updateStats();
  renderUartTerminal();
  updatePeripherals();
  if (typeof updateOledCanvas === 'function') updateOledCanvas();
  if (!light) updateToolbarButtonStates();
  // Every Step, Back, Run and Resume lands here, so this one call is what
  // keeps the waveform cursor in lockstep with the rest of the UI.
  updateWaveView();
}
