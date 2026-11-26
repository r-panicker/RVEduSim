// @ts-nocheck
// ================================================================
// Seeking - the trace IS the stepping mechanism
// ================================================================
// vvp cannot be paused mid-run, so stepping does not drive the
// simulator at all: the whole run is recorded once and the UI moves
// through the recording. That makes stepping instant and, unlike a real
// simulator, makes stepping BACKWARDS possible.
function hdlResetPeripheralState() {
  ledState = 0;
  sevsegState = '00000000';
  uartTxBuffer = '';
  uartTxBytes = [];
  oledPages.forEach(oledBlankPage);
  oledSwapUnpolled = false;
}

function hdlApplyPer(kind, f) {
  if (kind === 'C') {
    pc = parseInt(f[1], 16) >>> 0;
  } else if (kind === 'L') {
    ledState = parseInt(f[1], 16) & 0xFF;
  } else if (kind === 'S') {
    sevsegState = (parseInt(f[1], 16) >>> 0).toString(16).padStart(8, '0');
  } else if (kind === 'T') {
    const ch = parseInt(f[1], 16) & 0xFF;
    uartTxBytes.push(ch);
    uartTxBuffer += String.fromCharCode(ch);
  } else if (kind === 'B') {
    // The Wrapper asked for a present. The VHDL that would align it to a
    // scanout boundary is not simulated, so apply it now - the same model
    // the JS engine uses, which keeps the two engines in step.
    oledPresent();
  } else if (kind === 'P') {
    // Software read OLED_STATUS, so it is waiting the present out rather
    // than racing it.
    oledSwapUnpolled = false;
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
      oledBuffer[idx] = (rgb >>> 16) & 0xFF;
      oledBuffer[idx + 1] = (rgb >>> 8) & 0xFF;
      oledBuffer[idx + 2] = rgb & 0xFF;
      oledBuffer[idx + 3] = 255;
    }
  }
}

// A Verilator recording is kept to its last HDL_VL_KEEP cycles, so that a
// run need not stop. The instructions before that are folded into a
// snapshot of the state they leave, which a seek starts from instead of
// reset; offset counts them, so the instruction count stays true.
const HDL_VL_KEEP = 2000000;
function hdlRestoreBase(b) {
  loadProgram(machineCode);
  regs.set(b.regs);
  hdlRegKnown.set(b.regKnown);
  for (let i = 0; i < b.mem.length; i++) setMemByte(dataBase + i, b.mem[i]);
  hdlResetPeripheralState();
  restorePeriphState(b.periph);
  uartTxBytes = b.tx.slice();
  uartTxBuffer = b.txBuf;
  oledPages[0].set(b.oled[0]);
  oledPages[1].set(b.oled[1]);
  oledBuffer = oledPages[oledBackPage];
}
// The state the page holds now, as a starting point for seeks.
function hdlCaptureBase(cyc, acks) {
  const mem = new Uint8Array(hdlDmemBytes);
  for (let i = 0; i < mem.length; i++) mem[i] = getMemByte(dataBase + i);
  return { cyc, regs: regs.slice(), regKnown: hdlRegKnown.slice(), mem,
           periph: capturePeriphState(), tx: uartTxBytes.slice(), txBuf: uartTxBuffer,
           oled: oledPages.map(p => p.slice()), acks };
}

// Returns how many steps were folded away, 0 when it was not yet time.
function hdlTrimTrace(t) {
  const steps = t.steps;
  if (steps.length < 2) return 0;
  const last = steps[steps.length - 1].cyc;
  if (last - steps[0].cyc <= HDL_VL_KEEP * 1.25) return 0;
  const want = last - HDL_VL_KEEP;
  let lo = 0, hi = steps.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (steps[mid].cyc < want) lo = mid + 1; else hi = mid; }
  const cut = lo, was = hdlIdx;
  hdlSeek(cut);
  t.base = hdlCaptureBase(steps[cut].cyc, hdlSeekMark.acks);
  t.offset = (t.offset || 0) + cut;
  t.steps = steps.slice(cut);
  t.pre = [];
  t.preAcks = 0;
  hdlIdx = 0;
  hdlSeekMark = { trace: t, idx: 0, acks: t.base.acks };
  hdlSeek(Math.max(0, was - cut), true);
  return cut;
}
// Drops what a recording holds from cycle c on, so that a run printing
// from c (+TRACEFROM) can be joined onto it.
function hdlCutTrace(t, c) {
  let k = t.steps.length;
  while (k > 0 && t.steps[k - 1].cyc >= c) k--;
  t.steps.length = k;
  // The last step kept can hold what a long instruction did in later
  // cycles, which the run joined on prints again.
  const before = (list, at) => list === HDL_NONE ? list : list.filter(e => at(e) < c);
  const last = t.steps[k - 1];
  if (last) {
    last.per = before(last.per, e => parseInt(e[1][0], 10));
    last.regw = before(last.regw, e => e[2]);
    last.memw = before(last.memw, e => e[3]);
  }
  t.pre = before(t.pre, e => parseInt(e[1][0], 10));
  t.final = null;
  t.next = null;
  hdlSeekMark = null;
  return t;
}

