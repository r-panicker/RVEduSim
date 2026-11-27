// The waveform viewer, the HDL downloads (VCD and testbench) and the HDL
// simulation settings.

import { hdlVcdText, type HdlWave } from '../hdl/checkpoints';
import { HDL_MAX_CYCLES, HDL_VL_MAX_RUN, hdlCyclesFor, hdlLog, hdlNative, hdlStatus } from '../hdl/engine';
import { hdlQueueResim } from '../hdl/inputs';
import { hdlDiscoverRegBank, hdlMemFiles } from '../hdl/memory-images';
import { hdlCurrentInputs, hdlDiscardTrace, hdlWithBusy } from '../hdl/run';
import { hdlCurrentCycle, hdlSeek } from '../hdl/seek';
import { hdlActivity, hdlBuild, hdlConfig, hdlRec, hdlSources, hdlRecording } from '../hdl/state';
import { hdlPostSynthCheck, loadYosysEngine } from '../hdl/synthesis';
import { hdlBuildTestbench } from '../hdl/testbench';
import { hdlFindWrapper } from '../hdl/verilog';
import { loadProgram } from '../machine/reset';
import { program, ui } from '../machine/state';
import { updateDatapathPanelAvailability, updateVizButton } from './datapath';
import { setStatus } from './editor';
import { updateWaveformPanelAvailability } from './examples-language';
import { downloadTextFile } from './execution';
import { escapeHtml, mobileMode, panelDock, setMobileTab, setPanelVisible } from './panels';
import { updateToolbarButtonStates } from './run-control';
import { byId, targetEl } from './dom';
import { redraw } from './views.svelte';
import { errorMessage } from '../errors';

export function hdlDownloadVcd() {
  if (!hdlBuild.lastVcd) return;
  downloadTextFile('cg3207_hdl.vcd', hdlVcdText(hdlBuild.lastVcd) ?? '');
}

// ---- Waveforms -------------------------------------------------------
// The testbench already dumps a VCD of the whole hierarchy behind its
// +VCD plusarg, and `hdlTrace.steps[i].cyc` is the same cycle count the
// VCD timestamps, so the waveform strip is a viewer over data the run has
// already produced - no second simulation, and a cursor that is simply
// hdlCurrentCycle().
export const WAVE_H_KEY = 'rvsim.waveHeight.v1';
export const WAVE_OPEN_KEY = 'rvsim.waveOpen.v1';
export const WAVE_SIG_KEY = 'rvsim.waveSignals.v1';
export const WAVE_H_DEFAULT = 240;
export const WAVE_ROW_H = 22;      // must match .wave-name's height
export const WAVE_AXIS_H = 20;     // must match .wave-names-axis's height
export const WAVE_DEFAULT_SPAN = 40;   // cycles across, until the user zooms
export const WAVE_NARROW_SPAN = 12;    // ...and on a phone, where the canvas is a third as wide

export function waveDefaultSpan() {
  return mobileMode() ? WAVE_NARROW_SPAN : WAVE_DEFAULT_SPAN;
}

// Resolved against the parsed VCD by name, so a Wrapper that renames or
// omits one of these simply shows fewer rows rather than failing.
export const WAVE_DEFAULT_SIGNALS = [
  'CLK', 'RESET', 'dut.PC', 'dut.Instr', 'dut.MemWrite_out',
  'LED_OUT', 'SEVENSEGHEX', 'UART_TX'
];

export let waveOpen = false;
export let waveParsed: ParsedVcd | null = null;
export let waveParsedFrom: HdlWave | null = null;   // the waveform it was parsed from
export let waveParsedAt = 0, waveParseMs = 0;
export let waveSignals: string[] = [];   // full dotted paths, in display order
export let waveStart = 0;           // leftmost cycle on screen
export let waveSpan = waveDefaultSpan();
// Once the span has been chosen deliberately, a layout change must not
// overwrite it; until then it follows whatever the layout can show.
export let waveSpanChosen = false;
export let waveDropped = 0;         // chosen signals the current VCD no longer has

// ---- VCD parsing ------------------------------------------------------
// A signal: its VCD id, its name with any bit range (ref), its dotted path.
export interface WaveVar { id: string; ref: string; path: string; width: number; name: string }
export interface WaveScope { name: string; children: Map<string, WaveScope>; vars: WaveVar[] }
// One id's changes: the times, and the value from each on.
export interface WaveChanges { times: number[]; values: string[] }
export interface ParsedVcd {
  timescale: string; vars: WaveVar[]; byPath: Map<string, WaveVar>;
  changes: Map<string, WaveChanges>; root: WaveScope; endTime: number;
}

