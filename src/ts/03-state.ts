// @ts-nocheck
// Global machine state: the register files, sparse memory and segment
// layout, execution bookkeeping, the MMIO register map, and the UART,
// OLED, accelerometer, clock and board peripheral state.

let regs = new Int32Array(32);
// One FP register file, 64 bits a register, as RV32D has: an F instruction
// reads and writes the low half of the same f register a D instruction
// sees whole. A single is stored NaN-boxed (upper half all ones), and a
// single read from a register that is not boxed reads as the canonical
// NaN, as the spec requires. Views over one buffer, so the raw bits are
// never round-tripped through a JS number, which would lose a NaN's
// payload and with it the boxing; the Float32 view's low-half indexing
// assumes a little-endian host, which every browser is.
const fpFile = new ArrayBuffer(32 * 8);
const fpBits = new Uint32Array(fpFile);   // [2i] low word, [2i+1] high word
const fpLow32 = new Float32Array(fpFile);  // [2i] the single in register i
const dregs = new Float64Array(fpFile);    // [i] the double in register i

function getS(i) { return fpBits[2 * i + 1] === 0xFFFFFFFF ? fpLow32[2 * i] : NaN; }
function setS(i, v) { fpLow32[2 * i] = v; fpBits[2 * i + 1] = 0xFFFFFFFF; }
// A single's bit pattern: the canonical NaN if the register is not boxed.
function getSBits(i) { return fpBits[2 * i + 1] === 0xFFFFFFFF ? fpBits[2 * i] : 0x7FC00000; }
function setSBits(i, bits) { fpBits[2 * i] = bits >>> 0; fpBits[2 * i + 1] = 0xFFFFFFFF; }
const PAGE_BITS = 16; // 64 KB sparse memory pages
const PAGE_SIZE = 1 << PAGE_BITS; // 65536
const PAGE_MASK = PAGE_SIZE - 1; // 0xFFFF
let memoryPages = new Map();
// Configurable memory segment addresses. Defaults match MIPS/RISC-V SPIM-style layout:
//   code .text = 0x00400000, data = 0x10010000, stack top = dataBase + dataSize, MMIO = 0xFFFF0000
const DEFAULT_BASE = 0x00400000;
const DEFAULT_DATA_BASE = 0x10010000;
let baseAddress = DEFAULT_BASE;      // .text base
let codeSize = 0x00000200;           // .text size (default 0x200 / 512 bytes)
// Instruction words by which the last assembly overran the code segment,
// so the final status can say so rather than being overwritten by it.
let lastCodeOverflowWords = 0;
let dataBase = DEFAULT_DATA_BASE;    // .data base
let dataSize = 0x00000200;           // .data size (default 0x200 / 512 bytes)
let stackBase = 0x10010200;          // stack top = dataBase + dataSize
let mmioBase = 0xFFFF0000;           // MMIO base
let currentMemSegment = 'code';
let currentSettingsTab = 'compiler';
let pc = baseAddress;
let machineCode = []; // array of {address, bytes, instruction, line}
let disasmViewMode = 'word'; // 'word' = one whole 32-bit little-endian hex word per 4-byte group (default), 'bytes' = separate hex bytes
let labels = {};
let symbolTable = {};
let assembled = false;
let running = false;
let breakpoints = new Set();           // set of source line numbers (1-based)
let currentExecLine = -1;              // source line currently being executed (for highlight)
let lastChangedReg = -1;
let regDecSigned = true; // sign of the Registers panel's Content (Dec) column
let lastChangedMem = [];
let lastExecutedRd = -1; // Track which register was last written

// Execution statistics
let totalCycles = 0;
let instructionCount = 0;

// Cycles consumed per instruction category (configurable via the settings panel).
let cycleConfig = {
  basic: 1, muldiv: 2, load: 2, store: 2,
  branch: 1, jump: 1, fp: 4, system: 1
};

// Fast Statement Stepping mode: executes all instructions corresponding to a C statement / ASM pseudo-op in one step
let statementStepping = false;

// Maximum number of instructions executed per simulation chunk / batch before yielding to UI
let maxInstructionsPerRun = 100000000;

// Step history for "back step". Each entry stores CPU state + memory writes for one executed instruction.
let execHistory = [];       // stack of {pc, regs, fp, reservation, writes, pixels, periph, line}
let historyCap = 5000;
// Journal of memory writes performed during the current step (used to build undoable history).
let stepWriteLog = [];
let journalEnabled = false;
// Peripheral writes never reach writeMem's byte journal. The scalars are
// snapshotted whole once per step; the OLED pages are too big for that,
// so the bytes a step touches are journalled here instead.
let stepPixelLog = [];

