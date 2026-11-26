// @ts-nocheck
// The instruction-set simulator: reset and program loading, memory and
// MMIO access, the OLED and UART models, instruction execution (RV32I,
// M, F/D, A and the RV64 word forms) and the ecall services.

function getMemByte(addr) {
  const u = addr >>> 0;
  if (isMMIOAddr(u)) return handleMMIORead(u, 1);
  const p = memory.pages.get(u >>> PAGE_BITS);
  return p ? p[u & PAGE_MASK] : 0;
}

function setMemByte(addr, val) {
  const u = addr >>> 0;
  if (isMMIOAddr(u)) {
    handleMMIOWrite(u, val & 0xFF, 1);
    return;
  }
  const pageIdx = u >>> PAGE_BITS;
  let p = memory.pages.get(pageIdx);
  if (!p) {
    p = new Uint8Array(PAGE_SIZE);
    memory.pages.set(pageIdx, p);
  }
  p[u & PAGE_MASK] = val & 0xFF;
}

function initializeState() {
  cpu.regs = new Int32Array(32);
  fpBits.fill(0);
  lrReservation = null;
  memory.pages = new Map();
  cpu.pc = layout.baseAddress;
  cpu.lastChangedReg = -1;
  cpu.lastChangedMem = [];
  cpu.totalCycles = 0;
  cpu.instructionCount = 0;
  pipeReset();
  run.currentLine = -1;
  heapPointer = (typeof layout.dataBase !== 'undefined' ? layout.dataBase : 0x20000) + 0x4000;
  // Note: In RISC-V hardware, integer registers (including sp / x2) are initialized to 0 on reset
  oled.col = 0;
  oled.row = 0;
  oled.ctrl = 0;
  oled.data = 0;
  oled.advCol = false;
  oled.advRow = false;
  oledResetPages();
  updateOledCanvas();
}

let pcToLineMap = new Map();

function buildPcToLineMap(mc) {
  pcToLineMap = new Map();
  if (Array.isArray(mc)) {
    for (let k = 0; k < mc.length; k++) {
      const item = mc[k];
      if (!item.error && item.bytes && typeof item.address === 'number' && typeof item.line === 'number') {
        pcToLineMap.set(item.address, item.line);
      }
    }
  }
}

function loadProgram(mc) {
  initializeState();
  stepHistory.entries = [];
  stepHistory.writeLog = [];
  stepHistory.pixelLog = [];
  buildPcToLineMap(mc);
  for (let k = 0; k < mc.length; k++) {
    const item = mc[k];
    if (item.bytes && !item.error) {
      const addr = item.address;
      for (let i = 0; i < item.bytes.length; i++) {
        setMemByte(addr + i, item.bytes[i]);
      }
    }
  }
  if (program.labels['_start'] !== undefined) {
    cpu.pc = program.labels['_start'];
  } else if (program.labels['main'] !== undefined) {
    cpu.pc = program.labels['main'];
  } else {
    cpu.pc = layout.baseAddress;
  }
}

function isMMIOAddr(addr) {
  const u = addr >>> 0;
  return (u >= 0xFFFF0000 && u < 0xFFFF0100);
}

// True when an access touches the MMIO window without lying inside one
// register: a misaligned word at its edge, or one spanning two registers.
// Those go byte by byte, each byte to wherever its own address decodes,
// rather than all of it to wherever the first byte happened to fall.
function mmioSplitAccess(uaddr, size) {
  const last = (uaddr + size - 1) >>> 0;
  const first = isMMIOAddr(uaddr), lastIn = isMMIOAddr(last);
  if (!first && !lastIn) return false;
  return !(first && lastIn && (uaddr & ~3) === (last & ~3));
}

function readMem(addr, size, peekOnly = false) {
  const uaddr = addr >>> 0;
  if (mmioSplitAccess(uaddr, size)) {
    let val = 0;
    for (let i = 0; i < size; i++) {
      const a = (uaddr + i) >>> 0;
      const b = isMMIOAddr(a) ? handleMMIORead(a, 1, peekOnly) : getMemByte(a);
      val |= (b & 0xFF) << (i * 8);
    }
    return val >>> 0;
  }
  if (isMMIOAddr(uaddr)) return handleMMIORead(uaddr, size, peekOnly);
  const pageIdx = uaddr >>> PAGE_BITS;
  const offset = uaddr & PAGE_MASK;
  const page = memory.pages.get(pageIdx);
  if (offset + size <= PAGE_SIZE) {
    if (!page) return 0;
    if (size === 4) {
      return ((page[offset] | (page[offset + 1] << 8) | (page[offset + 2] << 16) | (page[offset + 3] << 24)) >>> 0);
    } else if (size === 1) {
      return page[offset];
    } else if (size === 2) {
      return page[offset] | (page[offset + 1] << 8);
    }
    let val = 0;
    for (let i = 0; i < size; i++) {
      val |= (page[offset + i] << (i * 8));
    }
    return val >>> 0;
  }
  let val = 0;
  for (let i = 0; i < size; i++) {
    const a = (uaddr + i) >>> 0;
    const p = memory.pages.get(a >>> PAGE_BITS);
    const b = p ? p[a & PAGE_MASK] : 0;
    val |= (b << (i * 8));
  }
  return val >>> 0;
}

function readMemSigned(addr, size, peekOnly = false) {
  const val = readMem(addr, size, peekOnly);
  if (size === 4) return val | 0;
  const signBit = 1 << (size * 8 - 1);
  if (val & signBit) return (val - (1 << (size * 8))) | 0;
  return val;
}

