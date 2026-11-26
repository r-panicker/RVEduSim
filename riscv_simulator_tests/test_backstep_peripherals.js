// test_backstep_peripherals.js
// Back-step unwinds registers and memory from a journal, but a peripheral
// write never goes through writeMem, and the OLED pages are too big to copy
// per step. These are the checks that a step into a peripheral comes back out
// again: the scalars from the snapshot, the pages from their own journal, and
// both sides of the UART receive path, which back-step would otherwise desync
// from instructionCount.

const fs = require('fs');
const path = require('path');
const { installExamplesFetch } = require('./examples_fetch');
const { JSDOM } = require('jsdom');

console.log('===========================================================');
console.log('🚀 TESTING PERIPHERAL ROLLBACK ON BACK STEP');
console.log('===========================================================');

const htmlContent = require('./page').html();
const CM6_BUNDLE_SOURCE = fs.readFileSync(path.resolve(__dirname, 'cm6_bundle.min.js'), 'utf8');

const dom = new JSDOM(htmlContent, {
  runScripts: 'dangerously',
  resources: 'usable',
  url: 'http://localhost:8080/index.html',
  beforeParse(window) {
    window.__CM6_DISABLE_CDN = true;
    window.addEventListener('DOMContentLoaded', () => {
      try { window.eval(CM6_BUNDLE_SOURCE); } catch (e) { console.error('CM6 inject failed:', e.message); }
    });
    window.requestAnimationFrame = (cb) => setTimeout(cb, 16);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
    window.matchMedia = () => ({ matches: false, addListener: () => {}, removeListener: () => {} });
    window.Range.prototype.getClientRects = () => [];
    window.Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
    window.Element.prototype.getClientRects = () => [];
    window.Element.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
    window.HTMLCanvasElement.prototype.getContext = () => ({
      createImageData: (w, h) => ({ data: new Uint8Array(w * h * 4) }),
      putImageData: () => {}, fillRect: () => {}, clearRect: () => {}
    });
    installExamplesFetch(window);
  }
});

const win = dom.window;
let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { console.log('  ✅ ' + name); passed++; }
  else { console.log('  ❌ ' + name); failed++; }
}

const ev = (src) => win.eval(src);

function assembleSrc(src) {
  win.setLanguageMode('asm');
  win.editor.value = src;
  win.assembleOnly();
}

// Counting steps would depend on how many instructions each `li` expands to,
// so the tests land on an instruction by address instead.
const addrOf = (re) => ev(`(() => { const m = program.machineCode.find(m => ${re}.test(m.text));
  return m ? m.address : -1; })()`);

function stepTo(re, max = 80) {
  const target = addrOf(re);
  let n = 0;
  while (ev('cpu.pc') !== target && n++ < max) win.stepOnce();
  return ev('cpu.pc') === target;
}

function backTo(re, max = 80) {
  const target = addrOf(re);
  let n = 0;
  while (ev('cpu.pc') !== target && n++ < max) win.stepBack();
  return ev('cpu.pc') === target;
}

// The panel state a step can move, as one comparable string.
function periphSnapshot() {
  return ev(`JSON.stringify({
    led: board.leds, sevseg: board.sevseg,
    col: oled.col, row: oled.row, ctrl: oled.ctrl, data: oled.data,
    advCol: oled.advCol, advRow: oled.advRow,
    front: oled.front, back: oled.back, unpolled: oled.swapUnpolled,
    pending: uart.pending.slice(), rxByte: uart.rxByte, rxFull: uart.rxFull,
    dropped: uart.rxDroppedTotal, nextDeliv: uart.nextDeliveryInstr,
    tx: uart.txText, txBytes: uart.txBytes.length,
    pixels: [oled.pages[0][0], oled.pages[0][1], oled.pages[0][2],
             oled.pages[1][0], oled.pages[1][1], oled.pages[1][2]]
  })`);
}