// Memory-mapped I/O: Standard 16550/RISC-V UART Serial Console (115200 8N1)
const UART_RX_VALID = 0xFFFF0000; // RO: Bit 0 = 1 when RX data is valid/available
const UART_RX = 0xFFFF0004; // RO: 8-bit character read (pops from queue)
const UART_TX_READY = 0xFFFF0008; // RO: Bit 0 = 1 when TX is ready to receive data
const UART_TX = 0xFFFF000C; // WO: 8-bit character write (outputs to display terminal)

// OLED 96x64 Pixel Display MMIO Registers
const OLED_COL = 0xFFFF0020; // WO: OLED pixel column index (0..95)
const OLED_ROW = 0xFFFF0024; // WO: OLED pixel row index (0..63)
const OLED_DATA = 0xFFFF0028; // WO: OLED color data word (triggers write)
const OLED_CTRL = 0xFFFF002C; // WO: OLED control register (bits [2:0] trigger mode, bit [3] present, bits [7:4] color format)
const OLED_STATUS = 0xFFFF0030; // RO: bit 0 set while a requested page swap has not completed

// Accelerometer & Cycle Count MMIO Registers
const ACCEL_DATA = 0xFFFF0040; // RO: 32-bit packed [31:24] Temp, [23:16] X, [15:8] Y, [7:0] Z
const ACCEL_DREADY = 0xFFFF0044; // RO: Bit 0 = 1 when new reading is available
const CYCLECOUNT = 0xFFFF00A0; // RO: Cycles elapsed since system reset

let oledCol = 0;
let oledRow = 0;
let oledCtrl = 0;
let oledDataVal = 0;
// The Wrapper's autoadvance_col / autoadvance_row flags: set by the first
// write in that mode, cleared by a write that triggers in any other, and
// what makes the first auto-advanced pixel land where it was addressed.
let oledAdvCol = false;
let oledAdvRow = false;
// Two frame pages, as the OLED controller has. Both start as page 0, so a
// program that never presents sees a single buffer; the first present
// splits them.
let oledPages = [new Uint8Array(96 * 64 * 4), new Uint8Array(96 * 64 * 4)];
let oledFrontPage = 0;   // what the panel scans out
let oledBackPage = 0;    // what writes land in
let oledBuffer = oledPages[0]; // alias for the back page, reassigned whenever that changes
let oledSwapUnpolled = false;  // a present was asked for, OLED_STATUS unread since
let oledRaceWarned = false;    // worth saying once a run, not once a pixel

let accelX = 0;      // 8-bit signed (-128..+127), 0g = 0x00
let accelY = 0;      // 8-bit signed (-128..+127), 0g = 0x00
let accelZ = 64;     // 8-bit signed (-128..+127), +1g = 0x40 (64)
let accelTemp = 25;  // 8-bit signed temperature (-40..+85), default 25°C
let accelDready = 1; // Bit 0 = 1 when data ready

// Peripherals
const PERIPH_LED = 0xFFFF0060;    // write-only: 8-bit LED display
const PERIPH_DIP = 0xFFFF0064;    // read-only: 16-bit DIP switches
const PERIPH_PB = 0xFFFF0068;     // read-only: 3-bit push buttons
const PERIPH_SEVENSEG = 0xFFFF0080; // write-only: 7-segment display

