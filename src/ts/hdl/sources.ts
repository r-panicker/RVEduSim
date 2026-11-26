// The Verilog sources the HDL engine compiles: files added by hand, the
// prebuilt core, a source folder that is read again on change, and the
// file list and Wrapper check.

import { hdlLog, hdlStatus, hdlBridge } from './engine';
import { hdlReportLint } from './lint';
import { hdlSyncReferenceWrapperDepths } from './memory-images';
import { hdlDiscardTrace } from './run';
import { hdlActivity, hdlSources, type HdlFolder, type HdlSource } from './state';
import { hdlFindWrapper, hdlStripNoise } from './verilog';
import { ui } from '../machine/state';
import { setSimEngineMode } from '../ui/engine-mode';
import { refreshDownloadMenu } from '../ui/execution';
import { escapeHtml } from '../ui/panels';
import { updateToolbarButtonStates } from '../ui/run-control';
import { hdlRefreshRegPathHint } from '../ui/waveform';
import { byId } from '../ui/dom';
import { errorMessage } from '../errors';
export function hdlAddFiles(fileList: ArrayLike<File>) {
  const pending: Promise<HdlSource>[] = [];
  for (const file of Array.from(fileList)) {
    if (!/\.(v|sv|vh|svh)$/i.test(file.name)) {
      hdlLog('Skipped ' + file.name + ' (not a Verilog source)', 'warn');
      continue;
    }
    pending.push(file.text().then(src => ({ name: file.name, src })));
  }
  if (!pending.length) return Promise.resolve();
  return Promise.all(pending).then(loaded => {
    for (const f of loaded) {
      const existing = hdlSources.files.findIndex(x => x.name === f.name);
      if (existing >= 0) hdlSources.files[existing] = f; else hdlSources.files.push(f);
    }
    renderHdlFileList();
    hdlLog('Loaded ' + loaded.length + ' file(s): ' + loaded.map(f => f.name).join(', '), 'sys');
  });
}


// The way in for someone whose own processor does not run yet: a
// pre-synthesised core plus the fixed Wrapper, replacing whatever is
// loaded. Fetched rather than baked into the page - it is only ever wanted
// deliberately, and the page is already ~1 MB.
export const HDL_PREBUILT_FILES = ['Wrapper.v', 'RV_reference.v'];

