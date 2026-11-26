// The simulator's mutable state, grouped by what it belongs to. Each group
// is one object, so every part of the program reads and writes the same
// state through it (cpu.pc, uart.rxFull) rather than through loose
// variables.

import { DEFAULT_BASE, DEFAULT_DATA_BASE } from './memory-map';

export interface MemWrite { addr: number; size: number }

// The processor as the functional model runs it. The FP registers are in
// fpregs.ts, views over one buffer that is never replaced.
export const cpu = {
  regs: new Int32Array(32),
  pc: DEFAULT_BASE,
  totalCycles: 0,
  instructionCount: 0,
  // What the last step changed, for the panels' highlights.
  lastChangedReg: -1,
  lastChangedMem: [] as MemWrite[],
  lastExecutedRd: -1,
  // The address lr.w reserved, cleared by the sc.w that uses it. With one
  // hart nothing else can break a reservation, so sc.w fails only when no
  // lr.w reserved that address since the last sc.w.
  reservation: null as number | null,
};

// Sparse memory: 64 KB pages, created on first write (see memory-map.ts).
export const memory = {
  pages: new Map<number, Uint8Array>(),
  // The next address sbrk (ecall 9) hands out; set past .data on reset.
  heapPointer: 0x24000,
  // Set while a write comes from an edit in the Memory panel, which is not
  // the program and so not racing the OLED's present.
  panelEdit: false,
};

// Where each segment is. Settable in the Linker settings; the stack starts
// at the top of the data segment.
export const layout = {
  baseAddress: DEFAULT_BASE,       // .text
  codeSize: 0x200,
  dataBase: DEFAULT_DATA_BASE,     // .data
  dataSize: 0x200,
  stackBase: DEFAULT_DATA_BASE + 0x200,
  mmioBase: 0xFFFF0000,
};

// One assembled line: its address and encoding, and the source line it came
// from. Data directives and pseudo-instructions add their own fields.
export interface MachineLine {
  address: number;
  bytes?: number[] | null;     // null for a line that failed to assemble
  line: number;                // 1-based source line
  text?: string;               // the source as written
  asmLine?: string;
  native?: string;             // the Native column: the instruction as encoded
  immFrom?: number;            // where the immediate sits in `native`
  immTo?: number;
  imm?: unknown;               // the immediate's other readings (asm/assembler.ts ImmInfo)
  isPseudo?: boolean;
  error?: string;
  [key: string]: unknown;
}

// The program the editor last assembled.
export const program = {
  machineCode: [] as MachineLine[],
  labels: {} as Record<string, number>,
  symbolTable: {} as Record<string, number>,  // .equ constants
  assembled: false,
  // Source line of each instruction address, for the highlight.
  pcToLine: new Map<number, number>(),
  // Instruction words by which the last assembly overran the code segment,
  // so the final status can say so rather than being overwritten by it.
  codeOverflowWords: 0,
};

// Cycles each kind of instruction takes, set in the Simulation settings.
export interface CycleConfig {
  basic: number; muldiv: number; load: number; store: number;
  branch: number; jump: number; fp: number; system: number;
}

export const run = {
  running: false,
  breakpoints: new Set<number>(),   // 1-based source lines
  currentLine: -1,                  // the source line being executed, for the highlight
  cycleConfig: { basic: 1, muldiv: 2, load: 2, store: 2, branch: 1, jump: 1, fp: 4, system: 1 } as CycleConfig,
  // One Step runs every instruction of a C statement or pseudo-instruction.
  statementStepping: false,
  // Instructions executed per batch before the page gets control back.
  maxInstructions: 100000000,
  timerId: null as ReturnType<typeof setTimeout> | null,   // the next batch of a run
  finished: false,                  // the program has exited or run off its end
};

// One OLED write a step made, for Back: the whole page a present copied
// over, or the four bytes of one pixel.
export interface OledPixelLogEntry {
  page: number;
  full?: Uint8Array;
  idx?: number;
  old?: Uint8Array;
}

