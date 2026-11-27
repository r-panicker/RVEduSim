// test_settings_persistence.js
// Settings survive a reload: a second page, started with the first one's
// localStorage, comes up with the same compiler, linker, JS-model, clock,
// UART and HDL settings, and the program it assembles first uses the saved
// memory layout. Reset All clears every rvsim.* key.

const fs = require('fs');
const path = require('path');
const { installExamplesFetch } = require('./examples_fetch');
const { JSDOM } = require('jsdom');

const html = require('./page').html();
const CM6 = fs.readFileSync(path.resolve(__dirname, 'cm6_bundle.min.js'), 'utf8');

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log('  ✅ ' + label); }
  else { failed++; console.log('  ❌ ' + label); }
}

function page(storage) {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', resources: 'usable', url: 'http://localhost:8080/index.html',
    beforeParse(window) {
      window.__CM6_DISABLE_CDN = true;
      for (const [k, v] of Object.entries(storage || {})) window.localStorage.setItem(k, v);
      window.addEventListener('DOMContentLoaded', () => {
        try { window.eval(CM6); } catch (e) { console.error('CM6 inject failed:', e.message); }
      });
      window.requestAnimationFrame = cb => setTimeout(cb, 16);
      window.cancelAnimationFrame = id => clearTimeout(id);
      window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
      window.Range.prototype.getClientRects = () => [];
      window.Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
      window.Element.prototype.getClientRects = () => [];
      window.Element.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
      if (window.HTMLCanvasElement) {
        window.HTMLCanvasElement.prototype.getContext = () => ({
          createImageData: (w, h) => ({ data: new Uint8Array(w * h * 4) }),
          putImageData() {}, fillRect() {}, clearRect() {}
        });
      }
      installExamplesFetch(window);
    }
  });
  const win = dom.window;
  return new Promise(resolve => {
    const wait = () => win.document.body && win.document.body.dataset.booted === '1' ? resolve(win) : setTimeout(wait, 20);
    wait();
  });
}

const storageOf = win => {
  const out = {};
  for (let i = 0; i < win.localStorage.length; i++) {
    const k = win.localStorage.key(i);
    out[k] = win.localStorage.getItem(k);
  }
  return out;
};
const change = (win, id, value) => {
  const el = win.document.getElementById(id);
  if (el.type === 'checkbox') el.checked = value; else el.value = value;
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
};
const settle = () => new Promise(r => setTimeout(r, 30));