// Single source of truth for every mapped MMIO register: its address, the
// name shown above it in the Memory view, its access type, the
// Peripherals section a program touching it unfolds, and what a read or a
// write does. `read(offset, peek)` returns the whole register and the
// caller picks out the lanes the access covers; `write(offset, val, size)`
// sees the raw bus value. A register with no `read` reads as 0, one with
// no `write` ignores writes, as the hardware does for read-only registers.
// `editable` defaults to (access !== 'RO') and is only overridden for
// UART_RX, whose "write" is a deliberate simulator feature (inject a byte
// into the RX queue) rather than a real register write.
const MMIO_REGISTERS = [
  { addr: UART_RX_VALID, name: 'UART RX VALID', access: 'RO', panel: 'uart',
    read: () => (uartRxFull ? 1 : 0) },
  { addr: UART_RX, name: 'UART RX', access: 'RO', editable: true, panel: 'uart',
    // A read with nothing waiting returns 0 and consumes nothing, which
    // is what the Wrapper's read mux does too.
    read: (off, peek) => {
      if (off !== 0 || !uartRxFull) return 0;
      if (!peek) uartRxFull = false;
      return uartRxByte;
    },
    write: (off, val) => { uartPending.push(val & 0xFF); uartNextDeliveryInstr = uartNow(); } },
  { addr: UART_TX_READY, name: 'UART TX READY', access: 'RO', panel: 'uart', read: () => 1 },
  { addr: UART_TX, name: 'UART TX', access: 'WO', panel: 'uart', write: (off, val) => uartTransmit(val & 0xFF) },
  // Truncated to the register's 7 bits, not wrapped at 96: the panel,
  // not the Wrapper, decides where an out-of-range column lands.
  { addr: OLED_COL, name: 'OLED COL', access: 'WO', panel: 'oled', read: () => oledCol,
    write: (off, val) => { oledCol = val & 0x7F; oledAdvCol = oledAdvRow = false; oledTrigger(0x1); } },
  { addr: OLED_ROW, name: 'OLED ROW', access: 'WO', panel: 'oled', read: () => oledRow,
    write: (off, val) => { oledRow = val & 0x3F; oledAdvCol = oledAdvRow = false; oledTrigger(0x2); } },
  { addr: OLED_DATA, name: 'OLED DATA', access: 'WO', panel: 'oled', read: () => oledDataVal,
    write: (off, val, size) => oledDataWrite(off, val, size) },
  // Write-only on hardware; echoed back so the Memory view has something
  // to show. The Wrapper gates it on MemWrite_out[0], so only an access
  // covering the low byte lane lands, and bit 3 makes the write a present
  // with the other bits ignored, so software need not know the mode it
  // set to present a frame.
  { addr: OLED_CTRL, name: 'OLED CTRL', access: 'WO', panel: 'oled', read: () => oledCtrl,
    write: (off, val) => {
      if (off !== 0) return;
      if (val & 0x08) oledPresent();
      else oledCtrl = val & 0xFF;
    } },
  // Bit 0 is the swap-pending flag. Always clear here: with no scanout
  // modelled a present has already landed by the time software looks, so
  // a polling loop passes straight through. On hardware it would spin
  // until the next frame. The read is noted so that a program which never
  // makes one can be told what it is relying on.
  { addr: OLED_STATUS, name: 'OLED STATUS', access: 'RO', panel: 'oled',
    read: (off, peek) => { if (!peek) oledSwapUnpolled = false; return 0; } },
  { addr: ACCEL_DATA, name: 'ACCEL DATA', access: 'RO', panel: 'accel',
    read: () => ((accelTemp & 0xFF) << 24 | (accelX & 0xFF) << 16 | (accelY & 0xFF) << 8 | (accelZ & 0xFF)) },
  { addr: ACCEL_DREADY, name: 'ACCEL DREADY', access: 'RO', panel: 'accel', read: () => accelDready & 1 },
  { addr: PERIPH_LED, name: 'LED', access: 'WO', panel: 'ledDip', read: () => ledState,
    write: (off, val, size) => { if (size === 4 || off === 0) ledState = val & 0xFF; } },
  // DIP and PB move only through the Peripherals panel; a write, from a
  // program or a Memory-view edit, is ignored as the hardware ignores it.
  { addr: PERIPH_DIP, name: 'DIP', access: 'RO', panel: 'ledDip', read: () => dipSwitches },
  { addr: PERIPH_PB, name: 'PB', access: 'RO', panel: 'pb', read: () => pbState },
  { addr: PERIPH_SEVENSEG, name: '7SEG', access: 'WO', panel: 'sevseg', read: () => sevsegValue(),
    write: (off, val, size) => {
      let v = sevsegValue();
      if (size === 4) v = val >>> 0;
      else v = (v & ~(0xFF << (off * 8))) | ((val & 0xFF) << (off * 8));
      sevsegState = (v >>> 0).toString(16).padStart(8, '0').toUpperCase();
    } },
  { addr: CYCLECOUNT, name: 'CYCLECOUNT', access: 'RO', read: () => totalCycles },
].map(r => ({ ...r, addr: r.addr >>> 0, editable: r.editable ?? (r.access !== 'RO') }));
const MMIO_BY_ADDR = new Map(MMIO_REGISTERS.map(r => [r.addr, r]));

function mmioRegisterAt(addr) {
  return MMIO_BY_ADDR.get(addr >>> 0);
}

// Why a Memory-view edit at this address would not land, or null if it
// would. An address in the MMIO window with no register behind it reads 0
// and drops writes, so it is as read-only as a named RO register.
function mmioReadOnlyMessage(addr) {
  if (!isMMIOAddr(addr)) return null;
  const r = mmioRegisterAt((addr >>> 0) & ~3);
  if (r && r.editable) return null;
  return r ? r.name + ' is a read-only MMIO register'
           : 'No MMIO register is mapped here: it reads 0 and ignores writes';
}

