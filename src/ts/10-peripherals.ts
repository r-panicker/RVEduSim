// @ts-nocheck
// The Peripherals panel: section folding, LEDs, switches, push buttons,
// 7-segment display, UART, OLED and accelerometer controls and status.

// Fold/unfold state, per section: `folded` is the current visual
// state; `userFolded` is set only when the *user* is the one who
// folded it, and suppresses auto-unfold-on-reference for that section
// until the next program load resets everything. Cycle Counter has no
// key here - it has nothing to fold (see the comment by `[data-periph]`
// in styles/11-peripherals.css).
const PERIPH_FOLD_KEYS = ['ledDip', 'pb', 'sevseg', 'uart', 'accel', 'oled'];
const PERIPH_DEFAULT_EXPANDED = new Set(['ledDip']);
let periphFoldState = {};

function resetPeriphFoldState() {
  periphFoldState = {};
  PERIPH_FOLD_KEYS.forEach(k => {
    periphFoldState[k] = { folded: !PERIPH_DEFAULT_EXPANDED.has(k), userFolded: false };
  });
  PERIPH_FOLD_KEYS.forEach(applyPeriphFoldOne);
}

function applyPeriphFoldOne(key) {
  const el = document.querySelector(`.periph-section[data-periph="${key}"]`);
  const st = periphFoldState[key];
  if (!el || !st) return;
  el.classList.toggle('periph-folded', st.folded);
}

function togglePeriphFold(key) {
  const st = periphFoldState[key];
  if (!st) return;
  st.folded = !st.folded;
  // Only folding it is a decision worth protecting from the next
  // auto-unfold; expanding it manually needs no protection since
  // nothing here ever auto-folds a section back up.
  st.userFolded = st.folded;
  applyPeriphFoldOne(key);
}

// Called from the real (non-peek) MMIO read/write path - a program
// reading or writing a peripheral's registers is "using" it, so bring
// it into view unless the user has deliberately folded it back since
// the program was last (re)loaded.
function notePeripheralUse(reg) {
  const st = reg.panel && periphFoldState[reg.panel];
  if (st && st.folded && !st.userFolded) {
    st.folded = false;
    applyPeriphFoldOne(reg.panel);
  }
}

// initPeripherals() re-runs every time the panel refreshes; the fold
// state itself must not reset on every one of those, only once at
// boot (before the very first assemble) and again on every actual
// program load (handled by resetPeriphFoldState() calls elsewhere).
let periphFoldBooted = false;

function initPeripherals() {
  if (!periphFoldBooted) {
    periphFoldBooted = true;
    resetPeriphFoldState();
  }
  const ledRow = document.getElementById('ledRow');
  if (ledRow) {
    let ledHtml = '';
    for (let i = 15; i >= 0; i--) {
      let typeClass, title, labelText;
      if (i >= 9) {
        typeClass = 'led-pc';
        title = `LED[${i}] — PC[${i - 7}]`;
        labelText = `P${i - 7}`;
      } else if (i === 8) {
        typeClass = 'led-clock';
        title = `LED[8] — Divided Clock`;
        labelText = `CLK`;
      } else {
        typeClass = 'led-user';
        title = `LED[${i}] — User Output (0xFFFF0060)`;
        labelText = `L${i}`;
      }

      ledHtml += `<div class="led-cell">
        <div class="led-sublabel">${labelText}</div>
        <div class="led ${typeClass}" id="led${i}" title="${title}"></div>
      </div>`;

      if (i === 9 || i === 8) {
        ledHtml += '<div class="led-group-divider"></div>';
      }
    }
    ledRow.innerHTML = ledHtml;
  }

  const dipCont = document.getElementById('dipContainer');
  if (dipCont) {
    let dipHtml = '';
    for (let i = 15; i >= 0; i--) {
      dipHtml += `<div class="dip-cell">
        <div class="dip-switch" id="dip${i}" onclick="toggleDip(${i})" title="DIP[${i}] (SW${i}) — Click to toggle ON/OFF">
          <div class="dip-rect-top"></div>
          <div class="dip-rect-bottom"></div>
        </div>
        <div class="dip-sublabel">SW${i}</div>
      </div>`;

      if (i === 9 || i === 8) {
        dipHtml += '<div class="led-group-divider" style="visibility:hidden"></div>';
      }
    }
    dipCont.innerHTML = dipHtml;
  }

  const pbCont = document.getElementById('pbContainer');
  if (pbCont) {
    const SQ = String.fromCharCode(39);
    // Click toggles (matches every other peripheral input here); the
    // arrow key held next to each button is momentary instead - down on
    // keydown, up on keyup - because that is what a real push button
    // does and a toggle cannot fake it without a second key press.
    pbCont.innerHTML =
      '<div class="btn-row">' +
      '<div class="pb-btn-wrap"><div class="pb-btn" id="pbBtnL" title="BTNL (bit 2) — click to toggle; hold J to press" onclick="pbToggle(' + SQ + '2' + SQ + ')">L</div></div>' +
      '<div class="pb-btn-wrap"><div class="pb-btn" id="pbBtnC" title="BTNC (bit 1) — click to toggle; hold K to press" onclick="pbToggle(' + SQ + '1' + SQ + ')">C</div></div>' +
      '<div class="pb-btn-wrap"><div class="pb-btn" id="pbBtnR" title="BTNR (bit 0) — click to toggle; hold L to press" onclick="pbToggle(' + SQ + '0' + SQ + ')">R</div></div>' +
      '</div>';
  }

  const sevseg = document.getElementById('sevsegContainer');
  if (sevseg) sevseg.innerHTML = '';

  updatePeripherals();
}

