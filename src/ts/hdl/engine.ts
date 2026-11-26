
import { HDL_CK_CYC_LINE, hdlVcdFromBytes } from './checkpoints';
import { HDL_CYCLES_DEFAULT, hdlActivity, hdlConfig, hdlSources } from './state';
import { log, setStatus } from '../ui/editor';
import { errorMessage } from '../errors';
/* ================================================================
   HDL SIMULATION MODE (Icarus Verilog -> WebAssembly)
   ================================================================
   A second execution engine that runs the user's OWN Verilog
   processor instead of the JavaScript functional model. The three
   Icarus stages are separate Emscripten modules driven from here:

     ivlpp  preprocessor  .v sources        -> one expanded source
     ivl    compiler      expanded source   -> .vvp bytecode
     vvp    runtime       .vvp              -> stdout + optional VCD

   Files move between the stages through each module's in-memory
   filesystem (MEMFS); nothing touches the real disk.

   The uploaded Wrapper.v is instantiated verbatim and never edited:
   the simulator only generates a testbench around it
   (hdl/testbench.ts), as a student does in Vivado. The testbench
   drives the Wrapper's fixed port list, feeds the peripherals from the
   UI state, and reports every peripheral write as a tagged `$display`
   line, which hdlTraceParser() (hdl/trace.ts) reads and
   hdlApplyPer() (hdl/seek.ts) applies to the LED, 7-segment, OLED
   and UART models.
   ================================================================ */

// Where to fetch ivlpp.js / ivl.js / vvp.js (+ their .wasm) from: the
// upstream build at a fixed commit, whose files are the ones in
// vendor/verisim/ (built from the Icarus commit the desktop app's native
// build is pinned to), then that vendored copy. The local copy needs the
// page to be served over http: Emscripten fetches its .wasm, and a
// file:// fetch is blocked as cross-origin.
export const HDL_ENGINE_SOURCES = [
  'https://cdn.jsdelivr.net/gh/senolgulgonul/verisim@972bb7b72322bce94918e26ddefc696da949eb06/',
  'vendor/verisim/',
  'verisim/'
];

// In the desktop app (electron/) Icarus runs natively, and the stages get
// the same files and arguments the WASM build would.
export const hdlNative = (window.rvNative && window.rvNative.icarus) ? window.rvNative : null;
// The app carries vendor/ beside the page, so the local copies come first.
export const hdlNativeJobs = new Set();
// An Emscripten module factory: instantiates the tool with its output hooks.
export type HdlToolFactory = (opts: { print: (s: string) => void; printErr: (s: string) => void }) => Promise<any>;
export type HdlToolName = 'ivlpp' | 'ivl' | 'vvp';
// A stage's input files, and what it returns: its output lines and the files it kept.
export type HdlToolFiles = Record<string, string | Uint8Array>;
export interface HdlToolResult { out: string[]; err: string[]; files: Record<string, Uint8Array> }

export let hdlEngine: Record<HdlToolName, HdlToolFactory> | null = null;
export let hdlEngineBase: string | null = null;     // the base URL that actually loaded
export let hdlEngineLoading: Promise<Record<HdlToolName, HdlToolFactory>> | null = null;  // de-dupes concurrent loads
export const HDL_MAX_CYCLES = 2000000;      // Icarus: the whole recording is kept
export const HDL_VL_MAX_RUN = 1000000000;   // Verilator: one run; the recording is trimmed (HDL_VL_KEEP)
// A waveform of a long run is the last this many cycles of it (Icarus
// drops the oldest in steps, so up to a quarter more); the whole run
// would be hundreds of megabytes.
export const HDL_VCD_WINDOW = 50000;
// A waveform followed during a live run is dropped past this size.
export const HDL_LIVE_VCD_MAX = 20e6;
// Without the architectural trace, a live run folds its peripheral
// events into a snapshot once it holds this many.
export const HDL_LIVE_PRE_KEEP = 100000;
export const hdlCyclesFor = Object.assign({}, HDL_CYCLES_DEFAULT);

