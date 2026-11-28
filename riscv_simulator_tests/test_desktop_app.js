/*
 * The desktop app (desktop/app, Tauri) driven through WebDriver: the page in
 * the app's own webview, native Icarus run from the toolbar and taking a
 * switch while it runs, Verilator built and run live, and the folder the
 * user picked remembered across a restart.
 *
 * Needs tauri-driver (cargo install tauri-driver) and the platform's
 * WebDriver (WebKitWebDriver on Linux, from webkit2gtk-driver; msedgedriver
 * on Windows). macOS has no WebDriver for its webview. The app is the one
 * cargo builds in desktop/target/release (npm run desktop:build), or
 * RVSIM_APP_EXE.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { findCoreDir } = require('./core_dir');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.platform === 'win32' ? '.exe' : '';
const APP = process.env.RVSIM_APP_EXE || path.join(ROOT, 'desktop', 'target', 'release', 'rvedusim' + EXE);
// A processor's RTL when there is one (see core_dir.js); otherwise the
// prebuilt core in examples/hdl, a gate-level netlist and the Wrapper.
const CORE = findCoreDir();
const FOLDER = CORE || path.join(ROOT, 'examples', 'hdl');
const NFILES = CORE ? 10 : fs.readdirSync(FOLDER).filter(f => /\.v$/.test(f)).length;
const SHOT = process.env.SHOT_DIR || os.tmpdir();
const PORT = 4444;

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log('  ✅ ' + label); }
  else { failed++; console.log('  ❌ ' + label); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- a WebDriver client, as much of one as this needs ----------------------
async function wd(method, url, body) {
  const r = await fetch('http://127.0.0.1:' + PORT + url, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(j.value.error + ': ' + j.value.message);
  return j.value;
}
function session(id) {
  const s = '/session/' + id;
  const eval_ = (fn, ...args) => wd('POST', s + '/execute/sync', { script: 'return (' + fn + ').apply(null, arguments)', args });
  return {
    eval: eval_,
    // Resolves true once fn() is truthy, false after ms.
    async until(fn, ms, ...args) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        try { if (await eval_(fn, ...args)) return true; } catch (e) { /* the page may be loading */ }
        await sleep(100);
      }
      return false;
    },
    async click(css) {
      const el = await wd('POST', s + '/element', { using: 'css selector', value: css });
      await wd('POST', s + '/element/' + Object.values(el)[0] + '/click', {});
    },
    // A screenshot is for a person to look at, and is not checked. On CI,
    // where nobody would see it, none is taken unless SHOT_DIR asks: there
    // WebKitGTK's screenshot has been seen not to answer, which leaves the
    // session's later commands waiting behind it.
    async shot(name) {
      if (process.env.CI && !process.env.SHOT_DIR) return;
      const b64 = await wd('GET', s + '/screenshot');
      fs.writeFileSync(path.join(SHOT, name), Buffer.from(b64, 'base64'));
    },
    close: () => wd('DELETE', s).catch(() => {}),
  };
}

async function launch(userData) {
  const v = await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: APP } } } });
  const page = session(v.sessionId);
  await page.until(() => typeof window.hdlPickFolder === 'function' && !!document.querySelector('.cm-editor'), 30000);
  // Errors from here on.
  await page.eval(() => { window.__errors = []; window.addEventListener('error', e => window.__errors.push(String(e.message))); });
  return page;
}

