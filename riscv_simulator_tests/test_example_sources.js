// test_example_sources.js
// The Example menu's three sources: built in, a web folder (the site's own
// examples/ by default, or a GitHub folder set in Settings), and a folder
// on this computer, with or without an index.txt. Each is a section of the
// menu; one that cannot be read shows why instead of an example.

const fs = require('fs');
const path = require('path');
const { installExamplesFetch, EXAMPLES_ROOT } = require('./examples_fetch');
const { JSDOM } = require('jsdom');

const html = require('./page').html();
const CM6 = fs.readFileSync(path.resolve(__dirname, 'cm6_bundle.min.js'), 'utf8');

let passed = 0, failed = 0;
function check(label, cond, extra) {
  if (cond) { passed++; console.log('  ✅ ' + label); }
  else { failed++; console.log('  ❌ ' + label + (extra ? '\n     ' + extra : '')); }
}

// A GitHub folder, served from the repository's own examples/ through
// raw.githubusercontent.com; every other URL there is a 404.
const RAW = 'https://raw.githubusercontent.com/someone/labs/main/ex/';
const fetched = [];
function installGitHubFetch(win) {
  const inner = win.fetch;
  win.fetch = async (url, opts) => {
    url = String(url);
    fetched.push({ url, cache: opts && opts.cache });
    if (url.startsWith(RAW)) {
      try {
        const text = fs.readFileSync(path.join(EXAMPLES_ROOT, url.slice(RAW.length)), 'utf8');
        return { ok: true, status: 200, text: async () => text };
      } catch (e) { return { ok: false, status: 404, text: async () => '' }; }
    }
    if (/^https:/.test(url)) return { ok: false, status: 404, text: async () => '' };
    return inner(url, opts);
  };
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously', resources: 'usable', url: 'http://localhost:8080/index.html',
  beforeParse(window) {
    window.__CM6_DISABLE_CDN = true;
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
    installGitHubFetch(window);
  }
});
const win = dom.window, doc = win.document;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) return false; await sleep(20); }
  return true;
}
// The menu as its sections: { heading: [labels] }, a disabled entry in [].
const menu = () => {
  const out = {};
  for (const n of doc.getElementById('exampleSelect').children) {
    if (n.tagName === 'OPTGROUP') out[n.label] = [...n.children].map(o => o.disabled ? '[' + o.textContent + ']' : o.textContent);
    else out['>'] = (out['>'] || []).concat(n.textContent);
  }
  return out;
};
const editorText = () => win.editor.value;
// A file as <input webkitdirectory> hands it over.
const file = (rel, text) => ({ name: rel.split('/').pop(), webkitRelativePath: rel, text: async () => text });