function writeMem(addr, val, size) {
  const uaddr = addr >>> 0;
  if (mmioSplitAccess(uaddr, size)) {
    for (let i = 0; i < size; i++) writeMem((uaddr + i) >>> 0, (val >>> (i * 8)) & 0xFF, 1);
    cpu.lastChangedMem = [{ addr: uaddr, size }];
    return;
  }
  if (isMMIOAddr(uaddr)) {
    handleMMIOWrite(uaddr, val, size);
    cpu.lastChangedMem = [{ addr: uaddr, size }];
    return;
  }
  // Journal old bytes for back-step (only during single-stepping execution)
  if (stepHistory.journalEnabled) {
    for (let i = 0; i < size; i++) {
      const a = (uaddr + i) >>> 0;
      const p = memory.pages.get(a >>> PAGE_BITS);
      const old = p ? p[a & PAGE_MASK] : 0;
      stepHistory.writeLog.push({ addr: a, old });
    }
  }
  const pageIdx = uaddr >>> PAGE_BITS;
  const offset = uaddr & PAGE_MASK;
  if (offset + size <= PAGE_SIZE) {
    let page = memory.pages.get(pageIdx);
    if (!page) {
      page = new Uint8Array(PAGE_SIZE);
      memory.pages.set(pageIdx, page);
    }
    if (size === 4) {
      page[offset] = val & 0xFF;
      page[offset + 1] = (val >> 8) & 0xFF;
      page[offset + 2] = (val >> 16) & 0xFF;
      page[offset + 3] = (val >> 24) & 0xFF;
    } else if (size === 1) {
      page[offset] = val & 0xFF;
    } else if (size === 2) {
      page[offset] = val & 0xFF;
      page[offset + 1] = (val >> 8) & 0xFF;
    } else {
      for (let i = 0; i < size; i++) {
        page[offset + i] = (val >> (i * 8)) & 0xFF;
      }
    }
  } else {
    for (let i = 0; i < size; i++) {
      const a = (uaddr + i) >>> 0;
      const pIdx = a >>> PAGE_BITS;
      let page = memory.pages.get(pIdx);
      if (!page) {
        page = new Uint8Array(PAGE_SIZE);
        memory.pages.set(pIdx, page);
      }
      page[a & PAGE_MASK] = (val >> (i * 8)) & 0xFF;
    }
  }
  cpu.lastChangedMem = [{ addr: uaddr, size }];
}

function oledBlankPage(buf) {
  buf.fill(0);
  for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
}

// Back to a single blank page, which is where a reset leaves the panel.
function oledResetPages() {
  oled.pages = [new Uint8Array(96 * 64 * 4), new Uint8Array(96 * 64 * 4)];
  oled.pages.forEach(oledBlankPage);
  oled.front = 0;
  oled.back = 0;
  oled.buffer = oled.pages[0];
  oled.swapUnpolled = false;
  oled.raceWarned = false;
}

// Present the page just drawn. The controller copies it into the new back
// page, so a program can go on updating only the pixels it cares about.
// On hardware the copy sits inside the window OLED_SwapPending covers;
// here there is no scanout to wait for, so it happens at once.
function oledPresent() {
  if (oled.front === oled.back) {
    // First present: split the pages, leaving the drawn frame on screen.
    oled.back = 1 - oled.front;
  } else {
    const t = oled.front;
    oled.front = oled.back;
    oled.back = t;
  }
  if (stepHistory.journalEnabled) stepHistory.pixelLog.push({ page: oled.back, full: oled.pages[oled.back].slice() });
  oled.pages[oled.back].set(oled.pages[oled.front]);
  oled.buffer = oled.pages[oled.back];
  oled.swapUnpolled = true;
  updateOledCanvas();
}

// The board makes a present take time: it waits up to a whole frame for the
// scanout to reach a boundary, then 12288 clocks to copy the shown page
// back. Pixels written before the boundary land in the page about to be
// shown, and pixels written during the copy are discarded outright - the
// copy engine owns the write port for its duration. OLED_STATUS is how
// software stays out of that window, and it is free here because neither
// delay is modelled, so a program that never reads it looks correct. Saying
// so is the only warning this page can give.
// An edit typed into the Memory panel is not the program racing anything.
let memoryPanelEdit = false;

function oledNotePixelWrite() {
  if (memoryPanelEdit || !oled.swapUnpolled || oled.raceWarned) return;
  oled.raceWarned = true;
  log('OLED: pixels were written after a present, with no read of OLED_STATUS ' +
      'in between. That works here, where a present lands at once. On the board ' +
      'it waits up to a frame (15.73 ms) for the scanout boundary - ' +
      Math.round(cpuHz() * 0.01572864).toLocaleString('en-US') + ' cycles at the ' +
      'current clock - and then ' + Math.round(cpuHz() * 122.88e-6).toLocaleString('en-US') +
      ' more to copy the page back. ' +
      'Pixels written before the boundary appear in the frame being presented, ' +
      'and pixels written during the copy are lost. Poll OLED_STATUS until bit 0 ' +
      'clears before drawing again.', 'warning');
}

// OLED_Col is a 7-bit register, so software can set a column the 96-wide
// panel does not have. The panel does not wrap it: PmodOLEDrgb_bitmap
// addresses with (col[6] and not col[5]) & col[5:0], which folds 96..127
// back onto 32..63 and leaves everything below 96 alone. Kept as a
// separate step from the register itself because the Wrapper's
// auto-advance arithmetic works on the raw 7-bit value, not the folded one.
function oledPanelCol(col) {
  const c = col & 0x7F;
  return ((c & 0x40) && !(c & 0x20)) ? (64 + (c & 0x3F)) : (c & 0x3F);
}

// Resolves a write to OLED_DATA into the Wrapper's 24-bit OLED_Data
// register. Two things this has to copy exactly, because the HDL engine
// paints the Wrapper's own OLED_Data and the two engines must agree:
//
//  - Narrow components are LEFT-ALIGNED and zero-filled, not scaled to
//    full range. 3-bit red 0b111 is 0xE0, not 0xFF.
//  - Each colour mode has its own byte-enable rule. 8-bit needs the low
//    byte, 16-bit needs the low two, and 24-bit takes whichever lanes
//    the access covers, leaving the rest of the register alone.
//
// Returns false when the access does not satisfy the mode's rule, in
// which case the register keeps its previous value - the pixel is still
// painted (the Wrapper triggers on the access, not on the update), just
// with the colour that was already there.
function oledStoreData(offset, val, size) {
  let be = 0;
  for (let i = 0; i < size; i++) be |= 1 << ((offset + i) & 3);
  // The bus presents the data on the lanes the address selects.
  const wd = (((val >>> 0) << (8 * (offset & 3))) >>> 0);
  const colorMode = (oled.ctrl >> 4) & 0x0F;

  if (colorMode === 0x1) {          // 16-bit 5R-6G-5B
    if ((be & 0x3) !== 0x3) return false;
    oled.data = ((((wd >>> 11) & 0x1F) << 19) |
                   (((wd >>> 5) & 0x3F) << 10) |
                   ((wd & 0x1F) << 3)) >>> 0;
  } else if (colorMode === 0x2) {   // 24-bit, one byte lane at a time
    if (!(be & 0x7)) return false;
    let v = oled.data >>> 0;
    if (be & 0x4) v = (v & ~0xFF0000) | (wd & 0xFF0000);
    if (be & 0x2) v = (v & ~0x00FF00) | (wd & 0x00FF00);
    if (be & 0x1) v = (v & ~0x0000FF) | (wd & 0x0000FF);
    oled.data = v >>> 0;
  } else {                          // 8-bit 3R-3G-2B
    if (!(be & 0x1)) return false;
    oled.data = ((((wd >>> 5) & 0x7) << 21) |
                   (((wd >>> 2) & 0x7) << 13) |
                   ((wd & 0x3) << 6)) >>> 0;
  }
  return true;
}

