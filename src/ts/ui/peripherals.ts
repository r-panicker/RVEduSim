// The Peripherals panel: section folding, LEDs, switches, push buttons,
// 7-segment display, UART, OLED and accelerometer controls and status.

import { HDL_STIM_ACCEL, HDL_STIM_DIP, HDL_STIM_PB, hdlAccelWord } from '../hdl/compile';
import { hdlOnInputChanged } from '../hdl/inputs';
import { hdlRefreshMmioView, hdlSendUartInput } from '../hdl/shared-ui';
import { hdlActivity, hdlRec } from '../hdl/state';
import { cpuHz } from '../machine/clock';
import { oledBlankPage } from '../machine/oled';
import { accel, board, clock, cpu, oled, run, uart, ui } from '../machine/state';
import { uartGapInstr, uartNow, uartTickDelivery } from '../machine/uart';
import { updateMemoryView } from './memory-register-views';
import { byId } from './dom';
import { MmioRegister } from '../machine/mmio';
import { redraw } from './views.svelte';

// Fold/unfold state, per section: `folded` is the current visual
// state; `userFolded` is set only when the *user* is the one who
// folded it, and suppresses auto-unfold-on-reference for that section
// until the next program load resets everything. Cycle Counter has no
// key here - it has nothing to fold (see the comment by `[data-periph]`
// in styles/11-peripherals.css).
export const PERIPH_FOLD_KEYS = ['ledDip', 'pb', 'sevseg', 'uart', 'accel', 'oled'];
export const PERIPH_DEFAULT_EXPANDED = new Set(['ledDip']);
// folded: shown folded; userFolded: the user folded it, so use does not unfold it.
export let periphFoldState: Record<string, { folded: boolean; userFolded: boolean }> = {};

export function resetPeriphFoldState() {
  periphFoldState = {};
  PERIPH_FOLD_KEYS.forEach(k => {
    periphFoldState[k] = { folded: !PERIPH_DEFAULT_EXPANDED.has(k), userFolded: false };
  });
  refreshPeriphPanel();
}

export function togglePeriphFold(key: string) {
  const st = periphFoldState[key];
  if (!st) return;
  st.folded = !st.folded;
  // Only folding it is a decision worth protecting from the next
  // auto-unfold; expanding it manually needs no protection since
  // nothing here ever auto-folds a section back up.
  st.userFolded = st.folded;
  refreshPeriphPanel();
}

// Called from the real (non-peek) MMIO read/write path - a program
// reading or writing a peripheral's registers is "using" it, so bring
// it into view unless the user has deliberately folded it back since
// the program was last (re)loaded.
export function notePeripheralUse(reg: MmioRegister) {
  const panel = reg.panel;
  const st = panel && periphFoldState[panel];
  if (panel && st && st.folded && !st.userFolded) {
    st.folded = false;
    refreshPeriphPanel();
  }
}

// initPeripherals() re-runs every time the panel refreshes; the fold
// state itself must not reset on every one of those, only once at
// boot (before the very first assemble) and again on every actual
// program load (handled by resetPeriphFoldState() calls elsewhere).
export let periphFoldBooted = false;

export function initPeripherals() {
  if (!periphFoldBooted) {
    periphFoldBooted = true;
    resetPeriphFoldState();
  }
  updatePeripherals();
}

// The LEDs and switches, left to right (bit 15 first). The PC, clock and
// user groups of LEDs are set apart after bits 9 and 8.
export const LED_CELLS = Array.from({ length: 16 }, (_, k) => {
  const i = 15 - k;
  const cell = i >= 9 ? { cls: 'led-pc', title: `LED[${i}] — PC[${i - 7}]`, label: `P${i - 7}` }
    : i === 8 ? { cls: 'led-clock', title: 'LED[8] — Divided Clock', label: 'CLK' }
    : { cls: 'led-user', title: `LED[${i}] — User Output (0xFFFF0060)`, label: `L${i}` };
  return { i, ...cell, gapAfter: i === 9 || i === 8 };
});

// Click toggles (matches every other peripheral input here); the arrow key
// held next to each button is momentary instead - down on keydown, up on
// keyup - because that is what a real push button does and a toggle cannot
// fake it without a second key press.
export const PB_BUTTONS = [
  { bit: 2, id: 'pbBtnL', name: 'L', title: 'BTNL (bit 2) — click to toggle; hold J to press' },
  { bit: 1, id: 'pbBtnC', name: 'C', title: 'BTNC (bit 1) — click to toggle; hold K to press' },
  { bit: 0, id: 'pbBtnR', name: 'R', title: 'BTNR (bit 0) — click to toggle; hold L to press' },
];