(async () => {
  console.log('===========================================================');
  console.log('📚 EXAMPLE SOURCES');
  console.log('===========================================================');
  await until(() => doc.body.dataset.booted === '1');
  await win.exampleIndexReady;
  await sleep(50);

  console.log('\n[1] The default menu');
  let m = menu();
  check('Built in holds DIP to LED alone', JSON.stringify(m['Built in']) === '["DIP to LED (start here)"]', JSON.stringify(m));
  check('Web lists the site\'s examples (' + (m.Web || []).length + '), without a second DIP to LED',
    m.Web && m.Web.length === 7 && m.Web.includes('Fibonacci') && !m.Web.some(l => /DIP/.test(l)));
  check('No folder section until a folder is chosen', Object.keys(m).length === 3);
  check('The last entry opens the sources', JSON.stringify(m['>']) === '["Example sources…"]');
  check('The index is fetched past the browser\'s cache',
    fetched.some(f => /examples\/index\.txt$/.test(f.url) && f.cache === 'no-cache'));
  await win.loadExample('fib');
  check('A web example loads, and the menu shows it', /fibonacci/i.test(editorText()) &&
    doc.getElementById('exampleSelect').value === 'fib');
  const sel = doc.getElementById('exampleSelect');
  sel.value = '__sources';
  sel.dispatchEvent(new win.Event('change', { bubbles: true }));
  check('Choosing Example sources… opens Settings → Examples and keeps the example selected',
    win.settingsModel.open && win.settingsModel.tab === 'examples' && sel.value === 'fib');
  win.closeSettingsModal();
  win.setLanguageMode('c');
  m = menu();
  check('In C mode each section lists its C programs', m['Built in'].length === 1 && m.Web.length === 5 && m.Web.includes('Fibonacci'));
  win.setLanguageMode('asm');

  console.log('\n[2] A GitHub folder');
  const url = win.examplesBaseUrl;
  check('A tree URL is read through raw.githubusercontent.com',
    url('https://github.com/someone/labs/tree/main/ex') === RAW);
  check('…as is a repository with no branch (HEAD), and a link to index.txt',
    url('https://github.com/a/b') === 'https://raw.githubusercontent.com/a/b/HEAD/' &&
    url('https://github.com/a/b/blob/dev/x/y/index.txt') === 'https://raw.githubusercontent.com/a/b/dev/x/y/');
  check('Any other https folder is taken as it is; text that is not a URL is refused',
    url('https://example.org/ex') === 'https://example.org/ex/' && url('labs folder') === null);
  win.openSettingsModal('examples');
  const field = doc.getElementById('examplesWebUrl');
  field.value = 'https://github.com/someone/labs/tree/main/ex';
  field.dispatchEvent(new win.Event('change', { bubbles: true }));
  await until(() => win.exampleSources.web.status === 'ok');
  await sleep(20);
  m = menu();
  const gh = 'GitHub: someone/labs/ex';
  check('The section is named after the folder, and lists all of its examples, its own DIP to LED too',
    m[gh] && m[gh].length === 8 && m[gh].includes('DIP to LED (start here)'), JSON.stringify(m));
  check('Settings shows how many it found', /^14 examples$/.test(doc.getElementById('examplesWebStatus').textContent));
  await win.loadExample('web:dip_led');
  check('Its DIP to LED loads from the folder, not the built-in copy',
    fetched.some(f => f.url === RAW + 'asm/DIP_to_LED.asm') && /DIP/.test(editorText()));
  check('The folder is saved with the settings', JSON.parse(win.localStorage.getItem('rvsim.settings.v1')).examples.webUrl ===
    'https://github.com/someone/labs/tree/main/ex');

  field.value = 'https://github.com/someone/missing';
  field.dispatchEvent(new win.Event('change', { bubbles: true }));
  await until(() => win.exampleSources.web.status === 'error');
  await sleep(20);
  m = menu();
  const miss = 'GitHub: someone/missing';
  check('A folder that cannot be read shows why, as a disabled entry', JSON.stringify(m[miss]) === '["[unavailable: HTTP 404]"]', JSON.stringify(m));
  check('…and Settings says so too', /unavailable: HTTP 404/.test(doc.getElementById('examplesWebStatus').textContent));
  check('Built in is still there', m['Built in'].length === 1);
  win.resetCurrentSettingsTab();
  await until(() => win.exampleSources.web.status === 'ok');
  await sleep(20);
  check('Reset Defaults goes back to the site\'s examples', menu().Web && menu().Web.length === 7 && field.value === '');

  console.log('\n[3] A folder on this computer');
  await win.examplesFolderPicked([
    file('mylabs/lab1/answer.asm', 'main:\n  li a0, 42\n'),
    file('mylabs/lab2.s', 'main:\n  li a0, 7\n'),
    file('mylabs/sum.c', 'int main(void) { return 3; }\n'),
    file('mylabs/notes.md', 'not a program'),
  ]);
  await sleep(20);
  m = menu();
  check('With no index.txt, every .asm and .s file is listed by its path',
    JSON.stringify(m.mylabs) === '["lab1/answer","lab2"]', JSON.stringify(m));
  check('Settings names the folder and counts its programs',
    doc.getElementById('examplesFolderBtn').textContent === 'mylabs' &&
    /^3 examples$/.test(doc.getElementById('examplesLocalStatus').textContent));
  await win.loadExample('local:lab1/answer.asm');
  check('A program from it loads, under its own file name',
    /li a0, 42/.test(editorText()) && win.editorState.fileName === 'answer.asm' && win.program.assembled);
  win.setLanguageMode('c');
  check('In C mode it lists the C file', JSON.stringify(menu().mylabs) === '["sum"]');
  win.setLanguageMode('asm');

  const index = fs.readFileSync(path.join(EXAMPLES_ROOT, 'index.txt'), 'utf8');
  await win.examplesFolderPicked([
    file('course/index.txt', index),
    file('course/asm/fibonacci.asm', fs.readFileSync(path.join(EXAMPLES_ROOT, 'asm', 'fibonacci.asm'), 'utf8')),
    file('course/asm/stray.asm', 'main:\n'),
  ]);
  await sleep(20);
  m = menu();
  check('With an index.txt, its rows are the menu, as for the web', m.course && m.course.length === 8 && !m.course.includes('stray'));
  await win.loadExample('local:fib');
  check('A listed program loads, and its memory sizes are applied',
    /fibonacci/i.test(editorText()) && win.layout.codeSize === 0x200);
  win.clearLog();
  await win.loadExample('local:circle_accel');
  check('A listed program missing from the folder says so', /not in the folder course/.test(
    [...doc.querySelectorAll('#console div')].map(d => d.textContent).join('\n')));

  win.openSettingsModal('examples');
  doc.querySelector('#settingsContent-examples .hdl-file-x').click();
  await sleep(20);
  check('× forgets the folder, and its section goes', !menu().course && !win.exampleSources.folder);

  console.log('\n===========================================================');
  console.log(failed ? `💥 ${failed} EXAMPLE SOURCE TEST(S) FAILED (${passed} passed)` : `🎉 ALL ${passed} EXAMPLE SOURCE TESTS PASSED!`);
  console.log('===========================================================');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Example sources test failed:', e); process.exit(1); });