export async function hdlLoadPrebuiltProcessor() {
  const btn = byId<HTMLButtonElement>('hdlPrebuiltBtn');
  if (btn) btn.disabled = true;
  try {
    hdlStatus('fetching the prebuilt processor …', 'busy');
    const loaded = await Promise.all(HDL_PREBUILT_FILES.map(async name => {
      const resp = await fetch('examples/hdl/' + name);
      if (!resp.ok) throw new Error(name + ' - HTTP ' + resp.status);
      const f: HdlSource = { name: name, src: await resp.text() };
      return f;
    }));
    for (const f of loaded) if (/^\s*module\s+Wrapper\b/m.test(f.src)) f.isPrebuilt = true;
    hdlForgetFolder();
    hdlSources.files = loaded;
    renderHdlFileList();
    hdlSyncReferenceWrapperDepths();
    hdlLog('Loaded the prebuilt processor: ' + loaded.map(f => f.name).join(', ') +
      '. It is pre-synthesised, so it will not tell you anything about how a ' +
      'processor is built - load your own sources when you have them.', 'sys');
    hdlStatus('prebuilt processor loaded', 'ok');
  } catch (e) {
    hdlLog('Could not load the prebuilt processor (' + errorMessage(e) + '). It is fetched ' +
      'from examples/hdl/, so the page has to be served over http rather than ' +
      'opened as a file.', 'err');
    hdlStatus('prebuilt processor unavailable', 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function hdlRemoveFile(name: string) {
  const gone = hdlSources.files.find(f => f.name === name);
  if (gone && gone.folderPath && hdlSources.folder) hdlSources.folder.excluded.add(gone.folderPath);
  hdlSources.files = hdlSources.files.filter(f => f.name !== name);
  renderHdlFileList();
}

export function hdlClearFiles() {
  hdlForgetFolder();
  hdlSources.files = [];
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

// Vivado's output folders hold generated copies of the sources.
export const HDL_FOLDER_SKIP = /^\.|\.(cache|runs|sim|hw|ip_user_files|gen)$|^(node_modules|xsim\.dir)$/;
export const HDL_SOURCE_RE = /\.(v|sv|vh|svh)$/i;
export const HDL_FOLDER_MAX = 500;

export function hdlFolderMakeState(kind: HdlFolder['kind'], name: string, extra?: { path?: string; handle?: DirHandle }): HdlFolder {
  return Object.assign({ kind, name, pending: false, excluded: new Set<string>() }, extra);
}

// A file of a source folder, by its path in the folder.
export interface FolderFile { path: string; src: string }

export async function hdlWalkHandle(dir: DirHandle, rel: string, out: FolderFile[]): Promise<FolderFile[]> {
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
export function hdlFolderSelect(all: FolderFile[]) {
  const files = all.filter(f => !f.path.split('/').slice(0, -1).some(d => HDL_FOLDER_SKIP.test(d)))
    .sort((a, b) => a.path.localeCompare(b.path));
  const defs = new Map<string, FolderFile[]>();
  const stripped = new Map<FolderFile, string>();
  for (const f of files) {
    const src = hdlStripNoise(f.src);
    stripped.set(f, src);
    for (const m of src.matchAll(/\bmodule\s+([A-Za-z_]\w*)/g)) {
      if (!defs.has(m[1])) defs.set(m[1], []);
      defs.get(m[1])!.push(f);
    }
  }
  if (!defs.has('Wrapper')) return { files, skipped: [] as FolderFile[], dups: [] as string[] };
  const reached = new Set(['Wrapper']);
  const queue = ['Wrapper'];
  while (queue.length) {
    const mod = queue.shift()!;
    for (const f of defs.get(mod) ?? []) {
      const src = stripped.get(f) ?? '';
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
  const keep: FolderFile[] = [], skipped: FolderFile[] = [];
  for (const f of files) {
    const mods = [...(stripped.get(f) ?? '').matchAll(/\bmodule\s+([A-Za-z_]\w*)/g)].map(m => m[1]);
    if (!mods.length || /\.(vh|svh)$/i.test(f.path) || mods.some(m => reached.has(m))) keep.push(f);
    else skipped.push(f);
  }
  const dups = [...reached].filter(m => (defs.get(m) ?? []).length > 1)
    .map(m => m + ' (' + (defs.get(m) ?? []).map(f => f.path).join(', ') + ')');
  return { files: keep, skipped, dups };
}

// Files are named by their base name, which is what error messages and
// the file list show; two of the same name in different subfolders get
// their paths instead.
export function hdlFolderName(list: FolderFile[]): HdlSource[] {
  const count = new Map<string, number>();
  for (const f of list) {
    const base = f.path.split('/').pop() ?? f.path;
    count.set(base, (count.get(base) || 0) + 1);
  }
  return list.map(f => {
    const base = f.path.split('/').pop() ?? f.path;
    return { name: (count.get(base) ?? 0) > 1 ? f.path.replace(/\//g, '__') : base, src: f.src, folderPath: f.path };
  });
}

// Puts a folder's sources in place of the folder files loaded before,
// keeping any file dropped in by hand, which also wins over a folder
// file of the same name. Returns whether anything changed.
export function hdlApplyFolderFiles(list: FolderFile[], first: boolean) {
  const f = hdlSources.folder;
  if (!f) return false;
  const sel = hdlFolderSelect(list.filter(x => !f.excluded.has(x.path)));
  const own = first ? [] : hdlSources.files.filter(x => !x.folderPath);
  const incoming = hdlFolderName(sel.files).filter(x => !own.some(o => o.name === x.name));
  const before = hdlSources.files.filter(x => x.folderPath);
  const same = before.length === incoming.length &&
    before.every((x, i) => x.name === incoming[i].name && x.src === incoming[i].src);
  if (same && !first) return false;
  hdlSources.files = own.concat(incoming);
  renderHdlFileList();
  if (first) {
    hdlLog('Loaded ' + incoming.length + ' file(s) from the folder ' + f.name + ': ' +
      incoming.map(x => x.name).join(', '), 'sys');
  } else {
    const was = new Map(before.map(x => [x.name, x.src]));
    const changes: string[] = [];
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
export function hdlReadFolder(first = false): Promise<boolean> {
  if (!hdlSources.folder || hdlSources.folder.pending || hdlSources.folder.kind === 'snapshot') return Promise.resolve(false);
  if (hdlSources.folderReading) return hdlSources.folderReading;
  const f = hdlSources.folder;
  hdlSources.folderReading = (async () => {
    try {
      let list: FolderFile[];
      if (f.kind === 'native') {
        list = await hdlBridge().readFolder(f.path ?? '');
      } else {
        const handle = f.handle;
        if (!handle) return false;
        if ((await handle.queryPermission({ mode: 'read' })) !== 'granted') {
          f.pending = true;
          renderHdlFileList();
          return false;
        }
        list = await hdlWalkHandle(handle, '', []);
      }
      if (f !== hdlSources.folder) return false;
      return hdlApplyFolderFiles(list, first);
    } catch (e) {
      hdlLog('Could not read the folder ' + f.name + ' (' + errorMessage(e) +
        '); the files loaded from it are unchanged.', 'warn');
      return false;
    } finally {
      hdlSources.folderReading = null;
    }
  })();
  return hdlSources.folderReading;
}

export async function hdlPickFolder() {
  try {
    if (window.rvNative) {
      const dir = await window.rvNative.pickFolder();
      if (!dir) return;
      hdlSources.folder = hdlFolderMakeState('native', dir.split(/[\\/]/).filter(Boolean).pop() || dir, { path: dir });
    } else if (window.showDirectoryPicker) {
      const folder = hdlSources.folder;
      if (folder && folder.pending) {
        if (!folder.handle || (await folder.handle.requestPermission({ mode: 'read' })) !== 'granted') return;
        folder.pending = false;
      } else {
        const handle = await window.showDirectoryPicker({ id: 'hdl-sources', mode: 'read' });
        hdlSources.folder = hdlFolderMakeState('handle', handle.name, { handle });
        hdlFolderStore('put', handle).catch(() => {});
      }
    } else {
      byId<HTMLInputElement>('hdlFolderInput').click();
      return;
    }
    if (await hdlReadFolder(true) && ui.engine !== 'hdl') setSimEngineMode('hdl');
  } catch (e) {
    if ((e as Error | null)?.name === 'AbortError') return;
    hdlLog('Could not open the folder (' + errorMessage(e) + ').', 'err');
  }
}

export function hdlForgetFolder() {
  if (!hdlSources.folder) return;
  hdlSources.folder = null;
  if (window.rvNative) window.rvNative.forgetFolder();
  else hdlFolderStore('delete').catch(() => {});
  for (const f of hdlSources.files) delete f.folderPath;
}

export function hdlRenderFolderButton() {
  const btn = byId<HTMLButtonElement>('hdlFolderBtn');
  if (!btn) return;
  const input = byId<HTMLInputElement>('hdlFolderInput');
  const can = window.rvNative || window.showDirectoryPicker || (input && 'webkitdirectory' in input);
  btn.style.display = can ? '' : 'none';
  if (hdlSources.folder && hdlSources.folder.pending) {
    btn.textContent = '↻ ' + hdlSources.folder.name;
    btn.title = 'Read the folder ' + hdlSources.folder.name + ' again. The browser asks for permission first.';
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
export function hdlFolderStore(op: 'get' | 'put' | 'delete', value?: unknown) {
  return new Promise<unknown>((resolve, reject) => {
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

export function hdlInitFolder() {
  const input = byId<HTMLInputElement>('hdlFolderInput');
  if (input) input.addEventListener('change', () => {
    const picked = Array.from(input.files || []);
    input.value = '';
    if (!picked.length) return;
    const root = (picked[0].webkitRelativePath || '').split('/')[0] || 'folder';
    Promise.all(picked
      .filter(f => HDL_SOURCE_RE.test(f.name))
      .slice(0, HDL_FOLDER_MAX)
      .map(f => f.text().then(src => ({ path: (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name, src }))))
      .then(list => {
        hdlForgetFolder();
        hdlSources.folder = hdlFolderMakeState('snapshot', root);
        hdlApplyFolderFiles(list, true);
        if (ui.engine !== 'hdl') setSimEngineMode('hdl');
      });
  });
  window.addEventListener('focus', () => {
    if (hdlSources.folder && !hdlActivity.running) hdlReadFolder();
  });
  hdlRenderFolderButton();
  if (window.rvNative) {
    if (window.rvNative.rememberedFolder) {
      const dir = window.rvNative.rememberedFolder;
      hdlSources.folder = hdlFolderMakeState('native', dir.split(/[\\/]/).filter(Boolean).pop() || dir, { path: dir });
      hdlReadFolder(true);
    }
  } else if (window.showDirectoryPicker) {
    hdlFolderStore('get').then(stored => {
      const handle = stored as DirHandle | undefined;
      if (!handle || hdlSources.folder || hdlSources.files.length) return;
      hdlSources.folder = hdlFolderMakeState('handle', handle.name, { handle });
      hdlReadFolder(true);
    }).catch(() => {});
  }
}

export function renderHdlFileList() {
  const el = byId('hdlFileList');
  if (!el) return;
  if (!hdlSources.files.length) {
    el.innerHTML = '<div class="hdl-empty">No files loaded yet.</div>';
  } else {
    const wrapper = hdlFindWrapper();
    el.innerHTML = hdlSources.files.map(f => {
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

export function updateHdlReadiness() {
  const wrapper = hdlFindWrapper();
  const warn = byId('hdlWrapperWarn');
  if (warn) warn.style.display = (hdlSources.files.length && !wrapper) ? 'block' : 'none';

  // No panel shows the file list all the time, so this chip is the standing
  // answer to "is my Verilog loaded?". Clicking it opens the tab that does.
  const chip = byId<HTMLButtonElement>('hdlFilesChip');
  if (chip) {
    chip.style.display = (ui.engine === 'hdl') ? '' : 'none';
    // Two labels: the narrow row cannot hold the long one beside six other
    // controls, and CSS picks which is shown.
    const label = (long: string, short: string) =>
      '<span class="chip-long">' + long + '</span>' +
      '<span class="chip-short">' + short + '</span>';
    if (!hdlSources.files.length) {
      chip.innerHTML = label('⚠ no Verilog', '⚠ no .v');
      chip.className = 'hdl-chip hdl-chip-warn';
      chip.title = 'HDL mode needs your processor sources - click to load them';
    } else if (!wrapper) {
      chip.innerHTML = label('⚠ no Wrapper', '⚠ no top');
      chip.className = 'hdl-chip hdl-chip-warn';
      chip.title = 'None of the ' + hdlSources.files.length +
        ' loaded files declares `module Wrapper` - click to fix';
    } else {
      chip.innerHTML = label(hdlSources.files.length + ' files', hdlSources.files.length + ' files');
      chip.className = 'hdl-chip';
      chip.title = 'Loaded: ' + hdlSources.files.map(f => f.name).join(', ') +
        ' - click to manage them';
    }
  }
  const note = byId('hdlSourcesNote');
  if (note) note.textContent = hdlSources.files.length
    ? hdlSources.files.length + ' loaded' + (hdlSources.folder && !hdlSources.folder.pending ? ' from ' + hdlSources.folder.name : '') +
      (wrapper ? ', Wrapper found' : ', no Wrapper')
    : 'none loaded';
  hdlRenderFolderButton();
  // The toolbar's Run/Step buttons gate on the same conditions, so they
  // have to be refreshed here too - loading the sources is exactly the
  // moment they become usable.
  if (typeof updateToolbarButtonStates === 'function') updateToolbarButtonStates();
}