// Narrow by design: this reads what Icarus or Verilator writes for the
// testbench hdl/testbench.ts generates, not arbitrary VCD.
export function parseVcd(text: string): ParsedVcd {
  const vars: WaveVar[] = [];
  const byPath = new Map<string, WaveVar>();
  const changes = new Map<string, WaveChanges>();
  const root: WaveScope = { name: '', children: new Map(), vars: [] };
  const scopeStack: WaveScope[] = [];
  let node = root;
  let timescale = '';
  let endTime = 0;
  let t = 0;

  // The header is parsed as tokens rather than lines: Icarus wraps
  // $timescale and can wrap $var, so a line-at-a-time reader would miss
  // declarations depending only on how long a signal's name happened to be.
  const endDefs = text.indexOf('$enddefinitions');
  const header = endDefs >= 0 ? text.slice(0, endDefs) : text;
  const tok = header.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tok.length; i++) {
    const cmd = tok[i];
    if (cmd === '$timescale') {
      const parts: string[] = [];
      while (++i < tok.length && tok[i] !== '$end') parts.push(tok[i]);
      timescale = parts.join('');
    } else if (cmd === '$scope') {
      const nm = tok[i + 2] || '?';
      let child = node.children.get(nm);
      if (!child) { child = { name: nm, children: new Map(), vars: [] }; node.children.set(nm, child); }
      scopeStack.push(node);
      node = child;
      while (++i < tok.length && tok[i] !== '$end') { /* skip to $end */ }
    } else if (cmd === '$upscope') {
      node = scopeStack.pop() || root;
      while (++i < tok.length && tok[i] !== '$end') { /* skip to $end */ }
    } else if (cmd === '$var') {
      // $var <type> <width> <id> <ref> [<bit range>] $end
      const width = parseInt(tok[i + 2], 10);
      const id = tok[i + 3];
      const name = tok[i + 4];
      const range = (tok[i + 5] && tok[i + 5] !== '$end') ? tok[i + 5] : '';
      if (id && name) {
        const scopePath: string[] = [];
        for (const s of scopeStack) if (s.name) scopePath.push(s.name);
        if (node.name) scopePath.push(node.name);
        const path = scopePath.concat(name).join('.');
        const v = { id, ref: name + range, path, width: Number.isFinite(width) ? width : 1, name };
        vars.push(v);
        node.vars.push(v);
        // A path carries several ids only in pathological files; first wins.
        if (!byPath.has(path)) byPath.set(path, v);
      }
      while (++i < tok.length && tok[i] !== '$end') { /* skip to $end */ }
    }
  }

  const record = (id: string, value: string) => {
    let c = changes.get(id);
    if (!c) { c = { times: [], values: [] }; changes.set(id, c); }
    // Icarus can emit the same value twice at one timestamp; keeping only
    // real transitions keeps the binary search below honest.
    const n = c.times.length;
    if (n && c.times[n - 1] === t) { c.values[n - 1] = value; return; }
    if (n && c.values[n - 1] === value) return;
    c.times.push(t);
    c.values.push(value);
  };

  // Value changes: one per line, which is what every VCD writer emits.
  const body = endDefs >= 0 ? text.slice(text.indexOf('$end', endDefs) + 4) : '';
  const lines = body.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line) continue;

    const c0 = line[0];
    if (c0 === '#') {
      const nt = parseInt(line.slice(1), 10);
      if (Number.isFinite(nt)) { t = nt; if (t > endTime) endTime = t; }
      continue;
    }
    if (c0 === '$') continue;   // $dumpvars / $end / $dumpoff wrappers
    if (c0 === 'b' || c0 === 'B' || c0 === 'r' || c0 === 'R') {
      const sp = line.indexOf(' ');
      if (sp > 0) record(line.slice(sp + 1).trim(), line.slice(0, sp));
      continue;
    }
    // Scalar: one value character immediately followed by the id.
    record(line.slice(1).trim(), c0);
  }

  return { timescale, vars, byPath, changes, root, endTime };
}

// Time in the VCD is whatever the testbench's timescale makes it; what
// the UI counts in is cycles. Derive the ratio from CLK's own edges
// rather than assuming the stock testbench's 10, so an edited clock
// cannot silently slide the cursor off the instruction it marks.
export function waveTicksPerCycle(p: ParsedVcd | null) {
  const clk = p && (p.byPath.get('cg3207_hdl_tb.CLK') ||
    p.vars.find(v => v.name === 'CLK' || v.name === 'clk'));
  const c = clk && p.changes.get(clk.id);
  if (!c || c.times.length < 3) return 10;
  // Two transitions make a full period.
  const period = c.times[2] - c.times[0];
  return period > 0 ? period : 10;
}

// Cycle c starts at a rising edge (the testbench's cycle 0 at the last
// one in reset), so a cycle's box on the waveform is the instruction that
// executes in it. The offset of those edges is read from CLK too.
export function waveCycleT0(p: ParsedVcd | null) {
  const tpc = waveTicksPerCycle(p);
  const clk = p && (p.byPath.get('cg3207_hdl_tb.CLK') ||
    p.vars.find(v => v.name === 'CLK' || v.name === 'clk'));
  const c = clk && p.changes.get(clk.id);
  if (c) for (let i = 0; i < c.times.length; i++) {
    if (c.values[i] === '1') return ((c.times[i] % tpc) + tpc) % tpc;
  }
  return tpc / 2;
}
export function waveTimeOfCycle(p: ParsedVcd, cycle: number) { return cycle * waveTicksPerCycle(p) + waveCycleT0(p); }
export function waveCycleOfTime(p: ParsedVcd, t: number) { return (t - waveCycleT0(p)) / waveTicksPerCycle(p); }

export function waveEnsureParsed() {
  if (!hdlBuild.lastVcd) { waveParsed = null; waveParsedFrom = null; return null; }
  if (waveParsed && waveParsedFrom === hdlBuild.lastVcd) return waveParsed;
  // A run recorded in stretches changes the waveform after each one;
  // parsing all of it every time would take most of the run's time.
  if (waveParsed && hdlActivity.chunked && performance.now() - waveParsedAt < 10 * waveParseMs) return waveParsed;
  const t0 = performance.now();
  const parsed = waveParsed = parseVcd(hdlVcdText(hdlBuild.lastVcd) ?? '');
  waveParsedFrom = hdlBuild.lastVcd;
  waveParsedAt = performance.now();
  waveParseMs = waveParsedAt - t0;
  waveApplySignalChoice(parsed);
  return parsed;
}

// A chosen set survives a re-run, and a re-run over edited Verilog can
// legitimately no longer have a signal. Drop those, but count them, so a
// shrinking list is reported rather than silent.
export function waveApplySignalChoice(p: ParsedVcd) {
  const chosen = waveLoadSignals();
  if (chosen && chosen.length) {
    const kept = chosen.filter(path => p.byPath.has(path));
    waveDropped = chosen.length - kept.length;
    if (kept.length) { waveSignals = kept; return; }
  }
  waveDropped = 0;
  waveSignals = waveResolveDefaults(p);
}

export function waveResolveDefaults(p: ParsedVcd) {
  const out: string[] = [];
  for (const want of WAVE_DEFAULT_SIGNALS) {
    // Match on the tail of the path so 'dut.PC' finds it under whatever
    // the top-level testbench scope happens to be called.
    const hit = p.vars.find(v => v.path === want || v.path.endsWith('.' + want));
    if (hit && !out.includes(hit.path)) out.push(hit.path);
  }
  return out;
}

export function waveLoadSignals(): string[] | null {
  try { return JSON.parse(localStorage.getItem(WAVE_SIG_KEY) || 'null'); }
  catch (e) { return null; }
}

export function waveSaveSignals() {
  try { localStorage.setItem(WAVE_SIG_KEY, JSON.stringify(waveSignals)); }
  catch (e) { /* private mode */ }
}

export function waveAddSignal(path: string) {
  if (!waveParsed || !waveParsed.byPath.has(path) || waveSignals.includes(path)) return;
  waveSignals.push(path);
  waveSaveSignals();
  updateWaveView();
  renderWavePicker();
}

export function waveRemoveSignal(path: string) {
  const i = waveSignals.indexOf(path);
  if (i < 0) return;
  waveSignals.splice(i, 1);
  waveSaveSignals();
  updateWaveView();
  renderWavePicker();
}