function writeOledPixel(val) {
  oledNotePixelWrite();
  // `val` is already the resolved 24-bit OLED_Data register.
  const r = (val >>> 16) & 0xFF;
  const g = (val >>> 8) & 0xFF;
  const b = val & 0xFF;

  const c = oledPanelCol(oled.col);
  const rIdx = oled.row & 0x3F;
  const pixelIdx = (rIdx * 96 + c) * 4;
  if (stepHistory.journalEnabled) stepHistory.pixelLog.push({ page: oled.back, idx: pixelIdx, old: oled.buffer.slice(pixelIdx, pixelIdx + 4) });
  oled.buffer[pixelIdx] = r;
  oled.buffer[pixelIdx + 1] = g;
  oled.buffer[pixelIdx + 2] = b;
  oled.buffer[pixelIdx + 3] = 255;
}

function setUartSendMode(mode) {
  uart.sendMode = (mode === 'typed' || mode === 'forgiving') ? mode : 'paste';
  // Keep the control in step when the mode is set from anywhere but the
  // control itself.
  const sel = document.getElementById('uartSendMode');
  if (sel && sel.value !== uart.sendMode) sel.value = uart.sendMode;
  const el = document.getElementById('uartCharInstr');
  // The instr/char box drives whichever rate the mode uses, so it follows
  // the mode rather than sitting there meaning nothing.
  if (el) {
    el.value = uart.sendMode === 'typed' ? uart.typedInstr : uart.charInstr;
    el.disabled = uart.sendMode !== 'typed';
    el.style.opacity = el.disabled ? '0.5' : '';
  }
  updatePeripherals();
}

function setUartCharInstr(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return;
  if (uart.sendMode === 'typed') uart.typedInstr = n; else uart.charInstr = n;
  updatePeripherals();
}

function uartGapInstr() {
  return uart.sendMode === 'typed' ? Math.max(1, uart.typedInstr)
       : Math.max(1, uart.charInstr);
}

// Hand one byte to the FPGA's holding register. If the program has not
// taken the previous one, the new byte is lost and the old one kept -
// The top level module for synthesis acks the UART to release it but leaves
// UART_RX alone, and raises no flag. Counted here only so the console can say
// what happened.
function uartDeliverByte(b) {
  if (uart.rxFull) { uart.rxDropped++; uart.rxDroppedTotal++; return false; }
  uart.rxByte = b & 0xFF;
  uart.rxFull = true;
  return true;
}

function uartReportDrops() {
  if (!uart.rxDropped || uart.pending.length) return;
  log(`UART RX: ${uart.rxDropped} byte${uart.rxDropped > 1 ? 's' : ''} lost - ` +
      `the program did not read UART_RX before the next character arrived ` +
      `(${uartGapInstr()} cycles apart). The hardware holds one byte and ` +
      `discards the rest without any flag, so this would be silent on the board.`, 'warning');
  uart.rxDropped = 0;
}

// The UART's clock. A character time is a count of single-cycle
// instructions, which is a count of cycles once the pipeline is on.
function uartNow() { return cpu.totalCycles; }

// Called once per executed instruction, or per cycle when pipelined.
// Moves bytes from the PC's buffer into the holding register as their
// time comes.
function uartTickDelivery() {
  if (!uart.pending.length) return;
  if (uart.sendMode === 'forgiving') {
    // Hand over only once the program has taken the previous byte, so
    // nothing is ever lost. The wire does not do this; see the guide.
    if (!uart.rxFull) uartDeliverByte(uart.pending.shift());
    return;
  }
  while (uart.pending.length && uartNow() >= uart.nextDeliveryInstr) {
    uartDeliverByte(uart.pending.shift());
    uart.nextDeliveryInstr = uartNow() + uartGapInstr();
  }
  uartReportDrops();
}

// Everything one step can change on the peripheral side, bar the OLED
// pages. Snapshotting the scalars whole keeps the undo in one place
// instead of a hook at every write site, so a new peripheral only has to
// be listed here; the cost is one small object per single-step.
function capturePeriphState() {
  return {
    ledState: board.leds, sevsegState: board.sevseg,
    oledCol: oled.col, oledRow: oled.row, oledCtrl: oled.ctrl, oledDataVal: oled.data, oledAdvCol: oled.advCol, oledAdvRow: oled.advRow,
    oledFrontPage: oled.front, oledBackPage: oled.back, oledSwapUnpolled: oled.swapUnpolled, oledRaceWarned: oled.raceWarned,
    uartPending: uart.pending.slice(),
    uartRxByte: uart.rxByte, uartRxFull: uart.rxFull, uartRxDropped: uart.rxDropped, uartRxDroppedTotal: uart.rxDroppedTotal,
    uartNextDeliveryInstr: uart.nextDeliveryInstr,
    uartTxBuffer: uart.txText, uartTxLen: uart.txBytes.length
  };
}

