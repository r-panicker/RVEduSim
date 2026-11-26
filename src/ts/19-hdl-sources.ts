// @ts-nocheck
// The Verilog sources the HDL engine compiles: files added by hand, the
// prebuilt core, a source folder that is read again on change, and the
// file list and Wrapper check.
function hdlAddFiles(fileList) {
  const pending = [];
  for (const file of fileList) {
    if (!/\.(v|sv|vh|svh)$/i.test(file.name)) {
      hdlLog('Skipped ' + file.name + ' (not a Verilog source)', 'warn');
      continue;
    }
    pending.push(file.text().then(src => ({ name: file.name, src })));
  }
  if (!pending.length) return Promise.resolve();
  return Promise.all(pending).then(loaded => {
    for (const f of loaded) {
      const existing = hdlFiles.findIndex(x => x.name === f.name);
      if (existing >= 0) hdlFiles[existing] = f; else hdlFiles.push(f);
    }
    renderHdlFileList();
    hdlLog('Loaded ' + loaded.length + ' file(s): ' + loaded.map(f => f.name).join(', '), 'sys');
  });
}

// The way in for someone whose own processor does not run yet: a
// pre-synthesised core plus the fixed Wrapper, replacing whatever is
// loaded. Fetched rather than baked into the page - it is only ever wanted
// deliberately, and the page is already ~1 MB.
const HDL_PREBUILT_FILES = ['Wrapper.v', 'RV_reference.v'];