export function waveToggleSignal(path: string) {
  if (waveSignals.includes(path)) waveRemoveSignal(path); else waveAddSignal(path);
}

// Back to the defaults, which is the way out of an empty or unhelpful set.
export function waveResetSignals() {
  try { localStorage.removeItem(WAVE_SIG_KEY); } catch (e) { /* private mode */ }
  if (waveParsed) { waveDropped = 0; waveSignals = waveResolveDefaults(waveParsed); }
  updateWaveView();
  renderWavePicker();
}

// Index of the last change at or before `time`, or -1 before the first.
export function waveChangeIndexAt(c: WaveChanges, time: number) {
  let lo = 0, hi = c.times.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c.times[mid] <= time) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

// Last value at or before `time`; null before the signal's first change.
export function waveValueAt(p: ParsedVcd, id: string, time: number) {
  const c = p.changes.get(id);
  if (!c || !c.times.length) return null;
  const i = waveChangeIndexAt(c, time);
  return i < 0 ? null : c.values[i];
}

// 'b1010' -> 'a'; 'x'/'z' runs stay symbolic rather than lying with a 0.
export function waveFormatValue(raw: string | null | undefined, width: number) {
  if (raw === null || raw === undefined) return '';
  if (raw.length === 1) return raw;
  const bits = raw.slice(1);
  if (/[xX]/.test(bits)) return 'x';
  if (/[zZ]/.test(bits)) return 'z';
  if (raw[0] === 'r' || raw[0] === 'R') return bits;
  const padded = bits.padStart(width || bits.length, bits[0] === '1' ? '0' : bits[0]);
  let hex = '';
  for (let i = padded.length; i > 0; i -= 4) {
    const chunk = padded.slice(Math.max(0, i - 4), i);
    hex = parseInt(chunk, 2).toString(16) + hex;
  }
  return hex || '0';
}

// ---- The dock ---------------------------------------------------------
export function waveDockEl() { return byId('waveDock'); }

export function setWaveHeight(px: number | null, persist: boolean) {
  const max = Math.max(120, window.innerHeight - 220);
  const h = Math.max(120, Math.min(px ?? WAVE_H_DEFAULT, max));
  setWaveView({ flex: '0 0 ' + h + 'px' });
  if (persist) { try { localStorage.setItem(WAVE_H_KEY, String(h)); } catch (e) { /* private mode */ } }
}

export function waveSavedHeight() {
  let saved: number | null = null;
  try { saved = parseInt(localStorage.getItem(WAVE_H_KEY) || '', 10); } catch (e) { saved = null; }
  return Number.isFinite(saved) ? saved : WAVE_H_DEFAULT;
}

// setWaveHeight writes an inline flex, which outranks any rule, so folding
// and the in-panel layout have to clear it rather than style around it.
export function waveApplyDockSize() {
  if (waveInPanel() || !document.body.classList.contains('wave-open')) {
    setWaveView({ flex: null });
  } else {
    setWaveHeight(waveSavedHeight(), false);
  }
}