// Back-stepping. Each entry undoes one instruction: the processor state
// before it and the memory and pixel writes it made.
export const stepHistory = {
  entries: [] as any[],
  cap: 5000,
  // Memory writes of the step being executed, journalled while enabled.
  writeLog: [] as any[],
  journalEnabled: false,
  // Peripheral writes never reach the byte journal. The scalars are
  // snapshotted whole once per step; the OLED pages are too big for that,
  // so the bytes a step touches are journalled here instead.
  pixelLog: [] as OledPixelLogEntry[],
};

// The board's LEDs, 7-segment display, switches and buttons.
export const board = {
  leds: 0,                 // LED[7:0]
  sevseg: '00000000',      // eight hex digits
  dip: 0,                  // 16 switches
  buttons: 0,              // BTNL, BTNC, BTNR in bits 2..0
};

// The accelerometer's reading, each an 8-bit signed value.
export const accel = {
  x: 0,
  y: 0,
  z: 64,       // +1 g
  temp: 25,    // °C
  dready: 1,
};

// One character at 115200 baud, in single-cycle instructions at the default
// clock (3.125 MHz): both the gap a terminal leaves when it sends a line and
// the time a polling loop has to read a character before the next arrives.
export const UART_CHAR_INSTR_DEFAULT = 270;

// The receive path has two sides, as the board does. `pending` is the PC's
// serial buffer: what was typed into the console, waiting to be clocked onto
// the wire. `rxByte`/`rxFull` is the FPGA's single holding register: the
// top level module for synthesis keeps exactly one byte, and a character
// arriving while it is full is discarded with the older one kept and no flag
// raised. Modelling that is the point: a queue would make a too-slow polling
// loop look correct and then drop characters on hardware.
export const uart = {
  pending: [] as number[],
  rxByte: 0,
  rxFull: false,                   // UART_RX_VALID
  rxDropped: 0,                    // lost to overrun, not yet reported
  rxDroppedTotal: 0,               // since the last reset, for the panel
  txText: '',                      // what the program has sent, as text
  txBytes: [] as number[],         // and as bytes, for the hex view
  charInstr: UART_CHAR_INSTR_DEFAULT,
  sendMode: 'paste' as 'paste' | 'typed' | 'forgiving',
  typedInstr: 20000,               // the gap for 'typed', a stand-in for typing speed
  nextDeliveryInstr: 0,            // instructionCount at which the next byte lands
  sendTotal: 0,                    // bytes in the current send, for progress
};

const OLED_PAGE_BYTES = 96 * 64 * 4;

// The OLED controller's registers and its two frame pages. Both pages start
// as page 0, so a program that never presents sees a single buffer; the
// first present splits them.
export const oled = {
  col: 0,
  row: 0,
  ctrl: 0,
  data: 0,
  // The Wrapper's autoadvance_col / autoadvance_row flags: set by the first
  // write in that mode, cleared by a write that triggers in any other, and
  // what makes the first auto-advanced pixel land where it was addressed.
  advCol: false,
  advRow: false,
  pages: [new Uint8Array(OLED_PAGE_BYTES), new Uint8Array(OLED_PAGE_BYTES)],
  front: 0,          // the page the panel scans out
  back: 0,           // the page writes land in
  buffer: null as unknown as Uint8Array,   // pages[back], kept in step with it
  swapUnpolled: false,   // a present was asked for, OLED_STATUS unread since
  raceWarned: false,     // worth saying once a run, not once a pixel
  // What the panel shows.
  get frontBuffer(): Uint8Array { return this.pages[this.front]; },
};
oled.buffer = oled.pages[0];

// The CPU clock, 100 MHz divided by 2^divBits, and how a run is paced.
export const clock = {
  divBits: 5,
  pace: 'max' as 'max' | 'real',
  rtRatio: 1,              // the fraction of real time reached while pacing
};

// View state shared by several panels.
export const ui = {
  memSegment: 'code',
  settingsTab: 'compiler',
  disasmView: 'word' as 'word' | 'bytes',   // a 32-bit word per 4 bytes, or separate bytes
  regDecSigned: true,                        // the Registers panel's Dec column
  engine: 'js' as 'js' | 'hdl',              // which engine runs the program
  clockLedLit: true,                         // LED[8], which holds its level while the clock is stopped
};