// LED[8] is the divided clock. Refreshes come in batches whose length says
// nothing about the clock, so while a run is in progress (in either
// engine) it is drawn from the wall clock: at the clock's own rate when
// Real time paces one slow enough to see, otherwise flickering, which is
// how a fast clock looks. A stopped clock holds its level; lit after Reset.
let clockLedTimer = null;
let clockLedLit = true;
function updateClockLed() {
  const led = document.getElementById('led8');
  const busy = running || !!(hdlLive || hdlChunked || hdlPlay);
  if (busy) {
    const hz = runPace === 'real' ? cpuHz() : Infinity;
    clockLedLit = hz <= 8 ? Math.floor(performance.now() / 1000 * hz * 2) % 2 === 0
                          : Math.floor(performance.now() / 125) % 2 === 0;
  }
  if (led) led.classList.toggle('on', clockLedLit);
  if (busy && !clockLedTimer) clockLedTimer = setTimeout(() => { clockLedTimer = null; updateClockLed(); }, 60);
}

function updatePeripherals() {
  // 1. PC[8:2] LEDs (LED[15:9]) -> Cyan/Blue
  for (let i = 15; i >= 9; i--) {
    const pcBit = i - 7;
    const led = document.getElementById('led' + i);
    if (led) led.classList.toggle('on', !!(pc & (1 << pcBit)));
  }

  // 2. Divided Clock LED (LED[8]) -> Amber/Orange
  updateClockLed();

  // 3. User Output LEDs (LED[7:0]) -> Green (driven by PERIPH_LED 0xFFFF0060)
  for (let i = 7; i >= 0; i--) {
    const led = document.getElementById('led' + i);
    if (led) led.classList.toggle('on', !!(ledState & (1 << i)));
  }

  // Update DIP switches (16 switches)
  for (let i = 15; i >= 0; i--) {
    const dip = document.getElementById('dip' + i);
    if (dip) dip.classList.toggle('on', !!(dipSwitches & (1 << i)));
  }

  // Update push buttons: bit 2 = BTNL, bit 1 = BTNC, bit 0 = BTNR
  const pbL = document.getElementById('pbBtnL');
  const pbC = document.getElementById('pbBtnC');
  const pbR = document.getElementById('pbBtnR');
  if (pbL) pbL.classList.toggle('pressed', !!(pbState & (1 << 2)));
  if (pbC) pbC.classList.toggle('pressed', !!(pbState & (1 << 1)));
  if (pbR) pbR.classList.toggle('pressed', !!(pbState & (1 << 0)));

  // Update 7-segment display
  sevsegUpdate();

  // Update UART Status Badges & RX Queue Info
  const rxValidEl = document.getElementById('badgeRxValid');
  const txReadyEl = document.getElementById('badgeTxReady');
  const countEl = document.getElementById('uartQueueCount');
  const previewEl = document.getElementById('uartQueuePreview');
  const termEl = document.getElementById('uartTerminal');

  const asChar = (b) => (b >= 32 && b <= 126)
    ? `'${String.fromCharCode(b)}'` : '0x' + b.toString(16).padStart(2, '0');

  if (rxValidEl) {
    rxValidEl.innerText = uartRxFull ? '1' : '0';
    rxValidEl.style.color = uartRxFull ? '#a6e3a1' : '#f9e2af';
  }
  if (txReadyEl) {
    txReadyEl.innerText = '1';
  }
  // The count is what the PC still has to send, not a receive FIFO - the
  // hardware holds one byte, and that is shown separately below.
  if (countEl) {
    countEl.innerText = uartPending.length +
      (uartPending.length === 1 ? ' byte to send' : ' bytes to send');
  }
  if (previewEl) {
    const held = uartRxFull ? `UART_RX holds ${asChar(uartRxByte)}` : 'UART_RX empty';
    const queued = uartPending.length
      ? ' · queued [' + uartPending.slice(0, 10).map(asChar).join(', ') +
        (uartPending.length > 10 ? '...' : '') + ']'
      : '';
    const lost = uartRxDroppedTotal ? ` · ${uartRxDroppedTotal} lost to overrun` : '';
    previewEl.innerText = held + queued + lost;
  }
  if (termEl) {
    renderUartTerminal();
  }

  const autoStatusEl = document.getElementById('uartAutoSendStatus');
  const btnEl = document.getElementById('uartSendBtn');
  if (autoStatusEl) {
    if (uartPending.length) {
      const sentCount = Math.max(0, uartSendTotal - uartPending.length);
      autoStatusEl.innerText = uartSendMode === 'forgiving'
        ? `Sending: ${sentCount}/${uartSendTotal} (waiting for the program)`
        : `Sending: ${sentCount}/${uartSendTotal} (${uartGapInstr()} cycles apart)`;
    } else {
      if (btnEl && btnEl.innerText === 'Cancel') {
        btnEl.innerText = 'Send';
        btnEl.style.background = '';
      }
    }
  }

  // Update OLED Status Badges & Mode Text
  const oledColEl = document.getElementById('oledColVal');
  const oledRowEl = document.getElementById('oledRowVal');
  const oledCtrlEl = document.getElementById('oledCtrlVal');
  const oledDescEl = document.getElementById('oledModeDesc');

  if (oledColEl) oledColEl.innerText = oledCol;
  if (oledRowEl) oledRowEl.innerText = oledRow;
  if (oledCtrlEl) oledCtrlEl.innerText = '0x' + (oledCtrl & 0xFF).toString(16).padStart(2, '0').toUpperCase();

  // Bit 0 of OLED_STATUS, shown the way DREADY and RX VALID are. Always 0
  // here: with no scanout to wait for, a present has landed by the time
  // anything can look. Which page the panel is on does change, so that is
  // spelled out below.
  const oledSwapEl = document.getElementById('badgeOledSwap');
  if (oledSwapEl) oledSwapEl.innerText = '0';
  const oledBufEl = document.getElementById('oledBufDesc');
  if (oledBufEl) {
    oledBufEl.innerText = (oledFrontPage === oledBackPage)
      ? 'Single buffered · writes appear at once'
      : `Double buffered · showing page ${oledFrontPage}, drawing into page ${oledBackPage}`;
  }

  if (oledDescEl) {
    const triggerMode = oledCtrl & 0x0F;
    const colorMode = (oledCtrl >> 4) & 0x0F;
    const triggerNames = {
      0x0: 'vary_pixel_data_mode',
      0x1: 'vary_col_mode (x)',
      0x2: 'vary_row_mode (y)',
      0x4: 'autoadvance_col (row major)',
      0x5: 'autoadvance_row (column major)'
    };
    const colorNames = {
      0x0: '8-bit (3R-3G-2B)',
      0x1: '16-bit (5R-6G-5B)',
      0x2: '24-bit (5R-3(0)-6G-2(0)-5B-3(0))'
    };
    const tName = triggerNames[triggerMode] || `trigger_0x${triggerMode.toString(16)}`;
    const cName = colorNames[colorMode] || `color_0x${colorMode.toString(16)}`;
    oledDescEl.innerText = `Mode: ${tName}  ·  Format: ${cName}`;
  }

  // Update Accelerometer UI & Cycle Count Badge
  const xEl = document.getElementById('accelXVal');
  const yEl = document.getElementById('accelYVal');
  const zEl = document.getElementById('accelZVal');
  const tEl = document.getElementById('accelTempVal');
  const dreadyEl = document.getElementById('badgeAccelDready');
  const cycleEl = document.getElementById('badgeCycleCount');

  const fmtHexByte = (v) => '0x' + (v & 0xFF).toString(16).padStart(2, '0').toUpperCase();
  const fmtG = (v) => (v / 64 >= 0 ? '+' : '') + (v / 64).toFixed(2) + 'g';

  if (xEl) xEl.innerText = `${accelX} (${fmtHexByte(accelX)}, ${fmtG(accelX)})`;
  if (yEl) yEl.innerText = `${accelY} (${fmtHexByte(accelY)}, ${fmtG(accelY)})`;
  if (zEl) zEl.innerText = `${accelZ} (${fmtHexByte(accelZ)}, ${fmtG(accelZ)})`;
  if (tEl) tEl.innerText = `${accelTemp}°C (${fmtHexByte(accelTemp)})`;
  if (dreadyEl) dreadyEl.innerText = accelDready ? '1' : '0';
  if (cycleEl) cycleEl.innerText = totalCycles;
  updateOledCanvas();
}

