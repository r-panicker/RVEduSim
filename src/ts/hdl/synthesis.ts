// ================================================================
// Post-synthesis simulation (Yosys)
// ================================================================
// With "Synthesise and check" ticked, every run is simulated twice: once
// as written, and once as a gate-level netlist produced by Yosys. The two
// traces are compared, so a construct that simulates one way and
// synthesises another shows up as a divergence at a named instruction.
//
// Only the core is synthesised. The Wrapper stays behavioural, which keeps
// its $readmemh working and so keeps the netlist independent of the
// program - one synthesis serves every run.
//
// Yosys is ~13 MB over the wire and is fetched from a pinned, immutable
// CDN URL the first time this option is used, then served from the
// browser's HTTP cache.

import { hdlRxFile, hdlStimFile } from './compile';
import { hdlCompile, hdlLog, hdlPreprocess, hdlSimulate, hdlStatus } from './engine';
import { hdlConfig, hdlSources } from './state';
import { hdlBuildTestbench } from './testbench';
import { hdlPlusargs } from './trace';
import { hdlFindWrapper, hdlHash } from './verilog';
import { layout } from '../machine/state';
import { setStatus } from '../ui/editor';
import { byId } from '../ui/dom';
import { errorMessage } from '../errors';
export const HDL_YOSYS_VERSION = '0.68.1207';
// The CDN first, then the vendored copy beside the page. The bundle
// resolves its own .wasm and resource tar relative to its own URL, so a
// local copy needs nothing but the whole vendor/yosys folder - and, like
// the Icarus engine, a page served over http rather than opened from disk.
export const HDL_YOSYS_SOURCES = [
  'https://cdn.jsdelivr.net/npm/@yowasp/yosys@' + HDL_YOSYS_VERSION + '/gen/bundle.js',
  'vendor/yosys/bundle.js'
];

// @yowasp/yosys's entry point: runs Yosys on the files given, returning the files it wrote.
export type RunYosys = (args: string[], files: Record<string, string>,
  opts: { stdout: (b: Uint8Array | null) => void; stderr: (b: Uint8Array | null) => void }) => Promise<Record<string, string>>;

export let hdlYosys: RunYosys | null = null;   // once loaded
export let hdlYosysLoading: Promise<RunYosys> | null = null;
export let hdlNetlist: { key: string; src: string } | null = null;     // one synthesis per source set
export let hdlNetlistVvp: { key: string; vvp: Uint8Array } | null = null;   // one compile per netlist

export async function loadYosysEngine() {
  if (hdlYosys) return hdlYosys;
  if (hdlYosysLoading) return hdlYosysLoading;
  hdlYosysLoading = (async (): Promise<RunYosys> => {
    hdlStatus('loading the synthesiser (~13 MB, first use only) …', 'busy');
    let lastErr: unknown = null;
    for (const url of HDL_YOSYS_SOURCES) {
      try {
        hdlLog('Loading Yosys ' + HDL_YOSYS_VERSION + ' from ' + url, 'sys');
        const mod = await import(/* webpackIgnore: true */ url);
        if (typeof mod.runYosys !== 'function')
          throw new Error('The Yosys bundle did not export runYosys.');
        const run: RunYosys = mod.runYosys;
        hdlYosys = run;
        hdlLog('Synthesiser ready.', 'sys');
        return run;
      } catch (e) {
        lastErr = e;
        hdlLog('  ' + errorMessage(e), 'warn');
      }
    }
    throw new Error('Could not load Yosys from ' + HDL_YOSYS_SOURCES.join(' or ') +
      (lastErr ? ' \u2014 ' + errorMessage(lastErr) : ''));
  })();
  try {
    return await hdlYosysLoading;
  } catch (e) {
    hdlYosysLoading = null;
    throw e;
  }
}

// Everything except the file that declares the Wrapper: the Wrapper is
// fixed and is not the thing being checked.
export function hdlCoreFiles() {
  const wrapper = hdlFindWrapper();
  return hdlSources.files.filter(f => !wrapper || f.name !== wrapper.name);
}

