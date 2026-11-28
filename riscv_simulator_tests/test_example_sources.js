// test_example_sources.js
// The Example menu's sources: built in, any number of web folders (the
// site's own examples/ and the CG3207 lecture examples by default, more
// added in Settings), and any number of folders on this computer, with or
// without an index.txt. Each is a section of the menu; one that cannot be
// read shows why instead of an example.

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

// raw.githubusercontent.com: a GitHub folder served from the repository's
// own examples/, and the lecture examples' folder from a stand-in; every
// other URL there is a 404.
const RAW = 'https://raw.githubusercontent.com/someone/labs/main/ex/';
const LECTURE_RAW = 'https://raw.githubusercontent.com/NUS-CG3207/nus-cg3207.github.io/main/docs/miscellaneous/LectureExamples/';
const LECTURE = {
  'index.txt': '| Key | Lang | Label | File | IROM | DMEM | Description |\n|-----|------|-------|------|------|------|------|\n' +
    '| week6sample | asm | Week 6 Sample | Week6Sample.asm | 9 | 9 | Load a word |\n' +
    '| week6quiz | asm | Week 6 Quiz | Week6Quiz.asm | 9 | 9 | A loop over four words |\n' +
    '| week11sample | asm | Week 11 Sample | Week11Sample.asm | 9 | 9 | Branch prediction |\n',
  'asm/Week6Sample.asm': 'main:\n  # week 6 sample\n  li a0, 6\n',
};
const fetched = [];
function installGitHubFetch(win) {
  const inner = win.fetch;
  win.fetch = async (url, opts) => {
    url = String(url);
    fetched.push({ url, cache: opts && opts.cache });
    const ok = text => ({ ok: true, status: 200, text: async () => text });
    const missing = { ok: false, status: 404, text: async () => '' };
    if (url.startsWith(LECTURE_RAW)) { const t = LECTURE[url.slice(LECTURE_RAW.length)]; return t === undefined ? missing : ok(t); }
    if (url.startsWith(RAW)) {
      try { return ok(fs.readFileSync(path.join(EXAMPLES_ROOT, url.slice(RAW.length)), 'utf8')); } catch (e) { return missing; }
    }
    if (/^https:/.test(url)) return missing;
    return inner(url, opts);
  };
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
      installGitHubFetch(window);
    }
  });
  return dom.window;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) return false; await sleep(20); }
  return true;
}
// The menu as its sections: { heading: [labels] }, a disabled entry in [].
const menuOf = doc => {
  const out = {};
  for (const n of doc.getElementById('exampleSelect').children) {
    if (n.tagName === 'OPTGROUP') out[n.label] = [...n.children].map(o => o.disabled ? '[' + o.textContent + ']' : o.textContent);
    else out['>'] = (out['>'] || []).concat(n.textContent);
  }
  return out;
};
// A file as <input webkitdirectory> hands it over.
const file = (rel, text) => ({ name: rel.split('/').pop(), webkitRelativePath: rel, text: async () => text });