// Dragging the bar above the strip. It grows upwards, so dragging up makes
// it taller.
export function onWaveResizeStart(e: PointerEvent) {
  const bar = e.currentTarget as HTMLElement;
  const el = waveDockEl();
  if (!el) return;
  const startY = e.clientY, startH = el.getBoundingClientRect().height;
  const move = (ev: PointerEvent) => { setWaveHeight(startH + (startY - ev.clientY), false); drawWaveforms(); };
  const up = () => {
    bar.classList.remove('dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    setWaveHeight(el.getBoundingClientRect().height, true);
    drawWaveforms();
  };
  bar.classList.add('dragging');
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  e.preventDefault();
}

export function onWaveResizeReset() {
  setWaveHeight(WAVE_H_DEFAULT, true);
  drawWaveforms();
}

// Whether the strip was open when the page was last left.
export function initWaveDock() {
  try { waveOpen = localStorage.getItem(WAVE_OPEN_KEY) === '1'; } catch (e) { waveOpen = false; }
  applyWaveOpen();
}

export function applyWaveOpen() {
  // Only ever open in HDL mode: there are no waveforms to show otherwise.
  const on = waveOpen && ui.engine === 'hdl';
  document.body.classList.toggle('wave-open', on);
  if (waveView.foldTitle !== 'Hide the waveform') { waveView = { ...waveView, foldTitle: 'Hide the waveform' }; redraw('waveform'); }
  if (typeof updateVizButton === 'function') updateVizButton();
  waveApplyDockSize();
  // As a panel it is shown by its tab, not by folding.
  if (on || waveInPanel()) updateWaveView();
}

export function waveInPanel() {
  return document.body.classList.contains('wave-in-panel');
}

export function toggleWaveDock() {
  waveOpen = !waveOpen;
  try { localStorage.setItem(WAVE_OPEN_KEY, waveOpen ? '1' : '0'); } catch (e) { /* private mode */ }
  applyWaveOpen();
  // On mobile the whole page scrolls and the strip lands past the panels,
  // so opening it would otherwise look like nothing happened.
  if (waveOpen && mobileMode()) {
    const el = waveDockEl();
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }
}

// A run's waveform is the one thing it produces that no other panel shows,
// so finishing one brings it into view: the dock on desktop, the tab on
// mobile, where the strip is a panel.
export function waveRevealForRun() {
  if (mobileMode()) {
    if (!panelDock.waveform) return;
    if (!panelDock.waveform.visible) setPanelVisible('waveform', true);
    setMobileTab('waveform');
    return;
  }
  if (!waveOpen) {
    waveOpen = true;
    try { localStorage.setItem(WAVE_OPEN_KEY, '1'); } catch (e) { /* private mode */ }
  }
  applyWaveOpen();
}

// The button belongs to HDL mode, the way Locals belongs to C mode.
export function updateWaveAvailability() {
  if (typeof updateWaveformPanelAvailability === 'function') updateWaveformPanelAvailability();
  if (document.body.dataset.booted) updateDatapathPanelAvailability();
  applyWaveOpen();
}

// Turning the dump on mid-session needs the run replayed to produce one;
// with no run recorded yet, the next Run produces it anyway.
export function waveEnableVcdAndRerun() {
  setHdlDumpVcd(true);
  const cb = byId<HTMLInputElement>('hdlVcd');
  if (cb) cb.checked = true;
  if (hdlRec.trace) hdlQueueResim('re-simulated with the VCD dump on');
}

export function updateWaveView() {
  const dock = waveDockEl();
  if (!dock || !(document.body.classList.contains('wave-open') || waveInPanel())) return;
  waveApplyDefaultSpan();
  const say = (notice: WaveNotice) => {
    waveView = { ...waveView, notice, info: '', empty: true };
    redraw('waveform');
    const box = byId<HTMLInputElement>('waveCycleInput');
    if (box) box.value = '';
  };

  if (!hdlConfig.dumpVcd) { say('vcdOff'); return; }
  const p = waveEnsureParsed();
  if (!p) { say('noRun'); return; }
  if (!waveSignals.length) { say('noSignals'); return; }

  if (waveView.notice || waveView.empty) { waveView = { ...waveView, notice: null, empty: false }; redraw('waveform'); }
  const cursor = Math.min(hdlCurrentCycle(), waveActiveEndCycle());

  // Follow the cursor: only move the window when it walks off the edge,
  // so stepping within view does not scroll under the reader.
  if (cursor < waveStart || cursor >= waveStart + waveSpan) {
    waveStart = Math.max(0, cursor - Math.floor(waveSpan / 2));
  }
  waveClampStart();
  updateWaveHeaderAndDraw();
  renderWavePicker();
}

// ---- Signal picker ----------------------------------------------------
// A flat filtered list rather than an expandable tree: at seven levels
// deep, typing "alu" beats clicking down four scopes, and the full path
// on every row keeps two instances of a module distinguishable.
export const WAVE_PICKER_LIMIT = 200;

// What the dock's header, signal picker, notice and signal names show
// (Waveform.svelte); the waveform itself is drawn on its canvas here.
export type WaveNotice = 'vcdOff' | 'noRun' | 'noSignals';
export type WavePickerItem = { path: string; on: boolean; width: string };
export let waveView = {
  notice: null as WaveNotice | null,
  info: '',
  foldTitle: 'Fold the waveform strip',
  pickerOpen: false,
  // null: no run to list the signals of.
  picker: null as { items: WavePickerItem[]; more: number } | null,
  names: [] as { path: string; label: string }[],
  // Nothing to draw: the notice says why.
  empty: false,
  // The strip's height while it is open at the bottom; null leaves it to
  // the stylesheet.
  flex: null as string | null,
};
function setWaveView(part: Partial<typeof waveView>) {
  waveView = { ...waveView, ...part };
  redraw('waveform');
}

export function toggleWavePicker() {
  waveView = { ...waveView, pickerOpen: !waveView.pickerOpen };
  redraw('waveform');
  if (waveView.pickerOpen) {
    renderWavePicker();
    const f = byId<HTMLInputElement>('wavePickerFilter');
    if (f) f.focus();
  }
}

export function renderWavePicker() {
  if (!waveView.pickerOpen) return;
  let picker: typeof waveView.picker = null;
  if (waveParsed) {
    const f = byId<HTMLInputElement>('wavePickerFilter');
    const q = (f && f.value || '').toLowerCase();
    const hits = waveParsed.vars.filter((v: { path: string; }) => !q || v.path.toLowerCase().includes(q));
    picker = {
      items: hits.slice(0, WAVE_PICKER_LIMIT).map(v => ({
        path: v.path, on: waveSignals.includes(v.path), width: v.width > 1 ? '[' + (v.width - 1) + ':0]' : '1',
      })),
      more: Math.max(0, hits.length - WAVE_PICKER_LIMIT),
    };
  }
  waveView = { ...waveView, picker };
  redraw('waveform');
}

export function initWavePicker() {
  // Clicking away closes it, the way any dropdown behaves - otherwise the
  // only way out is a button, and the nearest button is easy to miss.
  document.addEventListener('pointerdown', e => {
    if (!waveView.pickerOpen) return;
    if (targetEl(e)?.closest('#wavePicker') || targetEl(e)?.closest('#waveAddBtn')) return;
    toggleWavePicker();
  });
}

// ---- Zoom, pan and click-to-seek --------------------------------------
export function waveSetSpan(n: number, anchorCycle?: number | undefined) {
  const p = waveParsed;
  if (!p) return;
  waveSpanChosen = true;
  const last = waveActiveEndCycle();
  const span = Math.max(2, Math.min(Math.round(n), Math.max(2, last + 1)));
  // Keep whatever cycle the user pointed at under the pointer, so zooming
  // stays about the thing being looked at rather than the left edge.
  const anchor = (anchorCycle === undefined) ? hdlCurrentCycle() : anchorCycle;
  const frac = waveSpan ? (anchor - waveStart) / waveSpan : 0.5;
  waveSpan = span;
  waveStart = Math.round(anchor - frac * span);
  waveClampStart();
  updateWaveHeaderAndDraw();
}

// Where the waveform stops being worth showing. The recording runs to the
// cycle budget, but once the PC stops advancing - a halt, or a self-loop -
// the trace records nothing more, and the cycles after that are the same
// instruction spinning. Drawing them suggests there is something left to
// step to, so they are marked off instead.
export function waveActiveEndCycle() {
  const p = waveParsed;
  if (!p) return 0;
  const recorded = Math.max(0, Math.floor(waveCycleOfTime(p, p.endTime)));
  const t = hdlRec.trace;
  if (!t || !t.steps.length) return recorded;
  // +1 so the last instruction's own cycle is fully drawn.
  const lastStep = t.steps[t.steps.length - 1].cyc + 1;
  return Math.max(1, Math.min(recorded, lastStep));
}

// Clamps the whole viewport, span included: a re-run can shrink the active
// region (a program that now halts sooner), and a span left wider than
// what is left to show would read as "showing 0-39 of 7".
export function waveClampStart() {
  const p = waveParsed;
  if (!p) return;
  const last = waveActiveEndCycle();
  waveSpan = Math.max(2, Math.min(waveSpan, last + 1));
  waveStart = Math.max(0, Math.min(waveStart, Math.max(0, last - waveSpan + 1)));
}

export function waveZoom(factor: number) { waveSetSpan(waveSpan * factor); }

// Half a window per press, so there is always an overlap to line the new
// view up against. Touch drag pans too, but it is not discoverable and it
// fights the panel's own scrolling.
export function wavePan(dir: number) {
  if (!waveParsed) return;
  waveStart += dir * Math.max(1, Math.round(waveSpan / 2));
  waveClampStart();
  updateWaveHeaderAndDraw();
}

export function waveApplyDefaultSpan() {
  if (waveSpanChosen) return;
  waveSpan = waveDefaultSpan();
  waveClampStart();
}

export function waveFit() {
  if (!waveParsed) return;
  waveSpanChosen = true;
  waveSpan = Math.max(2, waveActiveEndCycle() + 1);
  waveStart = 0;
  updateWaveHeaderAndDraw();
}

// The window is placed by the caller here, so unlike updateWaveView() this
// does not snap back to following the cursor.
export function updateWaveHeaderAndDraw() {
  const p = waveParsed;
  if (!p) return;
  const box = byId<HTMLInputElement>('waveCycleInput');
  if (box && document.activeElement !== box) box.value = String(hdlCurrentCycle());
  const last = waveActiveEndCycle();
  const cyc = hdlCurrentCycle();
  const first = waveFirstCycle(p);
  // Once the PC stops, the hardware keeps counting cycles while the
  // waveform stops; saying only "cycle 200 ... of 7" would look wrong.
  const notes: string[] = [];
  if (cyc > last) notes.push(`PC last advanced at cycle ${last - 1}`);
  if (cyc < first) notes.push(`the waveform starts at cycle ${first}`);
  if (waveDropped) {
    notes.push(`${waveDropped} chosen signal${waveDropped > 1 ? 's' : ''} not in this run`);
  }
  waveView = { ...waveView, info: notes.join(' · ') };
  redraw('waveform');
  drawWaveNames(p);
  drawWaveforms();
}

// A long run's waveform keeps only its last stretch.
export function waveFirstCycle(p: ParsedVcd) {
  let t = Infinity;
  for (const c of p.changes.values()) if (c.times.length && c.times[0] < t) t = c.times[0];
  return Number.isFinite(t) ? Math.max(0, Math.floor(waveCycleOfTime(p, t))) : 0;
}

// A cycle typed into the header goes there as a click on the waveform
// would, and puts it in the middle of the view.
export function waveGotoCycle(text: string) {
  const c = parseInt(String(text).replace(/[\s,_]/g, ''), 10);
  if (!waveParsed || !Number.isFinite(c)) { updateWaveHeaderAndDraw(); return false; }
  const end = Math.max(waveActiveEndCycle(), hdlRec.trace ? hdlRec.trace.budget : 0);
  const cyc = Math.max(0, Math.min(c, end));
  waveSeekToCycle(cyc);
  waveStart = Math.max(0, cyc - Math.floor(waveSpan / 2));
  waveClampStart();
  updateWaveHeaderAndDraw();
  return true;
}

export function waveCycleAtX(clientX: number) {
  const canvas = byId<HTMLCanvasElement>('waveCanvas');
  if (!canvas) return 0;
  const r = canvas.getBoundingClientRect();
  return waveStart + ((clientX - r.left) / Math.max(1, r.width)) * waveSpan;
}

// Clicking a waveform moves the whole simulator to that cycle: the last
// instruction that had started by then, which is the one the waveform is
// showing there.
export function waveSeekToCycle(cycle: number) {
  const t = hdlRec.trace;
  if (!t || !t.steps.length) return;
  let idx = 0;
  for (let i = 0; i < t.steps.length; i++) {
    if (t.steps[i].cyc <= cycle) idx = i; else break;
  }
  hdlSeek(idx);
}

// The Cycle box: Enter goes there, Escape leaves it, and leaving it puts
// back the cycle the simulation is at.
export function onWaveCycleKey(e: KeyboardEvent) {
  const box = e.currentTarget as HTMLInputElement;
  if (e.key === 'Enter') { e.preventDefault(); waveGotoCycle(box.value); box.blur(); }
  else if (e.key === 'Escape') box.blur();
}
export function onWaveCycleBlur() {
  if (waveParsed) updateWaveHeaderAndDraw();
}

// A plain wheel is left alone so it scrolls the signal list, which is
// what a wheel does everywhere else on the page. Zoom takes the usual
// modifier instead (ctrl, or the trackpad pinch that reports as ctrl).
export function onWaveWheel(e: WheelEvent) {
  if (!waveParsed) return;
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    waveSetSpan(waveSpan * (e.deltaY > 0 ? 1.2 : 1 / 1.2), waveCycleAtX(e.clientX));
  } else if (e.shiftKey) {
    e.preventDefault();
    const step = Math.max(1, Math.round(waveSpan * 0.15));
    waveStart += (e.deltaY > 0 || e.deltaX > 0) ? step : -step;
    waveClampStart();
    updateWaveHeaderAndDraw();
  }
}