async function hdlLoadPrebuiltProcessor() {
  const btn = document.getElementById('hdlPrebuiltBtn');
  if (btn) btn.disabled = true;
  try {
    hdlStatus('fetching the prebuilt processor …', 'busy');
    const loaded = await Promise.all(HDL_PREBUILT_FILES.map(async name => {
      const resp = await fetch('examples/hdl/' + name);
      if (!resp.ok) throw new Error(name + ' - HTTP ' + resp.status);
      return { name: name, src: await resp.text() };
    }));
    for (const f of loaded) if (/^\s*module\s+Wrapper\b/m.test(f.src)) f.isPrebuilt = true;
    hdlForgetFolder();
    hdlFiles = loaded;
    renderHdlFileList();
    hdlSyncReferenceWrapperDepths();
    hdlLog('Loaded the prebuilt processor: ' + loaded.map(f => f.name).join(', ') +
      '. It is pre-synthesised, so it will not tell you anything about how a ' +
      'processor is built - load your own sources when you have them.', 'sys');
    hdlStatus('prebuilt processor loaded', 'ok');
  } catch (e) {
    hdlLog('Could not load the prebuilt processor (' + e.message + '). It is fetched ' +
      'from examples/hdl/, so the page has to be served over http rather than ' +
      'opened as a file.', 'err');
    hdlStatus('prebuilt processor unavailable', 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function hdlRemoveFile(name) {
  const gone = hdlFiles.find(f => f.name === name);
  if (gone && gone.folderPath && hdlFolder) hdlFolder.excluded.add(gone.folderPath);
  hdlFiles = hdlFiles.filter(f => f.name !== name);
  renderHdlFileList();
}

function hdlClearFiles() {
  hdlForgetFolder();
  hdlFiles = [];
  renderHdlFileList();
  hdlLog('Cleared all Verilog sources.', 'sys');
}

// ================================================================
// A source folder
// ================================================================
// The folder is read again when the window regains focus and before each
// fresh run, so edits made in another editor are picked up. Three ways
// in: the desktop app's bridge (remembered across restarts), the File
// System Access API in Chromium (remembered, though a later visit may
// need the permission granted again), and elsewhere a one-off
// <input webkitdirectory> snapshot that is never re-read.
let hdlFolder = null;  // { kind: 'native'|'handle'|'snapshot', name, path, handle, pending, excluded }

// Vivado's output folders hold generated copies of the sources.
const HDL_FOLDER_SKIP = /^\.|\.(cache|runs|sim|hw|ip_user_files|gen)$|^(node_modules|xsim\.dir)$/;
const HDL_SOURCE_RE = /\.(v|sv|vh|svh)$/i;
const HDL_FOLDER_MAX = 500;

function hdlFolderMakeState(kind, name, extra) {
  return Object.assign({ kind, name, pending: false, excluded: new Set() }, extra);
}

async function hdlWalkHandle(dir, rel, out) {
  for await (const [name, entry] of dir.entries()) {
    if (out.length >= HDL_FOLDER_MAX) break;
    const r = rel ? rel + '/' + name : name;
    if (entry.kind === 'directory') {
      if (!HDL_FOLDER_SKIP.test(name)) await hdlWalkHandle(entry, r, out);
    } else if (HDL_SOURCE_RE.test(name)) {
      out.push({ path: r, src: await (await entry.getFile()).text() });
    }
  }
  return out;
}

// Of a folder's sources, the ones to load: every file declaring a module
// that sits under the Wrapper, so that a testbench or an old copy beside
// them does not become a second top level. Headers stay, since any of
// them may be included. With no Wrapper in the folder, everything stays.
function hdlFolderSelect(all) {
  const files = all.filter(f => !f.path.split('/').slice(0, -1).some(d => HDL_FOLDER_SKIP.test(d)))
    .sort((a, b) => a.path.localeCompare(b.path));
  const defs = new Map();
  const stripped = new Map();
  for (const f of files) {
    const src = hdlStripNoise(f.src);
    stripped.set(f, src);
    for (const m of src.matchAll(/\bmodule\s+([A-Za-z_]\w*)/g)) {
      if (!defs.has(m[1])) defs.set(m[1], []);
      defs.get(m[1]).push(f);
    }
  }
  if (!defs.has('Wrapper')) return { files, skipped: [], dups: [] };
  const reached = new Set(['Wrapper']);
  const queue = ['Wrapper'];
  while (queue.length) {
    const mod = queue.shift();
    for (const f of defs.get(mod)) {
      const src = stripped.get(f);
      const at = src.search(new RegExp('\\bmodule\\s+' + mod + '\\b'));
      const end = src.indexOf('endmodule', at);
      const body = src.slice(at, end < 0 ? src.length : end);
      for (const name of defs.keys()) {
        if (reached.has(name)) continue;
        if (new RegExp('\\b' + name + '\\s*(#|[A-Za-z_]\\w*\\s*[(\\[])').test(body)) {
          reached.add(name);
          queue.push(name);
        }
      }
    }
  }
  const keep = [], skipped = [];
  for (const f of files) {
    const mods = [...stripped.get(f).matchAll(/\bmodule\s+([A-Za-z_]\w*)/g)].map(m => m[1]);
    if (!mods.length || /\.(vh|svh)$/i.test(f.path) || mods.some(m => reached.has(m))) keep.push(f);
    else skipped.push(f);
  }
  const dups = [...reached].filter(m => defs.get(m).length > 1)
    .map(m => m + ' (' + defs.get(m).map(f => f.path).join(', ') + ')');
  return { files: keep, skipped, dups };
}

// Files are named by their base name, which is what error messages and
// the file list show; two of the same name in different subfolders get
// their paths instead.
function hdlFolderName(list) {
  const count = new Map();
  for (const f of list) {
    const base = f.path.split('/').pop();
    count.set(base, (count.get(base) || 0) + 1);
  }
  return list.map(f => {
    const base = f.path.split('/').pop();
    return { name: count.get(base) > 1 ? f.path.replace(/\//g, '__') : base, src: f.src, folderPath: f.path };
  });
}

// Puts a folder's sources in place of the folder files loaded before,
// keeping any file dropped in by hand, which also wins over a folder
// file of the same name. Returns whether anything changed.
function hdlApplyFolderFiles(list, first) {
  const f = hdlFolder;
  const sel = hdlFolderSelect(list.filter(x => !f.excluded.has(x.path)));
  const own = first ? [] : hdlFiles.filter(x => !x.folderPath);
  const incoming = hdlFolderName(sel.files).filter(x => !own.some(o => o.name === x.name));
  const before = hdlFiles.filter(x => x.folderPath);
  const same = before.length === incoming.length &&
    before.every((x, i) => x.name === incoming[i].name && x.src === incoming[i].src);
  if (same && !first) return false;
  hdlFiles = own.concat(incoming);
  renderHdlFileList();
  if (first) {
    hdlLog('Loaded ' + incoming.length + ' file(s) from the folder ' + f.name + ': ' +
      incoming.map(x => x.name).join(', '), 'sys');
  } else {
    const was = new Map(before.map(x => [x.name, x.src]));
    const changes = [];
    for (const x of incoming) {
      if (!was.has(x.name)) changes.push(x.name + ' added');
      else if (was.get(x.name) !== x.src) changes.push(x.name + ' changed');
      was.delete(x.name);
    }
    for (const name of was.keys()) changes.push(name + ' removed');
    hdlLog('Reloaded from ' + f.name + ': ' + changes.join(', '), 'sys');
  }
  if (sel.skipped.length && (first || !same)) {
    hdlLog('Left out ' + sel.skipped.length + ' file(s) that nothing under Wrapper instantiates: ' +
      sel.skipped.map(x => x.path).join(', '), 'sys');
  }
  if (sel.dups.length) {
    hdlLog('More than one file in ' + f.name + ' declares ' + sel.dups.join('; ') +
      '. Remove the copy that should not be compiled (×), or delete it from the folder.', 'warn');
  }
  if (!incoming.length) hdlLog('The folder ' + f.name + ' holds no Verilog sources.', 'warn');
  return true;
}

// Reads the folder again if there is one. A folder that has gone, or can
// no longer be read, leaves the loaded files as they were.
let hdlFolderReading = null;
function hdlReadFolder(first) {
  if (!hdlFolder || hdlFolder.pending || hdlFolder.kind === 'snapshot') return Promise.resolve(false);
  if (hdlFolderReading) return hdlFolderReading;
  const f = hdlFolder;
  hdlFolderReading = (async () => {
    try {
      let list;
      if (f.kind === 'native') {
        list = await window.rvNative.readFolder(f.path);
      } else {
        if ((await f.handle.queryPermission({ mode: 'read' })) !== 'granted') {
          f.pending = true;
          renderHdlFileList();
          return false;
        }
        list = await hdlWalkHandle(f.handle, '', []);
      }
      if (f !== hdlFolder) return false;
      return hdlApplyFolderFiles(list, first);
    } catch (e) {
      hdlLog('Could not read the folder ' + f.name + ' (' + (e && e.message || e) +
        '); the files loaded from it are unchanged.', 'warn');
      return false;
    } finally {
      hdlFolderReading = null;
    }
  })();
  return hdlFolderReading;
}

async function hdlPickFolder() {
  try {
    if (window.rvNative) {
      const dir = await window.rvNative.pickFolder();
      if (!dir) return;
      hdlFolder = hdlFolderMakeState('native', dir.split(/[\\/]/).filter(Boolean).pop() || dir, { path: dir });
    } else if (window.showDirectoryPicker) {
      if (hdlFolder && hdlFolder.pending) {
        if ((await hdlFolder.handle.requestPermission({ mode: 'read' })) !== 'granted') return;
        hdlFolder.pending = false;
      } else {
        const handle = await window.showDirectoryPicker({ id: 'hdl-sources', mode: 'read' });
        hdlFolder = hdlFolderMakeState('handle', handle.name, { handle });
        hdlFolderStore('put', handle).catch(() => {});
      }
    } else {
      document.getElementById('hdlFolderInput').click();
      return;
    }
    if (await hdlReadFolder(true) && simEngineMode !== 'hdl') setSimEngineMode('hdl');
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    hdlLog('Could not open the folder (' + (e && e.message || e) + ').', 'err');
  }
}

function hdlForgetFolder() {
  if (!hdlFolder) return;
  hdlFolder = null;
  if (window.rvNative) window.rvNative.forgetFolder();
  else hdlFolderStore('delete').catch(() => {});
  for (const f of hdlFiles) delete f.folderPath;
}

function hdlRenderFolderButton() {
  const btn = document.getElementById('hdlFolderBtn');
  if (!btn) return;
  const input = document.getElementById('hdlFolderInput');
  const can = window.rvNative || window.showDirectoryPicker || (input && 'webkitdirectory' in input);
  btn.style.display = can ? '' : 'none';
  if (hdlFolder && hdlFolder.pending) {
    btn.textContent = '↻ ' + hdlFolder.name;
    btn.title = 'Read the folder ' + hdlFolder.name + ' again. The browser asks for permission first.';
  } else {
    btn.textContent = 'folder…';
    btn.title = (window.rvNative || window.showDirectoryPicker)
      ? 'Load every Verilog file in a folder and its subfolders that sits under Wrapper. ' +
        'The folder is read again before each run, so edits made in another editor are picked up.'
      : 'Load every Verilog file in a folder and its subfolders that sits under Wrapper. ' +
        'This browser hands over a copy, so pick the folder again after editing.';
  }
}

// One IndexedDB record holds the browser's folder handle, which
// localStorage cannot store.
function hdlFolderStore(op, value) {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { resolve(null); return; }
    const open = indexedDB.open('rvsim', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const store = open.result.transaction('kv', op === 'get' ? 'readonly' : 'readwrite').objectStore('kv');
      const req = op === 'get' ? store.get('hdlFolder')
        : op === 'put' ? store.put(value, 'hdlFolder') : store.delete('hdlFolder');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

function hdlInitFolder() {
  const input = document.getElementById('hdlFolderInput');
  if (input) input.addEventListener('change', e => {
    const picked = Array.from(e.target.files || []);
    e.target.value = '';
    if (!picked.length) return;
    const root = (picked[0].webkitRelativePath || '').split('/')[0] || 'folder';
    Promise.all(picked
      .filter(f => HDL_SOURCE_RE.test(f.name))
      .slice(0, HDL_FOLDER_MAX)
      .map(f => f.text().then(src => ({ path: (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name, src }))))
      .then(list => {
        hdlForgetFolder();
        hdlFolder = hdlFolderMakeState('snapshot', root);
        hdlApplyFolderFiles(list, true);
        if (simEngineMode !== 'hdl') setSimEngineMode('hdl');
      });
  });
  window.addEventListener('focus', () => {
    if (hdlFolder && !hdlRunning) hdlReadFolder();
  });
  hdlRenderFolderButton();
  if (window.rvNative) {
    if (window.rvNative.rememberedFolder) {
      const dir = window.rvNative.rememberedFolder;
      hdlFolder = hdlFolderMakeState('native', dir.split(/[\\/]/).filter(Boolean).pop() || dir, { path: dir });
      hdlReadFolder(true);
    }
  } else if (window.showDirectoryPicker) {
    hdlFolderStore('get').then(handle => {
      if (!handle || hdlFolder || hdlFiles.length) return;
      hdlFolder = hdlFolderMakeState('handle', handle.name, { handle });
      hdlReadFolder(true);
    }).catch(() => {});
  }
}

// Which uploaded file declares `module Wrapper`? Everything hinges on
// it being present, since the generated testbench instantiates it.
function hdlFindWrapper() {
  return hdlFiles.find(f => /^\s*module\s+Wrapper\b/m.test(f.src)) || null;
}

function renderHdlFileList() {
  const el = document.getElementById('hdlFileList');
  if (!el) return;
  if (!hdlFiles.length) {
    el.innerHTML = '<div class="hdl-empty">No files loaded yet.</div>';
  } else {
    const wrapper = hdlFindWrapper();
    el.innerHTML = hdlFiles.map(f => {
      const isWrap = wrapper && f.name === wrapper.name;
      const kb = (f.src.length / 1024).toFixed(1);
      return '<div class="hdl-file' + (isWrap ? ' hdl-file-wrapper' : '') + '">' +
        '<span class="hdl-file-name">' + escapeHtml(f.name) + '</span>' +
        (isWrap ? '<span class="hdl-file-tag">Wrapper</span>' : '') +
        '<span class="hdl-file-size">' + kb + ' kB</span>' +
        '<button type="button" class="hdl-file-x" title="Remove this file" ' +
        'data-name="' + escapeHtml(f.name) + '" onclick="hdlRemoveFile(this.dataset.name)">&times;</button>' +
        '</div>';
    }).join('');
  }
  // The sources define both the compiled binary and where the register
  // file lives, so any change to them retires the current recording.
  hdlDiscardTrace();
  hdlRefreshRegPathHint();
  updateHdlReadiness();
  hdlReportLint(true);
  refreshDownloadMenu();
}

function updateHdlReadiness() {
  const wrapper = hdlFindWrapper();
  const warn = document.getElementById('hdlWrapperWarn');
  if (warn) warn.style.display = (hdlFiles.length && !wrapper) ? 'block' : 'none';

  // No panel shows the file list all the time, so this chip is the standing
  // answer to "is my Verilog loaded?". Clicking it opens the tab that does.
  const chip = document.getElementById('hdlFilesChip');
  if (chip) {
    chip.style.display = (simEngineMode === 'hdl') ? '' : 'none';
    // Two labels: the narrow row cannot hold the long one beside six other
    // controls, and CSS picks which is shown.
    const label = (long, short) =>
      '<span class="chip-long">' + long + '</span>' +
      '<span class="chip-short">' + short + '</span>';
    if (!hdlFiles.length) {
      chip.innerHTML = label('⚠ no Verilog', '⚠ no .v');
      chip.className = 'hdl-chip hdl-chip-warn';
      chip.title = 'HDL mode needs your processor sources - click to load them';
    } else if (!wrapper) {
      chip.innerHTML = label('⚠ no Wrapper', '⚠ no top');
      chip.className = 'hdl-chip hdl-chip-warn';
      chip.title = 'None of the ' + hdlFiles.length +
        ' loaded files declares `module Wrapper` - click to fix';
    } else {
      chip.innerHTML = label(hdlFiles.length + ' files', hdlFiles.length + ' files');
      chip.className = 'hdl-chip';
      chip.title = 'Loaded: ' + hdlFiles.map(f => f.name).join(', ') +
        ' - click to manage them';
    }
  }
  const note = document.getElementById('hdlSourcesNote');
  if (note) note.textContent = hdlFiles.length
    ? hdlFiles.length + ' loaded' + (hdlFolder && !hdlFolder.pending ? ' from ' + hdlFolder.name : '') +
      (wrapper ? ', Wrapper found' : ', no Wrapper')
    : 'none loaded';
  hdlRenderFolderButton();
  // The toolbar's Run/Step buttons gate on the same conditions, so they
  // have to be refreshed here too - loading the sources is exactly the
  // moment they become usable.
  if (typeof updateToolbarButtonStates === 'function') updateToolbarButtonStates();
}