// Synthesis resolves parameters away, but the fixed Wrapper instantiates
// the core as `RV #(.PC_INIT(...)) RV1(...)`. Rename the synthesised top
// and wrap it in a module that still accepts the parameter.
export function hdlAddParamShim(netlist: string) {
  const hdr = /^module RV\(([^)]*)\);/m.exec(netlist);
  if (!hdr) return netlist;
  const ports = hdr[1].split(',').map(p => p.trim()).filter(Boolean);
  const decls: string[] = [];
  for (const line of netlist.slice(hdr.index + hdr[0].length).split('\n')) {
    const m = /^\s*(input|output|inout)\s+(.*);\s*$/.exec(line);
    if (m) { decls.push('  ' + m[1] + ' ' + m[2] + ';'); continue; }
    if (/^\s*(wire|reg)\b/.test(line) || !line.trim()) continue;
    break;
  }
  return netlist.replace(/^module RV\(/m, 'module RV_synth(') +
    '\nmodule RV #(parameter PC_INIT = 32\'h' + (layout.baseAddress >>> 0).toString(16) + ') (' +
    ports.join(', ') + ');\n' + decls.join('\n') +
    '\n  RV_synth u_synth(' + ports.join(', ') + ');\nendmodule\n';
}

// Synthesise the core to a generic netlist. Cached against the sources.
export async function hdlSynthesise() {
  const core = hdlCoreFiles();
  if (!core.length) throw new Error('No processor sources to synthesise.');
  const key = hdlHash(core.map(f => f.name + '\x00' + f.src).join('\x01') +
                      '|' + (layout.baseAddress >>> 0));
  if (hdlNetlist && hdlNetlist.key === key) return hdlNetlist.src;

  const runYosys = await loadYosysEngine();
  const filesIn: Record<string, string> = {};
  for (const f of core) filesIn[f.name] = f.src;
  const script = [
    'read_verilog ' + core.map(f => f.name).join(' '),
    'chparam -set PC_INIT 32\'h' + (layout.baseAddress >>> 0).toString(16) + ' RV',
    'synth -top RV',
    'write_verilog -noattr netlist.v',
    'stat',
  ].join('; ');

  const yosysOut: string[] = [];
  const sink = (b: Uint8Array | null) => yosysOut.push(new TextDecoder().decode(b || new Uint8Array()));
  hdlStatus('synthesising …', 'busy');
  const t0 = performance.now();
  let filesOut: Record<string, string>;
  try {
    filesOut = await runYosys(['-p', script], filesIn, { stdout: sink, stderr: sink });
  } catch (e) {
    filesOut = (e as { files?: Record<string, string> } | null)?.files || {};
    const text = yosysOut.join('');
    const err = text.split('\n').filter(l => /^ERROR/.test(l));
    hdlLog(err.length ? err.join('\n') : text.split('\n').slice(-12).join('\n'), 'err');
    throw new Error('Synthesis failed' + (err.length ? ': ' + err[0] : '.'));
  }
  const text = yosysOut.join('');
  const netlist = filesOut['netlist.v'];
  if (!netlist) throw new Error('Synthesis produced no netlist.');

  for (const l of text.split('\n')) {
    if (/^Warning:/.test(l)) hdlLog(l, 'warn');
  }
  // `stat` reports the top module's own cell count, submodules excluded.
  const cells = /^\s*(\d+)\s+cells\s*$/m.exec(text.slice(text.lastIndexOf('=== RV ===')));
  hdlLog('Synthesised the core in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s' +
    (cells ? ', ' + Number(cells[1]).toLocaleString() + ' gates in the top module' : '') + '.', 'sys');

  const src = hdlAddParamShim(netlist);
  hdlNetlist = { key, src };
  hdlNetlistVvp = null;
  return src;
}