function updateAccelValues() {
  const xS = document.getElementById('accelXSlider');
  const yS = document.getElementById('accelYSlider');
  const zS = document.getElementById('accelZSlider');
  const tS = document.getElementById('accelTempSlider');

  if (xS) accelX = parseInt(xS.value, 10);
  if (yS) accelY = parseInt(yS.value, 10);
  if (zS) accelZ = parseInt(zS.value, 10);
  if (tS) accelTemp = parseInt(tS.value, 10);

  updatePeripherals();
}

function setAccelPreset(preset) {
  if (preset === 'flat') {
    accelX = 0; accelY = 0; accelZ = 64;
  } else if (preset === 'tiltX') {
    accelX = (accelX === -64) ? 64 : -64;
    accelY = 0;
    accelZ = 0;
  } else if (preset === 'tiltY') {
    accelY = (accelY === -64) ? 64 : -64;
    accelX = 0;
    accelZ = 0;
  } else if (preset === 'shake') {
    accelX = 127; accelY = -128; accelZ = 127;
  } else if (preset === 'zero') {
    accelX = 0; accelY = 0; accelZ = 0;
  }

  const xS = document.getElementById('accelXSlider');
  const yS = document.getElementById('accelYSlider');
  const zS = document.getElementById('accelZSlider');
  if (xS) xS.value = accelX;
  if (yS) yS.value = accelY;
  if (zS) zS.value = accelZ;

  updatePeripherals();
}