// LED[8] is the divided clock. Refreshes come in batches whose length says
// nothing about the clock, so while a run is in progress (in either
// engine) it is drawn from the wall clock: at the clock's own rate when
// Real time paces one slow enough to see, otherwise flickering, which is
// how a fast clock looks. A stopped clock holds its level; lit after Reset.
export let clockLedTimer: number | null = null;
function updateClockLed() {
  const busy = run.running || !!(hdlActivity.live || hdlActivity.chunked || hdlActivity.play);
  if (busy) {
    const hz = clock.pace === 'real' ? cpuHz() : Infinity;
    ui.clockLedLit = hz <= 8 ? Math.floor(performance.now() / 1000 * hz * 2) % 2 === 0
                          : Math.floor(performance.now() / 125) % 2 === 0;
  }
  if (busy && !clockLedTimer) clockLedTimer = setTimeout(() => {
    clockLedTimer = null;
    updateClockLed();
    refreshPeriphPanel();
  }, 60);
}

// The console's status line when no send is in progress: how the last one
// ended. While one is, the line is the progress, worked out from the queue.
export let uartStatusNote = '';
export function setUartStatusNote(text: string) {
  uartStatusNote = text;
}

// Whether the terminal and the input box are in hex rather than ASCII.
export let uartHexMode = false;
export function setUartInputMode(mode: string) {
  uartHexMode = mode === 'hex';
  refreshPeriphPanel();
}

// What the panel shows, read from the machine state each time it redraws.
export function periphDisplay() {
  const bit = (v: number, i: number) => !!(v & (1 << i));
  const asChar = (b: number) => (b >= 32 && b <= 126)
    ? `'${String.fromCharCode(b)}'` : '0x' + b.toString(16).padStart(2, '0');
  const fmtHexByte = (v: number) => '0x' + (v & 0xFF).toString(16).padStart(2, '0').toUpperCase();
  const fmtG = (v: number) => (v / 64 >= 0 ? '+' : '') + (v / 64).toFixed(2) + 'g';
  const axis = (v: number) => `${v} (${fmtHexByte(v)}, ${fmtG(v)})`;

  // LED[15:9] = PC[8:2], LED[8] = the divided clock, LED[7:0] = PERIPH_LED.
  const leds = (i: number) => i >= 9 ? bit(cpu.pc, i - 7) : i === 8 ? ui.clockLedLit : bit(board.leds, i);

  // The count is what the PC still has to send, not a receive FIFO - the
  // hardware holds one byte, and that is shown separately.
  const n = uart.pending.length;
  const held = uart.rxFull ? `UART_RX holds ${asChar(uart.rxByte)}` : 'UART_RX empty';
  const queued = n ? ' · queued [' + uart.pending.slice(0, 10).map(asChar).join(', ') + (n > 10 ? '...' : '') + ']' : '';
  const lost = uart.rxDroppedTotal ? ` · ${uart.rxDroppedTotal} lost to overrun` : '';
  const sent = Math.max(0, uart.sendTotal - n);
  const status = !n ? uartStatusNote : uart.sendMode === 'forgiving'
    ? `Sending: ${sent}/${uart.sendTotal} (waiting for the program)`
    : `Sending: ${sent}/${uart.sendTotal} (${uartGapInstr()} cycles apart)`;

  const triggerMode = oled.ctrl & 0x0F;
  const colorMode = (oled.ctrl >> 4) & 0x0F;
  const triggerNames: Record<number, string> = {
    0x0: 'vary_pixel_data_mode',
    0x1: 'vary_col_mode (x)',
    0x2: 'vary_row_mode (y)',
    0x4: 'autoadvance_col (row major)',
    0x5: 'autoadvance_row (column major)'
  };
  const colorNames: Record<number, string> = {
    0x0: '8-bit (3R-3G-2B)',
    0x1: '16-bit (5R-6G-5B)',
    0x2: '24-bit (5R-3(0)-6G-2(0)-5B-3(0))'
  };
  const tName = triggerNames[triggerMode] || `trigger_0x${triggerMode.toString(16)}`;
  const cName = colorNames[colorMode] || `color_0x${colorMode.toString(16)}`;

  return {
    folded: (key: string) => !!(periphFoldState[key] && periphFoldState[key].folded),
    led: leds,
    dip: (i: number) => bit(board.dip, i),
    pressed: (b: number) => bit(board.buttons, b),
    sevseg: board.sevseg.padStart(8, '0').toLowerCase().split('').map(ch => HEX_SEGMENTS[ch] || [0, 0, 0, 0, 0, 0, 0]),
    cycles: String(cpu.totalCycles),

    rxValid: uart.rxFull,
    terminal: uartTermShown,
    hexMode: uartHexMode,
    sending: n > 0,
    canClear: uart.txText.length > 0,
    queueCount: n + (n === 1 ? ' byte to send' : ' bytes to send'),
    queuePreview: held + queued + lost,
    status,
    sendMode: uart.sendMode,
    // The box sets whichever gap the mode uses, so it follows the mode
    // rather than sitting there meaning nothing.
    charInstr: uart.sendMode === 'typed' ? uart.typedInstr : uart.charInstr,
    charInstrSet: uart.sendMode === 'typed',

    accel: { ...accel },
    accelX: axis(accel.x), accelY: axis(accel.y), accelZ: axis(accel.z),
    accelTemp: `${accel.temp}°C (${fmtHexByte(accel.temp)})`,

    oledCol: String(oled.col),
    oledRow: String(oled.row),
    oledCtrl: fmtHexByte(oled.ctrl),
    // Bit 0 of OLED_STATUS is always 0 here: with no scanout to wait for, a
    // present has landed by the time anything can look. Which page the
    // panel is on does change, so that is spelled out.
    oledBuf: oled.front === oled.back ? 'Single buffered · writes appear at once'
      : `Double buffered · showing page ${oled.front}, drawing into page ${oled.back}`,
    oledMode: `Mode: ${tName}  ·  Format: ${cName}`,
  };
}