function restorePeriphState(s) {
  board.leds = s.ledState; board.sevseg = s.sevsegState;
  oled.col = s.oledCol; oled.row = s.oledRow;
  oled.ctrl = s.oledCtrl; oled.data = s.oledDataVal;
  oled.advCol = s.oledAdvCol; oled.advRow = s.oledAdvRow;
  oled.front = s.oledFrontPage; oled.back = s.oledBackPage;
  oled.buffer = oled.pages[oled.back];
  oled.swapUnpolled = s.oledSwapUnpolled; oled.raceWarned = s.oledRaceWarned;
  uart.pending = s.uartPending.slice();
  uart.rxByte = s.uartRxByte; uart.rxFull = s.uartRxFull;
  uart.rxDropped = s.uartRxDropped; uart.rxDroppedTotal = s.uartRxDroppedTotal;
  uart.nextDeliveryInstr = s.uartNextDeliveryInstr;
  uart.txText = s.uartTxBuffer; uart.txBytes.length = s.uartTxLen;
}

// Undo one step's OLED page edits, newest first: a whole-page entry is a
// present's copy, a short one is a single pixel.
function restoreOledPages(log) {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.full) oled.pages[e.page].set(e.full);
    else oled.pages[e.page].set(e.old, e.idx);
  }
}

function mmioRegisterFor(u) {
  return MMIO_BY_ADDR.get((u & ~3) >>> 0);
}

function handleMMIOWrite(addr, val, size) {
  const u = addr >>> 0;
  const reg = mmioRegisterFor(u);
  if (!reg) return;
  notePeripheralUse(reg);
  if (reg.write) reg.write(u & 3, val, size);
}

function handleMMIORead(addr, size, peekOnly = false) {
  const u = addr >>> 0;
  const reg = mmioRegisterFor(u);
  if (!reg || !reg.read) return 0;
  if (!peekOnly) notePeripheralUse(reg);
  const off = u & 3;
  const v = reg.read(off, peekOnly) >>> 0;
  const bits = Math.min(size, 4 - off) * 8;
  return bits >= 32 ? v : (v >>> (off * 8)) & ((1 << bits) - 1);
}

function uartTransmit(ch) {
  uart.txBytes.push(ch);
  uart.txText += String.fromCharCode(ch);
  // A run repaints the terminal once per batch; doing it per byte
  // re-sets the whole transcript each time, which grows as n squared.
  if (!run.running) renderUartTerminal();
}

function sevsegValue() {
  return parseInt(board.sevseg, 16) || 0;
}

// vary_col / vary_row: writing the coordinate paints the stored colour.
function oledTrigger(mode) {
  if ((oled.ctrl & 0x0F) !== mode) return;
  oled.advCol = oled.advRow = false;
  writeOledPixel(oled.data);
}

// The colour mode is resolved here, on the write, not when the pixel is
// painted: a later mode change must not retint a stored colour, and
// vary_col/vary_row paint this register some writes afterwards.
//
// Auto-advance steps BEFORE painting, and only once the mode has already
// seen a write: the Wrapper arms a flag on the first write and gates the
// increment on its previous value. That ordering is what puts the first
// pixel on the column you set, and leaves the register on the last pixel
// drawn rather than one past it. Writing OLED_COL or OLED_ROW disarms the
// flag, so the next pixel lands where it was set.
function oledDataWrite(off, val, size) {
  oledStoreData(off, val, size);
  const triggerMode = oled.ctrl & 0x0F;
  if (triggerMode === 0x4) {          // autoadvance_col (row major)
    if (oled.advCol) {
      if (oled.col >= 95) {
        oled.col = 0;
        oled.row = (oled.row + 1) & 0x3F;
      } else {
        oled.col++;
      }
    }
    oled.advCol = true;
    oled.advRow = false;
    writeOledPixel(oled.data);
  } else if (triggerMode === 0x5) {   // autoadvance_row (column major)
    if (oled.advRow) {
      if (oled.row >= 63) {
        oled.row = 0;
        oled.col = (oled.col >= 95) ? 0 : oled.col + 1;
      } else {
        oled.row++;
      }
    }
    oled.advRow = true;
    oled.advCol = false;
    writeOledPixel(oled.data);
  } else if (triggerMode === 0x0) {   // vary_pixel_data
    oled.advCol = oled.advRow = false;
    writeOledPixel(oled.data);
  }
}

function fetchInstruction(addr) {
  return readMem(addr, 4);
}