(async () => {
  console.log('===========================================================');
  console.log('📚 EXAMPLE SOURCES');
  console.log('===========================================================');
  const win = page(), doc = win.document;
  const menu = () => menuOf(doc);
  const editorText = () => win.editor.value;
  await until(() => doc.body.dataset.booted === '1');
  await win.exampleIndexReady;
  await sleep(50);

  console.log('\n[1] The default menu');
  let m = menu();
  check('Built in holds DIP to LED alone', JSON.stringify(m['Built in']) === '["DIP to LED (start here)"]', JSON.stringify(m));
  check('RVEduSim lists the site\'s examples (' + (m.RVEduSim || []).length + '), without a second DIP to LED or Week 11',
    m.RVEduSim && m.RVEduSim.length === 6 && m.RVEduSim.includes('Fibonacci') && !m.RVEduSim.some(l => /DIP|Week 11/.test(l)));
  check('LectureExamples is there by default, with its examples', JSON.stringify(m.LectureExamples) === '["Week 6 Sample","Week 6 Quiz","Week 11 Sample"]',
    JSON.stringify(m.LectureExamples));
  check('No folder section until a folder is added', Object.keys(m).length === 4, Object.keys(m).join(', '));
  check('The last entry opens the sources', JSON.stringify(m['>']) === '["Example sources…"]');
  check('Each index is fetched past the browser\'s cache',
    fetched.some(f => /examples\/index\.txt$/.test(f.url) && f.cache === 'no-cache') &&
    fetched.some(f => f.url === LECTURE_RAW + 'index.txt' && f.cache === 'no-cache'));
  await win.loadExample('fib');
  check('A site example loads, and the menu shows it', /fibonacci/i.test(editorText()) && doc.getElementById('exampleSelect').value === 'fib');
  const lectureKey = win.exampleEntries().find(e => e.label === 'Week 6 Sample').key;
  await win.loadExample(lectureKey);
  check('A lecture example loads from its folder (' + lectureKey + ')', /week 6 sample/.test(editorText()) &&
    fetched.some(f => f.url === LECTURE_RAW + 'asm/Week6Sample.asm'));
  const sel = doc.getElementById('exampleSelect');
  sel.value = '__sources';
  sel.dispatchEvent(new win.Event('change', { bubbles: true }));
  check('Choosing Example sources… opens Settings → Examples and keeps the example selected',
    win.settingsModel.open && win.settingsModel.tab === 'examples' && sel.value === lectureKey);
  check('Settings lists both web folders, each with its count',
    [...doc.querySelectorAll('#examplesWeb .ex-source')].map(r => r.textContent.replace(/\s+/g, ' ').trim()).join(' | ') ===
      'RVEduSim 11 examples × | LectureExamples 3 examples ×');
  win.closeSettingsModal();
  win.setLanguageMode('c');
  m = menu();
  check('In C mode each section lists its C programs', m['Built in'].length === 1 && m.RVEduSim.length === 5 &&
    JSON.stringify(m.LectureExamples) === '["[no C programs]"]', JSON.stringify(m));
  win.setLanguageMode('asm');

  console.log('\n[2] Adding and removing web folders');
  const url = win.examplesBaseUrl;
  check('A tree URL is read through raw.githubusercontent.com', url('https://github.com/someone/labs/tree/main/ex') === RAW);
  check('…as is a repository with no branch (HEAD), and a link to index.txt',
    url('https://github.com/a/b') === 'https://raw.githubusercontent.com/a/b/HEAD/' &&
    url('https://github.com/a/b/blob/dev/x/y/index.txt') === 'https://raw.githubusercontent.com/a/b/dev/x/y/');
  check('Any other https folder is taken as it is; text that is not a URL is refused',
    url('https://example.org/ex') === 'https://example.org/ex/' && url('labs folder') === null);
  win.openSettingsModal('examples');
  const add = doc.getElementById('examplesWebAdd'), addBtn = doc.getElementById('examplesWebAddBtn');
  const type = async (text) => { add.value = text; add.dispatchEvent(new win.Event('input', { bubbles: true })); addBtn.click(); await sleep(10); };
  await type('labs folder');
  check('Text that is not a URL is not added, and says so', /not a URL/.test((doc.getElementById('examplesWebAddError') || {}).textContent || '') &&
    win.exampleSources.web.length === 2);
  await type('https://github.com/someone/labs/tree/main/ex');
  await until(() => win.exampleSources.web.length === 3 && win.exampleSources.web[2].state.status === 'ok');
  await sleep(20);
  m = menu();
  check('An added folder is a section of its own, named after the folder, with its own DIP to LED',
    m.ex && m.ex.length === 7 && m.ex.includes('DIP to LED (start here)') && m.RVEduSim && m.LectureExamples, JSON.stringify(m));
  check('…and the field is cleared for the next', add.value === '' && !doc.getElementById('examplesWebAddError'));
  await type('https://github.com/someone/labs/tree/main/ex/');
  check('The same folder again is refused', /already listed/.test((doc.getElementById('examplesWebAddError') || {}).textContent || ''));
  const exKey = win.exampleEntries().find(e => e.sourceId === win.exampleSources.web[2].id && e.label === 'DIP to LED (start here)').key;
  await win.loadExample(exKey);
  check('Its DIP to LED loads from the folder, not the built-in copy (' + exKey + ')',
    fetched.some(f => f.url === RAW + 'asm/DIP_to_LED.asm') && /DIP/.test(editorText()));
  await sleep(20);
  const savedWeb = JSON.parse(win.localStorage.getItem('rvsim.settings.v1')).examples.web;
  check('The list is saved with the settings', JSON.stringify(savedWeb) ===
    JSON.stringify(['', 'https://github.com/NUS-CG3207/nus-cg3207.github.io/tree/main/docs/miscellaneous/LectureExamples',
                    'https://github.com/someone/labs/tree/main/ex']), JSON.stringify(savedWeb));

  await type('https://github.com/someone/missing');
  await until(() => win.exampleSources.web.length === 4 && win.exampleSources.web[3].state.status === 'error');
  await sleep(20);
  m = menu();
  check('A folder that cannot be read shows why, as a disabled entry', JSON.stringify(m.missing) === '["[unavailable: HTTP 404]"]', JSON.stringify(m));
  check('…and Settings says so too', /unavailable: HTTP 404/.test(doc.querySelector('#examplesWeb .ex-source:last-of-type, #examplesWeb [data-source="' +
    win.exampleSources.web[3].id + '"]').textContent));
  doc.querySelector('#examplesWeb [data-source="' + win.exampleSources.web[0].id + '"] .hdl-file-x').click();
  await sleep(20);
  m = menu();
  check('× removes a folder, the site\'s own too, and its section goes', !m.RVEduSim && m.LectureExamples && m.ex && m.missing,
    Object.keys(m).join(', '));
  win.resetCurrentSettingsTab();
  await until(() => win.exampleSources.web.every(s => s.state.status === 'ok'));
  await sleep(20);
  m = menu();
  check('Reset Tab goes back to the two defaults', Object.keys(m).join(', ') === 'Built in, RVEduSim, LectureExamples, >', Object.keys(m).join(', '));

  console.log('\n[3] Folders on this computer');
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
  const index = fs.readFileSync(path.join(EXAMPLES_ROOT, 'index.txt'), 'utf8');
  await win.examplesFolderPicked([
    file('course/index.txt', index),
    file('course/asm/fibonacci.asm', fs.readFileSync(path.join(EXAMPLES_ROOT, 'asm', 'fibonacci.asm'), 'utf8')),
    file('course/asm/stray.asm', 'main:\n'),
  ]);
  await sleep(20);
  m = menu();
  check('A second folder is a section of its own beside the first', m.mylabs && m.course, Object.keys(m).join(', '));
  check('With an index.txt, its rows are the menu, as for the web', m.course.length === 7 && !m.course.includes('stray'), JSON.stringify(m.course));
  win.openSettingsModal('examples');
  check('Settings lists both folders with their counts',
    [...doc.querySelectorAll('#examplesLocal .ex-source')].map(r => r.textContent.replace(/\s+/g, ' ').trim()).join(' | ') ===
      'mylabs 3 examples × | course 13 examples ×',
    [...doc.querySelectorAll('#examplesLocal .ex-source')].map(r => r.textContent.replace(/\s+/g, ' ').trim()).join(' | '));
  const [mine, course] = win.exampleSources.local;
  await win.loadExample(mine.id + ':lab1/answer.asm');
  check('A program from the first loads, under its own file name',
    /li a0, 42/.test(editorText()) && win.editorState.fileName === 'answer.asm' && win.program.assembled);
  await win.loadExample(course.id + ':fib');
  check('A listed program from the second loads, and its memory sizes are applied', /fibonacci/i.test(editorText()) && win.layout.codeSize === 0x200);
  win.clearLog();
  await win.loadExample(course.id + ':circle_accel');
  check('A listed program missing from the folder says so', /not in the folder course/.test(
    [...doc.querySelectorAll('#console div')].map(d => d.textContent).join('\n')));
  doc.querySelector('#examplesLocal [data-source="' + mine.id + '"] .hdl-file-x').click();
  await sleep(20);
  m = menu();
  check('× forgets one folder, and only its section goes', !m.mylabs && m.course && win.exampleSources.local.length === 1);
  win.resetCurrentSettingsTab();
  await sleep(20);
  check('Reset Tab forgets the folders', !menu().course && !win.exampleSources.local.length);

  console.log('\n[4] Settings saved with one web folder');
  const old = page({ 'rvsim.settings.v1': JSON.stringify({ examples: { webUrl: 'https://github.com/someone/labs/tree/main/ex' } }) });
  await until(() => old.document.body.dataset.booted === '1');
  await old.exampleIndexReady;
  await sleep(50);
  check('come back as the defaults and that folder', Object.keys(menuOf(old.document)).join(', ') === 'Built in, RVEduSim, LectureExamples, ex, >',
    Object.keys(menuOf(old.document)).join(', '));

  console.log('\n===========================================================');
  console.log(failed ? `💥 ${failed} EXAMPLE SOURCE TEST(S) FAILED (${passed} passed)` : `🎉 ALL ${passed} EXAMPLE SOURCE TESTS PASSED!`);
  console.log('===========================================================');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Example sources test failed:', e); process.exit(1); });