// Keyboard shortcut: hold X/Y/Z/T, tap , or . to nudge that axis by one
// step, clamped to the same range as its slider - see the keydown
// handler (heldAxisKeys, in 17-find-replace.ts) for where `axis`/`delta`
// come from.
function bumpAccelAxis(axis, delta) {
  if (axis === 'x') accelX = Math.max(-128, Math.min(127, accelX + delta));
  else if (axis === 'y') accelY = Math.max(-128, Math.min(127, accelY + delta));
  else if (axis === 'z') accelZ = Math.max(-128, Math.min(127, accelZ + delta));
  else if (axis === 't') accelTemp = Math.max(-40, Math.min(85, accelTemp + delta));
  else return;

  const xS = document.getElementById('accelXSlider');
  const yS = document.getElementById('accelYSlider');
  const zS = document.getElementById('accelZSlider');
  const tS = document.getElementById('accelTempSlider');
  if (xS) xS.value = accelX;
  if (yS) yS.value = accelY;
  if (zS) zS.value = accelZ;
  if (tS) tS.value = accelTemp;

  updatePeripherals();
}

let oledImageData = null;

function updateOledCanvas() {
  const canvas = document.getElementById('oledCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (!oledImageData || oledImageData.width !== 96 || oledImageData.height !== 64) {
    oledImageData = ctx.createImageData(96, 64);
  }
  oledImageData.data.set(oledPages[oledFrontPage].subarray(0, 96 * 64 * 4));
  ctx.putImageData(oledImageData, 0, 0);
}

function clearOledDisplay() {
  oledPages.forEach(oledBlankPage);
  updateOledCanvas();
  updatePeripherals();
}