function decodeAndExecute(instr32, addr) {
  const opcode = instr32 & 0x7F;
  const rd = (instr32 >> 7) & 0x1F;
  const funct3 = (instr32 >> 12) & 0x7;
  const rs1 = (instr32 >> 15) & 0x1F;
  const rs2 = (instr32 >> 20) & 0x1F;
  const funct7 = (instr32 >> 25) & 0x7F;

  // Decode immediates
  const immI = sext(instr32 >> 20, 12);
  const immS = sext(((instr32 >> 25) << 5) | ((instr32 >> 7) & 0x1F), 12);
  const immB = sext(
    ((instr32 >> 31) << 12) |
    (((instr32 >> 25) & 0x3F) << 5) |
    (((instr32 >> 8) & 0xF) << 1) |
    ((instr32 >> 7) & 1) << 11, 13);
  const immU = instr32 & 0xFFFFF000;
  const immJ = sext(
    ((instr32 >> 31) << 20) |
    (((instr32 >> 21) & 0x3FF) << 1) |
    (((instr32 >> 20) & 1) << 11) |
    ((instr32 >> 12) & 0xFF) << 12, 21);

  let nextPC = addr + 4;

  switch (opcode) {
    case 0b0110111: // LUI
      cpu.regs[rd] = immU;
      break;
    case 0b0010111: // AUIPC
      cpu.regs[rd] = addr + immU;
      break;
    case 0b1101111: // JAL
      if (rd !== 0) cpu.regs[rd] = addr + 4;
      nextPC = addr + immJ;
      break;
    case 0b1100111: // JALR
      const jalrTarget = (cpu.regs[rs1] + immI) & ~1;
      if (rd !== 0) cpu.regs[rd] = addr + 4;
      nextPC = jalrTarget;
      break;
    case 0b1100011: // BRANCH
      let taken = false;
      switch (funct3) {
        case 0b000: taken = cpu.regs[rs1] === cpu.regs[rs2]; break; // BEQ
        case 0b001: taken = cpu.regs[rs1] !== cpu.regs[rs2]; break; // BNE
        case 0b100: taken = cpu.regs[rs1] < cpu.regs[rs2]; break; // BLT
        case 0b101: taken = cpu.regs[rs1] >= cpu.regs[rs2]; break; // BGE
        case 0b110: taken = unsigned(cpu.regs[rs1]) < unsigned(cpu.regs[rs2]); break; // BLTU
        case 0b111: taken = unsigned(cpu.regs[rs1]) >= unsigned(cpu.regs[rs2]); break; // BGEU
      }
      if (taken) nextPC = addr + immB;
      break;
    case 0b0000011: // LOAD
      let loadAddr = (cpu.regs[rs1] >>> 0) + immI;
      if (rd !== 0) {
        switch (funct3) {
          case 0b000: cpu.regs[rd] = readMemSigned(loadAddr, 1); break; // LB
          case 0b001: cpu.regs[rd] = readMemSigned(loadAddr, 2); break; // LH
          case 0b010: cpu.regs[rd] = readMemSigned(loadAddr, 4); break; // LW
          case 0b100: cpu.regs[rd] = readMem(loadAddr, 1); break; // LBU
          case 0b101: cpu.regs[rd] = readMem(loadAddr, 2); break; // LHU
        }
      }
      break;
    case 0b0100011: // STORE
      {
        let storeAddr = (cpu.regs[rs1] >>> 0) + immS;
        switch (funct3) {
          case 0b000: writeMem(storeAddr, cpu.regs[rs2] & 0xFF, 1); break; // SB
          case 0b001: writeMem(storeAddr, cpu.regs[rs2] & 0xFFFF, 2); break; // SH
          case 0b010: writeMem(storeAddr, cpu.regs[rs2], 4); break; // SW
        }
      }
      break;
    case 0b0011011: // OP-IMM-32 (addiw, slliw, srliw, sraiw)
      if (rd !== 0) {
        let shamtW = rs2 & 0x1F;
        switch (funct3) {
          case 0b000: cpu.regs[rd] = (cpu.regs[rs1] + immI) | 0; break; // ADDIW
          case 0b001: cpu.regs[rd] = (cpu.regs[rs1] << shamtW) | 0; break; // SLLIW
          case 0b101:
            if ((funct7 >> 5) & 1) cpu.regs[rd] = (cpu.regs[rs1] >> shamtW) | 0; // SRAIW
            else cpu.regs[rd] = (unsigned(cpu.regs[rs1]) >>> shamtW) | 0; // SRLIW
            break;
        }
      }
      break;
    case 0b0111011: // OP-32 (addw, subw, sllw, srlw, sraw)
      if (rd !== 0) {
        let shamtW = cpu.regs[rs2] & 0x1F;
        switch (funct3) {
          case 0b000:
            if (funct7 & 0x20) cpu.regs[rd] = (cpu.regs[rs1] - cpu.regs[rs2]) | 0; // SUBW
            else cpu.regs[rd] = (cpu.regs[rs1] + cpu.regs[rs2]) | 0; // ADDW
            break;
          case 0b001: cpu.regs[rd] = (cpu.regs[rs1] << shamtW) | 0; break; // SLLW
          case 0b101:
            if (funct7 & 0x20) cpu.regs[rd] = (cpu.regs[rs1] >> shamtW) | 0; // SRAW
            else cpu.regs[rd] = (unsigned(cpu.regs[rs1]) >>> shamtW) | 0; // SRLW
            break;
        }
      }
      break;
    case 0b1000011: // FMADD
    case 0b1000111: // FMSUB
    case 0b1001011: // FNMSUB
    case 0b1001111: // FNMADD
      {
        // Fused in the spec; here the product of two singles is exact in
        // a double, so .s is effectively fused, and .d rounds twice.
        const rs3 = (instr32 >> 27) & 0x1F;
        const funct2 = (instr32 >> 25) & 0x3;
        const neg = opcode === 0b1001011 || opcode === 0b1001111;   // fnm*
        const sub = opcode === 0b1000111 || opcode === 0b1001111;   // f*sub, fnmadd
        const fma = (a, b, c) => (neg ? -(a * b) : a * b) + (sub ? -c : c);
        if (funct2 === 0) setS(rd, fma(getS(rs1), getS(rs2), getS(rs3)));
        else if (funct2 === 1) dregs[rd] = fma(dregs[rs1], dregs[rs2], dregs[rs3]);
      }
      break;
    case 0b0010011: // ALU IMMEDIATE
      if (rd !== 0) {
        let shamt = rs2 & 0x1F;
        switch (funct3) {
          case 0b000: cpu.regs[rd] = cpu.regs[rs1] + immI; break; // ADDI
          case 0b010: cpu.regs[rd] = cpu.regs[rs1] < immI ? 1 : 0; break; // SLTI
          case 0b011: cpu.regs[rd] = unsigned(cpu.regs[rs1]) < unsigned(immI) ? 1 : 0; break; // SLTIU
          case 0b100: cpu.regs[rd] = cpu.regs[rs1] ^ immI; break; // XORI
          case 0b110: cpu.regs[rd] = cpu.regs[rs1] | immI; break; // ORI
          case 0b111: cpu.regs[rd] = cpu.regs[rs1] & immI; break; // ANDI
          case 0b001: cpu.regs[rd] = cpu.regs[rs1] << shamt; break; // SLLI
          case 0b101:
            if ((funct7 >> 5) & 1) cpu.regs[rd] = cpu.regs[rs1] >> shamt; // SRAI
            else cpu.regs[rd] = unsigned(cpu.regs[rs1]) >>> shamt; // SRLI
            break;
        }
      }
      break;
    case 0b0110011: // ALU REGISTER
      if (rd !== 0) {
        if (funct7 === 0b0000001) {
          switch (funct3) {
            case 0b000: cpu.regs[rd] = Math.imul(cpu.regs[rs1], cpu.regs[rs2]); break; // MUL
            case 0b001: // MULH
              cpu.regs[rd] = mulh(cpu.regs[rs1], cpu.regs[rs2]); break;
            case 0b010: // MULHSU
              cpu.regs[rd] = mulhsu(cpu.regs[rs1], cpu.regs[rs2]); break;
            case 0b011: // MULHU
              cpu.regs[rd] = mulhu(unsigned(cpu.regs[rs1]), unsigned(cpu.regs[rs2])); break;
            case 0b100: // DIV
              if (cpu.regs[rs2] === 0) cpu.regs[rd] = -1;
              else cpu.regs[rd] = Math.trunc(cpu.regs[rs1] / cpu.regs[rs2]);
              break;
            case 0b101: // DIVU
              if (cpu.regs[rs2] === 0) cpu.regs[rd] = -1;
              else cpu.regs[rd] = Math.trunc(unsigned(cpu.regs[rs1]) / unsigned(cpu.regs[rs2]));
              break;
            case 0b110: // REM
              if (cpu.regs[rs2] === 0) cpu.regs[rd] = cpu.regs[rs1];
              else cpu.regs[rd] = cpu.regs[rs1] % cpu.regs[rs2];
              break;
            case 0b111: // REMU
              if (cpu.regs[rs2] === 0) cpu.regs[rd] = unsigned(cpu.regs[rs1]);
              else cpu.regs[rd] = unsigned(cpu.regs[rs1]) % unsigned(cpu.regs[rs2]);
              break;
          }
        } else {
          switch (funct3) {
            case 0b000:
              if (funct7 & 0x20) cpu.regs[rd] = cpu.regs[rs1] - cpu.regs[rs2]; // SUB
              else cpu.regs[rd] = cpu.regs[rs1] + cpu.regs[rs2]; // ADD
              break;
            case 0b001: cpu.regs[rd] = cpu.regs[rs1] << (cpu.regs[rs2] & 0x1F); break; // SLL
            case 0b010: cpu.regs[rd] = cpu.regs[rs1] < cpu.regs[rs2] ? 1 : 0; break; // SLT
            case 0b011: cpu.regs[rd] = unsigned(cpu.regs[rs1]) < unsigned(cpu.regs[rs2]) ? 1 : 0; break; // SLTU
            case 0b100: cpu.regs[rd] = cpu.regs[rs1] ^ cpu.regs[rs2]; break; // XOR
            case 0b101:
              if (funct7 & 0x20) cpu.regs[rd] = cpu.regs[rs1] >> (cpu.regs[rs2] & 0x1F); // SRA
              else cpu.regs[rd] = unsigned(cpu.regs[rs1]) >>> (cpu.regs[rs2] & 0x1F); // SRL
              break;
            case 0b110: cpu.regs[rd] = cpu.regs[rs1] | cpu.regs[rs2]; break; // OR
            case 0b111: cpu.regs[rd] = cpu.regs[rs1] & cpu.regs[rs2]; break; // AND
          }
        }
      }
      break;
    case 0b0000111: // LOAD FP
      {
        const fAddr = cpu.regs[rs1] + immI;
        if (funct3 === 0b010) setSBits(rd, readMem(fAddr, 4));           // FLW
        else if (funct3 === 0b011) {                                      // FLD
          fpBits[2 * rd] = readMem(fAddr, 4);
          fpBits[2 * rd + 1] = readMem(fAddr + 4, 4);
        }
      }
      break;
    case 0b0100111: // STORE FP
      {
        // The bits as they are, boxed or not: stores do not check.
        const fAddr = cpu.regs[rs1] + immS;
        if (funct3 === 0b010) writeMem(fAddr, fpBits[2 * rs2], 4);       // FSW
        else if (funct3 === 0b011) {                                      // FSD
          writeMem(fAddr, fpBits[2 * rs2], 4);
          writeMem(fAddr + 4, fpBits[2 * rs2 + 1], 4);
        }
      }
      break;
    case 0b1010011: // FP OPERATIONS
      executeFP(instr32, rd, funct3, rs1, rs2, funct7);
      break;
    case 0b0101111: // ATOMIC
      executeAtomic(instr32, rd, funct3, rs1, rs2, funct7);
      break;
    case 0b1110011: // SYSTEM
      if (funct3 === 0b000) {
        if (immI === 0) handleECall(); // ECALL
        else if (immI === 1) handleEBreak(); // EBREAK
      }
      break;
    default:
      // Unknown instruction - just advance PC
      break;
  }

  cpu.regs[0] = 0;

  // Track last written register for UI highlighting
  if (rd !== 0 && opcode !== 0b0100011 && opcode !== 0b0100111 && opcode !== 0b1100011) {
    cpu.lastExecutedRd = rd;
  }

  return nextPC;
}

