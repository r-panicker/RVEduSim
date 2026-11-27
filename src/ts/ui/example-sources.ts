// Where the Example menu's programs come from. Three sources, all at once,
// each a section of the menu:
//   - built in: DIP to LED in each language, part of the page, so there is
//     always a program to open, offline or from file://;
//   - web: a folder laid out as examples/ is (index.txt, asm/, c/). By
//     default the site's own examples/ (the RVEduSim site's, in the desktop
//     app); in Settings, a GitHub folder or any https URL instead;
//   - a local folder, read as the HDL source folder is (hdl/sources.ts):
//     through the desktop app, a File System Access handle, or a one-off
//     <input webkitdirectory> copy. With no index.txt, every .asm, .s and
//     .c file in it is listed under its own name.
// Nothing is cached: each is read afresh when the page starts, when its
// setting changes, and (a folder) when the window regains focus, and an
// example's file is fetched when it is selected.

import { hdlFolderStore } from '../hdl/sources';
import { errorMessage } from '../errors';
import { redraw } from './views.svelte';

export type ExampleLang = 'asm' | 'c';
export interface ExampleEntry {
  key: string; source: 'builtin' | 'web' | 'local'; lang: ExampleLang;
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

export const DEFAULT_WEB_EXAMPLES = 'https://r-panicker.github.io/RVEduSim/examples/';
export const DEFAULT_DEPTH_BITS = 9;
const EXAMPLE_FILE_RE = /\.(asm|s|c)$/i;
const FOLDER_MAX = 500;

export const BUILTIN_EXAMPLES: ExampleEntry[] = [
  { key: 'dip_led', source: 'builtin', lang: 'asm', label: 'DIP to LED (start here)', file: 'asm/DIP_to_LED.asm',
    desc: 'DIP switches mirrored to LEDs, built into the page', depths: { irom: 9, dmem: 9 } },
  { key: 'dip_led_c', source: 'builtin', lang: 'c', label: 'DIP to LED (start here)', file: 'c/DIP_to_LED.c',
    desc: 'DIP switches mirrored to LEDs, built into the page', depths: { irom: 9, dmem: 9 } },
];

export const exampleSources = {
  webUrl: '',                                     // '' for the default
  web: { status: 'idle', error: '', entries: [] } as ExampleSourceState,
  folder: null as ExampleFolder | null,
  local: { status: 'idle', error: '', entries: [] } as ExampleSourceState,
};

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

function entriesFromIndex(text: string, source: 'web' | 'local', keyOf: (key: string) => string): ExampleEntry[] {
  return parseExampleIndexMarkdown(text).map(([key, lang, label, file, irom, dmem, desc]) => {
    const l: ExampleLang = lang === 'c' ? 'c' : 'asm';
    return { key: keyOf(key), source, lang: l, label, desc, file: l + '/' + file, depths: { irom, dmem } };
  });
}

// ---- The web source ----------------------------------------------------
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

// The default is the page's own examples/, except in the desktop app,
// which carries none and reads the site's.
export function webExamplesBase() {
  if (exampleSources.webUrl) return examplesBaseUrl(exampleSources.webUrl);
  return window.rvNative ? DEFAULT_WEB_EXAMPLES : 'examples/';
}

// The web section's heading: Web for the default, else a short name.
export function webSourceName() {
  if (!exampleSources.webUrl) return 'Web';
  const base = webExamplesBase();
  if (!base) return 'Web';
  const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/[^/]+\/(.*)$/.exec(base);
  if (raw) return 'GitHub: ' + raw[1] + '/' + raw[2] + (raw[3] ? '/' + raw[3].replace(/\/$/, '') : '');
  try { return new URL(base).host; } catch (e) { return 'Web'; }
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

let webToken = 0;
export async function loadWebExamples() {
  const my = ++webToken;
  const base = webExamplesBase();
  const s = exampleSources.web;
  if (!base) {
    exampleSources.web = { status: 'error', error: 'not a URL', entries: [] };
    changed();
    return;
  }
  exampleSources.web = { status: 'loading', error: '', entries: s.entries };
  changed();
  let next: ExampleSourceState;
  try {
    const text = await fetchText(base + 'index.txt');
    // The default index lists the built-in examples too; they are shown
    // once, under Built in. Another folder's own DIP to LED is its own.
    const entries = entriesFromIndex(text, 'web', k => isBuiltinKey(k) ? 'web:' + k : k)
      .filter(e => exampleSources.webUrl || !e.key.startsWith('web:'));
    next = entries.length ? { status: 'ok', error: '', entries }
      : { status: 'error', error: 'index.txt lists no examples', entries: [] };
  } catch (e) {
    next = { status: 'error', error: fetchFailure(e), entries: [] };
  }
  if (my !== webToken) return;
  exampleSources.web = next;
  changed();
}

export function setExamplesWebUrl(url: string) {
  const t = url.trim();
  if (t === exampleSources.webUrl) return;
  exampleSources.webUrl = t;
  loadWebExamples();
}

// ---- The local folder ------------------------------------------------
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

// The folder's files, kept from its last read; an example is loaded from
// them after the folder has been read again.
let folderFiles = new Map<string, string>();

function entriesFromFolder(files: { path: string; src: string }[]): ExampleEntry[] {
  const index = files.find(x => x.path.toLowerCase() === 'index.txt');
  if (index) return entriesFromIndex(index.src, 'local', k => 'local:' + k);
  return files.filter(x => EXAMPLE_FILE_RE.test(x.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(x => ({ key: 'local:' + x.path, source: 'local' as const, lang: /\.c$/i.test(x.path) ? 'c' as const : 'asm' as const,
                 label: x.path.replace(/\.(asm|s|c)$/i, ''), desc: x.path, file: x.path }));
}

let folderReading: Promise<boolean> | null = null;
export function readExamplesFolder(): Promise<boolean> {
  const f = exampleSources.folder;
  if (!f) return Promise.resolve(false);
  if (folderReading) return folderReading;
  folderReading = (async () => {
    try {
      const files = await readFolderFiles(f);
      if (f !== exampleSources.folder) return false;
      if (!files) {
        exampleSources.local = { status: 'error', entries: [],
          error: f.pending ? 'needs permission again (Settings → Examples)' : 'could not be read' };
        return false;
      }
      folderFiles = new Map(files.map(x => [x.path, x.src]));
      const entries = entriesFromFolder(files);
      exampleSources.local = entries.length ? { status: 'ok', error: '', entries }
        : { status: 'error', error: 'no .asm, .s or .c files', entries: [] };
      return true;
    } catch (e) {
      exampleSources.local = { status: 'error', error: 'could not be read (' + errorMessage(e) + ')', entries: [] };
      return false;
    } finally {
      folderReading = null;
      changed();
    }
  })();
  return folderReading;
}

function setFolder(f: ExampleFolder | null) {
  exampleSources.folder = f;
  folderFiles = new Map();
  exampleSources.local = { status: f ? 'loading' : 'idle', error: '', entries: [] };
  changed();
}

const folderName = (dir: string) => dir.split(/[\\/]/).filter(Boolean).pop() || dir;

export async function pickExamplesFolder() {
  try {
    if (window.rvNative) {
      const dir = await window.rvNative.pickFolder('examples');
      if (!dir) return;
      setFolder({ kind: 'native', name: folderName(dir), pending: false, path: dir });
    } else if (window.showDirectoryPicker) {
      const f = exampleSources.folder;
      if (f && f.pending && f.handle) {
        if ((await f.handle.requestPermission({ mode: 'read' })) !== 'granted') return;
        f.pending = false;
      } else {
        const handle = await window.showDirectoryPicker({ id: 'examples', mode: 'read' });
        setFolder({ kind: 'handle', name: handle.name, pending: false, handle });
        hdlFolderStore('put', handle, 'examplesFolder').catch(() => {});
      }
    } else {
      document.getElementById('examplesFolderInput')?.click();
      return;
    }
    await readExamplesFolder();
  } catch (e) {
    if ((e as Error | null)?.name === 'AbortError') return;
    exampleSources.local = { status: 'error', error: 'could not be opened (' + errorMessage(e) + ')', entries: [] };
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
  setFolder({ kind: 'snapshot', name: root, pending: false, files });
  await readExamplesFolder();
}

export function forgetExamplesFolder() {
  if (!exampleSources.folder) return;
  if (window.rvNative) window.rvNative.forgetFolder('examples');
  else hdlFolderStore('delete', undefined, 'examplesFolder').catch(() => {});
  setFolder(null);
}

// The text of an example, read afresh from its source.
export async function readExampleSource(e: ExampleEntry): Promise<string> {
  if (e.source === 'web') {
    const base = webExamplesBase();
    if (!base) throw new Error('the examples URL is not valid');
    return fetchText(base + e.file);
  }
  if (e.source === 'local') {
    await readExamplesFolder();
    const src = folderFiles.get(e.file);
    if (src === undefined) throw new Error(e.file + ' is not in the folder ' + (exampleSources.folder?.name ?? ''));
    return src;
  }
  throw new Error('a built-in example has no file to read');
}

export function initExampleSources() {
  loadWebExamples();
  if (window.rvNative && window.rvNative.rememberedExamplesFolder) {
    const dir = window.rvNative.rememberedExamplesFolder;
    setFolder({ kind: 'native', name: folderName(dir), pending: false, path: dir });
    readExamplesFolder();
  } else if (!window.rvNative && window.showDirectoryPicker) {
    hdlFolderStore('get', undefined, 'examplesFolder').then(stored => {
      const handle = stored as DirHandle | undefined;
      if (!handle || exampleSources.folder) return;
      setFolder({ kind: 'handle', name: handle.name, pending: false, handle });
      readExamplesFolder();
    }).catch(() => {});
  }
  window.addEventListener('focus', () => {
    if (exampleSources.folder && exampleSources.folder.kind !== 'snapshot') readExamplesFolder();
  });
}