// A drag on the waves pans them; a press that stays put seeks there.
let wavePan0: { x: number; start: number; moved: boolean } | null = null;
export let wavePanning = false;
export function onWaveDown(e: PointerEvent) {
  if (!waveParsed) return;
  wavePan0 = { x: e.clientX, start: waveStart, moved: false };
  (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
}
export function onWaveMove(e: PointerEvent) {
  if (!wavePan0) return;
  const dx = e.clientX - wavePan0.x;
  if (Math.abs(dx) > 3) {
    wavePan0.moved = true;
    if (!wavePanning) { wavePanning = true; redraw('waveform'); }
    const r = (e.currentTarget as Element).getBoundingClientRect();
    waveStart = Math.round(wavePan0.start - (dx / Math.max(1, r.width)) * waveSpan);
    waveClampStart();
    updateWaveHeaderAndDraw();
  }
}
export function onWaveUp(e: PointerEvent) {
  if (!wavePan0) return;
  const moved = wavePan0.moved;
  onWaveCancel();
  if (!moved) waveSeekToCycle(Math.floor(waveCycleAtX(e.clientX)));
}
export function onWaveCancel() {
  wavePan0 = null;
  if (wavePanning) { wavePanning = false; redraw('waveform'); }
}

export function waveShortLabel(path: string) {
  // The full path is in the title; the gutter shows the shortest tail
  // that still tells two instances apart.
  const parts = path.split('.');
  if (parts.length <= 2) return parts[parts.length - 1];
  const tail2 = parts.slice(-2).join('.');
  const clashes = waveSignals.filter(o => o !== path && o.endsWith('.' + parts[parts.length - 1])).length;
  return clashes ? tail2 : parts[parts.length - 1];
}

export function drawWaveNames(p: ParsedVcd) {
  waveView = { ...waveView, names: waveSignals.map(path => {
    const v = p.byPath.get(path);
    const bits = v && v.width > 1 ? `[${v.width - 1}:0]` : '';
    return { path, label: waveShortLabel(path) + (bits ? ' ' + bits : '') };
  }) };
  redraw('waveform');
}

export function drawWaveforms() {
  const canvas = byId<HTMLCanvasElement>('waveCanvas');
  const p = waveParsed;
  if (!canvas || !p || !document.body.classList.contains('wave-open')) return;
  // The rows define the height; the body scrolls if the strip is shorter.
  // Set before measuring, so the first draw is already the right size.
  const needed = WAVE_AXIS_H + waveSignals.length * WAVE_ROW_H;
  canvas.style.height = needed + 'px';
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, needed);
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#1e1e2e';
  ctx.fillRect(0, 0, w, h);

  const pxPerCycle = w / waveSpan;
  const xOf = (cycle: number) => (cycle - waveStart) * pxPerCycle;
  const activeEnd = waveActiveEndCycle();
  const deadX = xOf(activeEnd);

  // ---- cycle grid and axis ----
  ctx.font = '10px Consolas, "Courier New", monospace';
  ctx.textBaseline = 'middle';
  // A label every cycle is unreadable below ~28px per cycle.
  const labelEvery = Math.max(1, Math.ceil(28 / pxPerCycle));
  // Minor lines closer than a few pixels are noise, and over a long
  // recording there would be one per cycle; step by the label spacing.
  const gridStep = pxPerCycle >= 4 ? 1 : labelEvery;
  ctx.strokeStyle = '#313244';
  ctx.lineWidth = 1;
  for (let c = Math.ceil(waveStart / gridStep) * gridStep; c <= waveStart + waveSpan; c += gridStep) {
    const x = Math.round(xOf(c)) + 0.5;
    const major = (c % labelEvery) === 0;
    ctx.strokeStyle = major ? '#313244' : 'rgba(49,50,68,0.4)';
    ctx.beginPath();
    ctx.moveTo(x, major ? 0 : WAVE_AXIS_H);
    ctx.lineTo(x, h);
    ctx.stroke();
    if (major) {
      ctx.fillStyle = '#6c7086';
      ctx.fillText(String(c), x + 3, WAVE_AXIS_H / 2);
    }
  }
  ctx.strokeStyle = '#313244';
  ctx.beginPath();
  ctx.moveTo(0, WAVE_AXIS_H + 0.5);
  ctx.lineTo(w, WAVE_AXIS_H + 0.5);
  ctx.stroke();

  // ---- one row per signal ----
  waveSignals.forEach((path, i) => {
    const v = p.byPath.get(path);
    if (!v) return;
    const top = WAVE_AXIS_H + i * WAVE_ROW_H;
    const pad = 4;
    const yHi = top + pad;
    const yLo = top + WAVE_ROW_H - pad - 1;

    ctx.strokeStyle = 'rgba(49,50,68,0.45)';
    ctx.beginPath();
    ctx.moveTo(0, top + WAVE_ROW_H - 0.5);
    ctx.lineTo(w, top + WAVE_ROW_H - 0.5);
    ctx.stroke();

    const c = p.changes.get(v.id);
    if (!c || !c.times.length) return;

    // Walk the transitions that fall in view, plus the one before it so
    // the trace starts at the value actually held at the left edge.
    const tStart = waveTimeOfCycle(p, waveStart);
    const tEnd = waveTimeOfCycle(p, Math.min(waveStart + waveSpan, activeEnd));
    let k = waveChangeIndexAt(c, tStart);
    if (k < 0) k = 0;

    const single = v.width === 1;
    ctx.lineWidth = 1.4;

    let prevX = 0;
    let prevVal = c.values[k];
    const drawSeg = (x0: number, x1: number, raw: string) => {
      if (x1 <= x0) return;
      const bad = raw && (raw === 'x' || raw === 'z' || raw === 'X' || raw === 'Z' || /[xXzZ]/.test(raw));
      if (single) {
        const hi = raw === '1';
        ctx.strokeStyle = bad ? '#f38ba8' : '#a6e3a1';
        const y = bad ? (yHi + yLo) / 2 : (hi ? yHi : yLo);
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
      } else {
        ctx.strokeStyle = bad ? '#f38ba8' : '#89b4fa';
        // A bus reads as a stretched hexagon: both rails plus the bevels.
        const bev = Math.min(3, (x1 - x0) / 2);
        ctx.beginPath();
        ctx.moveTo(x0, (yHi + yLo) / 2);
        ctx.lineTo(x0 + bev, yHi);
        ctx.lineTo(x1 - bev, yHi);
        ctx.lineTo(x1, (yHi + yLo) / 2);
        ctx.lineTo(x1 - bev, yLo);
        ctx.lineTo(x0 + bev, yLo);
        ctx.closePath();
        ctx.stroke();
        const text = waveFormatValue(raw, v.width);
        const avail = x1 - x0 - 2 * bev - 2;
        if (text && avail > 10) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0 + bev + 1, yHi, avail, yLo - yHi);
          ctx.clip();
          ctx.fillStyle = bad ? '#f38ba8' : '#bac2de';
          ctx.fillText(text, x0 + bev + 2, (yHi + yLo) / 2);
          ctx.restore();
        }
      }
    };

    prevX = Math.max(0, xOf(waveCycleOfTime(p, c.times[k])));
    if (c.times[k] <= tStart) prevX = 0;
    for (let j = k + 1; j < c.times.length && c.times[j] <= tEnd; j++) {
      const x = xOf(waveCycleOfTime(p, c.times[j]));
      drawSeg(prevX, x, prevVal);
      if (single) {
        // The vertical edge between levels.
        const wasHi = prevVal === '1', isHi = c.values[j] === '1';
        if (wasHi !== isHi && !/[xXzZ]/.test(prevVal) && !/[xXzZ]/.test(c.values[j])) {
          ctx.strokeStyle = '#a6e3a1';
          ctx.beginPath();
          ctx.moveTo(x, yHi);
          ctx.lineTo(x, yLo);
          ctx.stroke();
        }
      }
      prevX = x;
      prevVal = c.values[j];
    }
    drawSeg(prevX, Math.min(w, deadX), prevVal);
  });

  // Past the last instruction, mask off what is only the halted PC
  // spinning, and say so once rather than leaving a blank stretch that
  // looks like a rendering failure.
  if (deadX < w) {
    const x0 = Math.max(0, deadX);
    ctx.fillStyle = 'rgba(17, 17, 27, 0.72)';
    ctx.fillRect(x0, WAVE_AXIS_H, w - x0, h - WAVE_AXIS_H);
    ctx.strokeStyle = '#585b70';
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, WAVE_AXIS_H);
    ctx.lineTo(x0 + 0.5, h);
    ctx.stroke();
    if (w - x0 > 90) {
      ctx.fillStyle = '#6c7086';
      ctx.fillText('PC not advancing past here', x0 + 8, WAVE_AXIS_H + 12);
    }
  }

  // ---- the cursor: where the simulator is stopped ----
  // Pinned to the active region: once the program halts the run keeps
  // counting cycles, and a cursor floating inside the masked area would
  // point at nothing. It sits mid-cycle, at the falling edge, where the
  // instruction's signals have settled, rather than on the edge where
  // they change.
  const cursor = Math.min(hdlCurrentCycle() + 0.5, activeEnd);
  const cx = Math.round(xOf(cursor)) + 0.5;
  if (cx >= 0 && cx <= w) {
    ctx.strokeStyle = '#f9e2af';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();
    ctx.fillStyle = '#f9e2af';
    ctx.beginPath();
    ctx.moveTo(cx - 4, 0);
    ctx.lineTo(cx + 4, 0);
    ctx.lineTo(cx, 6);
    ctx.closePath();
    ctx.fill();
  }
}