function unsigned(val) {
  return val >>> 0;
}

function mulh(a, b) {
  return Number((BigInt(a) * BigInt(b)) >> 32n);
}

function mulhu(a, b) {
  return Number((BigInt(a >>> 0) * BigInt(b >>> 0)) >> 32n);
}

function mulhsu(a, b) {
  return Number((BigInt(a) * BigInt(b >>> 0)) >> 32n);
}

function fpRound(v, rm) {
  switch (rm) {
    case 1: return Math.trunc(v);                               // rtz
    case 2: return Math.floor(v);                               // rdn
    case 3: return Math.ceil(v);                                // rup
    case 4: return Math.sign(v) * Math.round(Math.abs(v));      // rmm
    default: {                                                  // rne, and dyn
      const f = Math.floor(v), d = v - f;
      if (d !== 0.5) return d < 0.5 ? f : f + 1;
      return f % 2 === 0 ? f : f + 1;
    }
  }
}

// FP to integer conversion rounds as rm says and saturates, as the spec
// requires: NaN and anything above the range give the largest value,
// anything below it the smallest. A plain store into the Int32Array would
// wrap instead.
function fpToInt(v, unsignedResult, rm) {
  const t = fpRound(v, rm);
  if (unsignedResult) {
    if (Number.isNaN(t) || t > 0xFFFFFFFF) return -1;
    return t < 0 ? 0 : t;
  }
  if (Number.isNaN(t) || t > 0x7FFFFFFF) return 0x7FFFFFFF;
  return t < -0x80000000 ? -0x80000000 : t;
}

// fmin/fmax return the other operand when one is NaN, and the canonical
// NaN only when both are. Math.min/max already order -0 below +0.
function fpMinMax(a, b, isMax) {
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  return isMax ? Math.max(a, b) : Math.min(a, b);
}