(async () => {
  console.log('===========================================================');
  console.log('💾 SETTINGS PERSISTENCE');
  console.log('===========================================================');
  const a = await page();
  check('A first visit stores no settings until one changes', !a.localStorage.getItem('rvsim.settings.v1'));

  // Through the controls, as a user would.
  a.openSettingsModal('compiler');
  change(a, 'godboltOptSelect', '-O2');
  change(a, 'godboltUseM', true);
  a.openSettingsModal('linker');
  { const el = a.document.getElementById('ms-codesize'); el.value = '0x800'; el.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true })); }
  a.applyAndCloseSettings();
  a.openSettingsModal('simulator');
  change(a, 'simMicroarch', 'multi');
  change(a, 'cf-load', '5');
  change(a, 'simStatementStep', true);
  change(a, 'simMaxInstrPerRun', '4321');
  change(a, 'pipeBpOn', true);
  a.closeSettingsModal();
  a.setClkDivBits(9);
  change(a, 'uartSendMode', 'typed');
  a.setSimEngineMode('hdl');
  a.openSettingsModal('simulator');
  change(a, 'hdlCycles', '7777');
  change(a, 'hdlVcd', false);
  change(a, 'hdlCompare', true);
  change(a, 'hdlGeneration', '2005-sv');
  a.closeSettingsModal();
  await settle();
  const saved = JSON.parse(a.localStorage.getItem('rvsim.settings.v1') || 'null');
  check('Changing them stores them', !!saved && saved.layout.codeSize === 0x800 && saved.js.arch === 'multi');

  const b = await page(storageOf(a));
  const d = b.document;
  check('Compiler: optimisation and the M extension', d.getElementById('godboltOptSelect').value === '-O2' &&
    d.getElementById('godboltUseM').checked);
  check('Linker: the code segment size', b.layout.codeSize === 0x800);
  check('…and the first program is assembled into it', b.program.assembled && b.layout.codeSize === 0x800);
  b.openSettingsModal('linker');
  check('…and Settings shows it', d.getElementById('ms-codesize').value === '0x800');
  b.closeSettingsModal();
  check('JS model: microarchitecture, cycles table, statement stepping, batch limit',
    b.pipeline.arch === 'multi' && b.run.cycleConfig.load === 5 && b.run.statementStepping === true &&
    b.run.maxInstructions === 4321);
  check('…and the controls show them', d.getElementById('simMicroarch').value === 'multi');
  check('Branch predictor', b.pipeline.predictor.on === true);
  check('Clock divider', b.clock.divBits === 9);
  check('UART send mode', b.uart.sendMode === 'typed');
  check('HDL: cycles per run, waveform off, cross-check on, Verilog standard',
    b.hdlConfig.cycleBudget === 7777 && b.hdlConfig.dumpVcd === false && b.hdlConfig.compareEnabled === true &&
    d.getElementById('hdlGeneration').value === '2005-sv');
  check('…and the controls show them', d.getElementById('hdlCycles').value === '7777' &&
    d.getElementById('hdlVcd').checked === false && d.getElementById('hdlCompare').checked === true);
  check('Reading them back does not rewrite them', b.localStorage.getItem('rvsim.settings.v1') === a.localStorage.getItem('rvsim.settings.v1'));

  // Selecting an example sets the segments, and that is what is kept.
  await b.loadExample('image_display_accel');
  await settle();
  const ex = JSON.parse(b.localStorage.getItem('rvsim.settings.v1'));
  check('An example\'s memory layout is kept as the last one used (0x' + ex.layout.dataSize.toString(16) + ')',
    ex.layout.dataSize === b.layout.dataSize && b.layout.dataSize === 0x4000);

  // Saved values a newer page no longer knows are ignored, not applied.
  const bad = storageOf(a);
  bad['rvsim.settings.v1'] = JSON.stringify({ layout: { codeSize: 'big' }, js: { arch: 'superscalar', cycles: { load: -3 } },
                                              clock: { divBits: 99 }, compiler: { godboltOptSelect: '-O9' } });
  const c = await page(bad);
  check('Malformed or unknown values fall back to the defaults', c.layout.codeSize === 0x200 &&
    c.pipeline.arch === 'single' && c.run.cycleConfig.load === 2 && c.clock.divBits === 5 &&
    c.document.getElementById('godboltOptSelect').value === '-O0');

  // Reset All: every rvsim.* key goes, and the page reloads.
  b.localStorage.setItem('other.app', 'kept');
  const btn = [...b.document.querySelectorAll('.c-foot button')].find(x => /Reset All/.test(x.textContent));
  b.openSettingsModal('compiler');
  btn.click();
  check('The first click of Reset All only asks for a second', b.localStorage.getItem('rvsim.settings.v1') &&
    /Confirm reset/.test(btn.textContent) && /Click Reset All again/.test(b.document.getElementById('statusBar').textContent));
  btn.click();   // jsdom reports the reload as not implemented, and stays
  const left = Object.keys(storageOf(b));
  check('Reset All removes every rvsim.* key and nothing else (' + left.join(', ') + ')',
    left.length === 1 && left[0] === 'other.app');

  console.log('\n===========================================================');
  console.log(failed ? `💥 ${failed} SETTINGS PERSISTENCE TEST(S) FAILED (${passed} passed)` : `🎉 ALL ${passed} SETTINGS PERSISTENCE TESTS PASSED!`);
  console.log('===========================================================');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Settings persistence test failed:', e); process.exit(1); });
