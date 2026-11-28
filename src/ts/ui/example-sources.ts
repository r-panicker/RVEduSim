// Where the Example menu's programs come from: any number of sources, all
// at once, each a section of the menu:
//   - built in: DIP to LED in each language, part of the page, so there is
//     always a program to open, offline or from file://;
//   - web folders laid out as examples/ is (index.txt, asm/, c/): by
//     default the site's own examples/ (the RVEduSim site's, in the desktop
//     app) and the CG3207 lecture examples; in Settings, any GitHub folder
//     or https URL;
//   - folders on this computer, read as the HDL source folder is
//     (hdl/sources.ts): through the desktop app, a File System Access
//     handle, or a one-off <input webkitdirectory> copy. With no index.txt,
//     every .asm, .s and .c file in one is listed under its own name.
// Nothing is cached: each is read afresh when the page starts, when it is
// added, and (a folder) when the window regains focus, and an example's
// file is fetched when it is selected.

import { hdlFolderStore } from '../hdl/sources';
import { errorMessage } from '../errors';
import { redraw } from './views.svelte';

export type ExampleLang = 'asm' | 'c';
export interface ExampleEntry {
  key: string; source: 'builtin' | 'web' | 'local'; sourceId: string; lang: ExampleLang;
  label: string; desc: string;
  file: string;                                   // the path in its source
  depths?: { irom: number; dmem: number };        // from index.txt
}
// A source's state, as the menu and Settings show it.
export interface ExampleSourceState {
  status: 'idle' | 'loading' | 'ok' | 'error';
  error: string;                                  // why it could not be read
  entries: ExampleEntry[];
}
export interface ExampleFolder {
  kind: 'native' | 'handle' | 'snapshot'; name: string;
  pending: boolean;                               // the browser wants permission again
  path?: string; handle?: DirHandle;
  files?: { path: string; src: string }[];        // a snapshot's copy
}
// url '' is the site's own examples.
export interface WebSource { id: string; url: string; state: ExampleSourceState; token: number }
export interface LocalSource {
  id: string; folder: ExampleFolder; state: ExampleSourceState;
  files: Map<string, string>;                     // the folder's files at its last read
  reading: Promise<boolean> | null;
}

export const DEFAULT_WEB_EXAMPLES = 'https://r-panicker.github.io/RVEduSim/examples/';
export const LECTURE_EXAMPLES = 'https://github.com/NUS-CG3207/nus-cg3207.github.io/tree/main/docs/miscellaneous/LectureExamples';
export const DEFAULT_WEB_SOURCES = ['', LECTURE_EXAMPLES];
export const DEFAULT_DEPTH_BITS = 9;
const EXAMPLE_FILE_RE = /\.(asm|s|c)$/i;
const FOLDER_MAX = 500;
const FOLDERS_KEY = 'examplesFolders';            // the browser's folder handles, in IndexedDB

export const BUILTIN_EXAMPLES: ExampleEntry[] = [
  { key: 'dip_led', source: 'builtin', sourceId: 'builtin', lang: 'asm', label: 'DIP to LED (start here)', file: 'asm/DIP_to_LED.asm',
    desc: 'DIP switches mirrored to LEDs, built into the page', depths: { irom: 9, dmem: 9 } },
  { key: 'dip_led_c', source: 'builtin', sourceId: 'builtin', lang: 'c', label: 'DIP to LED (start here)', file: 'c/DIP_to_LED.c',
    desc: 'DIP switches mirrored to LEDs, built into the page', depths: { irom: 9, dmem: 9 } },
];

// webUrls: the web folders asked for, read when the page starts (the saved
// settings set it before that).
export const exampleSources = {
  webUrls: DEFAULT_WEB_SOURCES.slice(),
  web: [] as WebSource[],
  local: [] as LocalSource[],
};
let nextId = 1;

// What the menu and Settings redraw from; set by examples-language.ts.
let onChange: () => void = () => {};
export function onExampleSourcesChange(fn: () => void) { onChange = fn; }
function changed() { onChange(); redraw('settings'); }

