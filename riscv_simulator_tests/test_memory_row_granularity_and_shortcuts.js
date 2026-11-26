// test_memory_row_granularity_and_shortcuts.js
// Covers the Memory panel's rows and labels, and the keyboard shortcuts:
//   1. The Memory panel is one 32-bit word per row (never two) in both Byte
//      and Word mode, so a narrow-panel wrap can only ever separate a row's
//      own Hex cell from its own Content cell - not from another word's.
//   2. A label above a memory row (a code/data symbol, or an MMIO register's
//      name) carries a trailing ':', matching how a label reads in the
//      program itself.
//   3. J, K and L press BTNL, BTNC and BTNR while held; the arrow keys press
//      no push button.
//   4. Holding X/Y/Z/T, then , and . nudges that accelerometer axis by 5
//      (T = temperature), clamped to the same range as its slider, without
//      stepping; releasing the letter ends it.
//   5. → steps and ← steps back.

const fs = require('fs');
const path = require('path');
const { installExamplesFetch } = require('./examples_fetch');
const { JSDOM } = require('jsdom');

console.log('===========================================================');
console.log('🚀 TESTING MEMORY ROW GRANULARITY, LABEL COLONS & SHORTCUTS');
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
    if (window.HTMLCanvasElement) {
      window.HTMLCanvasElement.prototype.getContext = () => ({
        createImageData: (w, h) => ({ data: new Uint8Array(w * h * 4) }),
        putImageData: () => {}, fillRect: () => {}, clearRect: () => {}
      });
    }
    installExamplesFetch(window); // before the page's own fetch() for the Example menu
  }
});

const win = dom.window;
const doc = win.document;
const press = (type, key, shiftKey = false) => doc.dispatchEvent(new win.KeyboardEvent(type, { key, shiftKey, bubbles: true, cancelable: true }));