// Sign injection works on bit patterns: the magnitude of a, the sign
// chosen from b by funct3 (0 copy, 1 negate, 2 xor).
function fpSignInject(aSign, bSign, funct3) {
  if (funct3 === 0b000) return bSign;
  if (funct3 === 0b001) return bSign ^ 1;
  return aSign ^ bSign;
}

// funct3 is the rounding mode for the arithmetic and the conversions and
// selects the operation for the rest. Arithmetic always rounds to nearest
// even, which is what JS does; the conversions to integer honour it.
function executeFP(instr32, rd, funct3, rs1, rs2, funct7) {
  // fmt is funct7's low bit, except fcvt.s.d, whose fmt names the result.
  const isDouble = (funct7 & 1) === 1 || funct7 === 0b0100000;

  if (isDouble) {
    const a = dregs[rs1], b = dregs[rs2];
    switch (funct7) {
      case 0b0000001: dregs[rd] = a + b; break;                            // FADD.D
      case 0b0000101: dregs[rd] = a - b; break;                            // FSUB.D
      case 0b0001001: dregs[rd] = a * b; break;                            // FMUL.D
      case 0b0001101: dregs[rd] = a / b; break;                            // FDIV.D
      case 0b0101101: if (rs2 === 0) dregs[rd] = Math.sqrt(a); break;      // FSQRT.D
      case 0b0010101: if (funct3 <= 1) dregs[rd] = fpMinMax(a, b, funct3 === 1); break; // FMIN.D / FMAX.D
      case 0b1100001: if (rs2 <= 1) cpu.regs[rd] = fpToInt(a, rs2 === 1, funct3); break;    // FCVT.W[U].D
      case 0b1101001: if (rs2 <= 1) dregs[rd] = rs2 === 1 ? unsigned(cpu.regs[rs1]) : cpu.regs[rs1]; break; // FCVT.D.W[U]
      case 0b0100000: if (rs2 === 1) setS(rd, a); break;                   // FCVT.S.D
      case 0b0100001: if (rs2 === 0) dregs[rd] = getS(rs1); break;         // FCVT.D.S
      case 0b0010001:                                                      // FSGNJ[N|X].D
        if (funct3 <= 2) {
          const hi = fpBits[2 * rs1 + 1];
          const sign = fpSignInject(hi >>> 31, fpBits[2 * rs2 + 1] >>> 31, funct3);
          fpBits[2 * rd] = fpBits[2 * rs1];
          fpBits[2 * rd + 1] = ((hi & 0x7FFFFFFF) | (sign << 31)) >>> 0;
        }
        break;
      case 0b1010001:
        if (funct3 === 0b010) cpu.regs[rd] = a === b ? 1 : 0;                  // FEQ.D
        else if (funct3 === 0b001) cpu.regs[rd] = a < b ? 1 : 0;               // FLT.D
        else if (funct3 === 0b000) cpu.regs[rd] = a <= b ? 1 : 0;              // FLE.D
        break;
      case 0b1110001: if (funct3 === 0b001) cpu.regs[rd] = fclass(a, true); break; // FCLASS.D
    }
  } else {
    const a = getS(rs1), b = getS(rs2);
    switch (funct7) {
      case 0b0000000: setS(rd, a + b); break;                              // FADD.S
      case 0b0000100: setS(rd, a - b); break;                              // FSUB.S
      case 0b0001000: setS(rd, a * b); break;                              // FMUL.S
      case 0b0001100: setS(rd, a / b); break;                              // FDIV.S
      case 0b0101100: if (rs2 === 0) setS(rd, Math.sqrt(a)); break;        // FSQRT.S
      case 0b0010100: if (funct3 <= 1) setS(rd, fpMinMax(a, b, funct3 === 1)); break; // FMIN.S / FMAX.S
      case 0b1100000: if (rs2 <= 1) cpu.regs[rd] = fpToInt(a, rs2 === 1, funct3); break;  // FCVT.W[U].S
      case 0b1110000: // FMV.X.W moves the low word as it is; FCLASS.S shares funct7
        if (funct3 === 0b000) cpu.regs[rd] = fpBits[2 * rs1] | 0;
        else if (funct3 === 0b001) cpu.regs[rd] = fclass(a, false);
        break;
      case 0b1101000: if (rs2 <= 1) setS(rd, rs2 === 1 ? unsigned(cpu.regs[rs1]) : cpu.regs[rs1]); break; // FCVT.S.W[U]
      case 0b1111000: if (funct3 === 0b000) setSBits(rd, cpu.regs[rs1]); break; // FMV.W.X
      case 0b0010000:                                                      // FSGNJ[N|X].S
        if (funct3 <= 2) {
          const x = getSBits(rs1);
          const sign = fpSignInject(x >>> 31, getSBits(rs2) >>> 31, funct3);
          setSBits(rd, (x & 0x7FFFFFFF) | (sign << 31));
        }
        break;
      case 0b1010000:
        if (funct3 === 0b010) cpu.regs[rd] = a === b ? 1 : 0;                  // FEQ.S
        else if (funct3 === 0b001) cpu.regs[rd] = a < b ? 1 : 0;               // FLT.S
        else if (funct3 === 0b000) cpu.regs[rd] = a <= b ? 1 : 0;              // FLE.S
        break;
    }
  }
}

// One bit per class: -inf, -normal, -subnormal, -0, +0, +subnormal,
// +normal, +inf, signalling NaN, quiet NaN. A NaN is reported quiet, since
// a JS number cannot carry the signalling bit.
function fclass(f, isDouble) {
  if (Number.isNaN(f)) return 0x200;
  const neg = f < 0 || Object.is(f, -0);
  if (!Number.isFinite(f)) return neg ? 0x001 : 0x080;
  if (f === 0) return neg ? 0x008 : 0x010;
  const minNormal = isDouble ? 2.2250738585072014e-308 : 1.1754943508222875e-38;
  if (Math.abs(f) < minNormal) return neg ? 0x004 : 0x020;
  return neg ? 0x002 : 0x040;
}

// The address lr.w reserved, cleared by the sc.w that uses it. With one
// hart nothing else can break a reservation, so sc.w fails only when no
// lr.w reserved that address since the last sc.w.
let lrReservation = null;