// ---- index.txt -------------------------------------------------------
// `| key | lang | label | file | irom | dmem | description |` rows; the first
// all-dashes row (markdown's alignment row) marks where they start, so a
// row before it is a header whatever it says.
export type ExampleRow = [string, string, string, string, number, number, string];
export function parseExampleIndexMarkdown(text: string) {
  const rows: ExampleRow[] = [];
  let dataStarted = false;
  for (let line of String(text || '').split('\n')) {
    line = line.trim();
    if (!line.startsWith('|')) continue;
    line = line.slice(1);
    if (line.endsWith('|')) line = line.slice(0, -1);
    const cells = line.split('|').map(c => c.trim());
    if (!dataStarted) {
      if (cells.length && cells.every(c => /^:?-+:?$/.test(c))) dataStarted = true;
      continue;
    }
    if (cells.length < 7 || !cells[0]) continue;
    const bits = (c: string) => {
      const n = parseInt(c, 10);
      return (Number.isFinite(n) && n >= 2 && n <= 30) ? n : DEFAULT_DEPTH_BITS;
    };
    rows.push([cells[0], cells[1], cells[2], cells[3], bits(cells[4]), bits(cells[5]), cells.slice(6).join(' | ')]);
  }
  return rows;
}

function entriesFromIndex(text: string, source: 'web' | 'local', sourceId: string, keyOf: (key: string) => string): ExampleEntry[] {
  return parseExampleIndexMarkdown(text).map(([key, lang, label, file, irom, dmem, desc]) => {
    const l: ExampleLang = lang === 'c' ? 'c' : 'asm';
    return { key: keyOf(key), source, sourceId, lang: l, label, desc, file: l + '/' + file, depths: { irom, dmem } };
  });
}