const pixelAt = (page, col, row) =>
  ev(`(() => { const b = oled.pages[${page}], i = (${row} * 96 + ${col}) * 4;
      return [b[i], b[i + 1], b[i + 2]].join(','); })()`);

setTimeout(() => {
  try {
    // ---------------------------------------------------------------
    console.log('\n[1] LED, 7-segment and UART transmit');
    const SIMPLE = `
.text
main:
    li   t0, 0xFFFF0000
    li   a0, 0xAA
    sw   a0, 0x60(t0)          # LED
    li   a1, 0x12345678
    sw   a1, 0x80(t0)          # 7-segment
    li   a2, 0x41
    sw   a2, 0x0C(t0)          # UART_TX 'A'
    nop
`;
    assembleSrc(SIMPLE);
    stepTo(/sw\s+a2/); win.stepOnce();
    check('LED, 7-seg and the terminal all took the writes',
      ev('board.leds') === 0xAA && ev('board.sevseg') === '12345678' && ev('uart.txText') === 'A');

    win.stepBack();
    check('back over the UART write un-prints the character', ev('uart.txText') === '');
    check('and drops the raw byte with it', ev('uart.txBytes.length') === 0);
    backTo(/sw\s+a1/);
    check('back over the 7-segment write restores it', ev('board.sevseg') === '00000000');
    backTo(/sw\s+a0/);
    check('back over the LED write restores it', ev('board.leds') === 0);

    // ---------------------------------------------------------------
    console.log('\n[2] OLED registers and a painted pixel');
    const PIXEL = `
.text
main:
    li   t0, 0xFFFF0000
    li   t1, 0x20
    sw   t1, 0x2C(t0)          # OLED_CTRL: 16-bit colour, paint on data write
    li   t2, 7
    sw   t2, 0x20(t0)          # OLED_COL
    li   t3, 3
    sw   t3, 0x24(t0)          # OLED_ROW
    li   t4, 0xF800
    sw   t4, 0x28(t0)          # OLED_DATA, paints
    nop
`;
    assembleSrc(PIXEL);
    stepTo(/sw\s+t4/); win.stepOnce();
    const painted = pixelAt(ev('oled.back'), 7, 3);
    check('the pixel landed', painted !== '0,0,0');
    check('and the registers hold what was written',
      ev('oled.col') === 7 && ev('oled.row') === 3 && ev('oled.ctrl') === 0x20);

    win.stepBack();
    check('back over the data write unpaints the pixel',
      pixelAt(ev('oled.back'), 7, 3) === '0,0,0');
    backTo(/sw\s+t3/);
    check('back over the row write restores OLED_ROW', ev('oled.row') === 0);
    backTo(/sw\s+t2/);
    check('back over the column write restores OLED_COL', ev('oled.col') === 0);
    backTo(/sw\s+t1/);
    check('back over the control write restores OLED_CTRL', ev('oled.ctrl') === 0);

    // ---------------------------------------------------------------
    console.log('\n[3] A present, which copies a whole page');
    const PRESENT = PIXEL.replace(/    nop\n$/, `    li   t5, 0x08
    sw   t5, 0x2C(t0)          # present
    li   t6, 0x001F
    sw   t6, 0x28(t0)          # paint again, into the new back page
    nop
`);
    assembleSrc(PRESENT);
    stepTo(/sw\s+t6/); win.stepOnce();
    check('the present split the pages', ev('oled.front') !== ev('oled.back'));
    const afterSecond = pixelAt(ev('oled.back'), 7, 3);
    check('and the second colour is in the back page', afterSecond !== painted);

    win.stepBack();
    check('back over the second paint restores the presented colour',
      pixelAt(ev('oled.back'), 7, 3) === painted);
    backTo(/sw\s+t5/);
    check('back over the present puts both page pointers back',
      ev('oled.front') === ev('oled.back') && ev('oled.front') === 0);
    check('and leaves the pixel drawn before it alone',
      pixelAt(ev('oled.back'), 7, 3) === painted);
    check('with the page the copy overwrote blank again',
      pixelAt(1, 7, 3) === '0,0,0');

    // ---------------------------------------------------------------
    console.log('\n[4] Receive: arrival, which back-step must un-deliver');
    const POLL = `
.text
main:
    li   t0, 0xFFFF0000
wait:
    lw   t1, 0x00(t0)          # UART_RX_VALID
    beq  t1, zero, wait
    lw   t2, 0x04(t0)          # UART_RX, consumes the byte
    nop
`;
    assembleSrc(POLL);
    win.stepOnce();
    ev('uart.pending = [0x41, 0x42]; uart.sendTotal = 2; uart.nextDeliveryInstr = cpu.instructionCount;');
    win.stepOnce();
    check('one byte is handed over, the other still queued',
      ev('uart.rxFull') === true && ev('uart.rxByte') === 0x41 && ev('uart.pending.length') === 1);

    win.stepBack();
    check('back-step un-delivers it', ev('uart.rxFull') === false);
    check('and puts it back at the head of the queue',
      ev('JSON.stringify(uart.pending)') === '[65,66]');

    // Re-stepping must deliver the same byte, not the next one; otherwise the
    // receive path falls out of step with instructionCount.
    win.stepOnce();
    check('stepping forward again delivers the same byte, losing nothing',
      ev('uart.rxByte') === 0x41 && ev('uart.pending.length') === 1);

    // ---------------------------------------------------------------
    console.log('\n[5] Receive: the load that consumes the held byte');
    check('reached the consuming load', stepTo(/lw\s+t2/));
    const heldBefore = ev('uart.rxByte');
    check('with a byte held', ev('uart.rxFull') === true);
    win.stepOnce();
    check('the load takes it and clears UART_RX_VALID',
      ev('uart.rxFull') === false && (ev('cpu.regs[7]') & 0xFF) === heldBefore);
    win.stepBack();
    check('back-step hands it back', ev('uart.rxFull') === true && ev('uart.rxByte') === heldBefore);

    // ---------------------------------------------------------------
    console.log('\n[6] Step back then forward is a no-op, peripherals included');
    assembleSrc(PRESENT);
    stepTo(/sw\s+t3/);
    ev('uart.pending = [0x39]; uart.nextDeliveryInstr = cpu.instructionCount;');
    win.stepOnce(); win.stepOnce();
    const before = periphSnapshot();
    const pcBefore = ev('cpu.pc');
    win.stepBack(); win.stepBack();
    check('two back-steps move the state', periphSnapshot() !== before);
    win.stepOnce(); win.stepOnce();
    check('and two forward steps put it back exactly', periphSnapshot() === before);
    check('with the PC where it was', ev('cpu.pc') === pcBefore);

    // ---------------------------------------------------------------
    console.log('\n[7] The history entry carries what the restore needs');
    check('a step records its peripheral snapshot and page journal',
      ev('stepHistory.entries.length > 0 && !!stepHistory.entries[stepHistory.entries.length - 1].periph && ' +
         'Array.isArray(stepHistory.entries[stepHistory.entries.length - 1].pixels)'));
    check('and a step that paints records the pixel it overwrote',
      ev(`(() => {
        setLanguageMode('asm'); editor.value = ${JSON.stringify(PIXEL)}; assembleOnly();
        const target = program.machineCode.find(m => /sw\\s+t4/.test(m.text)).address;
        let n = 0;
        while (cpu.pc !== target && n++ < 80) stepOnce();
        stepOnce();
        return stepHistory.entries[stepHistory.entries.length - 1].pixels.length === 1;
      })()`));

    console.log('\n===========================================================');
    if (failed) {
      console.log(`❌ ${failed} CHECK(S) FAILED (${passed} passed)`);
      process.exit(1);
    }
    console.log(`🎉 ALL ${passed} BACK-STEP PERIPHERAL TESTS PASSED!`);
    console.log('===========================================================');
    process.exit(0);
  } catch (err) {
    console.error('❌ TEST FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}, 800);