function executeAtomic(instr32, rd, funct3, rs1, rs2, funct7) {
  if (funct3 !== 0b010) return;
  const funct5 = funct7 >>> 2;
  const addr = cpu.regs[rs1] >>> 0;
  if (funct5 === 0b00011) {                        // SC.W
    const ok = lrReservation === addr;
    if (ok) writeMem(addr, cpu.regs[rs2], 4);
    cpu.regs[rd] = ok ? 0 : 1;
    lrReservation = null;
    return;
  }
  const memVal = readMem(addr, 4) | 0;
  if (funct5 === 0b00010) {                        // LR.W
    cpu.regs[rd] = memVal;
    lrReservation = addr;
    return;
  }
  const src = cpu.regs[rs2];
  let result;
  switch (funct5) {
    case 0b00001: result = src; break;                                        // AMOSWAP.W
    case 0b00000: result = memVal + src; break;                               // AMOADD.W
    case 0b00100: result = memVal ^ src; break;                               // AMOXOR.W
    case 0b01100: result = memVal & src; break;                               // AMOAND.W
    case 0b01000: result = memVal | src; break;                               // AMOOR.W
    case 0b10000: result = Math.min(memVal, src); break;                      // AMOMIN.W
    case 0b10100: result = Math.max(memVal, src); break;                      // AMOMAX.W
    case 0b11000: result = Math.min(unsigned(memVal), unsigned(src)); break;  // AMOMINU.W
    case 0b11100: result = Math.max(unsigned(memVal), unsigned(src)); break;  // AMOMAXU.W
    default: return;
  }
  cpu.regs[rd] = memVal;
  writeMem(addr, result, 4);
}

function handleECall() {
  const a7 = cpu.regs[17]; // x17 = a7 service number
  const a0 = cpu.regs[10]; // x10 = a0 argument
  const a1 = cpu.regs[11]; // x11 = a1 argument

  switch (a7) {
    case 1: // print_int (a0)
      log(`${a0}`, 'info');
      break;
    case 2: // print_float (fa0)
      log(`${getS(10)}`, 'info');
      break;
    case 3: // print_double (fa0)
      log(`${dregs[10]}`, 'info');
      break;
    case 4: // print_string (a0 = null-terminated string address)
      {
        let s = '';
        let addr = a0 >>> 0;
        while (getMemByte(addr) !== 0 && s.length < 65536) {
          s += String.fromCharCode(getMemByte(addr));
          addr++;
        }
        log(s, 'info');
      }
      break;
    case 5: // read_int -> a0
      {
        let val = 0;
        if (typeof prompt === 'function') {
          const input = prompt('RARS Syscall 5 (read_int): Enter integer:');
          val = parseInt(input, 10) || 0;
        }
        cpu.regs[10] = val | 0;
        log(`[Syscall read_int]: ${val}`, 'info');
      }
      break;
    case 6: // read_float -> fa0
      {
        let val = 0.0;
        if (typeof prompt === 'function') {
          const input = prompt('RARS Syscall 6 (read_float): Enter float:');
          val = parseFloat(input) || 0.0;
        }
        setS(10, val);
        log(`[Syscall read_float]: ${val}`, 'info');
      }
      break;
    case 7: // read_double -> fa0
      {
        let val = 0.0;
        if (typeof prompt === 'function') {
          const input = prompt('RARS Syscall 7 (read_double): Enter double:');
          val = parseFloat(input) || 0.0;
        }
        dregs[10] = val;
        log(`[Syscall read_double]: ${val}`, 'info');
      }
      break;
    case 8: // read_string (a0 = buffer addr, a1 = max length)
      {
        const maxLen = Math.max(0, a1);
        let input = '';
        if (typeof prompt === 'function') {
          input = prompt(`RARS Syscall 8 (read_string): Enter string (max ${maxLen} chars):`) || '';
        }
        let addr = a0 >>> 0;
        const copyLen = Math.min(input.length, Math.max(0, maxLen - 1));
        for (let i = 0; i < copyLen; i++) {
          setMemByte(addr + i, input.charCodeAt(i) & 0xFF);
        }
        setMemByte(addr + copyLen, 0); // null terminator
        log(`[Syscall read_string]: "${input.substring(0, copyLen)}"`, 'info');
      }
      break;
    case 9: // sbrk (a0 = n bytes) -> a0 = old heap pointer
      {
        const bytes = a0 | 0;
        const oldHeap = heapPointer;
        heapPointer += bytes;
        cpu.regs[10] = oldHeap;
        log(`[Syscall sbrk]: allocated ${bytes} bytes at 0x${oldHeap.toString(16)}`, 'info');
      }
      break;
    case 10: // exit
      log('Program exited via ecall 10 (Exit).', 'info');
      run.running = false;
      break;
    case 11: // print_char (a0 = ASCII char)
      {
        const ch = String.fromCharCode(a0 & 0xFF);
        log(ch, 'info');
      }
      break;
    case 12: // read_char -> a0
      {
        let ch = '\0';
        if (typeof prompt === 'function') {
          const input = prompt('RARS Syscall 12 (read_char): Enter character:') || '';
          if (input.length > 0) ch = input[0];
        }
        cpu.regs[10] = ch.charCodeAt(0) & 0xFF;
        log(`[Syscall read_char]: '${ch}'`, 'info');
      }
      break;
    case 34: // print_int_hex (a0)
      log('0x' + (a0 >>> 0).toString(16).padStart(8, '0').toUpperCase(), 'info');
      break;
    case 35: // print_int_binary (a0)
      log('0b' + (a0 >>> 0).toString(2).padStart(32, '0'), 'info');
      break;
    case 36: // print_int_unsigned (a0)
      log(`${a0 >>> 0}`, 'info');
      break;
    case 40: // sleep / delay a0 ms
      log(`[Syscall sleep]: ${a0} ms`, 'info');
      break;
    case 93: // exit2 (exit with code in a0)
      log(`Program exited via ecall 93 (Exit2) with return code ${a0}.`, 'info');
      run.running = false;
      break;
    default:
      log(`[ECALL] Syscall #${a7} (a0=0x${(a0 >>> 0).toString(16)})`, 'warn');
  }
}

function handleEBreak() {
  log('[EBREAK] Breakpoint hit', 'warn');
  run.running = false;
}