// The engine's output goes to the console under the editor, next to the
// assembler's - one place to look when something fails, and room to grow
// for a multi-line Verilog compile error. Lines are tagged so they can be
// told apart at a glance.
export const HDL_LOG_CLASS: Record<string, string> = { err: 'error', warn: 'warn', sys: 'info', ok: 'success' };
export function hdlLog(msg: string, cls: string) {
  const type = HDL_LOG_CLASS[cls] || '';
  String(msg).replace(/\s+$/, '').split('\n')
    .forEach(line => log('[HDL] ' + line, type));
}
// There is no separate HDL console to wipe; mark the start of a run so a
// fresh compile is easy to find in the scrollback.
export function hdlClearConsole() {
  log('[HDL] ------------------------------------------------', 'info');
}
export function hdlStatus(text: string, cls: string) {
  setStatus('HDL: ' + text,
    cls === 'err' ? 'error' : cls === 'ok' ? 'success' : '');
}

// Load the three Emscripten module factories, trying each base URL in
// turn. Cached after the first success — the wasm is ~2.7 MB total.
export async function loadHdlEngine() {
  if (hdlNative) return null;
  if (hdlEngine) return hdlEngine;
  if (hdlEngineLoading) return hdlEngineLoading;
  hdlEngineLoading = (async () => {
    let lastErr: unknown = null;
    for (const base of HDL_ENGINE_SOURCES) {
      try {
        hdlStatus('loading engine from ' + base + ' …', 'busy');
        const [ivlpp, ivl, vvp] = await Promise.all([
          import(/* webpackIgnore: true */ base + 'ivlpp.js'),
          import(/* webpackIgnore: true */ base + 'ivl.js'),
          import(/* webpackIgnore: true */ base + 'vvp.js')
        ]);
        const engine = { ivlpp: ivlpp.default, ivl: ivl.default, vvp: vvp.default };
        hdlEngine = engine;
        hdlEngineBase = base;
        hdlStatus('engine ready (Icarus Verilog → WASM)', 'ok');
        hdlLog('Engine loaded from ' + base, 'sys');
        return engine;
      } catch (e) {
        lastErr = e;
      }
    }
    hdlEngineLoading = null;
    hdlStatus('engine failed to load', 'err');
    throw new Error('Could not load the Icarus/WASM engine from any source. ' +
      'Last error: ' + errorMessage(lastErr));
  })();
  return hdlEngineLoading;
}

// ---- the engine runs in a worker -----------------------------------
// A long simulation is seconds to minutes of uninterrupted WASM, and on
// the page's own thread nothing responds until it returns. Each stage
// runs in a module worker instead, which imports the same Emscripten
// factory by URL. Where a worker cannot be made or cannot load the
// engine, the stages run on the page itself.
export const HDL_WORKER_SRC = `
const factories = {};
self.onmessage = async ({ data: job }) => {
  let factory;
  try {
    factory = await (factories[job.url] || (factories[job.url] = import(job.url).then(m => m.default)));
  } catch (e) {
    delete factories[job.url];
    self.postMessage({ id: job.id, load: true, error: String(e && e.message || e) });
    return;
  }
  try {
    const out = [], err = [];
    const m = await factory({ print: s => out.push(s), printErr: s => (job.merge ? out : err).push(s) });
    for (const name in job.files) m.FS.writeFile('/' + name, job.files[name]);
    try { m.callMain(job.args); } catch (e) { if (!(e && e.name === 'ExitStatus')) throw e; }
    const files = {};
    if (job.keep) {
      const re = new RegExp(job.keep);
      for (const name of m.FS.readdir('/')) if (re.test(name)) files[name] = m.FS.readFile('/' + name);
    }
    self.postMessage({ id: job.id, out, err, files }, Object.values(files).map(f => f.buffer));
  } catch (e) {
    self.postMessage({ id: job.id, error: String(e && e.message || e) });
  }
};`;
export let hdlWorker: Worker | null = null;
export let hdlWorkerUrl: string | null = null;
export let hdlWorkerFailed = false;  // the stages run on the page from then on
export const hdlWorkerJobs = new Map<number, { resolve: (r: HdlToolResult) => void; reject: (e: Error) => void }>();

export function hdlWorkerGet() {
  if (hdlWorker) return hdlWorker;
  const url = hdlWorkerUrl = URL.createObjectURL(new Blob([HDL_WORKER_SRC], { type: 'text/javascript' }));
  const w = new Worker(url, { type: 'module' });
  w.onmessage = ({ data }) => {
    const job = hdlWorkerJobs.get(data.id);
    if (!job) return;
    hdlWorkerJobs.delete(data.id);
    if (data.error) job.reject(Object.assign(new Error(data.error), { workerBroken: !!data.load }));
    else job.resolve(data);
  };
  w.onerror = ev => {
    ev.preventDefault();
    hdlStopWorker(Object.assign(new Error(ev.message || 'the worker did not start'), { workerBroken: true }));
  };
  hdlWorker = w;
  return w;
}