// UART & Console State
//
// The receive path has two sides, as the board does. `uartPending` is the
// PC's serial buffer: whatever you typed into the console, waiting to be
// clocked onto the wire. `uartRxByte`/`uartRxFull` is the FPGA's single
// holding register - the top level module for synthesis keeps exactly one
// byte, and a character arriving while it is still full is discarded with the
// older one kept and no flag raised. Modelling that is the point: a queue here would make a
// too-slow polling loop look correct and then drop characters on hardware.
let uartPending = [];            // PC side: bytes still to be sent, in order
let uartRxByte = 0;              // FPGA side: the one byte being held
let uartRxFull = false;          // FPGA side: UART_RX_VALID
let uartRxDropped = 0;           // characters lost to overrun, not yet reported
let uartRxDroppedTotal = 0;      // ...and since the last reset, for the panel
let uartTxBuffer = '';           // Display terminal output string for UART_TX
let uartTxBytes = [];            // Raw byte values received via UART_TX (for hex re-render)

// Delivery pacing. One character on the wire is 10 bit-times; at 115200
// baud that is 86.4 us, and at the default CLK_DIV_BITS the CPU runs at
// 3.125 MHz, so a character is 270 single-cycle instructions. That is both
// the gap a terminal produces when it dumps a line and the budget a polling
// loop has to read one before the next arrives. Settable, because it moves
// with the clock divider.
const UART_CHAR_INSTR_DEFAULT = 270;

// The board's CPU clock. The top level module for synthesis divides 100 MHz
// by 2^CLK_DIV_BITS.
let clkDivBits = 5;
let runPace = 'max';             // 'max' | 'real'
let rtRatio = 1;                 // real time reached while pacing, 0..1
// At this clock or slower (CLK_DIV_BITS 20 and up), real time shows each
// instruction as it runs: the line, the registers and memory follow.
const RT_FOLLOW_HZ = 100;
function clkDivider() { return 2 ** clkDivBits; }
function cpuHz() { return 100e6 / clkDivider(); }
function fmtHz(f) {
  return f >= 1e6 ? +(f / 1e6).toPrecision(3) + ' MHz' : f >= 1e3 ? +(f / 1e3).toPrecision(3) + ' kHz'
    : +f.toPrecision(3) + ' Hz';
}
function fmtSimTime(cycles) {
  const t = cycles / cpuHz();
  return t < 1e-3 ? +(t * 1e6).toFixed(1) + ' µs' : t < 1 ? +(t * 1e3).toFixed(2) + ' ms' : +t.toFixed(2) + ' s';
}
// One character at 115200 baud is 8640 clocks of uart.vhd's 100 MHz.
function uartCharCycles() { return Math.max(1, Math.round(8640 / clkDivider())); }
function syncClockControls() {
  document.querySelectorAll('[data-clk="div"]').forEach(el => { el.value = String(clkDivBits); });
  document.querySelectorAll('[data-clk="hz"]').forEach(el => { el.textContent = fmtHz(cpuHz()); });
  document.querySelectorAll('[data-clk="pace"]').forEach(el => { el.value = runPace; });
}
function setClkDivBits(v) {
  const n = parseInt(v, 10);
  if (Number.isFinite(n)) clkDivBits = Math.max(0, Math.min(26, n));
  uartCharInstr = uartCharCycles();
  syncClockControls();
  setUartSendMode(uartSendMode);
  updateStats();
}
function setRunPace(v) {
  runPace = v === 'real' ? 'real' : 'max';
  syncClockControls();
  updateStats();
}
function clockInitControls() {
  document.querySelectorAll('[data-clk="div"]').forEach(el => { el.onchange = () => setClkDivBits(el.value); });
  document.querySelectorAll('[data-clk="pace"]').forEach(el => { el.onchange = () => setRunPace(el.value); });
  syncClockControls();
}
let uartCharInstr = UART_CHAR_INSTR_DEFAULT;
let uartSendMode = 'paste';      // 'paste' | 'typed' | 'forgiving'
let uartTypedInstr = 20000;      // gap for 'typed', a stand-in for human speed
let uartNextDeliveryInstr = 0;   // instructionCount at which the next byte lands
let uartSendTotal = 0;           // bytes in the current send, for progress

// Peripheral state
let ledState = 0;                // current LED display value
let sevsegState = '00000000';    // 7-segment display string
let dipSwitches = 0;             // simulated DIP switch value (16 bits)
let pbState = 0;                 // simulated push button state (3 bits: BTNL, BTNC, BTNR)