// Only writes the Wrapper actually commits to DMEM belong in the memory
// image; MMIO writes at the same port are peripheral activity and arrive
// as their own events.
function hdlApplyMemWrite(addr, be, data) {
  if (addr < dataBase || addr >= dataBase + hdlDmemBytes) return;
  const word = addr & ~3;
  for (let i = 0; i < 4; i++)
    if (be & (1 << i)) setMemByte(word + i, (data >>> (i * 8)) & 0xFF);
}

function hdlCurrentCycle() {
  if (!hdlTrace) return 0;
  const s = hdlTrace.steps;
  if (hdlIdx < s.length) return s[hdlIdx].cyc;
  if (hdlPaced && !s.length) return Math.floor(hdlPaced.cyc);
  return hdlTrace.final ? hdlTrace.final.cyc : (s.length ? s[s.length - 1].cyc : 0);
}

let hdlSeekMark = null;   // { trace, idx, acks } as the last seek left them
// How many of the events of a recording without the trace are shown: all,
// or, while a run is held to the paced clock, those the clock has reached.
function hdlPreShown() {
  const pre = hdlTrace.pre;
  if (!hdlPaced || hdlTrace.steps.length) return pre.length;
  let n = 0;
  while (n < pre.length && parseInt(pre[n][1][0], 10) <= hdlPaced.cyc) n++;
  return hdlPaced.applied = n;
}

// Position `idx` means "idx instructions have completed"; the state
// shown is the state the hardware was in just before instruction idx.
// forward: carry on from the last seek instead of replaying from cycle 0,
// which is how a live run follows its own end. Only valid when nothing
// else has touched the state since that seek, so only the live run asks.
// light: only what a running simulation shows (peripherals, stats, the
// waveform), not the line, registers and memory, which catch up when it stops.
function hdlSeek(idx, forward, light) {
  if (!hdlTrace) return;
  const steps = hdlTrace.steps;
  idx = Math.max(0, Math.min(idx, steps.length));

  let k0 = 0, acks;
  const mark = hdlSeekMark;
  if (forward && mark && mark.trace === hdlTrace && mark.idx === hdlIdx && idx >= hdlIdx) {
    k0 = hdlIdx;
    acks = mark.acks;
    // The last step shown can have gained what the run joined on added
    // to it.
    const ls = mark.tail && steps[k0 - 1];
    if (ls) {
      for (const w of ls.regw.slice(mark.tail[0])) { regs[w[0]] = w[1] | 0; hdlRegKnown[w[0]] = 1; }
      for (const w of ls.memw.slice(mark.tail[1])) hdlApplyMemWrite(w[0], w[1], w[2]);
      for (const e of ls.per.slice(mark.tail[2])) hdlApplyPer(e[0], e[1]);
      acks += (ls.acks || 0) - mark.tail[3];
    }
  } else if (hdlTrace.base) {
    // Without the architectural trace, the events after the snapshot
    // are all in pre.
    hdlRestoreBase(hdlTrace.base);
    const n = hdlPreShown();
    for (let i = 0; i < n; i++) hdlApplyPer(hdlTrace.pre[i][0], hdlTrace.pre[i][1]);
    acks = hdlTrace.base.acks + (hdlTrace.preAcks || 0);
  } else {
    loadProgram(machineCode);
    hdlRegKnown.fill(0);
    hdlResetPeripheralState();
    const n = hdlPreShown();
    for (let i = 0; i < n; i++) hdlApplyPer(hdlTrace.pre[i][0], hdlTrace.pre[i][1]);
    acks = hdlTrace.preAcks || 0;
  }

  let changed = -1;
  for (let k = k0; k < idx; k++) {
    const s = steps[k];
    for (const w of s.regw) { regs[w[0]] = w[1] | 0; hdlRegKnown[w[0]] = 1; }
    if (k === idx - 1 && s.regw.length) changed = s.regw[s.regw.length - 1][0];
    for (const w of s.memw) hdlApplyMemWrite(w[0], w[1], w[2]);
    for (const e of s.per) hdlApplyPer(e[0], e[1]);
    acks += s.acks || 0;
  }

  hdlIdx = idx;
  const ls = steps[idx - 1];
  hdlSeekMark = { trace: hdlTrace, idx, acks,
                  tail: ls ? [ls.regw.length, ls.memw.length, ls.per.length, ls.acks || 0] : null };
  lastChangedReg = changed;
  pc = idx < steps.length ? steps[idx].pc
     : hdlPaced && !steps.length ? pc
     : (hdlTrace.next !== null && hdlTrace.next !== undefined ? hdlTrace.next
     : (steps.length ? steps[steps.length - 1].pc : baseAddress));
  instructionCount = (hdlTrace.offset || 0) + idx;
  totalCycles = hdlCurrentCycle();
  currentExecLine = sourceLineForPc(pc);

  // Rebuild both sides of the receive path from the recording: what has
  // arrived by this cycle, minus what the program has already taken. The
  // hardware holds one byte, so the first un-acked arrival is the held
  // one and the rest are still on the PC's side. This is what makes
  // RX_VALID fall back to 0 once a byte is read, and come back when you
  // step backwards over that read.
  const arrived = hdlRx.filter(e => e.cycle <= totalCycles).slice(acks);
  uartRxFull = arrived.length > 0;
  uartRxByte = uartRxFull ? (arrived[0].byte & 0xFF) : 0;
  uartPending = arrived.slice(1).map(e => e.byte & 0xFF);

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