// ---- Testbench download and settings --------------------------------
// The saved testbench replays the last recorded run's inputs. Before any
// run, or in JS mode, it starts from the inputs as they are now.
export function hdlDownloadTestbench() {
  const run = ui.engine === 'hdl' && hdlRec.trace
    ? { cycles: hdlConfig.cycleBudget, base: hdlRec.base, stim: hdlRec.stim.slice().sort((a, b) => a.cycle - b.cycle), rx: hdlRec.rx }
    : { cycles: hdlConfig.cycleBudget, base: hdlCurrentInputs(), stim: [], rx: [] };
  downloadTextFile('cg3207_hdl_tb.v', hdlBuildTestbench({ run }));
  setStatus('Saved the testbench for this run to cg3207_hdl_tb.v; it needs AA_IROM.mem and AA_DMEM.mem beside it', 'success');
}

// Cycles per Run is remembered for Verilator, Icarus, and Icarus with
// post-synthesis simulation.
export function hdlCyclesKey() { return hdlConfig.simulator === 'icarus' && hdlConfig.synthEnabled ? 'synth' : hdlConfig.simulator; }
export function hdlShowCycles() {
  hdlConfig.cycleBudget = hdlCyclesFor[hdlCyclesKey()];
  const cyc = byId<HTMLInputElement>('hdlCycles');
  if (cyc) {
    cyc.max = String(hdlConfig.simulator === 'verilator' ? HDL_VL_MAX_RUN : HDL_MAX_CYCLES);
    cyc.value = String(hdlConfig.cycleBudget);
  }
}
export function setHdlCycles(v: string) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return;
  hdlConfig.cycleBudget = Math.min(n, hdlConfig.simulator === 'verilator' ? HDL_VL_MAX_RUN : HDL_MAX_CYCLES);
  hdlCyclesFor[hdlCyclesKey()] = hdlConfig.cycleBudget;
  // Keep the field honest when the budget is set from anywhere else,
  // including the automatic extension when stepping off the end.
  const el = byId<HTMLInputElement>('hdlCycles');
  if (el && parseInt(el.value, 10) !== hdlConfig.cycleBudget) el.value = String(hdlConfig.cycleBudget);
}
export function setHdlDumpVcd(on: boolean) {
  hdlConfig.dumpVcd = !!on;
  updateWaveView();
  hdlRefreshDetail();
}
export function setHdlWaveTop(on: boolean) { hdlConfig.waveTop = !!on;   hdlRefreshDetail();
}
export function setHdlLiveWave(v: string) { hdlConfig.liveWave = v === 'live' ? 'live' : 'pause';   hdlRefreshDetail();
}
// ---- Detail presets -------------------------------------------------
// Each sets the options that cost run time. They stay visible and can be
// changed one by one, after which the preset reads Custom; with no
// waveform recorded, its two sub-settings do not count.
// A Detail preset: what a run records and checks.
export interface HdlDetail { trace: boolean; vcd: boolean; top: boolean; live: string; compare: boolean; synth: boolean }
export const HDL_DETAIL: Record<string, HdlDetail> = {
  full:     { trace: true,  vcd: true,  top: false, live: 'live',  compare: false, synth: false },
  balanced: { trace: true,  vcd: true,  top: true,  live: 'pause', compare: false, synth: false },
  fastest:  { trace: false, vcd: false, top: true,  live: 'pause', compare: false, synth: false }
};
export function hdlDetailNow(): HdlDetail {
  return { trace: hdlConfig.traceEnabled, vcd: hdlConfig.dumpVcd, top: hdlConfig.waveTop, live: hdlConfig.liveWave,
           compare: hdlConfig.compareEnabled, synth: hdlConfig.synthEnabled };
}
export function hdlDetailMatch() {
  const now = hdlDetailNow();
  for (const name in HDL_DETAIL) {
    const p = HDL_DETAIL[name];
    if ((Object.keys(p) as (keyof HdlDetail)[]).every(k => (!now.vcd && (k === 'top' || k === 'live')) || p[k] === now[k])) return name;
  }
  return 'custom';
}
// Puts every control in step with the settings, which a preset or Reset
// Defaults changes without touching the controls.
export function hdlRefreshDetail() {
  const check = (id: string, v: boolean) => { const el = byId<HTMLInputElement>(id); if (el && el.checked !== v) el.checked = v; };
  const choose = (id: string, v: string) => { const el = byId<HTMLSelectElement>(id); if (el && el.value !== v) el.value = v; };
  check('hdlTrace', hdlConfig.traceEnabled);
  check('hdlVcd', hdlConfig.dumpVcd);
  choose('hdlWaveTop', hdlConfig.waveTop ? 'top' : 'all');
  choose('hdlLiveWave', hdlConfig.liveWave);
  check('hdlCompare', hdlConfig.compareEnabled);
  check('hdlSynth', hdlConfig.synthEnabled);
  const scope = byId('hdlWaveScopeRow');
  if (scope) scope.style.display = hdlConfig.dumpVcd ? 'flex' : 'none';
  const lw = byId('hdlLiveWaveRow');
  if (lw) lw.style.display = hdlConfig.dumpVcd && hdlConfig.simulator === 'verilator' ? 'flex' : 'none';
  const sel = byId<HTMLSelectElement>('hdlDetail');
  if (sel) {
    const m = hdlDetailMatch();
    const custom = sel.querySelector<HTMLOptionElement>('option[value="custom"]');
    if (custom) custom.hidden = m !== 'custom';
    sel.value = m;
  }
}
export function setHdlDetail(name: string, quiet: boolean) {
  const p = HDL_DETAIL[name];
  if (!p) { hdlRefreshDetail(); return; }
  const now = hdlDetailNow();
  const said: string[] = [];
  if (now.vcd !== p.vcd) said.push('waveform ' + (p.vcd ? 'on' : 'off'));
  if (p.vcd && now.top !== p.top) said.push('waveform signals: ' + (p.top ? 'Wrapper only' : 'all'));
  if (p.vcd && now.live !== p.live) said.push('waveform built ' + (p.live === 'live' ? 'while running' : 'on Pause'));
  if (now.trace !== p.trace) said.push('architectural trace ' + (p.trace ? 'on' : 'off (Step, Back, breakpoints and registers need it)'));
  if (now.compare !== p.compare) said.push('cross-check ' + (p.compare ? 'on' : 'off'));
  if (now.synth !== p.synth) said.push('post-synthesis simulation ' + (p.synth ? 'on' : 'off'));
  if (now.trace !== p.trace) setHdlTrace(p.trace);
  setHdlDumpVcd(p.vcd);
  setHdlWaveTop(p.top);
  setHdlLiveWave(p.live);
  setHdlCompare(p.compare);
  if (now.synth !== p.synth) setHdlSynth(p.synth);
  hdlRefreshDetail();
  if (!quiet && said.length) hdlLog('Detail: ' + name[0].toUpperCase() + name.slice(1) + ' - ' + said.join(', ') + '.', 'sys');
}