// Ends the worker and fails whatever it was running. With no error
// given, that is a cancellation: the run was discarded mid-flight.
export function hdlStopWorker(err?: Error) {
  if (window.rvNative) for (const id of hdlNativeJobs) window.rvNative.hdlKill(id);
  if (hdlWorker) hdlWorker.terminate();
  if (hdlWorkerUrl) URL.revokeObjectURL(hdlWorkerUrl);
  hdlWorker = null;
  hdlWorkerUrl = null;
  const e = err || Object.assign(new Error('cancelled'), { cancelled: true });
  for (const job of hdlWorkerJobs.values()) job.reject(e);
  hdlWorkerJobs.clear();
}

// Run one stage: write `files` into its file system, call main with
// `args`, and return its output lines and the files matching `keep`.
// keep: the files to return; merge: stderr goes to out, in order.
export async function hdlTool(tool: HdlToolName, files: HdlToolFiles, args: string[],
                              opts: { keep?: RegExp; merge?: boolean } = {}): Promise<HdlToolResult> {
  if (hdlNative) {
    const id = ++hdlActivity.jobSeq;
    hdlNativeJobs.add(id);
    try {
      const r = await hdlNative.hdlRun(id, tool, files, args,
        { merge: !!opts.merge, keep: opts.keep ? opts.keep.source : null });
      if (r.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
      return r;
    } finally {
      hdlNativeJobs.delete(id);
    }
  }
  await loadHdlEngine();
  if (!hdlWorkerFailed) {
    try {
      return await new Promise<HdlToolResult>((resolve, reject) => {
        const id = ++hdlActivity.jobSeq;
        hdlWorkerJobs.set(id, { resolve, reject });
        try {
          hdlWorkerGet().postMessage({
            id, url: new URL(hdlEngineBase + tool + '.js', location.href).href,
            files, args, merge: !!opts.merge, keep: opts.keep ? opts.keep.source : null
          });
        } catch (e) {
          hdlWorkerJobs.delete(id);
          reject(Object.assign(e as Error, { workerBroken: true }));
        }
      });
    } catch (e) {
      const broken = e as Error & { workerBroken?: boolean };
      if (!broken || !broken.workerBroken) throw e;
      hdlWorkerFailed = true;
      hdlStopWorker(broken);
      hdlLog('The simulator runs on the page itself here (' + broken.message + '), so the page ' +
        'does not respond while it compiles or simulates.', 'warn');
    }
  }
  const engine = hdlEngine;
  if (!engine) throw new Error('The Icarus engine is not loaded.');
  const out: string[] = [], err: string[] = [];
  const m = await engine[tool]({ print: s => out.push(s), printErr: s => (opts.merge ? out : err).push(s) });
  for (const name in files) m.FS.writeFile('/' + name, files[name]);
  m.callMain(args);
  const got: Record<string, Uint8Array> = {};
  if (opts.keep) for (const name of m.FS.readdir('/')) if (opts.keep.test(name)) got[name] = m.FS.readFile('/' + name);
  return { out, err, files: got };
}

// ---- stage 1: preprocess every source in one pass -----------------
// A single ivlpp pass over all files gives them a shared macro table,
// exactly like `iverilog a.v b.v ...` does.
export async function hdlPreprocess(files: { name: string; src: string }[]) {
  const fsFiles: HdlToolFiles = {};
  const args = ['-L']; // emit `line directives so ivl errors map back to the right file
  for (const f of files) {
    fsFiles[f.name] = f.src.endsWith('\n') ? f.src : f.src + '\n';
    args.push('/' + f.name);
  }
  const r = await hdlTool('ivlpp', fsFiles, args);
  return { src: r.out.join('\n') + '\n', err: r.err.join('\n') };
}

// ---- stage 2: compile to .vvp bytecode ----------------------------
export async function hdlCompile(src: string, generation: string) {
  const r = await hdlTool('ivl', {
    'ivl.conf': 'basedir:/\nmodule:system.vpi\ngeneration:' + (generation || '2005') +
      '\ngeneration:no-specify\nout:/out.vvp\niwidth:32\nwidthcap:65536\n' +
      'functor:cprop\nfunctor:nodangle\nflag:DLL=vvp.tgt\n',
    'src.v': src
  }, ['-C/ivl.conf', '--', '/src.v'], { keep: /^out\.vvp$/ });
  return { vvp: r.files['out.vvp'] || null, err: hdlFilterNoise(r.err.join('\n')) };
}

// ---- stage 3: run ------------------------------------------------
// The plusargs are how a run is configured without recompiling: cycle
// budget, trace level, switch positions and the sizes of the stimulus
// files are all read by the testbench at $value$plusargs time. The
// checkpoints a run writes come back as { cycle: { txt, mem: [] } }.
export const HDL_RUN_KEEP = /^(dump\.vcd|ck_s?\d+(_m\d+\.mem|\.txt))$/;
export async function hdlSimulate(vvpBytes: Uint8Array, memFiles: HdlToolFiles, plusargs: string[]) {
  const files: HdlToolFiles = Object.assign({ 'sim.vvp': vvpBytes }, memFiles);
  const r = await hdlTool('vvp', files, ['/sim.vvp'].concat(plusargs || []),
    { merge: true, keep: HDL_RUN_KEEP });
  return hdlDecodeRun(r);
}

// A Verilator model takes the same plusargs and files as vvp does.
export async function hdlRunModel(model: unknown, files: HdlToolFiles, plusargs: string[]) {
  const id = ++hdlActivity.jobSeq;
  hdlNativeJobs.add(id);
  let r;
  try {
    r = await window.rvNative.vlRun(id, model, files, plusargs || [], { merge: true, keep: HDL_RUN_KEEP.source });
  } finally {
    hdlNativeJobs.delete(id);
  }
  if (r.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
  return hdlDecodeRun(r);
}

// Builds the design with Verilator in the desktop app. Headers are
// handed over to be included, not compiled on their own.
export let hdlVerilatorNoted = false;
export let hdlZigNoted = false;

// A first build can take several minutes: on a computer with no C++ compiler,
// one is downloaded and prepared before Verilator's own runtime is
// compiled. Each step goes to the status line, so it is never a silent
// wait.
export function hdlOnVerilatorProgress(id: number, e: { phase: string; total?: number; received?: number; done?: number }) {
  if (!hdlNativeJobs.has(id)) return;
  const mb = (n: number) => (n / 1048576).toFixed(0);
  if (e.phase === 'compiler-download') {
    if (!hdlZigNoted) {
      hdlZigNoted = true;
      hdlLog('No C++ compiler was found on this computer, so the one Verilator needs (Zig, about ' +
        '55 MB, 100 MB on Windows) is being downloaded and prepared. This takes several minutes, once.', 'sys');
    }
    hdlStatus('downloading the C++ compiler for Verilator' +
      (e.total ? ': ' + mb(e.received ?? 0) + ' of ' + mb(e.total) + ' MB' : '...'), 'busy');
  } else if (e.phase === 'compiler-unpack') {
    hdlStatus('unpacking the C++ compiler...', 'busy');
  } else if (e.phase === 'compiler-check') {
    hdlStatus('preparing the C++ compiler (once; it builds its C++ library first)...', 'busy');
  } else if (e.phase === 'verilate') {
    hdlStatus('Verilator: translating the design to C++...', 'busy');
  } else if (e.phase === 'runtime') {
    hdlStatus('Verilator: compiling its runtime, once (' + e.done + ' of ' + e.total + ')...', 'busy');
  } else if (e.phase === 'cxx') {
    hdlStatus('Verilator: compiling the model (' + e.done + ' of ' + e.total + ' files)...', 'busy');
  } else if (e.phase === 'link') {
    hdlStatus('Verilator: linking...', 'busy');
  }
}
export async function hdlVerilate(tb: string, gen: string, ck: string) {
  const language = { '1995': '1364-1995', '2001': '1364-2001', '2005-sv': '1800-2017' }[gen] || '1364-2005';
  const files: Record<string, string> = {}, headers: Record<string, string> = {};
  for (const f of hdlSources.files) (/\.(vh|svh)$/i.test(f.name) ? headers : files)[f.name] = f.src;
  if (ck) {
    files['cg3207_hdl_ck.v'] = ck;
    tb = tb.replace(/endmodule\s*$/, '  cg3207_hdl_ck cg3207_ck();\n\nendmodule\n');
  }
  files['cg3207_hdl_tb.v'] = tb;
  if (!hdlVerilatorNoted) {
    hdlVerilatorNoted = true;
    hdlLog('Verilator simulates two-state logic: what Icarus shows as x, such as a register ' +
      'that has never been written, is 0 here.', 'sys');
  }
  hdlStatus('building with Verilator...', 'busy');
  const id = ++hdlActivity.jobSeq;
  hdlNativeJobs.add(id);
  let r;
  try {
    r = await window.rvNative.vlBuild(id, files, { language, headers, waveTop: hdlConfig.waveTop });
  } finally {
    hdlNativeJobs.delete(id);
  }
  if (r.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
  if (r.ok) {
    hdlLog(r.cached ? 'Reusing the Verilator model built earlier for these sources.'
      : 'Verilator build ' + ((r.ms.verilate + r.ms.cxx) / 1000).toFixed(1) + ' s (' + r.compiler + ')', 'sys');
  }
  return { ok: !!r.ok, model: r.ok ? r.key : null, log: r.log || '' };
}

// Errors are listed as they come. Warnings, which a student design can
// have by the hundred, are counted by kind with the first of each; the
// testbench's own are left out.
export function hdlReportVerilator(log: string) {
  const errs = [], warn = new Map();
  for (const line of String(log || '').split(/\r?\n/)) {
    const m = /^%(Error|Warning)(?:-([A-Z0-9_]+))?: (.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'Error') { if (!/^Exiting due to/.test(m[3])) errs.push(m[3]); continue; }
    if (/cg3207_hdl_(tb|ck)\.v/.test(m[3])) continue;
    const k = m[2] || 'WARNING';
    if (!warn.has(k)) warn.set(k, { n: 0, first: m[3] });
    warn.get(k).n++;
  }
  for (const [k, w] of warn) hdlLog('Verilator ' + k + (w.n > 1 ? ' ×' + w.n : '') + ': ' + w.first, 'warn');
  for (const e of errs) hdlLog(e, 'err');
  if (/C\+\+ compilation failed|Linking failed|No C\+\+20 compiler/.test(log)) hdlLog(String(log).slice(-3000), 'err');
}

// Verilator's two checkpoint files are named by slot; the cycle each
// holds is the testbench's cyc, saved with the rest.
// Each checkpoint: the state file's text and the memory images, by cycle.
export type HdlVlCheckpoints = Record<string, { txt: string; mem: string[] }>;

export function hdlDecodeCk(files: Record<string, Uint8Array>) {
  const dec = new TextDecoder();
  const ck: HdlVlCheckpoints = {};
  for (const name in files || {}) {
    const m = /^ck_(s?\d+)(?:_m(\d+)\.mem|\.txt)$/.exec(name);
    if (!m) continue;
    const c = ck[m[1]] || (ck[m[1]] = { txt: '', mem: [] });
    if (m[2] === undefined) c.txt = dec.decode(files[name]);
    else c.mem[+m[2]] = dec.decode(files[name]);
  }
  for (const s of Object.keys(ck)) {
    if (s[0] !== 's') continue;
    const c = ck[s];
    delete ck[s];
    const k = parseInt(c.txt.split(/\r?\n/)[HDL_CK_CYC_LINE] || '', 2);
    if (k > 0) ck[k] = c;
  }
  return ck;
}
export function hdlDecodeRun(r: { out: string[]; files: Record<string, Uint8Array> }) {
  const dec = new TextDecoder();
  return { out: r.out.join('\n'), vcd: r.files['dump.vcd'] ? hdlVcdFromBytes(r.files['dump.vcd'], dec) : null, ck: hdlDecodeCk(r.files) };
}

// Drop diagnostics that are artefacts of the WASM build rather than
// anything wrong with the user's design.
export function hdlFilterNoise(text: string) {
  return (text || '').split('\n')
    .filter((l: string) => !/system\.vpi|dynamic linking not enabled/.test(l))
    .join('\n');
}

// Run once the page has loaded every module (main.ts), in page order.
export function onEngineLoad() {
  if (window.rvNative) {
    HDL_ENGINE_SOURCES.sort((a, b) => Number(/^https?:/.test(a)) - Number(/^https?:/.test(b)));
  }
  if (window.rvNative && window.rvNative.onVlProgress) window.rvNative.onVlProgress(hdlOnVerilatorProgress);
}