setTimeout(async () => {
  try {
    win.setLanguageMode('asm');
    await win.loadExample('dip_led');
    win.assembleOnly();

    // --- [1] One word per row ---
    win.memGo('code');
    win.eval("document.getElementById('memRows').value='4';");
    win.setMemViewMode('word');
    const addrs = Array.from(doc.querySelectorAll('#memView .addr')).map(el => parseInt(el.textContent, 16));
    if (addrs.length !== 4) throw new Error(`Expected 4 address rows for Rows=4, got ${addrs.length}`);
    if (addrs[1] - addrs[0] !== 4 || addrs[2] - addrs[1] !== 4) throw new Error(`Rows should step by 4 bytes (one word), got deltas ${addrs[1]-addrs[0]}, ${addrs[2]-addrs[1]}`);
    if (doc.querySelectorAll('#memView .word-cell').length !== 4) throw new Error('Expected exactly one .word-cell per row');
    console.log('✅ Word mode: one 32-bit word per row, stepping by 4 bytes');

    win.setMemViewMode('bytes');
    if (doc.querySelectorAll('#memView .mem-row-bytes').length !== 4) throw new Error('Expected exactly one 4-byte group per row in Byte mode');
    console.log('✅ Byte mode: one 4-byte group per row');

    // Stack: one word per row, decreasing
    win.memGo('stack');
    win.eval("document.getElementById('memRows').value='4';");
    win.setMemViewMode('word');
    const stackAddrs = Array.from(doc.querySelectorAll('#memView .addr')).map(el => parseInt(el.textContent, 16));
    if (stackAddrs[0] - stackAddrs[1] !== 4 || stackAddrs[1] - stackAddrs[2] !== 4) {
      throw new Error(`Stack rows should decrease by 4 bytes, got ${stackAddrs.slice(0, 3).map(a => '0x' + a.toString(16))}`);
    }
    console.log('✅ Stack: one word per row, decreasing by 4 bytes');

    // --- [2] Label colons ---
    win.memGo('code');
    win.eval("document.getElementById('memRows').value='2';");
    win.updateMemoryView();
    const codeHtml = doc.getElementById('memView').innerHTML;
    if (!/class="mem-row-label"[^>]*>[^<]+:<\/span>/.test(codeHtml)) throw new Error('A code label should render with a trailing ":"');
    console.log('✅ Code/data label renders with a trailing ":"');

    win.memGo('mmio');
    win.eval("document.getElementById('memAddr').value='0xFFFF0060'; document.getElementById('memRows').value='2';");
    win.updateMemoryView();
    const mmioHtml = doc.getElementById('memView').innerHTML;
    if (!mmioHtml.includes('LED (WO):')) throw new Error('MMIO label should render as "LED (WO):"');
    if (!mmioHtml.includes('DIP (RO):')) throw new Error('MMIO label should render as "DIP (RO):"');
    console.log('✅ MMIO register label renders with a trailing ":"');

    // --- [3] Push buttons are J K L, held ---
    [['j', 0x4], ['k', 0x2], ['l', 0x1]].forEach(([key, bit]) => {
      press('keydown', key);
      if (win.eval('board.buttons') !== bit) throw new Error(`${key.toUpperCase()} should press only its button (0x${bit.toString(16)})`);
      press('keyup', key);
      if (win.eval('board.buttons') !== 0) throw new Error(`${key.toUpperCase()} release should clear its button`);
    });
    ['ArrowLeft', 'ArrowDown', 'ArrowRight'].forEach(key => {
      press('keydown', key); press('keyup', key);
    });
    if (win.eval('board.buttons') !== 0) throw new Error('The arrow keys should press no push button');
    press('keydown', 'K', true);
    if (win.eval('board.buttons') !== 0x2) throw new Error('K in capitals should press BTNC too');
    press('keyup', 'K', true);
    if (win.eval('board.buttons') !== 0) throw new Error('K in capitals should release BTNC');
    console.log('✅ J, K and L press BTNL, BTNC and BTNR while held; the arrows press none');

    // --- [4] Accelerometer axis shortcut: hold X/Y/Z/T, , and . (5 units per press) ---
    win.eval('accel.x = 0; accel.temp = 25;');
    const instr0 = win.eval('cpu.instructionCount');
    press('keydown', 'x');
    press('keydown', '.');
    if (win.eval('accel.x') !== 5) throw new Error(`X + . should increase accel.x to 5, got ${win.eval('accel.x')}`);
    press('keydown', ',');
    press('keydown', ',');
    if (win.eval('accel.x') !== -5) throw new Error(`X + , x2 should net accel.x to -5, got ${win.eval('accel.x')}`);
    press('keyup', 'x');
    press('keydown', ',');
    if (win.eval('accel.x') !== -5) throw new Error('accel.x should not change once X is released');
    if (win.eval('cpu.instructionCount') !== instr0) throw new Error('The accelerometer keys should not step');
    console.log('✅ Hold X, , and . nudge accel.x by 5; releasing X ends it');

    press('keydown', 't');
    press('keydown', '.');
    if (win.eval('accel.temp') !== 30) throw new Error(`T + . should increase accel.temp to 30, got ${win.eval('accel.temp')}`);
    press('keyup', 't');
    press('keydown', 'T', true);
    press('keydown', '>', true);
    if (win.eval('accel.temp') !== 35) throw new Error(`Shift+T with Shift+. should increase accel.temp to 35, got ${win.eval('accel.temp')}`);
    press('keyup', 'T', true);
    console.log('✅ Hold T, , and . nudge accel.temp by 5');

    win.eval('accel.z = 127;');
    press('keydown', 'z');
    press('keydown', '.');
    if (win.eval('accel.z') !== 127) throw new Error(`accel.z should clamp at 127, got ${win.eval('accel.z')}`);
    press('keyup', 'z');
    console.log('✅ Accelerometer axis shortcut clamps to the slider range');

    // --- [5] → and ← are Step and Back ---
    win.eval('resetAll()');
    const pc0 = win.eval('cpu.pc');
    press('keydown', 'ArrowRight'); press('keyup', 'ArrowRight');
    if (win.eval('cpu.pc') === pc0 || win.eval('cpu.instructionCount') !== 1)
      throw new Error('→ should step one instruction');
    press('keydown', 'ArrowLeft'); press('keyup', 'ArrowLeft');
    if (win.eval('cpu.pc') !== pc0 || win.eval('cpu.instructionCount') !== 0)
      throw new Error('← should step back');
    console.log('✅ → steps and ← steps back');

    console.log('\n===========================================================');
    console.log('🎉 ALL MEMORY ROW GRANULARITY & SHORTCUT TESTS PASSED!');
    console.log('===========================================================');
    process.exit(0);
  } catch (err) {
    console.error('❌ TEST FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}, 500);