// Which simulator builds and runs the design. Verilator needs the desktop
// app; the page shows the same choice in a browser, disabled, so that the
// two look alike.
export const hdlVerilatorAvail = !!(window.rvNative && window.rvNative.verilator);
export const HDL_SIMULATOR_KEY = 'rvsim.hdlSimulator';

export function hdlInitSimulator() {
  const sel = byId<HTMLSelectElement>('hdlSimulator');
  const row = byId('hdlSimulatorRow');
  if (!sel || !row) return;
  sel.disabled = !hdlVerilatorAvail;
  row.title = hdlVerilatorAvail
    ? 'Icarus Verilog simulates four-state logic (x and z) and starts at once. Verilator first compiles ' +
      'your design to C++, which takes several seconds each time the sources change, and then runs ' +
      '20 to 100 times faster; it is two-state, so what Icarus shows as x is 0. Post-synthesis ' +
      'simulation needs Icarus.'
    : window.rvNative ? 'This build of the desktop app has no Verilator.'
    : 'Verilator is available only in the desktop app.';
  let saved: string | null = null;
  try { saved = localStorage.getItem(HDL_SIMULATOR_KEY); } catch (e) { /* private mode */ }
  setHdlSimulator(saved === 'verilator' ? 'verilator' : 'icarus', true);
}