(async () => {
  if (!fs.existsSync(APP)) { check('The app is built (' + APP + ')', false); process.exit(1); }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rvsim-app-'));
  const env = Object.assign({}, process.env, { RVSIM_USER_DATA: userData, RVSIM_TEST_FOLDER: FOLDER });
  // On Linux the app opens links with xdg-open; this one only notes the URL.
  const opened = path.join(userData, 'opened.txt');
  if (process.platform === 'linux') {
    const bin = path.join(userData, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'xdg-open'), '#!/bin/sh\necho "$1" >> "' + opened + '"\n', { mode: 0o755 });
    env.PATH = bin + path.delimiter + env.PATH;
  }
  const driver = spawn('tauri-driver', ['--port', String(PORT)], { env, stdio: 'ignore' });
  driver.on('error', e => { console.error('tauri-driver: ' + e.message); process.exit(1); });
  let page;
  try {
    for (let i = 0; i < 50; i++) { try { await wd('GET', '/status'); break; } catch (e) { await sleep(100); } }
    console.log('===========================================================');
    console.log('🖥  THE DESKTOP APP');
    console.log('===========================================================');
    page = await launch(userData);

    console.log('\n[1] The page, carried by the app');
    const loc = await page.eval(() => location.href);
    check('It loads from the app itself (' + loc + ')', /^(tauri:\/\/localhost|https?:\/\/tauri\.localhost)(\/|$)/.test(loc));
    check('The bridge reports native Icarus', await page.eval(() => !!(window.rvNative && window.rvNative.icarus)));
    check('Node is not reachable from the page', await page.eval(() => typeof require === 'undefined' && typeof process === 'undefined'));
    if (process.platform === 'linux') {
      await page.eval(() => {
        document.querySelector('a[href="https://github.com/r-panicker/RVEduSim"]').click();
        window.open('https://example.org/open');
        setTimeout(() => { location.href = 'https://example.org/navigate'; }, 0);
      });
      const urls = () => fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8').trim().split('\n').sort() : [];
      for (let i = 0; i < 50 && urls().length < 3; i++) await sleep(100);
      const want = ['https://example.org/navigate', 'https://example.org/open', 'https://github.com/r-panicker/RVEduSim'];
      check('Links to the web open in the browser (' + urls().join(', ') + ')', JSON.stringify(urls()) === JSON.stringify(want));
      check('The app stays on its page', /^tauri:\/\/localhost/.test(await page.eval(() => location.href)));
    }

    console.log('\n[2] Picking a folder with the button');
    await page.eval(() => setSimEngineMode('hdl'));
    await page.until(() => { const b = document.getElementById('hdlFolderBtn'); return b && b.offsetParent !== null; }, 10000);
    await page.click('#hdlFolderBtn');
    const loaded = await page.until(n => getHdlFiles().length === n, 10000, NFILES);
    check('The ' + NFILES + ' sources in ' + path.basename(FOLDER) + '/ are loaded', loaded);
    const note = await page.eval(() => document.getElementById('hdlSourcesNote').textContent);
    check('The sources note names the folder', new RegExp(NFILES + ' loaded from ' + path.basename(FOLDER) + ', Wrapper found').test(note));
    await page.shot('rvsim_app_settings.png');
    await page.eval(() => closeSettingsModal());

    console.log('\n[3] Run from the toolbar');
    await page.eval(() => { loadExample('dip_led').then(() => setDipSwitches(0x00ad)); });
    await page.until(() => /DIP/.test(document.getElementById('exampleSelect').selectedOptions[0].textContent), 10000);
    await sleep(300);
    await page.click('#runPauseBtn');
    check('The LEDs show the switches after Run', await page.until(() => getLedState() === 0xad, 60000));
    const log = await page.eval(() => [...document.querySelectorAll('#console div')].map(d => d.textContent).join('\n'));
    const m = /preprocess (\d+) ms, compile (\d+) ms/.exec(log);
    console.log('    ' + (m ? m[0] : 'no timing line'));
    check('The console carries no engine error', !/\[HDL\].*(error|failed)/i.test(log));
    await page.shot('rvsim_app_run.png');

    console.log('\n[3a] An Icarus run takes a switch while it runs');
    await page.eval(() => { resetAll(); setDipSwitches(0x00ad); setHdlCycles(200000); });
    await page.click('#runPauseBtn');
    await page.until(() => /running - cycle/.test(document.getElementById('statusBar').textContent), 60000);
    check('The Run button reads Pause while it runs', await page.eval(() => /Pause/.test(document.getElementById('runPauseBtn').textContent)));
    if (!(await page.eval(() => !!document.getElementById('dip0').offsetParent))) await page.click('#panelChip-peripherals');
    await page.click('#dip0');
    const icFollowed = await page.until(() => getLedState() !== 0xad, 10000);
    const icStill = await page.eval(() => /running - cycle/.test(document.getElementById('statusBar').textContent));
    await page.shot('rvsim_app_icarus_chunks.png');
    check('A switch clicked during the run shows on the LEDs while it runs (LED 0x' +
      (await page.eval(() => getLedState().toString(16))) + ')', icFollowed && icStill);
    await page.click('#runPauseBtn');
    const icPaused = await page.until(() => /HDL paused/.test(document.getElementById('statusBar').textContent), 10000);
    const icAfter = await page.eval(() => [document.getElementById('statusBar').textContent, getHdlTrace().budget]);
    check('Pause stops it part-way (' + icAfter.join(', ') + ')', icPaused && icAfter[1] < 200000);
    await page.eval(() => resetAll());

    console.log('\n[3b] Verilator, chosen in Settings');
    await page.eval(() => openSettingsModal('simulator'));
    check('The Simulator setting can be changed', !(await page.eval(() => document.getElementById('hdlSimulator').disabled)));
    await page.eval(() => { const s = document.getElementById('hdlSimulator'); s.value = 'verilator'; s.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.shot('rvsim_app_verilator_settings.png');
    await page.eval(() => { closeSettingsModal(); setDipSwitches(0x005a); });
    await page.click('#runPauseBtn');
    const vlLit = await page.until(() => getLedState() === 0x5a, 600000);
    const vlLog = await page.eval(() => [...document.querySelectorAll('#console div')].map(d => d.textContent).join('\n'));
    const vb = /Verilator build ([\d.?]+) s \(([^)]+)\)|Reusing the Verilator model/.exec(vlLog);
    console.log('    ' + (vb ? vb[0] : 'no build line'));
    check('Run builds with Verilator and lights the LEDs', vlLit && !!vb);
    if (!vlLit || !vb) console.log(vlLog.split('\n').slice(-25).map(l => '    | ' + l).join('\n'));
    await page.eval(() => { resetAll(); setHdlCycles(50000000); });
    await page.click('#runPauseBtn');
    if (!(await page.until(() => /running live/.test(document.getElementById('statusBar').textContent), 60000)))
      console.log('    status: ' + (await page.eval(() => document.getElementById('statusBar').textContent)) + '\n' +
        (await page.eval(() => [...document.querySelectorAll('#console div')].slice(-15).map(d => '    | ' + d.textContent).join('\n'))));
    await page.eval(() => setDipSwitches(0x000f));
    const followed = await page.until(() => getLedState() === 0x0f, 10000);
    const stillLive = await page.eval(() => /running live/.test(document.getElementById('statusBar').textContent));
    check('A switch flipped during a live run shows on the LEDs while it runs', followed && stillLive);
    check('The Run button reads Pause while it runs', await page.eval(() => /Pause/.test(document.getElementById('runPauseBtn').textContent)));
    await page.click('#runPauseBtn');
    check('Pause stops it', await page.until(() => /paused/.test(document.getElementById('statusBar').textContent), 30000));
    await page.eval(() => setHdlSimulator('icarus'));
    const fetched = await page.eval(() => performance.getEntriesByType('resource').map(e => e.name).filter(u => /verisim|yosys/.test(u)));
    check('No HDL engine was fetched (' + fetched.length + ')', fetched.length === 0);
    const errors = await page.eval(() => window.__errors);
    check('No page errors (' + errors.join('; ') + ')', errors.length === 0);
    await page.close();

    console.log('\n[4] The folder is remembered');
    page = await launch(userData);
    check('A restart loads the same folder without asking', await page.until(n => getHdlFiles().length === n, 10000, NFILES));
    await page.eval(() => hdlClearFiles());
    await page.close();
    page = await launch(userData);
    await sleep(1000);
    check('Clear files forgets it', (await page.eval(() => getHdlFiles().length)) === 0);
    await page.close();
    page = null;
  } catch (e) {
    console.error(e);
    failed++;
  } finally {
    if (page) await page.close();
    driver.kill();
    fs.rmSync(userData, { recursive: true, force: true });
  }
  console.log('\n===========================================================');
  console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