// Redraws the panel. The terminal's text is worked out here, once, and the
// terminal kept scrolled to its end when that text changes.
export function refreshPeriphPanel() {
  let text: string;
  if (uart.txBytes.length === 0) text = '(Terminal output will appear here...)';
  else if (uartHexMode) text = uart.txBytes.map(b => '0x' + b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  // A carriage return ends a line, as on a terminal; the terminal's
  // white-space: pre-wrap would show it as a space.
  else text = uart.txText.replace(/\r\n?/g, '\n');
  const changed = text !== uartTermShown;
  uartTermShown = text;
  redraw('peripherals');
  if (changed) {
    const termEl = document.getElementById('uartTerminal');
    if (termEl) termEl.scrollTop = termEl.scrollHeight;
  }
}

export function updatePeripherals() {
  updateClockLed();
  refreshPeriphPanel();
  updateOledCanvas();
  hdlRefreshMmioView();
}

export function updateAccelValues() {
  const xS = byId<HTMLInputElement>('accelXSlider');
  const yS = byId<HTMLInputElement>('accelYSlider');
  const zS = byId<HTMLInputElement>('accelZSlider');
  const tS = byId<HTMLInputElement>('accelTempSlider');

  if (xS) accel.x = parseInt(xS.value, 10);
  if (yS) accel.y = parseInt(yS.value, 10);
  if (zS) accel.z = parseInt(zS.value, 10);
  if (tS) accel.temp = parseInt(tS.value, 10);

  updatePeripherals();
  hdlOnInputChanged(HDL_STIM_ACCEL, hdlAccelWord());
}

export function setAccelPreset(preset: string) {
  if (preset === 'flat') {
    accel.x = 0; accel.y = 0; accel.z = 64;
  } else if (preset === 'tiltX') {
    accel.x = (accel.x === -64) ? 64 : -64;
    accel.y = 0;
    accel.z = 0;
  } else if (preset === 'tiltY') {
    accel.y = (accel.y === -64) ? 64 : -64;
    accel.x = 0;
    accel.z = 0;
  } else if (preset === 'shake') {
    accel.x = 127; accel.y = -128; accel.z = 127;
  } else if (preset === 'zero') {
    accel.x = 0; accel.y = 0; accel.z = 0;
  }

  updatePeripherals();
  hdlOnInputChanged(HDL_STIM_ACCEL, hdlAccelWord());
}

// Keyboard shortcut: hold X/Y/Z/T, tap , or . to nudge that axis by one
// step, clamped to the same range as its slider - see the keydown
// handler (heldAxisKeys, in ui/find-replace.ts) for where `axis`/`delta`
// come from.
export function bumpAccelAxis(axis: unknown, delta: number) {
  if (axis === 'x') accel.x = Math.max(-128, Math.min(127, accel.x + delta));
  else if (axis === 'y') accel.y = Math.max(-128, Math.min(127, accel.y + delta));
  else if (axis === 'z') accel.z = Math.max(-128, Math.min(127, accel.z + delta));
  else if (axis === 't') accel.temp = Math.max(-40, Math.min(85, accel.temp + delta));
  else return;
  updatePeripherals();
}

export let oledImageData: ImageData | null = null;

export function updateOledCanvas() {
  const canvas = byId<HTMLCanvasElement>('oledCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (!oledImageData || oledImageData.width !== 96 || oledImageData.height !== 64) {
    oledImageData = ctx.createImageData(96, 64);
  }
  oledImageData.data.set(oled.pages[oled.front].subarray(0, 96 * 64 * 4));
  ctx.putImageData(oledImageData, 0, 0);
}

export function clearOledDisplay() {
  oled.pages.forEach(oledBlankPage);
  updateOledCanvas();
  updatePeripherals();
}

export function parseAsciiEscapes(str: string) {
  const bytes: number[] = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === '\\' && i + 1 < str.length) {
      const next = str[i + 1];
      switch (next) {
        case 'n': bytes.push(10); i += 2; break;   // LF Line Feed (0x0A)
        case 'r': bytes.push(13); i += 2; break;   // CR Carriage Return (0x0D)
        case 't': bytes.push(9); i += 2; break;   // TAB Horizontal Tab (0x09)
        case '0': {
          if (i + 2 < str.length && str[i + 2] === 'x') {
            const hexMatch = str.slice(i + 3, i + 5);
            if (/^[0-9a-fA-F]{2}$/.test(hexMatch)) {
              bytes.push(parseInt(hexMatch, 16));
              i += 5;
              break;
            }
          }
          const octalMatch = str.slice(i + 1).match(/^[0-7]{1,3}/);
          if (octalMatch) {
            bytes.push(parseInt(octalMatch[0], 8) & 0xFF);
            i += 1 + octalMatch[0].length;
            break;
          }
          bytes.push(0); i += 2; break;            // NUL Null byte (0x00)
        }
        case 'b': bytes.push(8); i += 2; break;   // BS Backspace (0x08)
        case 'f': bytes.push(12); i += 2; break;   // FF Form Feed (0x0C)
        case 'v': bytes.push(11); i += 2; break;   // VT Vertical Tab (0x0B)
        case 'e': bytes.push(27); i += 2; break;   // ESC Escape (0x1B)
        case 'x': case 'X': {
          const hexMatch = str.slice(i + 2, i + 4);
          if (/^[0-9a-fA-F]{2}$/.test(hexMatch)) {
            bytes.push(parseInt(hexMatch, 16));
            i += 4;
          } else {
            bytes.push(str.charCodeAt(i) & 0xFF);
            i++;
          }
          break;
        }
        case '\\': bytes.push(92); i += 2; break;  // Backslash
        case '\'': bytes.push(39); i += 2; break;  // Single quote
        case '"': bytes.push(34); i += 2; break;  // Double quote
        default:
          bytes.push(str.charCodeAt(i + 1) & 0xFF);
          i += 2;
          break;
      }
    } else {
      bytes.push(str.charCodeAt(i) & 0xFF);
      i++;
    }
  }
  return bytes;
}