export function setHdlSimulator(v: string, restoring = false) {
  if (v !== 'verilator' || !hdlVerilatorAvail) v = 'icarus';
  const changed = v !== hdlConfig.simulator;
  hdlConfig.simulator = v as typeof hdlConfig.simulator;
  hdlShowCycles();
  hdlRefreshDetail();
  const sel = byId<HTMLSelectElement>('hdlSimulator');
  if (sel) sel.value = v;
  if (!restoring) { try { localStorage.setItem(HDL_SIMULATOR_KEY, v); } catch (e) { /* private mode */ } }
  const synth = byId('hdlSynthCard');
  if (synth) synth.style.display = v === 'verilator' ? 'none' : '';
  if (v === 'verilator' && hdlConfig.synthEnabled) {
    setHdlSynth(false);
    const cb = byId<HTMLInputElement>('hdlSynth');
    if (cb) cb.checked = false;
  }
  if (changed) hdlDiscardTrace();
}

export function hdlSimulatorName() {
  return hdlConfig.simulator === 'verilator' ? 'Verilator' : hdlNative ? 'Icarus Verilog' : 'Icarus/WASM';
}
export function setHdlTrace(on: boolean) {
  hdlConfig.traceEnabled = !!on;
  hdlDiscardTrace();
  updateToolbarButtonStates();
  hdlRefreshDetail();
}
export function setHdlCompare(on: boolean) { hdlConfig.compareEnabled = !!on;   hdlRefreshDetail();
}
// Ticking this is what triggers the one-off Yosys download. If a run has
// already been recorded, synthesise and check it now instead of waiting
// for the next Run.
export function setHdlSynth(on: boolean) {
  const was = hdlConfig.synthEnabled;
  hdlConfig.synthEnabled = !!on;
  hdlShowCycles();
  updateToolbarButtonStates();
  hdlRefreshDetail();
  if (!hdlConfig.synthEnabled || was) return;
  if (!hdlRec.trace || !hdlBuild.lastRtlOut) {
    loadYosysEngine().catch((e: unknown) => {
      hdlLog(errorMessage(e), 'err');
      hdlStatus('the synthesiser failed to load', 'err');
    });
    return;
  }
  hdlWithBusy(async () => {
    try {
      const wrapper = hdlFindWrapper();
      if (!wrapper) throw new Error('No Wrapper among the sources.');
      loadProgram(program.machineCode);
      const mem = hdlMemFiles(wrapper.src);
      await hdlPostSynthCheck(hdlBuild.lastRtlOut, hdlRecording().budget,
                              hdlConfig.traceEnabled ? 2 : 1, mem.files);
      hdlSeek(hdlRec.idx);
    } catch (e) {
      hdlLog(errorMessage(e), 'err');
      setStatus('Post-synthesis check failed - see the console', 'error');
    }
    return null;
  });
}
// The register path is compiled into the testbench as a hierarchical
// reference, so changing it invalidates the cached binary.
export function setHdlRegPath() { hdlBuild.vvpCache = null; hdlDiscardTrace(); }

export function hdlRefreshRegPathHint() {
  const el = byId<HTMLInputElement>('hdlRegPath');
  if (!el) return;
  const found = hdlDiscoverRegBank();
  el.placeholder = found || 'e.g. dut.RV1.RegFile1.RegBank';
  const hint = byId('hdlRegPathHint');
  if (hint) {
    hint.textContent = found
      ? 'detected automatically: ' + found
      : (hdlSources.files.length ? 'no 32-entry register array found - name the path to see registers'
                         : 'load your sources to detect the register file');
  }
}