// Compile the netlist against the real Wrapper and the generated
// testbench. The register view is dropped: synthesis turns the register
// file into logic, so there is no array left to reach into.
export async function hdlNetlistBinary() {
  const netlist = await hdlSynthesise();
  const wrapper = hdlFindWrapper();
  if (!wrapper) throw new Error('No Wrapper among the sources.');
  const tb = hdlBuildTestbench({ regBankPath: null });
  const gen = (byId<HTMLSelectElement>('hdlGeneration') || {}).value || '2005';
  const key = hdlHash(gen + '|' + netlist + '|' + wrapper.src + '|' + tb);
  if (hdlNetlistVvp && hdlNetlistVvp.key === key) return hdlNetlistVvp.vvp;

  hdlStatus('compiling the netlist …', 'busy');
  const pp = await hdlPreprocess([
    { name: 'netlist.v', src: netlist },
    { name: wrapper.name, src: wrapper.src },
    { name: 'cg3207_hdl_tb.v', src: tb },
  ]);
  const c = await hdlCompile(pp.src, gen);
  if (!c.vvp) {
    hdlLog(c.err || 'The synthesised netlist did not compile.', 'err');
    throw new Error('The synthesised netlist did not compile.');
  }
  hdlNetlistVvp = { key: key, vvp: c.vvp };
  return c.vvp;
}

// The observable behaviour of a run: the instruction stream, memory
// writes and peripheral activity. Register writes are excluded - the
// netlist has no register file to report them from.
export function hdlObservable(stdout: any) {
  return String(stdout || '').split('\n')
    .filter(l => /^@@[IMLSTO] /.test(l))
    .map(l => l.trim());
}

// What the panels are currently showing, for every user-facing message.
export function hdlModeLabel() {
  return hdlConfig.synthEnabled ? 'behavioural + post-synthesis' : 'behavioural';
}

// Index of the first event where two runs disagree, or -1 if identical.
export function hdlFirstDifference(a: string | any[], b: string | any[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return i;
  }
  return -1;
}

// Run the netlist with the same environment as the RTL run and compare.
export async function hdlPostSynthCheck(rtlOut: string | null, budget: any, traceLvl: number, memFiles: { 'AA_IROM.mem': string; 'AA_DMEM.mem': string; }) {
  const vvp = await hdlNetlistBinary();
  hdlStatus('simulating the netlist …', 'busy');
  const t0 = performance.now();
  const plus = hdlPlusargs(budget, traceLvl);
  const files = Object.assign({}, memFiles, {
    'stim.mem': hdlStimFile(), 'uart_rx.mem': hdlRxFile(),
  });
  const s = await hdlSimulate(vvp, files, plus);
  const ms = performance.now() - t0;

  const a = hdlObservable(rtlOut), b = hdlObservable(s.out);
  const at = hdlFirstDifference(a, b);
  if (at < 0) {
    hdlLog('Post-synthesis check: the netlist matches your RTL over ' +
      a.length + ' recorded events (' + ms.toFixed(0) + ' ms).', 'sys');
    setStatus('Synthesised netlist matches the RTL', 'success');
    return { ok: true, events: a.length };
  }
  hdlLog('Post-synthesis check: the netlist DIVERGES from your RTL.', 'err');
  hdlLog('  first difference at event ' + at + ' of ' + Math.max(a.length, b.length), 'err');
  hdlLog('  RTL     : ' + (a[at] === undefined ? '(nothing further)' : a[at]), 'err');
  hdlLog('  netlist : ' + (b[at] === undefined ? '(nothing further)' : b[at]), 'err');
  hdlLog('This is where the design behaves differently once synthesised - ' +
    'usually an inferred latch, an incomplete sensitivity list, or a race ' +
    'between blocking assignments. Check the synthesis lint above.', 'warn');
  setStatus('Synthesised netlist diverges from the RTL', 'error');
  return { ok: false, at: at, rtl: a[at], netlist: b[at] };
}