// ---- Web folders -------------------------------------------------------
// A github.com folder is read through raw.githubusercontent.com, which
// serves the files themselves (with CORS); any other http(s) URL is taken
// as the folder. null: not a URL this can read.
export function examplesBaseUrl(url: string): string | null {
  const t = url.trim();
  const gh = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/\s]+)(\/[^\s]*)?)?\/?$/.exec(t);
  if (gh) {
    const path = (gh[4] || '').replace(/\/index\.txt$/, '').replace(/^\/+|\/+$/g, '');
    return 'https://raw.githubusercontent.com/' + gh[1] + '/' + gh[2] + '/' + (gh[3] || 'HEAD') + '/' + (path ? path + '/' : '');
  }
  if (!/^https?:\/\/[^/\s]+/.test(t)) return null;
  return t.replace(/\/index\.txt$/, '').replace(/\/*$/, '/');
}

// The site's own is the page's examples/, except in the desktop app, which
// carries none and reads the site's.
export function webBase(url: string) {
  if (url) return examplesBaseUrl(url);
  return window.rvNative ? DEFAULT_WEB_EXAMPLES : 'examples/';
}

// A web folder's heading: RVEduSim for the site's own, else the folder's
// name (a GitHub folder's last part, or the repository) or the host.
export function webSourceName(url: string) {
  if (!url) return 'RVEduSim';
  const base = webBase(url);
  if (!base) return url;
  const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/[^/]+\/(.*)$/.exec(base);
  if (raw) return raw[3].replace(/\/$/, '').split('/').pop() || raw[2];
  try {
    const u = new URL(base);
    return u.pathname.replace(/\/$/, '').split('/').pop() || u.host;
  } catch (e) { return url; }
}

const isBuiltinKey = (k: string) => BUILTIN_EXAMPLES.some(b => b.key === k);

// Fetched without the browser's cache, so an edit to the folder shows on
// the next read rather than whenever the cache expires.
async function fetchText(url: string) {
  const resp = await fetch(url, { cache: 'no-cache' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return resp.text();
}
function fetchFailure(e: unknown) {
  const m = errorMessage(e);
  return /^HTTP /.test(m) ? m : (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'offline' : 'could not be reached';
}

async function loadWebSource(src: WebSource) {
  const my = ++src.token;
  const base = webBase(src.url);
  if (!base) {
    src.state = { status: 'error', error: 'not a URL', entries: [] };
    changed();
    return;
  }
  src.state = { status: 'loading', error: '', entries: src.state.entries };
  changed();
  let next: ExampleSourceState;
  try {
    const text = await fetchText(base + 'index.txt');
    // The site's index lists the built-in examples too; they are shown
    // once, under Built in. Another folder's examples are its own, keyed
    // by the source, so two folders can use the same key.
    const entries = entriesFromIndex(text, 'web', src.id, k => src.url ? src.id + ':' + k : isBuiltinKey(k) ? '' : k)
      .filter(e => e.key);
    next = entries.length ? { status: 'ok', error: '', entries }
      : { status: 'error', error: 'index.txt lists no examples', entries: [] };
  } catch (e) {
    next = { status: 'error', error: fetchFailure(e), entries: [] };
  }
  if (my !== src.token || !exampleSources.web.includes(src)) return;
  src.state = next;
  changed();
}

function newWebSource(url: string): WebSource {
  return { id: url ? 'w' + nextId++ : 'web', url, state: { status: 'idle', error: '', entries: [] }, token: 0 };
}

// Replaces the web folders (at start-up, and Reset Tab).
export function setWebSources(urls: string[]) {
  exampleSources.webUrls = urls.slice();
  exampleSources.web = urls.map(newWebSource);
  changed();
  for (const s of exampleSources.web) loadWebSource(s);
}

// Adds a web folder. Returns why it was not added, or ''.
export function addWebSource(url: string) {
  const t = url.trim();
  if (!t) return 'type a URL';
  if (!examplesBaseUrl(t)) return 'not a URL';
  const base = webBase(t);
  if (exampleSources.web.some(s => webBase(s.url) === base)) return 'already listed';
  const src = newWebSource(t);
  exampleSources.web.push(src);
  exampleSources.webUrls = exampleSources.web.map(s => s.url);
  changed();
  loadWebSource(src);
  return '';
}

export function removeWebSource(id: string) {
  exampleSources.web = exampleSources.web.filter(s => s.id !== id);
  exampleSources.webUrls = exampleSources.web.map(s => s.url);
  changed();
}

// ---- Folders on this computer ------------------------------------------
async function walkHandle(dir: DirHandle, rel: string, out: { path: string; src: string }[]) {
  for await (const [name, entry] of dir.entries()) {
    if (out.length >= FOLDER_MAX) break;
    const r = rel ? rel + '/' + name : name;
    if (entry.kind === 'directory') {
      if (!/^\.|^node_modules$/.test(name)) await walkHandle(entry, r, out);
    } else if (EXAMPLE_FILE_RE.test(name) || name.toLowerCase() === 'index.txt') {
      out.push({ path: r, src: await (await entry.getFile()).text() });
    }
  }
  return out;
}

async function readFolderFiles(f: ExampleFolder): Promise<{ path: string; src: string }[] | null> {
  if (f.kind === 'snapshot') return f.files || [];
  if (f.kind === 'native') return window.rvNative ? window.rvNative.readFolder(f.path ?? '', 'examples') : null;
  if (!f.handle) return null;
  if ((await f.handle.queryPermission({ mode: 'read' })) !== 'granted') { f.pending = true; return null; }
  return walkHandle(f.handle, '', []);
}

function entriesFromFolder(id: string, files: { path: string; src: string }[]): ExampleEntry[] {
  const index = files.find(x => x.path.toLowerCase() === 'index.txt');
  if (index) return entriesFromIndex(index.src, 'local', id, k => id + ':' + k);
  return files.filter(x => EXAMPLE_FILE_RE.test(x.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(x => ({ key: id + ':' + x.path, source: 'local' as const, sourceId: id, lang: /\.c$/i.test(x.path) ? 'c' as const : 'asm' as const,
                 label: x.path.replace(/\.(asm|s|c)$/i, ''), desc: x.path, file: x.path }));
}

export function readLocalSource(src: LocalSource): Promise<boolean> {
  if (src.reading) return src.reading;
  src.reading = (async () => {
    try {
      const files = await readFolderFiles(src.folder);
      if (!exampleSources.local.includes(src)) return false;
      if (!files) {
        src.state = { status: 'error', entries: [],
          error: src.folder.pending ? 'needs permission again (Settings → Examples)' : 'could not be read' };
        return false;
      }
      src.files = new Map(files.map(x => [x.path, x.src]));
      const entries = entriesFromFolder(src.id, files);
      src.state = entries.length ? { status: 'ok', error: '', entries }
        : { status: 'error', error: 'no .asm, .s or .c files', entries: [] };
      return true;
    } catch (e) {
      src.state = { status: 'error', error: 'could not be read (' + errorMessage(e) + ')', entries: [] };
      return false;
    } finally {
      src.reading = null;
      changed();
    }
  })();
  return src.reading;
}

function addLocalSource(folder: ExampleFolder) {
  const src: LocalSource = { id: 'f' + nextId++, folder, state: { status: 'loading', error: '', entries: [] }, files: new Map(), reading: null };
  exampleSources.local.push(src);
  changed();
  return src;
}

const folderName = (dir: string) => dir.split(/[\\/]/).filter(Boolean).pop() || dir;

// The browser's folders are kept as their handles, which only IndexedDB
// can store.
function storeHandles() {
  if (window.rvNative || !window.showDirectoryPicker) return;
  const handles = exampleSources.local.filter(s => s.folder.kind === 'handle').map(s => s.folder.handle);
  hdlFolderStore('put', handles, FOLDERS_KEY).catch(() => {});
}

// Adds a folder, or, given one that wants the browser's permission again,
// asks for it.
export async function pickExamplesFolder(id?: string) {
  try {
    const again = id ? exampleSources.local.find(s => s.id === id) : null;
    if (again && again.folder.pending && again.folder.handle) {
      if ((await again.folder.handle.requestPermission({ mode: 'read' })) !== 'granted') return;
      again.folder.pending = false;
      await readLocalSource(again);
      return;
    }
    if (window.rvNative) {
      const dir = await window.rvNative.pickFolder('examples');
      if (!dir) return;
      if (exampleSources.local.some(s => s.folder.path === dir)) return;
      await readLocalSource(addLocalSource({ kind: 'native', name: folderName(dir), pending: false, path: dir }));
    } else if (window.showDirectoryPicker) {
      const handle = await window.showDirectoryPicker({ id: 'examples', mode: 'read' });
      for (const s of exampleSources.local) if (s.folder.handle && await s.folder.handle.isSameEntry(handle)) return;
      const src = addLocalSource({ kind: 'handle', name: handle.name, pending: false, handle });
      storeHandles();
      await readLocalSource(src);
    } else {
      document.getElementById('examplesFolderInput')?.click();
    }
  } catch (e) {
    if ((e as Error | null)?.name === 'AbortError') return;
    const src = addLocalSource({ kind: 'snapshot', name: 'folder', pending: false, files: [] });
    src.state = { status: 'error', error: 'could not be opened (' + errorMessage(e) + ')', entries: [] };
    changed();
  }
}

// The copy <input webkitdirectory> hands over, in browsers without the
// File System Access API.
export async function examplesFolderPicked(list: FileList | File[]) {
  const picked = Array.from(list);
  if (!picked.length) return;
  const root = (picked[0].webkitRelativePath || '').split('/')[0] || 'folder';
  const files = await Promise.all(picked
    .filter(f => EXAMPLE_FILE_RE.test(f.name) || f.name.toLowerCase() === 'index.txt')
    .slice(0, FOLDER_MAX)
    .map(async f => ({ path: (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name, src: await f.text() })));
  await readLocalSource(addLocalSource({ kind: 'snapshot', name: root, pending: false, files }));
}

export function forgetExamplesFolder(id: string) {
  const src = exampleSources.local.find(s => s.id === id);
  if (!src) return;
  exampleSources.local = exampleSources.local.filter(s => s !== src);
  if (src.folder.kind === 'native' && window.rvNative) window.rvNative.forgetFolder('examples', src.folder.path);
  storeHandles();
  changed();
}

export function forgetAllExamplesFolders() {
  for (const s of exampleSources.local.slice()) forgetExamplesFolder(s.id);
}

// The text of an example, read afresh from its source.
export async function readExampleSource(e: ExampleEntry): Promise<string> {
  if (e.source === 'web') {
    const src = exampleSources.web.find(s => s.id === e.sourceId);
    const base = src && webBase(src.url);
    if (!base) throw new Error('its web folder is no longer listed');
    return fetchText(base + e.file);
  }
  if (e.source === 'local') {
    const src = exampleSources.local.find(s => s.id === e.sourceId);
    if (!src) throw new Error('its folder is no longer listed');
    await readLocalSource(src);
    const text = src.files.get(e.file);
    if (text === undefined) throw new Error(e.file + ' is not in the folder ' + src.folder.name);
    return text;
  }
  throw new Error('a built-in example has no file to read');
}

// The name of where an example comes from, for messages.
export function exampleSourceName(e: ExampleEntry) {
  if (e.source === 'local') return 'the folder ' + (exampleSources.local.find(s => s.id === e.sourceId)?.folder.name ?? '');
  const w = exampleSources.web.find(s => s.id === e.sourceId);
  return w ? webSourceName(w.url) : 'the web';
}

export function initExampleSources() {
  setWebSources(exampleSources.webUrls);
  if (window.rvNative) {
    for (const dir of window.rvNative.rememberedExamplesFolders || []) {
      readLocalSource(addLocalSource({ kind: 'native', name: folderName(dir), pending: false, path: dir }));
    }
  } else if (window.showDirectoryPicker) {
    Promise.all([hdlFolderStore('get', undefined, FOLDERS_KEY), hdlFolderStore('get', undefined, 'examplesFolder')]).then(([list, one]) => {
      const handles = (Array.isArray(list) ? list : one ? [one] : []) as DirHandle[];
      for (const handle of handles) readLocalSource(addLocalSource({ kind: 'handle', name: handle.name, pending: false, handle }));
      if (one) { hdlFolderStore('delete', undefined, 'examplesFolder').catch(() => {}); storeHandles(); }
    }).catch(() => {});
  }
  window.addEventListener('focus', () => {
    for (const s of exampleSources.local) if (s.folder.kind !== 'snapshot') readLocalSource(s);
  });
}
