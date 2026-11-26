// @ts-nocheck
// The waveform viewer, the HDL downloads (VCD and testbench) and the HDL
// simulation settings.

import { hdlVcdText } from '../hdl/checkpoints';
import { HDL_MAX_CYCLES, HDL_VL_MAX_RUN, hdlCyclesFor, hdlLog, hdlNative, hdlStatus } from '../hdl/engine';
import { hdlQueueResim } from '../hdl/inputs';
import { hdlDiscoverRegBank, hdlMemFiles } from '../hdl/memory-images';
import { hdlCurrentInputs, hdlDiscardTrace, hdlWithBusy } from '../hdl/run';
import { hdlCurrentCycle, hdlSeek } from '../hdl/seek';
import { hdlActivity, hdlBuild, hdlConfig, hdlRec, hdlSources } from '../hdl/state';
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

export function hdlDownloadVcd() {
  if (!hdlBuild.lastVcd) return;
  downloadTextFile('cg3207_hdl.vcd', hdlVcdText(hdlBuild.lastVcd));
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
export let waveParsed = null;       // parseVcd() result
export let waveParsedFrom = null;   // the hdlLastVcd it was parsed from
export let waveParsedAt = 0, waveParseMs = 0;
export let waveSignals = [];        // full dotted paths, in display order
export let waveStart = 0;           // leftmost cycle on screen
export let waveSpan = waveDefaultSpan();
// Once the span has been chosen deliberately, a layout change must not
// overwrite it; until then it follows whatever the layout can show.
export let waveSpanChosen = false;
export let waveDropped = 0;         // chosen signals the current VCD no longer has

// ---- VCD parsing ------------------------------------------------------
// Narrow by design: this reads what Icarus or Verilator writes for the
// testbench hdl/testbench.ts generates, not arbitrary VCD.
export function parseVcd(text) {
  const vars = [];                // {id, ref, path, width}
  const byPath = new Map();
  const changes = new Map();      // id -> {times: [], values: []}
  const root = { name: '', children: new Map(), vars: [] };
  const scopeStack = [];
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
      const parts = [];
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
        const scopePath = [];
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

  const record = (id, value) => {
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
export function waveTicksPerCycle(p) {
  const clk = p && (p.byPath.get('cg3207_hdl_tb.CLK') ||
    p.vars.find(v => v.name === 'CLK' || v.name === 'clk'));
  const c = clk && p.changes.get(clk.id);
  if (!c || c.times.length < 3) return 10;
  // Two transitions make a full period.
  const period = c.times[2] - c.times[0];
  return period > 0 ? period : 10;
}

export function waveEnsureParsed() {
  if (!hdlBuild.lastVcd) { waveParsed = null; waveParsedFrom = null; return null; }
  if (waveParsed && waveParsedFrom === hdlBuild.lastVcd) return waveParsed;
  // A run recorded in stretches changes the waveform after each one;
  // parsing all of it every time would take most of the run's time.
  if (waveParsed && hdlActivity.chunked && performance.now() - waveParsedAt < 10 * waveParseMs) return waveParsed;
  const t0 = performance.now();
  waveParsed = parseVcd(hdlVcdText(hdlBuild.lastVcd));
  waveParsedFrom = hdlBuild.lastVcd;
  waveParsedAt = performance.now();
  waveParseMs = waveParsedAt - t0;
  waveApplySignalChoice(waveParsed);
  return waveParsed;
}

// A chosen set survives a re-run, and a re-run over edited Verilog can
// legitimately no longer have a signal. Drop those, but count them, so a
// shrinking list is reported rather than silent.
export function waveApplySignalChoice(p) {
  const chosen = waveLoadSignals();
  if (chosen && chosen.length) {
    const kept = chosen.filter(path => p.byPath.has(path));
    waveDropped = chosen.length - kept.length;
    if (kept.length) { waveSignals = kept; return; }
  }
  waveDropped = 0;
  waveSignals = waveResolveDefaults(p);
}

export function waveResolveDefaults(p) {
  const out = [];
  for (const want of WAVE_DEFAULT_SIGNALS) {
    // Match on the tail of the path so 'dut.PC' finds it under whatever
    // the top-level testbench scope happens to be called.
    const hit = p.vars.find(v => v.path === want || v.path.endsWith('.' + want));
    if (hit && !out.includes(hit.path)) out.push(hit.path);
  }
  return out;
}

export function waveLoadSignals() {
  try { return JSON.parse(localStorage.getItem(WAVE_SIG_KEY) || 'null'); }
  catch (e) { return null; }
}

export function waveSaveSignals() {
  try { localStorage.setItem(WAVE_SIG_KEY, JSON.stringify(waveSignals)); }
  catch (e) { /* private mode */ }
}

export function waveAddSignal(path) {
  if (!waveParsed || !waveParsed.byPath.has(path) || waveSignals.includes(path)) return;
  waveSignals.push(path);
  waveSaveSignals();
  updateWaveView();
  renderWavePicker();
}

export function waveRemoveSignal(path) {
  const i = waveSignals.indexOf(path);
  if (i < 0) return;
  waveSignals.splice(i, 1);
  waveSaveSignals();
  updateWaveView();
  renderWavePicker();
}

export function waveToggleSignal(path) {
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
export function waveChangeIndexAt(c, time) {
  let lo = 0, hi = c.times.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c.times[mid] <= time) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

// Last value at or before `time`; null before the signal's first change.
export function waveValueAt(p, id, time) {
  const c = p.changes.get(id);
  if (!c || !c.times.length) return null;
  const i = waveChangeIndexAt(c, time);
  return i < 0 ? null : c.values[i];
}

// 'b1010' -> 'a'; 'x'/'z' runs stay symbolic rather than lying with a 0.
export function waveFormatValue(raw, width) {
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
export function waveDockEl() { return document.getElementById('waveDock'); }

export function setWaveHeight(px, persist) {
  const dock = waveDockEl();
  if (!dock) return;
  const max = Math.max(120, window.innerHeight - 220);
  const h = Math.max(120, Math.min(px, max));
  dock.style.flex = '0 0 ' + h + 'px';
  if (persist) { try { localStorage.setItem(WAVE_H_KEY, String(h)); } catch (e) { /* private mode */ } }
}

export function waveSavedHeight() {
  let saved = null;
  try { saved = parseInt(localStorage.getItem(WAVE_H_KEY) || '', 10); } catch (e) { saved = null; }
  return Number.isFinite(saved) ? saved : WAVE_H_DEFAULT;
}

// setWaveHeight writes an inline flex, which outranks any rule, so folding
// and the in-panel layout have to clear it rather than style around it.
export function waveApplyDockSize() {
  const dock = waveDockEl();
  if (!dock) return;
  if (waveInPanel() || !document.body.classList.contains('wave-open')) {
    dock.style.flex = '';
  } else {
    setWaveHeight(waveSavedHeight(), false);
  }
}

export function initWaveResizer() {
  const bar = document.getElementById('waveResizer');
  const el = waveDockEl();
  if (!bar || !el) return;

  let startY = 0, startH = 0;
  const move = e => {
    // The strip grows upwards, so dragging up makes it taller.
    setWaveHeight(startH + (startY - e.clientY), false);
    drawWaveforms();
  };
  const up = () => {
    bar.classList.remove('dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    setWaveHeight(el.getBoundingClientRect().height, true);
    drawWaveforms();
  };
  bar.addEventListener('pointerdown', e => {
    startY = e.clientY;
    startH = el.getBoundingClientRect().height;
    bar.classList.add('dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  });
  bar.addEventListener('dblclick', () => { setWaveHeight(WAVE_H_DEFAULT, true); drawWaveforms(); });

  if (window.ResizeObserver) {
    new ResizeObserver(() => { if (waveOpen) drawWaveforms(); }).observe(el);
  }

  try { waveOpen = localStorage.getItem(WAVE_OPEN_KEY) === '1'; } catch (e) { waveOpen = false; }
  applyWaveOpen();
}

export function applyWaveOpen() {
  // Only ever open in HDL mode: there are no waveforms to show otherwise.
  const on = waveOpen && ui.engine === 'hdl';
  document.body.classList.toggle('wave-open', on);
  const fold = document.getElementById('waveFoldBtn');
  if (fold) fold.title = 'Hide the waveform';
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
    if (!panelDock || !panelDock.waveform) return;
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
  const cb = document.getElementById('hdlVcd');
  if (cb) cb.checked = true;
  if (hdlRec.trace) hdlQueueResim('re-simulated with the VCD dump on');
}

export function updateWaveView() {
  const dock = waveDockEl();
  if (!dock || !(document.body.classList.contains('wave-open') || waveInPanel())) return;
  waveApplyDefaultSpan();
  const notice = document.getElementById('waveNotice');
  const info = document.getElementById('waveInfo');

  const say = (html) => {
    dock.classList.add('wave-empty');
    if (notice) notice.innerHTML = html;
    if (info) info.textContent = '';
    const box = document.getElementById('waveCycleInput');
    if (box) box.value = '';
  };

  if (!hdlConfig.dumpVcd) {
    say('Waveforms come from the VCD dump, which is off. ' +
      '<button type="button" onclick="waveEnableVcdAndRerun()">Turn it on and re-run</button>');
    return;
  }
  const p = waveEnsureParsed();
  if (!p) { say('Run the program to record a waveform.'); return; }
  if (!waveSignals.length) {
    say('No signals selected. Use <b>+ Signal</b> to pick some, ' +
      'or <button type="button" onclick="waveResetSignals()">go back to the defaults</button>.');
    return;
  }

  dock.classList.remove('wave-empty');
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

export function toggleWavePicker() {
  const el = document.getElementById('wavePicker');
  if (!el) return;
  el.hidden = !el.hidden;
  const btn = document.getElementById('waveAddBtn');
  if (btn) btn.classList.toggle('active', !el.hidden);
  if (!el.hidden) {
    renderWavePicker();
    const f = document.getElementById('wavePickerFilter');
    if (f) f.focus();
  }
}

export function renderWavePicker() {
  const list = document.getElementById('wavePickerList');
  const picker = document.getElementById('wavePicker');
  if (!list || !picker || picker.hidden) return;
  if (!waveParsed) {
    list.innerHTML = '<div class="wave-picker-empty">Run with the VCD dump on to see the signal list.</div>';
    return;
  }
  const f = document.getElementById('wavePickerFilter');
  const q = (f && f.value || '').toLowerCase();
  const hits = waveParsed.vars.filter(v => !q || v.path.toLowerCase().includes(q));
  if (!hits.length) {
    list.innerHTML = '<div class="wave-picker-empty">No signal matches.</div>';
    return;
  }
  const shown = hits.slice(0, WAVE_PICKER_LIMIT);
  let html = '';
  for (const v of shown) {
    const on = waveSignals.includes(v.path);
    html += `<div class="wave-picker-item${on ? ' on' : ''}" data-path="${escapeHtml(v.path)}">` +
      `<span>${on ? '✓' : ' '}</span><span>${escapeHtml(v.path)}</span>` +
      `<span class="wave-picker-w">${v.width > 1 ? '[' + (v.width - 1) + ':0]' : '1'}</span></div>`;
  }
  if (hits.length > shown.length) {
    html += `<div class="wave-picker-empty">${hits.length - shown.length} more — narrow the filter.</div>`;
  }
  list.innerHTML = html;
}

export function initWavePicker() {
  const f = document.getElementById('wavePickerFilter');
  if (f) {
    f.addEventListener('input', renderWavePicker);
    f.addEventListener('keydown', e => { if (e.key === 'Escape') toggleWavePicker(); });
  }
  const list = document.getElementById('wavePickerList');
  if (list) {
    list.addEventListener('click', e => {
      const item = e.target.closest('.wave-picker-item');
      if (item) waveToggleSignal(item.getAttribute('data-path'));
    });
  }
  const names = document.getElementById('waveNames');
  if (names) {
    names.addEventListener('click', e => {
      const btn = e.target.closest('.wave-name-remove');
      if (btn) waveRemoveSignal(btn.getAttribute('data-path'));
    });
  }
  // Clicking away closes it, the way any dropdown behaves - otherwise the
  // only way out is a button, and the nearest button is easy to miss.
  document.addEventListener('pointerdown', e => {
    const el = document.getElementById('wavePicker');
    if (!el || el.hidden) return;
    if (e.target.closest('#wavePicker') || e.target.closest('#waveAddBtn')) return;
    toggleWavePicker();
  });
}

// ---- Zoom, pan and click-to-seek --------------------------------------
export function waveSetSpan(n, anchorCycle) {
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
  const recorded = Math.floor(p.endTime / waveTicksPerCycle(p));
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

export function waveZoom(factor) { waveSetSpan(waveSpan * factor); }

// Half a window per press, so there is always an overlap to line the new
// view up against. Touch drag pans too, but it is not discoverable and it
// fights the panel's own scrolling.
export function wavePan(dir) {
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
  const info = document.getElementById('waveInfo');
  const box = document.getElementById('waveCycleInput');
  if (box && document.activeElement !== box) box.value = String(hdlCurrentCycle());
  if (info) {
    const last = waveActiveEndCycle();
    const cyc = hdlCurrentCycle();
    const first = waveFirstCycle(p);
    // Once the PC stops, the hardware keeps counting cycles while the
    // waveform stops; saying only "cycle 200 ... of 7" would look wrong.
    const notes = [];
    if (cyc > last) notes.push(`PC last advanced at cycle ${last - 1}`);
    if (cyc < first) notes.push(`the waveform starts at cycle ${first}`);
    if (waveDropped) {
      notes.push(`${waveDropped} chosen signal${waveDropped > 1 ? 's' : ''} not in this run`);
    }
    info.textContent = notes.join(' · ');
  }
  drawWaveNames(p);
  drawWaveforms();
}

// A long run's waveform keeps only its last stretch.
export function waveFirstCycle(p) {
  let t = Infinity;
  for (const c of p.changes.values()) if (c.times.length && c.times[0] < t) t = c.times[0];
  return Number.isFinite(t) ? Math.floor(t / waveTicksPerCycle(p)) : 0;
}

// A cycle typed into the header goes there as a click on the waveform
// would, and puts it in the middle of the view.
export function waveGotoCycle(text) {
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

export function waveCycleAtX(clientX) {
  const canvas = document.getElementById('waveCanvas');
  if (!canvas) return 0;
  const r = canvas.getBoundingClientRect();
  return waveStart + ((clientX - r.left) / Math.max(1, r.width)) * waveSpan;
}

// Clicking a waveform moves the whole simulator to that cycle: the last
// instruction that had started by then, which is the one the waveform is
// showing there.
export function waveSeekToCycle(cycle) {
  const t = hdlRec.trace;
  if (!t || !t.steps.length) return;
  let idx = 0;
  for (let i = 0; i < t.steps.length; i++) {
    if (t.steps[i].cyc <= cycle) idx = i; else break;
  }
  hdlSeek(idx);
}

export function initWaveCanvas() {
  const box = document.getElementById('waveCycleInput');
  if (box) {
    box.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); waveGotoCycle(box.value); box.blur(); }
      else if (e.key === 'Escape') box.blur();
    });
    box.addEventListener('blur', () => { if (waveParsed) updateWaveHeaderAndDraw(); });
  }
  const canvas = document.getElementById('waveCanvas');
  if (!canvas) return;

  // A plain wheel is left alone so it scrolls the signal list, which is
  // what a wheel does everywhere else on the page. Zoom takes the usual
  // modifier instead (ctrl, or the trackpad pinch that reports as ctrl).
  canvas.addEventListener('wheel', e => {
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
  }, { passive: false });

  let downX = 0, startAtDown = 0, dragging = false, moved = false;
  canvas.addEventListener('pointerdown', e => {
    if (!waveParsed) return;
    dragging = true; moved = false;
    downX = e.clientX;
    startAtDown = waveStart;
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - downX;
    if (Math.abs(dx) > 3) {
      moved = true;
      canvas.classList.add('wave-panning');
      const r = canvas.getBoundingClientRect();
      waveStart = Math.round(startAtDown - (dx / Math.max(1, r.width)) * waveSpan);
      waveClampStart();
      updateWaveHeaderAndDraw();
    }
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('wave-panning');
    canvas.releasePointerCapture && canvas.hasPointerCapture &&
      canvas.hasPointerCapture(e.pointerId) && canvas.releasePointerCapture(e.pointerId);
    // A drag pans; only a press that stayed put is a seek.
    if (!moved) waveSeekToCycle(Math.floor(waveCycleAtX(e.clientX)));
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', () => { dragging = false; canvas.classList.remove('wave-panning'); });
}

export function waveShortLabel(path) {
  // The full path is in the title; the gutter shows the shortest tail
  // that still tells two instances apart.
  const parts = path.split('.');
  if (parts.length <= 2) return parts[parts.length - 1];
  const tail2 = parts.slice(-2).join('.');
  const clashes = waveSignals.filter(o => o !== path && o.endsWith('.' + parts[parts.length - 1])).length;
  return clashes ? tail2 : parts[parts.length - 1];
}

export function drawWaveNames(p) {
  const host = document.getElementById('waveNames');
  if (!host) return;
  let html = '<div class="wave-names-axis">cycle</div>';
  for (const path of waveSignals) {
    const v = p.byPath.get(path);
    const label = waveShortLabel(path);
    const bits = v && v.width > 1 ? `[${v.width - 1}:0]` : '';
    html += `<div class="wave-name" title="${escapeHtml(path)}">` +
      `<span>${escapeHtml(label)}${bits ? ' ' + bits : ''}</span>` +
      `<button class="wave-name-remove" type="button" data-path="${escapeHtml(path)}" ` +
      `title="Remove this signal">✕</button></div>`;
  }
  host.innerHTML = html;
}

export function drawWaveforms() {
  const canvas = document.getElementById('waveCanvas');
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

  const tpc = waveTicksPerCycle(p);
  const pxPerCycle = w / waveSpan;
  const xOf = (cycle) => (cycle - waveStart) * pxPerCycle;
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
    const tStart = waveStart * tpc;
    const tEnd = Math.min(waveStart + waveSpan, activeEnd) * tpc;
    let k = waveChangeIndexAt(c, tStart);
    if (k < 0) k = 0;

    const single = v.width === 1;
    ctx.lineWidth = 1.4;

    let prevX = 0;
    let prevVal = c.values[k];
    const drawSeg = (x0, x1, raw) => {
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

    prevX = Math.max(0, xOf(c.times[k] / tpc));
    if (c.times[k] <= tStart) prevX = 0;
    for (let j = k + 1; j < c.times.length && c.times[j] <= tEnd; j++) {
      const x = xOf(c.times[j] / tpc);
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
  // point at nothing.
  const cursor = Math.min(hdlCurrentCycle(), activeEnd);
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
  let run;
  if (ui.engine === 'hdl' && hdlRec.trace) {
    run = { cycles: hdlConfig.cycleBudget, base: hdlRec.base, stim: hdlRec.stim.slice().sort((a, b) => a.cycle - b.cycle), rx: hdlRec.rx };
  } else {
    run = { cycles: hdlConfig.cycleBudget, base: hdlCurrentInputs(), stim: [], rx: [] };
  }
  downloadTextFile('cg3207_hdl_tb.v', hdlBuildTestbench({ run }));
  setStatus('Saved the testbench for this run to cg3207_hdl_tb.v; it needs AA_IROM.mem and AA_DMEM.mem beside it', 'success');
}

// Cycles per Run is remembered for Verilator, Icarus, and Icarus with
// post-synthesis simulation.
export function hdlCyclesKey() { return hdlConfig.simulator === 'icarus' && hdlConfig.synthEnabled ? 'synth' : hdlConfig.simulator; }
export function hdlShowCycles() {
  hdlConfig.cycleBudget = hdlCyclesFor[hdlCyclesKey()];
  const cyc = document.getElementById('hdlCycles');
  if (cyc) {
    cyc.max = String(hdlConfig.simulator === 'verilator' ? HDL_VL_MAX_RUN : HDL_MAX_CYCLES);
    cyc.value = hdlConfig.cycleBudget;
  }
}
export function setHdlCycles(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return;
  hdlConfig.cycleBudget = Math.min(n, hdlConfig.simulator === 'verilator' ? HDL_VL_MAX_RUN : HDL_MAX_CYCLES);
  hdlCyclesFor[hdlCyclesKey()] = hdlConfig.cycleBudget;
  // Keep the field honest when the budget is set from anywhere else,
  // including the automatic extension when stepping off the end.
  const el = document.getElementById('hdlCycles');
  if (el && parseInt(el.value, 10) !== hdlConfig.cycleBudget) el.value = hdlConfig.cycleBudget;
}
export function setHdlDumpVcd(on) {
  hdlConfig.dumpVcd = !!on;
  updateWaveView();
  hdlRefreshDetail();
}
export function setHdlWaveTop(on) { hdlConfig.waveTop = !!on;   hdlRefreshDetail();
}
export function setHdlLiveWave(v) { hdlConfig.liveWave = v === 'live' ? 'live' : 'pause';   hdlRefreshDetail();
}
// ---- Detail presets -------------------------------------------------
// Each sets the options that cost run time. They stay visible and can be
// changed one by one, after which the preset reads Custom; with no
// waveform recorded, its two sub-settings do not count.
export const HDL_DETAIL = {
  full:     { trace: true,  vcd: true,  top: false, live: 'live',  compare: false, synth: false },
  balanced: { trace: true,  vcd: true,  top: true,  live: 'pause', compare: false, synth: false },
  fastest:  { trace: false, vcd: false, top: true,  live: 'pause', compare: false, synth: false }
};
export function hdlDetailNow() {
  return { trace: hdlConfig.traceEnabled, vcd: hdlConfig.dumpVcd, top: hdlConfig.waveTop, live: hdlConfig.liveWave,
           compare: hdlConfig.compareEnabled, synth: hdlConfig.synthEnabled };
}
export function hdlDetailMatch() {
  const now = hdlDetailNow();
  for (const name in HDL_DETAIL) {
    const p = HDL_DETAIL[name];
    if (Object.keys(p).every(k => (!now.vcd && (k === 'top' || k === 'live')) || p[k] === now[k])) return name;
  }
  return 'custom';
}
// Puts every control in step with the settings, which a preset or Reset
// Defaults changes without touching the controls.
export function hdlRefreshDetail() {
  const byId = id => document.getElementById(id);
  const set = (id, prop, v) => { const el = byId(id); if (el && el[prop] !== v) el[prop] = v; };
  set('hdlTrace', 'checked', hdlConfig.traceEnabled);
  set('hdlVcd', 'checked', hdlConfig.dumpVcd);
  set('hdlWaveTop', 'value', hdlConfig.waveTop ? 'top' : 'all');
  set('hdlLiveWave', 'value', hdlConfig.liveWave);
  set('hdlCompare', 'checked', hdlConfig.compareEnabled);
  set('hdlSynth', 'checked', hdlConfig.synthEnabled);
  const scope = byId('hdlWaveScopeRow');
  if (scope) scope.style.display = hdlConfig.dumpVcd ? 'flex' : 'none';
  const lw = byId('hdlLiveWaveRow');
  if (lw) lw.style.display = hdlConfig.dumpVcd && hdlConfig.simulator === 'verilator' ? 'flex' : 'none';
  const sel = byId('hdlDetail');
  if (sel) {
    const m = hdlDetailMatch();
    const custom = sel.querySelector('option[value="custom"]');
    if (custom) custom.hidden = m !== 'custom';
    sel.value = m;
  }
}
export function setHdlDetail(name, quiet) {
  const p = HDL_DETAIL[name];
  if (!p) { hdlRefreshDetail(); return; }
  const now = hdlDetailNow();
  const said = [];
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
  const sel = document.getElementById('hdlSimulator');
  const row = document.getElementById('hdlSimulatorRow');
  if (!sel || !row) return;
  sel.disabled = !hdlVerilatorAvail;
  row.title = hdlVerilatorAvail
    ? 'Icarus Verilog simulates four-state logic (x and z) and starts at once. Verilator first compiles ' +
      'your design to C++, which takes several seconds each time the sources change, and then runs ' +
      '20 to 100 times faster; it is two-state, so what Icarus shows as x is 0. Post-synthesis ' +
      'simulation needs Icarus.'
    : window.rvNative ? 'This build of the desktop app has no Verilator.'
    : 'Verilator is available only in the desktop app.';
  let saved = null;
  try { saved = localStorage.getItem(HDL_SIMULATOR_KEY); } catch (e) { /* private mode */ }
  setHdlSimulator(saved === 'verilator' ? 'verilator' : 'icarus', true);
}

export function setHdlSimulator(v, restoring) {
  if (v !== 'verilator' || !hdlVerilatorAvail) v = 'icarus';
  const changed = v !== hdlConfig.simulator;
  hdlConfig.simulator = v;
  hdlShowCycles();
  hdlRefreshDetail();
  const sel = document.getElementById('hdlSimulator');
  if (sel) sel.value = v;
  if (!restoring) { try { localStorage.setItem(HDL_SIMULATOR_KEY, v); } catch (e) { /* private mode */ } }
  const synth = document.getElementById('hdlSynthCard');
  if (synth) synth.style.display = v === 'verilator' ? 'none' : '';
  if (v === 'verilator' && hdlConfig.synthEnabled) {
    setHdlSynth(false);
    const cb = document.getElementById('hdlSynth');
    if (cb) cb.checked = false;
  }
  if (changed) hdlDiscardTrace();
}

export function hdlSimulatorName() {
  return hdlConfig.simulator === 'verilator' ? 'Verilator' : hdlNative ? 'Icarus Verilog' : 'Icarus/WASM';
}
export function setHdlTrace(on) {
  hdlConfig.traceEnabled = !!on;
  hdlDiscardTrace();
  updateToolbarButtonStates();
  hdlRefreshDetail();
}
export function setHdlCompare(on) { hdlConfig.compareEnabled = !!on;   hdlRefreshDetail();
}
// Ticking this is what triggers the one-off Yosys download. If a run has
// already been recorded, synthesise and check it now instead of waiting
// for the next Run.
export function setHdlSynth(on) {
  const was = hdlConfig.synthEnabled;
  hdlConfig.synthEnabled = !!on;
  hdlShowCycles();
  updateToolbarButtonStates();
  hdlRefreshDetail();
  if (!hdlConfig.synthEnabled || was) return;
  if (!hdlRec.trace || !hdlBuild.lastRtlOut) {
    loadYosysEngine().catch(e => {
      hdlLog(String(e && e.message ? e.message : e), 'err');
      hdlStatus('the synthesiser failed to load', 'err');
    });
    return;
  }
  hdlWithBusy(async () => {
    try {
      const wrapper = hdlFindWrapper();
      loadProgram(program.machineCode);
      const mem = hdlMemFiles(wrapper.src);
      await hdlPostSynthCheck(hdlBuild.lastRtlOut, hdlRec.trace.budget,
                              hdlConfig.traceEnabled ? 2 : 1, mem.files);
      hdlSeek(hdlRec.idx);
    } catch (e) {
      hdlLog(String(e && e.message ? e.message : e), 'err');
      setStatus('Post-synthesis check failed - see the console', 'error');
    }
    return null;
  });
}
// The register path is compiled into the testbench as a hierarchical
// reference, so changing it invalidates the cached binary.
export function setHdlRegPath() { hdlBuild.vvpCache = null; hdlDiscardTrace(); }

export function hdlRefreshRegPathHint() {
  const el = document.getElementById('hdlRegPath');
  if (!el) return;
  const found = hdlDiscoverRegBank();
  el.placeholder = found || 'e.g. dut.RV1.RegFile1.RegBank';
  const hint = document.getElementById('hdlRegPathHint');
  if (hint) {
    hint.textContent = found
      ? 'detected automatically: ' + found
      : (hdlSources.files.length ? 'no 32-entry register array found - name the path to see registers'
                         : 'load your sources to detect the register file');
  }
}
