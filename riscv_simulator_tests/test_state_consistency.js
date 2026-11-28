/*
 * Every view shows the state it is a view of, whatever the order of the
 * actions that got it there. In a real browser (Chrome, headless), a seeded
 * random sequence of actions is played, as a user would do them where there
 * is a control for it: the microarchitecture from Settings and from the
 * datapath strip, the branch predictor and hazard switches, the engine and
 * language, examples, Step, Back, Run, Reset, the datapath and its views,
 * the clock, Reset Tab, reloading the page, and crossing between the desktop
 * and phone layouts. After each one, every view is compared with the state
 * (consistencyErrors below); a reload also checks that the settings came
 * back as they were. A failure prints the actions that led to it.
 *
 *   node test_state_consistency.js [steps per run] [seed]
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const STEPS = parseInt(process.argv[2], 10) || 150;
const SEED0 = parseInt(process.argv[3], 10) || 1;
const RUNS = [
  { name: 'desktop', viewport: { width: 1400, height: 900 }, seed: SEED0 },
  { name: 'phone', viewport: { width: 412, height: 860 }, mobile: true, seed: SEED0 + 1 },
  { name: 'desktop, then phone', viewport: { width: 1400, height: 900 }, seed: SEED0 + 2, resize: true },
];

let passed = 0, failed = 0;
function check(label, cond, extra) {
  if (cond) { passed++; console.log('  ✅ ' + label); }
  else { failed++; console.log('  ❌ ' + label + (extra ? '\n' + extra : '')); }
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.txt': 'text/plain',
                '.asm': 'text/plain', '.c': 'text/plain', '.v': 'text/plain' };
function serve() {
  const page = require('../tools/page').inlinePage({ minify: true });
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (name === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page); return; }
    const file = path.join(ROOT, name);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

// The course's single-cycle processor, for HDL mode.
const RV = require('./core_dir').coreDir('test_state_consistency');
const DESIGN = fs.readdirSync(RV).filter(f => /\.v$/.test(f) && !/tb|test/i.test(f))
  .map(f => ({ name: f, src: fs.readFileSync(path.join(RV, f), 'utf8') }));

// Runs in the page: what each view shows, against the state it shows.
function consistencyErrors() {
  const out = [];
  const $ = id => document.getElementById(id);
  const shown = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const body = document.body.classList;
  const eq = (what, view, state) => { if (view !== state) out.push(`${what}: shows ${JSON.stringify(view)}, state ${JSON.stringify(state)}`); };
  const P = window.pipeline, hdl = ui.engine === 'hdl';

  // The microarchitecture and the pipeline's settings.
  eq('pipeline.on', P.on, P.arch === 'pipe');
  eq('body dp-pipe', body.contains('dp-pipe'), P.on);
  eq('body dp-bp', body.contains('dp-bp'), P.predictor.on);
  if ($('dpArch')) eq('strip selector', $('dpArch').value, P.on ? 'pipe' : 'single');
  eq('Settings microarchitecture', $('simMicroarch').value, P.arch);
  eq('Settings hazard switches shown', getComputedStyle($('pipeHazBox')).display !== 'none', P.on);
  eq('Settings cycles table shown', getComputedStyle($('cyclesTableBox')).display !== 'none', P.arch === 'multi');
  eq('Settings predictor box', $('pipeBpOn').checked, P.predictor.on);
  eq('Settings predictor bits', $('pipeBpBits').value, String(P.predictor.bits));
  eq('Settings predictor entries', $('pipeBpEntries').value, String(P.predictor.entries));
  for (const el of document.querySelectorAll('[data-haz]')) eq('hazard ' + el.dataset.haz, el.checked, !!P.hazards[el.dataset.haz]);
  for (const k of Object.keys(run.cycleConfig)) if ($('cf-' + k)) eq('cycles ' + k, $('cf-' + k).value, String(run.cycleConfig[k]));
  eq('body dp-view-timeline', body.contains('dp-view-timeline'), dpView === 'timeline');
  if (dpView === 'timeline') eq('timeline only when pipelined', P.on, true);
  const svgShown = { single: shown($('dpSvg')), pipe: shown($('dpPipeSvg')), bp: shown($('dpPipeBpSvg')) };
  if (dpActive() && dpView === 'diagram' && shown($('dpDock'))) {
    eq('single-cycle diagram shown', svgShown.single, !P.on);
    eq('pipelined diagram shown', svgShown.pipe, P.on && !P.predictor.on);
    eq('pipelined diagram with predictor shown', svgShown.bp, P.on && P.predictor.on);
  }
  if (dpActive() && dpPanel.enc && program.assembled) eq('encoding column kind', dpPanel.enc.pipe, P.on);
  if (dpActive() && !P.on && dpModel && !dpModel.pipe && program.assembled) {
    eq('strip instruction is the PC\'s', ($('dpInstr').textContent.match(/0x[0-9a-f]{8}/) || [''])[0], dpHex(cpu.pc));
  }
  const stages = document.querySelectorAll('.cm-pipe-stage').length;
  if (stages) eq('pipeline stages in the editor only when pipelined', P.on && !hdl, true);

  // The engine and language.
  eq('toolbar JS', $('engBtnJs').classList.contains('active'), !hdl);
  eq('toolbar HDL', $('engBtnHdl').classList.contains('active'), hdl);
  eq('body hdl-mode', body.contains('hdl-mode'), hdl);
  eq('Settings JS group hidden', $('simGroupJs').hidden, hdl);
  eq('Settings HDL group hidden', $('simGroupHdl').hidden, !hdl);
  eq('toolbar Datapath/Waveform', /Waveform/.test($('btnViz').textContent), hdl);
  if (hdl) eq('datapath strip hidden in HDL mode', shown($('dpDock')) && !body.contains('dp-in-panel'), false);
  eq('toolbar ASM', $('langBtnAsm').classList.contains('active'), editorState.language === 'asm');
  eq('toolbar C', $('langBtnC').classList.contains('active'), editorState.language === 'c');

  // The metrics, from whichever engine.
  const stats = $('statsBar').textContent;
  const settled = !hdlActivity.running && !run.running;
  if (settled && document.querySelector('#statsBar .stat-tag')) {
    if (!stats.includes('Cycles: ' + cpu.totalCycles)) out.push(`stats cycles: "${stats}", state ${cpu.totalCycles}`);
    if (!stats.includes('Instr: ' + cpu.instructionCount)) out.push(`stats instructions: "${stats}", state ${cpu.instructionCount}`);
    if (!stats.includes(formatPC())) out.push(`stats PC: "${stats}", state ${formatPC()}`);
    const tag = document.querySelector('#statsBar .stat-tag').textContent;
    eq('stats tag', tag, hdl ? 'hw' : P.on ? 'pipe' : P.arch === 'multi' ? 'multi' : 'single');
  }
  // The waveform's Cycle box follows the recording while it is not typed in.
  const box = $('waveCycleInput');
  if (hdl && settled && box && shown(box) && document.activeElement !== box && box.value !== '' && hdlRec.trace) {
    eq('waveform Cycle box', box.value, String(hdlCurrentCycle()));
  }
  eq('Run button while running', /Pause/.test($('runPauseBtn').textContent), !!run.running);

  // The clock and the rest of Settings.
  eq('clock CLK_DIV_BITS', document.querySelector('[data-clk="div"]').value, String(clock.divBits));
  eq('clock frequency', document.querySelector('[data-clk="hz"]').textContent, fmtHz(cpuHz()));
  eq('clock pace', document.querySelector('[data-clk="pace"]').value, clock.pace);
  eq('statement stepping', $('simStatementStep').checked, !!run.statementStepping);
  eq('max instructions', $('simMaxInstrPerRun').value, String(run.maxInstructions));
  eq('compiler', $('godboltCompilerSelect').value, compilerConfig.compiler);
  eq('optimisation', $('godboltOptSelect').value, compilerConfig.opt);
  eq('arch flags', $('godboltArchFlags').value, compilerConfig.archFlags);
  eq('M extension', $('godboltUseM').checked, compilerConfig.useM);
  eq('HDL trace', $('hdlTrace').checked, hdlConfig.traceEnabled);
  eq('HDL waveform', $('hdlVcd').checked, hdlConfig.dumpVcd);
  eq('HDL cross-check', $('hdlCompare').checked, hdlConfig.compareEnabled);
  eq('HDL cycles', $('hdlCycles').value, String(hdlConfig.cycleBudget));
  eq('HDL simulator', $('hdlSimulator').value, hdlConfig.simulator);
  eq('HDL standard', $('hdlGeneration').value, hdlConfig.generation);
  eq('HDL detail', $('hdlDetail').value, hdlDetailMatch());

  // The registers, from either engine (in HDL mode, those the recording
  // has seen written).
  if (settled) {
    const rows = document.querySelectorAll('#regBody tr');
    rows.forEach((tr, i) => {
      if (i > 31 || (hdl && !(hdlRec.regKnown && hdlRec.regKnown[i]))) return;
      const cell = tr.querySelector('.reg-val');
      if (!cell || document.activeElement === cell) return;
      const shownHex = cell.textContent.replace(/[^0-9a-f]/gi, '').toLowerCase().slice(-8);
      eq('register x' + i, shownHex, (cpu.regs[i] >>> 0).toString(16).padStart(8, '0'));
    });
  }

  // The panel chips: on a phone the tab shown, on a desktop the panels shown.
  for (const chip of document.querySelectorAll('[id^="panelChip-"]')) {
    const name = chip.id.slice(10);
    const on = dockView.mobile ? mobileTab === name : !!(panelDock[name] && panelDock[name].visible);
    eq('panel chip ' + name, chip.classList.contains('active'), on);
  }

  // The strips and panels.
  eq('body wave-open', body.contains('wave-open'), pageMode.waveOpen);
  eq('body dp-open', body.contains('dp-open'), pageMode.dpOpen);
  if (!dockView.mobile) {
    eq('waveform strip shown', shown($('waveDock')), pageMode.waveOpen && hdl);
    if (!hdl) eq('datapath strip shown', shown($('dpDock')), pageMode.dpOpen);
  }
  eq('body dp-in-panel', body.contains('dp-in-panel'), dockView.mobile);
  eq('body wave-in-panel', body.contains('wave-in-panel'), dockView.mobile);
  eq('Datapath/Waveform button lit', $('btnViz').classList.contains('viz-on'), toolbar.viz.shown);
  eq('example menu', $('exampleSelect').value, toolbar.exampleKey);
  return out;
}

// A small seeded generator, so a failure can be replayed.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

async function playRun(browser, url, spec) {
  console.log(`\n[${spec.name}] ${STEPS} actions, seed ${spec.seed}`);
  const ctx = await browser.newContext({ viewport: spec.viewport, isMobile: !!spec.mobile, hasTouch: !!spec.mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => d.dismiss().catch(() => {}));
  const boot = async () => {
    await page.waitForFunction(() => document.body.dataset.booted === '1', null, { timeout: 30000 });
    await page.evaluate(() => window.exampleIndexReady).catch(() => {});
  };
  await page.goto(url);
  await boot();
  const rand = rng(spec.seed);
  const pick = a => a[Math.floor(rand() * a.length)];
  const log = [];
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const settings = async (tab, fn) => {
    await ev(t => openSettingsModal(t), tab);
    await fn();
    await ev(() => closeSettingsModal());
  };
  const visible = sel => page.locator(sel).first().isVisible().catch(() => false);
  // What covers a control's centre, if anything: the maximised strip covers
  // the toolbar by design; anything else is reported.
  const coveredBy = sel => ev(sel => {
    const el = document.querySelector(sel);
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top || el.contains(top) || top.contains(el)) return null;
    return (top.id ? '#' + top.id : top.tagName.toLowerCase() + '.' + [...top.classList].join('.')) +
      (document.body.classList.contains('dp-max') && top.closest('#dpDock') ? ' (maximised strip)' : '');
  }, sel);
  let covered = null;
  const clickIf = async sel => {
    if (!(await visible(sel)) || !(await page.locator(sel).first().isEnabled())) return false;
    const by = await coveredBy(sel);
    if (by) { if (!/maximised strip/.test(by)) covered = sel + ' is covered by ' + by; return false; }
    try { await page.click(sel, { timeout: 5000 }); }
    catch (e) {
      // Disabled between the look and the click (a compile starting, a run
      // ending) is the page working, not a fault.
      if (/not enabled/.test(String(e && e.message))) return false;
      throw e;
    }
    return true;
  };

  // What a user does first to reach a control: the datapath strip (JS
  // mode, opened from the toolbar or its phone tab), or HDL mode with the
  // processor loaded.
  const toEngine = async e => {
    if ((await ev(() => ui.engine)) === e) return true;
    if (!(await clickIf(e === 'hdl' ? '#engBtnHdl' : '#engBtnJs'))) return false;
    await ev(() => closeSettingsModal());
    return true;
  };
  const openStrip = async () => {
    if (await visible('#dpArch')) return true;
    if (!(await toEngine('js'))) return false;
    if (!(await ev(() => program.assembled))) await clickIf('#btnAssemble');
    if (await ev(() => dockView.mobile)) {
      if (!(await visible('#panelChip-datapath'))) await clickIf('#btnViz');
      await clickIf('#panelChip-datapath');
    } else await clickIf('#btnViz');
    await page.waitForTimeout(100);
    return visible('#dpArch');
  };
  const toHdl = async () => {
    if (!(await toEngine('hdl'))) return false;
    if (!(await ev(() => hdlSources.files.length))) await ev(d => hdlSetSources(d), DESIGN);
    return true;
  };

  const ACTIONS = {
    'Settings: microarchitecture': () => settings('simulator', async () => {
      if (await ev(() => ui.engine === 'hdl')) return 'skipped (HDL)';
      const v = pick(['single', 'multi', 'pipe']);
      await page.selectOption('#simMicroarch', v);
      return v;
    }),
    'strip: microarchitecture': async () => {
      if (!(await openStrip())) return 'skipped (no strip)';
      const v = pick(['single', 'pipe']);
      await page.selectOption('#dpArch', v);
      return v;
    },
    'Settings: branch predictor': () => settings('simulator', async () => {
      if (!(await visible('#pipeBpOn'))) return 'skipped';
      await page.click('#pipeBpOn');
      return '';
    }),
    'Settings: predictor bits': () => settings('simulator', async () => {
      if (!(await visible('#pipeBpBits')) || !(await page.isEnabled('#pipeBpBits'))) return 'skipped';
      const v = pick(['1', '2']); await page.selectOption('#pipeBpBits', v); return v;
    }),
    'Settings: hazard switch': () => settings('simulator', async () => {
      const boxes = await page.locator('[data-haz]').count();
      if (!boxes || !(await visible('[data-haz]'))) return 'skipped';
      const i = Math.floor(rand() * boxes);
      await page.locator('[data-haz]').nth(i).click();
      return String(i);
    }),
    'Settings: cycles table': () => settings('simulator', async () => {
      if (!(await visible('#cf-load'))) return 'skipped';
      const v = String(1 + Math.floor(rand() * 6));
      await page.fill('#cf-load', v); await page.press('#cf-load', 'Tab');
      return v;
    }),
    'Settings: clock': () => settings('simulator', async () => {
      const v = String(Math.floor(rand() * 30));
      await page.fill('[data-clk="div"]', v); await page.press('[data-clk="div"]', 'Tab');
      return v;
    }),
    'Settings: Reset Tab': () => settings(pick(['simulator', 'compiler', 'linker']), async () => {
      await page.click('.c-foot button:has-text("Reset Tab")');
      return await ev(() => ui.settingsTab);
    }),
    'engine': async () => {
      const v = pick(['js', 'js', 'hdl']);
      if (!(await clickIf(v === 'hdl' ? '#engBtnHdl' : '#engBtnJs'))) return 'skipped';
      await ev(() => closeSettingsModal());
      return v;
    },
    'language': async () => {
      const v = pick(['asm', 'asm', 'asm', 'c']);
      return (await clickIf(v === 'c' ? '#langBtnC' : '#langBtnAsm')) ? v : 'skipped';
    },
    'example': async () => {
      const opts = await page.$$eval('#exampleSelect option', os => os.filter(o => o.value && !o.disabled && o.value !== '__sources').map(o => o.value));
      const v = pick(opts.filter(o => !/accel|image|circle|uart|oled/i.test(o)).concat(opts.slice(0, 1)));
      if (!v) return 'skipped';
      const why = await ev(() => { const s = document.getElementById('exampleSelect'); return s.disabled ? 'disabled' : s.getClientRects().length ? '' : 'not shown'; });
      if (why) return 'skipped (' + why + ')';
      try { await page.selectOption('#exampleSelect', v, { timeout: 5000 }); }
      catch (e) { return { error: 'could not choose ' + v + ': ' + String(e).split('\n').slice(0, 6).join(' / ') }; }
      await page.waitForTimeout(150);
      return v;
    },
    'HDL: load the processor': async () => {
      if (!(await toEngine('hdl'))) return 'skipped';
      await ev(d => hdlSetSources(d), DESIGN);
      return DESIGN.length + ' files';
    },
    'HDL: Run': async () => {
      if (!(await toHdl())) return 'skipped';
      if (!(await ev(() => program.assembled))) await clickIf('#btnAssemble');
      if (!(await clickIf('#runPauseBtn'))) return 'skipped';
      const pause = rand() < 0.4;
      const t0 = Date.now();
      while (Date.now() - t0 < 90000) {
        await page.waitForTimeout(200);
        const busy = await ev(() => hdlActivity.running || /Pause/.test(document.getElementById('runPauseBtn').textContent));
        if (!busy) return 'finished';
        if (pause && Date.now() - t0 > 1500) { await clickIf('#runPauseBtn'); pause && (await page.waitForTimeout(300)); return 'paused'; }
      }
      return { error: 'an HDL run did not finish in 90 s' };
    },
    'Assemble': async () => (await clickIf('#btnAssemble')) ? '' : 'skipped',
    'Step': async () => { let n = 1 + Math.floor(rand() * 4), k = 0; while (n-- && await clickIf('#btnStep')) k++; return String(k); },
    'Back': async () => { let n = 1 + Math.floor(rand() * 3), k = 0; while (n-- && await clickIf('#btnBack')) k++; return String(k); },
    'Run, then Pause': async () => {
      if (await ev(() => ui.engine === 'hdl')) return 'skipped (HDL)';
      if (!(await clickIf('#runPauseBtn'))) return 'skipped';
      await page.waitForTimeout(40 + Math.floor(rand() * 200));
      if (await ev(() => run.running)) await page.click('#runPauseBtn');
      await page.waitForTimeout(50);
      return '';
    },
    'Reset': async () => (await clickIf('#btnReset')) ? '' : 'skipped',
    'Datapath/Waveform button': async () => (await clickIf('#btnViz')) ? '' : 'skipped',
    'strip: Diagram/Timeline': async () => {
      if (!(await openStrip())) return 'skipped (no strip)';
      const v = pick(['#dpViewDiagram', '#dpViewTimeline']);
      return (await clickIf(v)) ? v : 'skipped';
    },
    'strip: ◀ ▶': async () => {
      if (!(await openStrip())) return 'skipped (no strip)';
      const v = pick(['#dpPrevBtn', '#dpNextBtn', '#dpNextBtn']);
      return (await clickIf(v)) ? v : (await clickIf('#floatSteps button:nth-child(2)')) ? 'float ▶' : 'skipped';
    },
    'strip: maximise': async () => {
      if (!(await openStrip())) return 'skipped (no strip)';
      return (await clickIf('.dp-max-btn')) ? '' : 'skipped';
    },
    'panel chip': async () => {
      const ids = await page.$$eval('[id^="panelChip-"]', els => els.filter(e => e.getClientRects().length).map(e => e.id));
      if (!ids.length) return 'skipped';
      const id = pick(ids);
      return (await clickIf('#' + id)) ? id.slice(10) : 'skipped';
    },
    'reload': async () => {
      const before = await ev(() => JSON.stringify(settingsSnapshot()));
      await page.reload();
      await boot();
      const after = await ev(() => JSON.stringify(settingsSnapshot()));
      if (before !== after) return { error: 'settings changed across the reload:\n  before ' + before + '\n  after  ' + after };
      return '';
    },
  };
  if (spec.resize) ACTIONS['cross the phone breakpoint'] = async () => {
    const vp = page.viewportSize();
    const to = vp.width > 800 ? { width: 412, height: 860 } : { width: 1400, height: 900 };
    await page.setViewportSize(to);
    await page.waitForTimeout(200);
    return String(to.width);
  };
  const names = Object.keys(ACTIONS);

  const done = {};
  let bad = null;
  const first = await page.evaluate(consistencyErrors);
  if (first.length) bad = { at: 'boot', errs: first };
  for (let i = 0; i < STEPS && !bad; i++) {
    const name = pick(names);
    let res;
    try { res = await ACTIONS[name](); } catch (e) {
      // Playwright's call log says why a click did not happen.
      const lines = String(e && e.message || e).split('\n').map(l => l.trim()).filter(Boolean);
      res = { error: 'action threw: ' + lines[0] + (lines.length > 1 ? '\n       ' + [...new Set(lines.slice(1))].slice(-6).join('\n       ') : '') };
    }
    log.push(name + (typeof res === 'string' && res ? ' (' + res + ')' : ''));
    if (!(typeof res === 'string' && /^skipped/.test(res))) done[name] = (done[name] || 0) + 1;
    await page.waitForTimeout(30);
    if (covered) { res = { error: covered }; covered = null; }
    if (res && res.error) { bad = { at: name, errs: [res.error] }; break; }
    const errs = await page.evaluate(consistencyErrors);
    if (errs.length) {
      errs.push('context: ' + await ev(() => JSON.stringify({ width: innerWidth, mobileMode: mobileMode(), dockMobile: dockView.mobile,
        focus: document.activeElement && (document.activeElement.id || document.activeElement.tagName), mobileTab })));
      bad = { at: name, errs };
    }
  }
  check(`${spec.name}: every view agrees with the state after each action`, !bad,
    bad && ('     after: ' + bad.at + '\n     ' + bad.errs.join('\n     ') + '\n     actions: ' + log.slice(-25).join(' → ')));
  check(`${spec.name}: no page errors`, !errors.length, errors.slice(0, 3).join('\n'));
  console.log('     done: ' + names.map(n => n + ' ' + (done[n] || 0)).join(', '));
  await ctx.close();
}

(async () => {
  const server = await serve();
  const url = 'http://127.0.0.1:' + server.address().port + '/index.html';
  // C programs are compiled by Godbolt, reached through the proxy when
  // there is one.
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome',
    ...(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {}) });
  try {
    console.log('===========================================================');
    console.log('🔁 STATE CONSISTENCY IN CHROME');
    console.log('===========================================================');
    for (const spec of RUNS) await playRun(browser, url, spec);
  } finally {
    await browser.close();
    server.close();
  }
  console.log('\n===========================================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