function parseAsciiEscapes(str) {
  const bytes = [];
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

function sendUartInput() {
  const modeEl = document.getElementById('uartInputMode');
  const textEl = document.getElementById('uartInputText');
  const btnEl = document.getElementById('uartSendBtn');
  const statusEl = document.getElementById('uartAutoSendStatus');
  if (!modeEl || !textEl) return;

  if (uartPending.length) {
    uartPending = [];
    if (btnEl) {
      btnEl.innerText = 'Send';
      btnEl.style.background = '';
    }
    if (statusEl) statusEl.innerText = '(send cancelled)';
    updatePeripherals();
    return;
  }

  const raw = textEl.value;
  if (!raw.trim()) return;

  let bytes = [];
  if (modeEl.value === 'ascii') {
    bytes = parseAsciiEscapes(raw);
  } else if (modeEl.value === 'hex') {
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
  for (const b of bytes) uartPending.push(b);
  uartSendTotal = uartPending.length;
  uartNextDeliveryInstr = uartNow();
  uartTickDelivery();
  textEl.value = '';
  if (btnEl && uartPending.length) {
    btnEl.innerText = 'Cancel';
    btnEl.style.background = '#f38ba8';
  }
  if (statusEl) {
    statusEl.innerText = uartPending.length
      ? `Sending: ${uartSendTotal - uartPending.length}/${uartSendTotal}` : '';
  }

  updatePeripherals();
  updateMemoryView();
}

let uartTermShown = null;

function renderUartTerminal() {
  const termEl = document.getElementById('uartTerminal');
  if (!termEl) return;
  const modeEl = document.getElementById('uartInputMode');
  const isHex = modeEl && modeEl.value === 'hex';
  let text;
  if (uartTxBytes.length === 0) {
    text = '(Terminal output will appear here...)';
  } else if (isHex) {
    text = uartTxBytes.map(b => '0x' + b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  } else {
    text = uartTxBuffer;
  }
  // Only touch the DOM when the rendered text actually changes — avoids
  // needless reflow/scroll churn (which on mobile can disrupt an in-progress
  // text entry into the UART input while a program is transmitting).
  // Compared against what was last written rather than read back:
  // reading innerText forces a layout.
  if (uartTermShown !== text) {
    uartTermShown = text;
    termEl.innerText = text;
    termEl.scrollTop = termEl.scrollHeight;
  }
}

function clearUartTx() {
  uartTxBuffer = '';
  uartTxBytes = [];
  uartPending = [];
  uartRxFull = false;
  uartRxByte = 0;
  uartRxDropped = 0;
  uartRxDroppedTotal = 0;
  const btnEl = document.getElementById('uartSendBtn');
  if (btnEl) {
    btnEl.innerText = 'Send';
    btnEl.style.background = '';
  }
  const statusEl = document.getElementById('uartAutoSendStatus');
  if (statusEl) statusEl.innerText = '';
  renderUartTerminal();
  updatePeripherals();
  updateMemoryView();
}

function toggleDip(idx) {
  dipSwitches ^= (1 << idx);
  dipSwitches &= 0xFFFF;
  updatePeripherals();
}

// Push button: click to toggle press/release
function pbToggle(btn) {
  if (btn >= 0 && btn <= 2) {
    if (pbState & (1 << btn)) {
      pbState &= ~(1 << btn);
    } else {
      pbState |= (1 << btn);
    }
  }
  updatePeripherals();
}

// Push button: keyboard hold. Sets the bit to exactly `down`, so it
// behaves as a momentary button - pressed while held, not latched on.
function pbSetState(btn, down) {
  if (btn < 0 || btn > 2) return;
  const bit = 1 << btn;
  const next = down ? (pbState | bit) : (pbState & ~bit);
  if (next === pbState) return; // key-repeat while already held: no-op
  pbState = next;
  updatePeripherals();
}

// ============================================================
// SVG 7-Segment Display
// ============================================================

// Segment shapes for one 7-segment digit (22x40 SVG)
// a=top, b=top-right, c=bottom-right, d=bottom, e=bottom-left, f=top-left, g=middle
const SEGMENT_PATHS = [
  'M3,3 L19,3 L18,5 L4,5 Z',
  'M19,5 L21,4 L21,17 L19,16 Z',
  'M19,23 L21,24 L21,35 L19,36 Z',
  'M4,35 L18,35 L18,37 L3,37 Z',
  'M1,35 L3,36 L3,24 L1,23 Z',
  'M1,16 L3,17 L3,4 L1,3 Z',
  'M4,18 L18,18 L18,20 L4,20 Z'
];

// Segment bits for each hex digit [a,b,c,d,e,f,g]
const HEX_SEGMENTS = {
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

function createDigitSVG(digit) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'sevseg-digit');
  svg.setAttribute('viewBox', '0 0 22 40');

  const bits = HEX_SEGMENTS[digit] || [0, 0, 0, 0, 0, 0, 0];

  for (let i = 0; i < 7; i++) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', SEGMENT_PATHS[i]);
    path.setAttribute('class', 'sevseg-segment' + (bits[i] ? ' lit' : ''));
    path.setAttribute('data-seg', i);
    svg.appendChild(path);
  }

  return svg;
}

function sevsegUpdate() {
  const container = document.getElementById('sevsegContainer');
  if (!container) return;

  const val = sevsegState.padStart(8, '0').toLowerCase();
  container.innerHTML = '';

  for (let i = 0; i < 8; i++) {
    const ch = val[i];
    const svg = createDigitSVG(ch);
    container.appendChild(svg);
  }
}