export function queueUartInput() {
  const textEl = byId<HTMLInputElement>('uartInputText');
  if (!textEl) return;

  if (uart.pending.length) {
    uart.pending = [];
    setUartStatusNote('(send cancelled)');
    updatePeripherals();
    return;
  }

  const raw = textEl.value;
  if (!raw.trim()) return;

  let bytes: number[] = [];
  if (!uartHexMode) {
    bytes = parseAsciiEscapes(raw);
  } else {
    // Hex mode: each comma-separated token is interpreted as a hex byte
    // (optionally prefixed with 0x/0X). e.g. "0x48, 0x69, 0x0D" or "48 69 0d".
    const tokens = raw.split(',');
    for (let token of tokens) {
      token = token.trim();
      if (!token) continue;
      let hexStr = token.replace(/^0[xX]/, '');
      // Also allow a single trailing 'h' hex suffix (e.g. "41h").
      hexStr = hexStr.replace(/[hH]$/, '');
      if (!/^[0-9a-fA-F]{1,2}$/.test(hexStr)) continue;
      const val = parseInt(hexStr, 16);
      if (val >= 0 && val <= 255) {
        bytes.push(val);
      }
    }
  }

  if (bytes.length === 0) return;

  // The bytes join the PC's buffer; delivery clocks them onto the wire one
  // character time apart, the way a serial port does.
  for (const b of bytes) uart.pending.push(b);
  uart.sendTotal = uart.pending.length;
  uart.nextDeliveryInstr = uartNow();
  uartTickDelivery();
  textEl.value = '';
  setUartStatusNote('');

  updatePeripherals();
  updateMemoryView();
}

// The console's Send: HDL mode puts the bytes on the recording's timeline.
export function sendUartInput() {
  if (ui.engine === 'hdl' && hdlRec.trace) hdlSendUartInput();
  else queueUartInput();
}

// The terminal's text as last drawn.
export let uartTermShown = '';

export function renderUartTerminal() {
  refreshPeriphPanel();
}

export function clearUartTx() {
  uart.txText = '';
  uart.txBytes = [];
  uart.pending = [];
  uart.rxFull = false;
  uart.rxByte = 0;
  uart.rxDropped = 0;
  uart.rxDroppedTotal = 0;
  setUartStatusNote('');
  updatePeripherals();
  updateMemoryView();
}

export function toggleDip(idx: number) {
  board.dip ^= (1 << idx);
  board.dip &= 0xFFFF;
  updatePeripherals();
  hdlOnInputChanged(HDL_STIM_DIP, board.dip & 0xFFFF);
}

// Push button: click to toggle press/release
export function pbToggle(btn: number) {
  if (btn >= 0 && btn <= 2) {
    if (board.buttons & (1 << btn)) {
      board.buttons &= ~(1 << btn);
    } else {
      board.buttons |= (1 << btn);
    }
  }
  updatePeripherals();
  hdlOnInputChanged(HDL_STIM_PB, board.buttons & 0x7);
}

// Push button: keyboard hold. Sets the bit to exactly `down`, so it
// behaves as a momentary button - pressed while held, not latched on.
export function pbSetState(btn: number, down: boolean) {
  if (btn < 0 || btn > 2) return;
  const bit = 1 << btn;
  const next = down ? (board.buttons | bit) : (board.buttons & ~bit);
  if (next === board.buttons) return; // key-repeat while already held: no-op
  board.buttons = next;
  updatePeripherals();
}

// The 7-segment display: the segment shapes for one digit (22x40 SVG),
// a=top, b=top-right, c=bottom-right, d=bottom, e=bottom-left, f=top-left, g=middle
export const SEGMENT_PATHS = [
  'M3,3 L19,3 L18,5 L4,5 Z',
  'M19,5 L21,4 L21,17 L19,16 Z',
  'M19,23 L21,24 L21,35 L19,36 Z',
  'M4,35 L18,35 L18,37 L3,37 Z',
  'M1,35 L3,36 L3,24 L1,23 Z',
  'M1,16 L3,17 L3,4 L1,3 Z',
  'M4,18 L18,18 L18,20 L4,20 Z'
];

// Segment bits for each hex digit [a,b,c,d,e,f,g]
export const HEX_SEGMENTS: Record<string, number[]> = {
  0: [1, 1, 1, 1, 1, 1, 0],
  1: [0, 1, 1, 0, 0, 0, 0],
  2: [1, 1, 0, 1, 1, 0, 1],
  3: [1, 1, 1, 1, 0, 0, 1],
  4: [0, 1, 1, 0, 0, 1, 1],
  5: [1, 0, 1, 1, 0, 1, 1],
  6: [1, 0, 1, 1, 1, 1, 1],
  7: [1, 1, 1, 0, 0, 0, 0],
  8: [1, 1, 1, 1, 1, 1, 1],
  9: [1, 1, 1, 1, 0, 1, 1],
  'a': [1, 1, 1, 0, 1, 1, 1],
  'b': [0, 0, 1, 1, 1, 1, 1],
  'c': [1, 0, 0, 1, 1, 1, 0],
  'd': [0, 1, 1, 1, 1, 0, 1],
  'e': [1, 0, 0, 1, 1, 1, 1],
  'f': [1, 0, 0, 0, 1, 1, 1]
};
