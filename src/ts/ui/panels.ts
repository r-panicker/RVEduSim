// @ts-nocheck
// The right-side panels: docking, floating, the 2×2 grid and the mobile
// tab view, splitters, intra-panel column widths and the per-panel row
// filter. Also the shared escapeHtml(), the editor's autocomplete data and
// symbol scan, and the Registers table.
//
// The panels in PANEL_DEFS are independent, not mutually exclusive tabs:
// each can be shown on its own, stacked vertically in the right column,
// or detached to a floating window. Layout persists to localStorage.

import { assemble } from '../asm/assembler';
import { hdlMarkUnknownRegisters } from '../hdl/shared-ui';
import { ABI_NAMES, INSTRUCTIONS, PSEUDO_INSTRUCTIONS } from '../isa/instructions';
import { cpu, layout, program, run, ui } from '../machine/state';
import { dpOnStateChange, syncDatapathPanelHost, updateDatapathPanelAvailability, updateFloatSteps } from './datapath';
import { updateDisassembly, updateMachineCode } from './disassembly';
import { disassemblyDisplay, editor, log, regBody, resetExecutionForSourceChange, setBreakpointsEffect } from './editor';
import { editorState } from './editor-state';
import { syncWaveformPanelHost, updateLocalsPanelAvailability, updateWaveformPanelAvailability } from './examples-language';
import { updateLocalsView } from './locals';
import { updateMemSubTabs, updateMemoryView } from './memory-register-views';
import { initPeripherals, updatePeripherals } from './peripherals';
import { byId } from './dom';
export const PANEL_DOCK_KEY = 'rvsim.panelDock.v1';
export const PANEL_DEFS = [
  { name: 'registers', label: 'Registers' },
  { name: 'memory', label: 'Memory' },
  { name: 'peripherals', label: 'Peripherals' },
  { name: 'disassembly', label: 'Disassembly' },
  { name: 'locals', label: 'Locals' },
  { name: 'waveform', label: 'Waveforms', mobileOnly: true },
  { name: 'datapath', label: 'Datapath', mobileOnly: true },
];
// Width (px) of the right-side dock while the 2×2 grid is active. When the
// user collapses back to ≤2 docked panels, the previously saved width
// (from the main splitter drag) is restored.
export const DOCK_TWO_COL_WIDTH_PCT = 0.5;
// Minimum width of a docked panel column in the 2×2 grid. Column bases are
// `0 1 Npx` (shrinkable), and the row-fit clamps below guarantee a pair of
// persisted widths + the 6px splitter never overflow the dock — the drag
// floor, the splitter-drag floor, and the persisted-state clamp all use it.
export const MIN_COL_W = 90;
// Where each panel is: shown or not, docked or floating, its floating
// rectangle and its docked sizes; order is the dock's order. Saved as is.
export interface PanelState { visible: boolean; floating: boolean; x: number; y: number; w: number; h: number; basis: number; wbasis: number }
export type PanelDock = { order: string[] } & { [name: string]: PanelState };
export let panelDock: PanelDock | null = null;
export let floatDrag = null;
export let dockSavedWidth: number | null = null;
// In the tabbed mobile view (≤800px) exactly one panel is shown at a time;
// `mobileTab` tracks which one. It is ephemeral — it never changes the
// persisted desktop panel visibility/layout.
export let mobileTab: string | null = null;

export function panelDockDefaults() {
  // Per-panel seeds. Anything in PANEL_DEFS without an entry here still
  // gets a default below, so adding a panel can never leave the dock
  // holding an undefined state object.
  const seeds = {
    registers: { visible: true, x: 90, y: 90, w: 460, h: 360 },
    memory: { x: 130, y: 120, w: 540, h: 400 },
    peripherals: { x: 170, y: 150, w: 560, h: 440 },
    disassembly: { x: 210, y: 180, w: 580, h: 400 },
    locals: { x: 250, y: 210, w: 480, h: 360 },
  };
  const def = { order: PANEL_DEFS.map(p => p.name) };
  PANEL_DEFS.forEach(({ name }, i) => {
    const seed = seeds[name] || {};
    def[name] = {
      visible: seed.visible === true,
      floating: false,
      x: seed.x !== undefined ? seed.x : 90 + i * 40,
      y: seed.y !== undefined ? seed.y : 90 + i * 30,
      w: seed.w !== undefined ? seed.w : 520,
      h: seed.h !== undefined ? seed.h : 400,
      basis: 0,
      wbasis: 0
    };
  });
  return def;
}

export function loadPanelDock() {
  const def = panelDockDefaults();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PANEL_DOCK_KEY) || 'null'); } catch (e) { saved = null; }
  if (!saved || typeof saved !== 'object') return def;
  PANEL_DEFS.forEach(({ name }) => {
    if (saved[name] && typeof saved[name] === 'object') def[name] = Object.assign(def[name], saved[name]);
  });
  if (Array.isArray(saved.order) && saved.order.length) {
    // Keep the user's ordering for the panels it names, then append any
    // panel it does not know about (a layout saved before that panel
    // existed).
    const known = saved.order.filter((n: string) => PANEL_DEFS.some(p => p.name === n));
    const missing = PANEL_DEFS.map(p => p.name).filter(n => !known.includes(n));
    if (known.length) def.order = known.concat(missing);
  }
  return def;
}

export function savePanelDock() {
  try { localStorage.setItem(PANEL_DOCK_KEY, JSON.stringify(panelDock)); } catch (e) { /* storage unavailable */ }
}

// True when the 2×2 grid is active (more than two docked panels on a wide
// enough viewport). On ≤800px the mobile tabbed view takes over.
export function dockUsesTwoColumns() {
  if (!panelDock) return false;
  if ((window.innerWidth || 1200) <= 800) return false;
  const docked = panelDock.order.filter((n: string | number) => panelDock[n].visible && !panelDock[n].floating);
  return docked.length > 2;
}

export function mobileMode() {
  return (window.innerWidth || 1200) <= 800;
}

// Pick a sensible default active tab for the mobile tabbed view: the first
// visible panel in dock order, falling back to the last used mobile tab if
// it is still visible, then to 'registers'.
export function ensureMobileTab() {
  if (!panelDock) return;
  if (mobileTab && panelDock[mobileTab] && panelDock[mobileTab].visible) return;
  const first = panelDock.order.find((n: string | number) => panelDock[n] && panelDock[n].visible);
  mobileTab = first || 'registers';
}

// Mobile chip clicks switch the single visible tab, mutually exclusive,
// without touching the persisted desktop panel visibility.
export function setMobileTab(name: string | null) {
  if (!panelDock || !panelDock[name]) return;
  mobileTab = name;
  applyPanelDock();
  refreshPanel(name);
  if (typeof updateFloatSteps === 'function') updateFloatSteps();
}

export function updateMobileFindBtn() {
  const b = byId<HTMLButtonElement>('mobileFindBtn');
  if (b) b.hidden = !(mobileMode() && PANEL_FIND.has(mobileTab));
}

export function currentDockWidth() {
  const rp = document.querySelector('.right-panel');
  if (!rp) return 0;
  const rectW = rp.getBoundingClientRect().width;
  if (rectW > 0) return rectW;
  // jsdom (and layouts where getBoundingClientRect is stubbed) returns 0 for
  // the rendered width; fall back to the inline width so `updateDockWidthForGrid`
  // still computes a sensible target instead of collapsing the dock.
  const inlineW = parseFloat(rp.style.width);
  return Number.isFinite(inlineW) ? inlineW : 0;
}

// When the 2×2 grid is active the dock expands to half of the window
// width; otherwise it returns to the user's manually chosen width.
// The target is applied as an absolute width, never as a grow-only
// `Math.max(current, target)`: a grow-only clamp would make the panels
// area jump left, leaving blank space on the right, whenever a relayout
// follows a main-splitter drag narrower than 50%.
export function updateDockWidthForGrid() {
  const rp = document.querySelector('.right-panel');
  if (!rp) return;
  if (dockUsesTwoColumns()) {
    const target = Math.round((window.innerWidth || 1200) * DOCK_TWO_COL_WIDTH_PCT);
    if (dockSavedWidth === null) dockSavedWidth = currentDockWidth();
    rp.style.width = Math.max(target, 220) + 'px';
  } else {
    if (dockSavedWidth !== null) {
      rp.style.width = Math.max(220, dockSavedWidth) + 'px';
      dockSavedWidth = null;
    }
  }
}

// Row-fit clamp for the 2×2 grid: if a paired row's persisted column bases
// (+ the 6px splitter) exceed the dock's available width, scale them down
// proportionally so the row never overflows. Only shrink on overflow — a
// lone row-2 panel is never affected (it always uses `1 1 0`). Shared by
// `applyPanelDock()` and the live main-splitter drag, both of which need to
// re-clamp persisted widths against the current (possibly narrower) dock.
// The clamp reads only the rendered clientWidth, which is 0 while the dock
// has no layout (not yet laid out, or under jsdom); the clamp is then
// skipped and the persisted widths are kept as they are. Once the dock is
// laid out, a main-splitter drag that narrows it re-clamps the persisted
// pair to fit, leaving no blank space on the right.
export function clampGridRowWidths() {
  if (!panelDock) return;
  if (!dockUsesTwoColumns()) return;
  if (mobileMode()) return;
  const rp = document.querySelector('.right-panel');
  if (!rp) return;
  const availW = rp.clientWidth;
  if (!(availW > 0)) return;
  const dockedNames = panelDock.order.filter((n: string | number) => panelDock[n].visible && !panelDock[n].floating);
  const mid = Math.ceil(dockedNames.length / 2);
  const row1 = dockedNames.slice(0, mid);
  const row2 = dockedNames.slice(mid);
  let changed = false;
  [row1, row2].forEach((rowNames) => {
    if (rowNames.length < 2) return; // single panel row — full width
    let total = 0;
    rowNames.forEach((n: string | number) => { total += (panelDock[n].wbasis || 0); });
    if (total <= 0 || total + 6 <= availW) return;
    // Scale the pair down to fit the dock while keeping each column at
    // least MIN_COL_W: give each its minimum, then split the remaining
    // space in the persisted ratio. (A plain proportional scale with a
    // per-column floor can still overflow — e.g. one column pinned at
    // its floor plus a large other column would exceed the dock.)
    const extra = Math.max(0, availW - 6 - 2 * MIN_COL_W);
    const r1 = rowNames[0], r2 = rowNames[1];
    const b1 = panelDock[r1].wbasis || 0;
    panelDock[r1].wbasis = MIN_COL_W + Math.round((b1 / total) * extra);
    panelDock[r2].wbasis = availW - 6 - panelDock[r1].wbasis; // exact fit
    changed = true;
  });
  // Runs on every pointermove of a splitter drag; most of those fit.
  if (changed) savePanelDock();
}

/* ============================================================
   Intra-panel column layout & resize separators
   (Registers / Memory / Disassembly — Peripherals is untouched)

   Every column has a width in px. Columns marked `grow: 0` (#, Name,
   Addr, Machine code, Hex) hold their content-sized `fit` width and
   never scale up just because the panel got wider; columns with a
   `grow` weight (the Value pair, Native + Source, ASCII) share out
   whatever surplus the panel has beyond that. So widening the dock
   gives the space to the text columns, and the short fixed-length
   data never gets stretched or wrapped for no reason.

   When the panel is NARROWER than the sum of every column's minimum,
   nothing is crushed: the widths stay at their minimums and the panel
   scrolls horizontally instead. That is what keeps the wrapping off
   any single column — the text columns take up the slack first (they
   have the largest span between `min` and `fit`), and past that point
   the whole row scrolls rather than one column collapsing.

   Dragging a separator behaves like a spreadsheet: the first movement
   pins every column at its current rendered width, then only the
   dragged column's width changes — so everything to its right keeps
   its width and simply shifts along. Double-click any separator to
   unpin the whole panel and go back to the automatic layout.
   Pinned widths persist per panel under `rvsim.panelColW.<panel>`.
   ============================================================ */
export const PANEL_COLS = {
  registers: [
    { key: 'id',   min: 34,  fit: 44,  grow: 0 },
    { key: 'name', min: 46,  fit: 92,  grow: 0 },
    { key: 'hex',  min: 92,  fit: 124, grow: 0 },
    { key: 'dec',  min: 80,  fit: 96,  grow: 1 },
  ],
  memory: [
    { key: 'addr',  min: 92,  fit: 106, grow: 0 },
    { key: 'hex',   min: 108, fit: 140, grow: 0 },
    // `fit` here is set by "CONTENT (DEC)" plus its sign-toggle switch
    // (the longer combination, wider than "CONTENT (ASCII)" alone),
    // so the whole header sits on one line at the panel's natural width
    // instead of wrapping the toggle onto a row of its own.
    { key: 'ascii', min: 88,  fit: 145, grow: 1 },
  ],
  disassembly: [
    { key: 'addr',   min: 84,  fit: 94,  grow: 0 },
    { key: 'mc',     min: 96,  fit: 116, grow: 0 },
    { key: 'native', min: 128, fit: 200, grow: 1 },
    { key: 'source', min: 128, fit: 200, grow: 1 },
  ],
  locals: [
    { key: 'name', min: 60,  fit: 92,  grow: 0 },
    { key: 'addr', min: 92,  fit: 106, grow: 0 },
    { key: 'hex',  min: 92,  fit: 124, grow: 0 },
    { key: 'dec',  min: 80,  fit: 96,  grow: 1 },
  ],
};

export function panelColWidthKey(panel: string) { return 'rvsim.panelColW.' + panel; }
export const panelColWidthCache = {};
// Pinned (user-dragged) widths for a panel, keyed by column. A column
// absent from this map is laid out automatically.
export function panelColWidths(panel: string | number) {
  if (!panelColWidthCache[panel]) {
    let out = {};
    try {
      const raw = localStorage.getItem(panelColWidthKey(panel));
      const o = raw ? JSON.parse(raw) : null;
      if (o && typeof o === 'object') out = o;
    } catch (e) { /* corrupt storage → automatic layout */ }
    panelColWidthCache[panel] = out;
  }
  return panelColWidthCache[panel];
}
export function savePanelColWidths(panel: any) {
  try { localStorage.setItem(panelColWidthKey(panel), JSON.stringify(panelColWidths(panel))); }
  catch (e) { /* storage unavailable */ }
}

export function panelBodyEl(panel: string) {
  const el = panelEl(panel);
  return el ? (el.querySelector(':scope > .panel-body') || el) : null;
}
// Usable width inside the panel: clientWidth includes padding (and
// already excludes any vertical scrollbar), so take the padding off.
export function panelContentWidth(panel: any) {
  const body = panelBodyEl(panel);
  if (!body || !body.clientWidth) return 0;
  let padL = 0, padR = 0;
  try {
    const cs = getComputedStyle(body);
    padL = parseFloat(cs.paddingLeft) || 0;
    padR = parseFloat(cs.paddingRight) || 0;
  } catch (e) { /* no layout (headless) */ }
  return Math.max(0, body.clientWidth - padL - padR);
}

// The Memory Hex column can never be narrower than the hex data itself,
// otherwise the header separator slides over bytes that are still being
// drawn. `.mem-hex-block` carries `min-width: max-content`, so measure
// that natural width and clamp the drag to it. Measured once per render
// (it only changes with the Byte/Word mode) to avoid reflow per move.
export let memHexNaturalW = 0;
export function measureMemHexNatural() {
  const blk = document.querySelector('#memView .mem-hex-block');
  if (!blk) return memHexNaturalW;
  const prev = blk.style.width;
  blk.style.width = 'max-content';
  const w = Math.ceil(blk.getBoundingClientRect().width);
  blk.style.width = prev;
  if (w > 0) memHexNaturalW = w;
  return memHexNaturalW;
}

export function columnFloor(panel: string, key: string) {
  const c = PANEL_COLS[panel].find((x: { key: string; }) => x.key === key);
  let floor = c ? c.min : 40;
  if (panel === 'memory' && key === 'hex' && memHexNaturalW > 0) {
    floor = Math.max(floor, memHexNaturalW);
  }
  return floor;
}

// Resolve every column to a px width for the panel's current size.
export function computedColWidths(panel: string | number) {
  const cols = PANEL_COLS[panel];
  const pinned = panelColWidths(panel);
  const isPinned = (c: { key: string | number; }) => Number.isFinite(Number(pinned[c.key]));
  const w = cols.map((c: { key: any; fit?: any; }) => isPinned(c)
    ? Math.max(columnFloor(panel, c.key), Number(pinned[c.key]))
    : c.fit);
  const total = w.reduce((a: any, b: any) => a + b, 0);
  const avail = panelContentWidth(panel);
  // Surplus goes only to the unpinned grow columns; a pinned column
  // keeps exactly the width it was dragged to.
  const growTotal = cols.reduce((s: any, c: { grow: any; }) => s + (isPinned(c) ? 0 : c.grow), 0);
  if (avail > total && growTotal > 0) {
    const extra = avail - total;
    cols.forEach((c: { grow: number; }, i: string | number) => { if (!isPinned(c) && c.grow) w[i] += extra * c.grow / growTotal; });
  }
  return w.map((x: number) => Math.round(x));
}

// Push the computed widths into the DOM. The tables carry a <colgroup>
// (one <col> per column) and the Memory panel a set of custom
// properties; both also get a min-width equal to the column total, so a
// panel too narrow to hold them scrolls instead of crushing a column.
export function applyPanelColLayout(panel: string) {
  const w = computedColWidths(panel);
  const total = w.reduce((a: any, b: any) => a + b, 0);
  if (panel === 'memory') {
    [byId('memView'), byId('memColHeader')].forEach(el => {
      if (!el) return;
      el.style.setProperty('--mem-addr-w', w[0] + 'px');
      el.style.setProperty('--mem-hex-w', w[1] + 'px');
      el.style.setProperty('--mem-ascii-w', w[2] + 'px');
      el.style.minWidth = total + 'px';
    });
    return;
  }
  const tbl = (panel === 'registers')
    ? byId<HTMLTableElement>('regTable')
    : (disassemblyDisplay && disassemblyDisplay.querySelector('.code-list'));
  if (!tbl) return;
  const colEls = tbl.querySelectorAll('colgroup > col');
  if (colEls.length !== w.length) return;
  colEls.forEach((c, i) => { c.style.width = w[i] + 'px'; });
  tbl.style.minWidth = total + 'px';
}

export function resetPanelColWidths(panel: string | number) {
  panelColWidthCache[panel] = {};
  savePanelColWidths(panel);
  applyPanelColLayout(panel);
}

// One delegated pointer-drag handler for every `.col-resizer` across all
// three panels. The Registers and Memory handles are static markup; the
// Disassembly ones are rebuilt on every render — delegating on `document`
// means nothing needs re-wiring after a rebuild. initPanelDock() can run
// more than once (crossing the mobile/desktop breakpoint), so the
// listeners are attached only the first time.
export let panelColResizersAttached = false;
export function initPanelColResizers() {
  if (!panelColResizersAttached) {
    panelColResizersAttached = true;
    let drag: { pinnedAll: any; panel: any; key: any; startW: any; startX: any; handle: any; idx?: any; } | null = null;
    document.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest && e.target.closest('.col-resizer');
      if (!handle) return;
      const panel = handle.dataset.panel, key = handle.dataset.col;
      if (!panel || !PANEL_COLS[panel] || !key) return;
      e.preventDefault();
      const idx = PANEL_COLS[panel].findIndex((c: { key: any; }) => c.key === key);
      drag = {
        handle, panel, key, idx,
        startX: e.clientX,
        startW: computedColWidths(panel)[idx],
        pinnedAll: false,
      };
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* unsupported */ }
    });
    document.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.pinnedAll) {
        // First movement of this drag: freeze every column at the width
        // it is rendered at right now. From here on only the dragged
        // column changes, so the ones to its right hold their width and
        // shift along with it rather than being re-flowed underneath.
        // (Done on first move, not on pointerdown, so a plain click —
        // or a double-click to reset — never pins anything.)
        drag.pinnedAll = true;
        const widths = computedColWidths(drag.panel);
        const pinned = panelColWidths(drag.panel);
        PANEL_COLS[drag.panel].forEach((c: { key: string | number; }, i: string | number) => { pinned[c.key] = widths[i]; });
      }
      const pinned = panelColWidths(drag.panel);
      pinned[drag.key] = Math.max(columnFloor(drag.panel, drag.key), Math.round(drag.startW + (e.clientX - drag.startX)));
      applyPanelColLayout(drag.panel);
    });
    const stopDrag = () => {
      if (!drag) return;
      drag.handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (drag.pinnedAll) savePanelColWidths(drag.panel);
      drag = null;
    };
    document.addEventListener('pointerup', stopDrag);
    document.addEventListener('pointercancel', stopDrag);
    document.addEventListener('dblclick', (e) => {
      const handle = e.target.closest && e.target.closest('.col-resizer');
      if (!handle) return;
      const panel = handle.dataset.panel;
      if (panel && PANEL_COLS[panel]) resetPanelColWidths(panel);
    });

    // Re-flow the columns whenever a panel is resized (dock splitter,
    // window resize, floating-panel resize), so the grow columns keep
    // absorbing the surplus. Guarded on the measured width so the
    // observer cannot retrigger itself off its own writes.
    if (typeof ResizeObserver !== 'undefined') {
      const lastW = {};
      const ro = new ResizeObserver((entries) => {
        entries.forEach(entry => {
          const panel = entry.target.dataset.colPanel;
          if (!panel) return;
          const w = panelContentWidth(panel);
          if (lastW[panel] === w) return;
          lastW[panel] = w;
          applyPanelColLayout(panel);
        });
      });
      Object.keys(PANEL_COLS).forEach(panel => {
        const body = panelBodyEl(panel);
        if (!body || body._colRoAttached) return;
        body._colRoAttached = true;
        body.dataset.colPanel = panel;
        ro.observe(body);
      });
    }
  }
  Object.keys(PANEL_COLS).forEach(applyPanelColLayout);
}

export function panelEl(name: string) { return document.getElementById('tab-' + name); }

export function isPanelVisible(name: string) {
  return !!(panelDock && panelDock[name] && panelDock[name].visible);
}

export function refreshPanel(name: string) {
  try {
    if (name === 'registers') updateRegisters();
    else if (name === 'memory') { if (typeof updateMemSubTabs === 'function') updateMemSubTabs(); updateMemoryView(); }
    else if (name === 'peripherals') initPeripherals();
    else if (name === 'disassembly') updateDisassembly();
    else if (name === 'locals') updateLocalsView();
    // A panel that was just shown may have gone from zero width to a
    // real one, so re-run its column layout against the new size.
    if (PANEL_COLS[name]) applyPanelColLayout(name);
  } catch (e) { /* dependent state not ready yet */ }
}

// ---- Panel row filter -------------------------------------------------
// Peripherals is absent because it has controls, not rows.
export const PANEL_FIND = new Set(['registers', 'memory', 'disassembly', 'locals']);

// Placeholders say what the filter reaches, which differs for Memory: it
// narrows the rows the address window is already showing, not the segment.
export const PANEL_FIND_PLACEHOLDER = {
  registers: 'Filter registers',
  memory: 'Filter the rows shown',
  disassembly: 'Filter instructions',
  locals: 'Filter locals'
};

// Not persisted: a filter that silently survived a reload would look like
// missing data rather than a filter.
export const panelFindText = {};

export function buildPanelFindBar(name: string) {
  const bar = document.createElement('div');
  bar.className = 'panel-find';
  bar.id = 'panelFind-' + name;
  bar.hidden = true;
  bar.innerHTML =
    '<input type="text" spellcheck="false" placeholder="' + PANEL_FIND_PLACEHOLDER[name] + '">' +
    '<span class="panel-find-count"></span>' +
    '<button class="find-btn find-close" type="button" title="Clear (Esc)">&times;</button>';

  const input = bar.querySelector('input');
  input.addEventListener('input', () => setPanelFind(name, input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closePanelFind(name); }
  });
  bar.querySelector('button').addEventListener('click', () => closePanelFind(name));
  return bar;
}

export function panelFindBar(name: string) { return document.getElementById('panelFind-' + name); }

export function panelFindBtn(name: any) {
  const el = panelEl(name);
  return el && el.querySelector(':scope > .panel-hdr [data-panel-act="find"]');
}

export function setPanelFind(name: string | number, text: string) {
  panelFindText[name] = text || '';
  const btn = panelFindBtn(name);
  if (btn) btn.classList.toggle('active', !!panelFindText[name]);
  refreshPanel(name);
}

export function togglePanelFind(name: string) {
  const bar = panelFindBar(name);
  if (!bar) return;
  if (bar.hidden) {
    bar.hidden = false;
    bar.querySelector('input').focus();
  } else {
    closePanelFind(name);
  }
}

export function closePanelFind(name: any) {
  const bar = panelFindBar(name);
  if (!bar) return;
  bar.hidden = true;
  const input = bar.querySelector('input');
  if (input) input.value = '';
  setPanelFind(name, '');
}

// True when there is no filter, so callers can guard a row unconditionally.
export function panelFindMatch(name: string, haystack: string) {
  const q = panelFindText[name];
  if (!q) return true;
  return String(haystack).toLowerCase().includes(q.toLowerCase());
}

export function panelFindActive(name: string) { return !!panelFindText[name]; }

export function setPanelFindCount(name: string, shown: string | number, total: string | number) {
  const bar = panelFindBar(name);
  if (!bar) return;
  const el = bar.querySelector('.panel-find-count');
  if (el) el.textContent = panelFindText[name] ? shown + ' of ' + total : '';
}

// Wrap each panel's existing content in a scrollable body and prepend a header bar.
export function ensurePanelChrome() {
  PANEL_DEFS.forEach(({ name, label }) => {
    const el = panelEl(name);
    if (!el || el.querySelector(':scope > .panel-hdr')) return;

    const body = document.createElement('div');
    body.className = 'panel-body';
    while (el.firstChild) body.appendChild(el.firstChild);

    const findable = PANEL_FIND.has(name);
    const hdr = document.createElement('div');
    hdr.className = 'panel-hdr';
    hdr.innerHTML =
      '<span class="panel-hdr-title">' + label + '</span>' +
      '<span class="panel-hdr-actions">' +
      (findable
        ? '<button class="panel-hdr-btn" type="button" data-panel-act="find" title="Filter rows">🔍</button>'
        : '') +
      '<button class="panel-hdr-btn" type="button" data-panel-act="float">⧉</button>' +
      '<button class="panel-hdr-btn" type="button" data-panel-act="hide" title="Hide this panel">✕</button>' +
      '</span>';

    el.appendChild(hdr);
    if (findable) el.appendChild(buildPanelFindBar(name));
    el.appendChild(body);

    hdr.addEventListener('pointerdown', (e) => onFloatDragStart(e, name));
    hdr.querySelector('[data-panel-act="float"]').addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanelFloat(name);
    });
    hdr.querySelector('[data-panel-act="hide"]').addEventListener('click', (e) => {
      e.stopPropagation();
      setPanelVisible(name, false);
    });
    if (findable) {
      hdr.querySelector('[data-panel-act="find"]').addEventListener('click', (e) => {
        e.stopPropagation();
        togglePanelFind(name);
      });
    }

    observeFloatResize(name);
  });
}

export function observeFloatResize(name: string) {
  const el = panelEl(name);
  if (!el || el._roAttached || typeof ResizeObserver === 'undefined') return;
  el._roAttached = true;
  const ro = new ResizeObserver(() => {
    const st = panelDock && panelDock[name];
    if (st && st.floating && el.classList.contains('panel-floating')) {
      st.w = el.offsetWidth;
      st.h = el.offsetHeight;
      clearTimeout(el._roT);
      el._roT = setTimeout(savePanelDock, 300);
    }
  });
  ro.observe(el);
}

export function applyPanelDock() {
  const stack = byId('panelStack');
  if (!stack || !panelDock) return;

  // Preserve focus + caret across the relayout below. Re-appending panel
  // nodes inside #panelStack (or refreshing a panel's innerHTML) can make
  // the browser drop focus — which on mobile closes the soft keyboard in
  // the middle of typing into the UART console (or any other form field).
  const activeEl = document.activeElement;
  let restoreFocus = null;
  if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT' || activeEl.isContentEditable)) {
    restoreFocus = {
      el: activeEl,
      selStart: (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') ? activeEl.selectionStart : null,
      selEnd: (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') ? activeEl.selectionEnd : null
    };
  }
  const restoreFocusNow = () => {
    if (!restoreFocus || !restoreFocus.el.isConnected) return;
    try {
      restoreFocus.el.focus();
      if (restoreFocus.selStart !== null && restoreFocus.selEnd !== null) {
        restoreFocus.el.setSelectionRange(restoreFocus.selStart, restoreFocus.selEnd);
      }
    } catch (e) { /* element not focusable — ignore */ }
  };

  // Remove every dynamically inserted splitter and grid row from a
  // previous apply, moving any panels that live inside dock rows back
  // into the stack first (removing the rows would detach the panels, and
  // getElementById cannot find detached nodes).
  stack.querySelectorAll('.panel-dock-row').forEach(row => {
    while (row.firstChild) stack.appendChild(row.firstChild);
    row.remove();
  });
  stack.querySelectorAll('.panel-vsplitter, .panel-hsplitter').forEach(s => s.remove());

  const dockedNames = panelDock.order.filter((n: string | number) => panelDock[n].visible && !panelDock[n].floating);
  const floatingNames = panelDock.order.filter((n: string | number) => panelDock[n].visible && panelDock[n].floating);
  const twoCols = dockUsesTwoColumns();
  const mobile = mobileMode();
  syncWaveformPanelHost();
  if (document.body.dataset.booted) syncDatapathPanelHost();
  if (mobile) ensureMobileTab();

  // Set the dock width before laying out the grid: the row-fit clamp below
  // reads the actual available width, and the panel loop below uses it.
  updateDockWidthForGrid();
  clampGridRowWidths();

  // Reorder every panel node to match panelDock.order (direct children of
  // the stack in the single-column layout), then set docked/floating state.
  panelDock.order.forEach((name: string | null) => {
    const el = panelEl(name);
    if (!el) return;
    stack.appendChild(el);
    const st = panelDock[name];
    el.classList.remove('panel-docked', 'panel-floating', 'focused', 'panel-mobile-active');
    el.style.flex = '';
    el.style.left = el.style.top = el.style.width = el.style.height = '';

    // In the tabbed mobile view only the active tab is displayed — even if
    // its persisted desktop visibility is off (the tabbed view always shows
    // exactly one panel; visibility is only re-persisted if the user taps a
    // chip, which calls setPanelVisible(true)).
    if (mobile && name === mobileTab) el.classList.add('panel-mobile-active');

    if (!st.visible) return;

    // Mobile tabbed view: the CSS rule `.panel-mobile-active` fully controls
    // the layout (flex: 0 0 auto; height: auto; overflow: visible) so the
    // active tab expands to its natural content height and the page scrolls.
    // Do not apply desktop docked flex-basis/height logic here.
    if (mobile) return;

    if (st.floating && !mobile) {
      el.classList.add('panel-floating');
      el.style.left = st.x + 'px';
      el.style.top = st.y + 'px';
      el.style.width = st.w + 'px';
      el.style.height = st.h + 'px';
    } else if (twoCols) {
      el.classList.add('panel-docked');
      // Column widths are driven by flex-basis: default (wbasis 0) is an
      // even 1:1 split; a dragged width is a basis (`0 1 Npx`) so the flex
      // layout honours it while the panel can still shrink when the dock
      // gets narrower than the dragged total. (A fixed `0 0 Npx` basis
      // cannot shrink, so a narrow main splitter would make the row
      // overflow the dock and leave blank space on the right.) A panel that is the
      // ONLY panel in its grid row (e.g. the 3rd of 3 visible panels) must
      // always span the full row width — a persisted column width would
      // otherwise leave a blank space where a 4th panel would sit.
      const rowHasPair = !(dockedNames.length % 2 === 1 && dockedNames.indexOf(name) === dockedNames.length - 1);
      el.style.flex = (rowHasPair && st.wbasis && st.wbasis > 0) ? ('0 1 ' + st.wbasis + 'px') : '1 1 0';
    } else {
      el.classList.add('panel-docked');
      el.style.flex = (st.basis && st.basis > 0) ? ('0 0 ' + st.basis + 'px') : '1 1 0';
    }
  });

  if (dockedNames.length > 0) {
    if (twoCols) {
      // 2×2 grid: row 1 holds the first ceil(n/2) panels, row 2 the rest.
      const mid = Math.ceil(dockedNames.length / 2);
      const row1 = dockedNames.slice(0, mid);
      const row2 = dockedNames.slice(mid);
      [row1, row2].forEach((rowNames, rowIdx) => {
        const row = document.createElement('div');
        row.className = 'panel-dock-row' + (rowNames.length < 2 ? ' panel-dock-row-single' : '');
        // Restore persisted row heights (from dragging the row splitter).
        if (Array.isArray(panelDock.rowHeights) && panelDock.rowHeights[rowIdx]) {
          row.style.flex = '0 0 ' + panelDock.rowHeights[rowIdx] + 'px';
        }
        const first = rowNames[0];
        if (first) {
          row.appendChild(panelEl(first));
          // Horizontal splitter between the two columns of the row.
          for (let i = 1; i < rowNames.length; i++) {
            const sp = document.createElement('div');
            sp.className = 'panel-hsplitter';
            sp.title = 'Drag to resize · double-click to even out';
            row.appendChild(sp);
            row.appendChild(panelEl(rowNames[i]));
          }
        }
        stack.appendChild(row);
        // Vertical splitter between row 1 and row 2.
        if (rowIdx === 0) {
          const sp = document.createElement('div');
          sp.className = 'panel-vsplitter';
          sp.title = 'Drag to resize · double-click to even out';
          stack.appendChild(sp);
        }
      });
      // Wire up splitters after the DOM is built.
      stack.querySelectorAll('.panel-hsplitter').forEach(sp => attachHSplitter(sp));
      stack.querySelectorAll('.panel-vsplitter').forEach(sp => attachVSplitter(sp));
    } else {
      // Single column: plain vertical stack with row splitters.
      for (let i = 0; i < dockedNames.length - 1; i++) {
        const sp = document.createElement('div');
        sp.className = 'panel-vsplitter';
        sp.title = 'Drag to resize · double-click to even out';
        panelEl(dockedNames[i]).after(sp);
        attachVSplitter(sp);
      }
    }
  }

  const emptyHint = stack.querySelector('.panel-stack-empty');
  if (emptyHint) stack.appendChild(emptyHint);
  // On desktop the empty hint shows when no docked panel is visible. In the
  // tabbed mobile view a tab is ALWAYS shown (panel-mobile-active), so the
  // "All panels are hidden" hint never applies there.
  stack.classList.toggle('is-empty', !mobile && dockedNames.length === 0);

  // Toolbar chip + float-button state.
  PANEL_DEFS.forEach(({ name }) => {
    const st = panelDock[name];
    const chip = document.getElementById('panelChip-' + name);
    if (chip) {
      if (mobile) {
        // On mobile the chips behave like a classic tab strip: exactly one
        // is active (the currently shown tab), never "floating".
        chip.classList.toggle('active', name === mobileTab);
        chip.classList.remove('floating');
      } else {
        chip.classList.toggle('active', st.visible);
        chip.classList.toggle('floating', st.visible && st.floating);
      }
    }
    const fb = panelEl(name) && panelEl(name).querySelector('[data-panel-act="float"]');
    if (fb) {
      fb.textContent = st.floating ? '▣' : '⧉';
      fb.title = st.floating ? 'Dock back into the side panel' : 'Detach to a floating window';
    }
  });

  floatingNames.forEach((name: string) => keepFloatInView(name));
  savePanelDock();
  // Bring focus back to the field that was being typed in (e.g. the UART
  // console) now that the panels have been moved/re-appended, so the mobile
  // soft keyboard is not dismissed by the relayout.
  restoreFocusNow();
  updateMobileFindBtn();
}

export function keepFloatInView(name: string) {
  const st = panelDock[name];
  const el = panelEl(name);
  if (!st || !el) return;
  const maxX = window.innerWidth - 60;
  const maxY = window.innerHeight - 32;
  if (st.x > maxX) st.x = Math.max(0, maxX);
  if (st.y > maxY) st.y = Math.max(0, maxY);
  if (st.x < -el.offsetWidth + 60) st.x = 0;
  if (st.y < 0) st.y = 0;
  el.style.left = st.x + 'px';
  el.style.top = st.y + 'px';
}

export function setPanelVisible(name: string, vis: boolean) {
  if (!panelDock || !panelDock[name]) return;
  panelDock[name].visible = vis;
  if (!vis) panelDock[name].floating = false;
  applyPanelDock();
  if (vis) refreshPanel(name);
}

export function togglePanel(name: string) {
  if (!panelDock || !panelDock[name]) return;
  setPanelVisible(name, !panelDock[name].visible);
}

export function togglePanelFloat(name: string) {
  const st = panelDock && panelDock[name];
  if (!st || !st.visible) return;
  st.floating = !st.floating;
  if (st.floating) {
    if (st.x > window.innerWidth - 120 || st.x < 0) st.x = Math.max(20, (window.innerWidth - st.w) / 2);
    if (st.y > window.innerHeight - 80 || st.y < 0) st.y = Math.max(20, (window.innerHeight - st.h) / 3);
  }
  applyPanelDock();
  refreshPanel(name);
}

export function onFloatDragStart(e: PointerEvent, name: string) {
  const st = panelDock && panelDock[name];
  if (!st || !st.floating) return;
  if (e.target.closest('.panel-hdr-btn')) return;
  const el = panelEl(name);
  floatDrag = { name, startX: e.clientX, startY: e.clientY, origX: st.x, origY: st.y };
  document.querySelectorAll('.tab-content.panel-floating').forEach(p => p.classList.remove('focused'));
  el.classList.add('focused');
  if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
  el.addEventListener('pointermove', onFloatDragMove);
  el.addEventListener('pointerup', onFloatDragEnd);
  el.addEventListener('pointercancel', onFloatDragEnd);
  e.preventDefault();
}

export function onFloatDragMove(e: { clientX: number; clientY: number; }) {
  if (!floatDrag) return;
  const st = panelDock[floatDrag.name];
  const el = panelEl(floatDrag.name);
  let nx = floatDrag.origX + (e.clientX - floatDrag.startX);
  let ny = floatDrag.origY + (e.clientY - floatDrag.startY);
  nx = Math.max(-el.offsetWidth + 60, Math.min(nx, window.innerWidth - 60));
  ny = Math.max(0, Math.min(ny, window.innerHeight - 32));
  st.x = nx; st.y = ny;
  el.style.left = nx + 'px';
  el.style.top = ny + 'px';
}

export function onFloatDragEnd() {
  if (!floatDrag) return;
  const el = panelEl(floatDrag.name);
  el.removeEventListener('pointermove', onFloatDragMove);
  el.removeEventListener('pointerup', onFloatDragEnd);
  el.removeEventListener('pointercancel', onFloatDragEnd);
  floatDrag = null;
  savePanelDock();
}

// Row splitter: drags to redistribute the height of the two docked panels
// (or dock rows in the 2×2 grid) above and below it.
export function attachVSplitter(sp: Element) {
  let dragging = false, startY = 0, aboveEl: { offsetHeight: number; style: { flex: string; }; } | null = null, belowEl: { offsetHeight: number; style: { flex: string; }; } | null = null, aboveH = 0, belowH = 0;
  sp.addEventListener('pointerdown', (e: { clientY: number; pointerId: any; preventDefault: () => void; }) => {
    aboveEl = sp.previousElementSibling;
    belowEl = sp.nextElementSibling;
    if (!aboveEl || !belowEl) return;
    dragging = true;
    startY = e.clientY;
    aboveH = aboveEl.offsetHeight;
    belowH = belowEl.offsetHeight;
    sp.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  sp.addEventListener('pointermove', (e: { clientY: number; }) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    aboveEl.style.flex = '0 0 ' + Math.max(90, aboveH + dy) + 'px';
    belowEl.style.flex = '0 0 ' + Math.max(90, belowH - dy) + 'px';
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Persist the heights of the two dock rows (2×2 grid) or the two
    // docked panels (single column).
    const pair = [aboveEl, belowEl].filter(el => el && el.classList.contains('panel-dock-row'));
    if (pair.length === 2) {
      panelDock.rowHeights = pair.map(el => el.offsetHeight);
    } else {
      panelDock.order.forEach((n: string) => {
        const el = panelEl(n);
        if (el && el.classList.contains('panel-docked')) panelDock[n].basis = el.offsetHeight;
      });
    }
    savePanelDock();
  };
  sp.addEventListener('pointerup', stop);
  sp.addEventListener('pointercancel', stop);
  sp.addEventListener('dblclick', () => {
    panelDock.rowHeights = undefined;
    panelDock.order.forEach((n: string | number) => { panelDock[n].basis = 0; });
    applyPanelDock();
  });
}

// Column splitter: drags to redistribute the width of the two columns
// within one row of the 2×2 grid.
export function attachHSplitter(sp: Element) {
  let dragging = false, startX = 0, lastX = 0, leftEl: { offsetWidth: number; style: { flex: string; }; } | null = null, rightEl: { offsetWidth: number; style: { flex: string; }; } | null = null;
  // The flex-basis values at pointerdown. Tracked explicitly because a
  // shrinkable basis (`0 1 Npx`) means `offsetWidth` reflects the RENDERED
  // (possibly shrunk) width, not the value we want to persist. They are
  // snapshots — never mutated during the drag. The dragged width is always
  // computed as `snapshot + (clientX − startX)` (absolute from pointerdown),
  // mirroring the row splitter; accumulating the delta into the snapshot
  // would compound on every move and make a small drag shoot to the extreme.
  let leftBasis = 0, rightBasis = 0;
  sp.addEventListener('pointerdown', (e: { clientX: number; pointerId: any; preventDefault: () => void; }) => {
    leftEl = sp.previousElementSibling;
    rightEl = sp.nextElementSibling;
    if (!leftEl || !rightEl) return;
    dragging = true;
    startX = e.clientX;
    lastX = startX;
    leftBasis = leftEl.offsetWidth;
    rightBasis = rightEl.offsetWidth;
    sp.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  sp.addEventListener('pointermove', (e: { clientX: number; }) => {
    if (!dragging) return;
    lastX = e.clientX;
    const dx = lastX - startX;
    // Set flex-basis (`0 1 Npx`) so the flex row honours the widths while
    // the panels can still shrink if the dock is narrower than the dragged
    // total. A fixed `0 0 Npx` basis cannot shrink, so it would overflow
    // the dock, shifting the panels area left with blank space on the right.
    const wl = Math.max(MIN_COL_W, leftBasis + dx);
    const wr = Math.max(MIN_COL_W, rightBasis - dx);
    leftEl.style.flex = '0 1 ' + wl + 'px';
    rightEl.style.flex = '0 1 ' + wr + 'px';
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Persist the widths of the two docked panels in this row. Clamp the
    // dragged bases to the row's available space so an over-wide drag can
    // never persist an overflowing state: when the two bases + the 6px
    // splitter exceed the row width, scale them down proportionally.
    const pair = [leftEl, rightEl].map(el => {
      if (!el) return null;
      const n = el.id && el.id.replace(/^tab-/, '');
      return n && panelDock[n] ? n : null;
    });
    const dx = lastX - startX;
    let wl = Math.max(MIN_COL_W, leftBasis + dx);
    let wr = Math.max(MIN_COL_W, rightBasis - dx);
    const row = sp.parentElement;
    const available = row ? row.clientWidth : 0;
    const total = wl + wr;
    if (available > 0 && total + 6 > available && total > 0) {
      // Scale the pair down to fit the row while keeping each column at
      // least MIN_COL_W: give each its minimum, then split the remaining
      // space in the dragged ratio. (A plain proportional scale with a
      // per-column floor can still overflow — e.g. one column pinned at its
      // floor plus a large other column would exceed the row.)
      const extra = Math.max(0, available - 6 - 2 * MIN_COL_W);
      wl = MIN_COL_W + Math.round((wl / total) * extra);
      wr = available - 6 - wl; // exact fit, no rounding overflow
    }
    if (pair[0]) panelDock[pair[0]].wbasis = Math.max(MIN_COL_W, wl);
    if (pair[1]) panelDock[pair[1]].wbasis = Math.max(MIN_COL_W, wr);
    savePanelDock();
  };
  sp.addEventListener('pointerup', stop);
  sp.addEventListener('pointercancel', stop);
  sp.addEventListener('dblclick', () => {
    panelDock.order.forEach((n: string | number) => { panelDock[n].wbasis = 0; });
    applyPanelDock();
  });
}

export function initPanelDock() {
  panelDock = loadPanelDock();
  ensurePanelChrome();
  PANEL_DEFS.forEach(({ name }) => {
    const chip = document.getElementById('panelChip-' + name);
    if (chip) chip.addEventListener('click', () => {
      if (mobileMode()) {
        // Mobile tabs behave like the classic tab strip: tapping a tab
        // shows that panel (even if it is currently hidden), and exactly
        // one panel is displayed at a time.
        if (!panelDock[name].visible) setPanelVisible(name, true);
        setMobileTab(name);
      } else {
        togglePanel(name);
      }
    });
  });
  applyPanelDock();
  panelDock.order.forEach((name: string) => { if (isPanelVisible(name)) refreshPanel(name); });
  updateLocalsPanelAvailability();
  updateWaveformPanelAvailability();
  // Wire up the intra-panel column-resize separators (Registers /
  // Memory / Disassembly) and apply any persisted per-panel widths.
  initPanelColResizers();
  window.addEventListener('resize', () => {
    // While a form field is focused (UART console, memory address box,
    // find/replace, …), a mobile on-screen keyboard open/close fires a
    // window resize (visual viewport). Relayouting the panel stack during
    // typing would move the focused node and can dismiss the keyboard, so
    // skip every panel/layout adjustment in that case.
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) {
      return;
    }
    let moved = false;
    PANEL_DEFS.forEach(({ name }) => {
      const st = panelDock[name];
      if (st.visible && st.floating) { keepFloatInView(name); moved = true; }
    });
    if (moved) savePanelDock();
    // Keep the 2×2 grid width in sync when the viewport size changes.
    if (dockUsesTwoColumns() || dockSavedWidth !== null) updateDockWidthForGrid();
    // The waveform and datapath panels exist only below the breakpoint,
    // and their chips are not part of the state applyPanelDock() re-applies.
    updateWaveformPanelAvailability();
    if (document.body.dataset.booted) updateDatapathPanelAvailability();
    // Re-apply when crossing the mobile/desktop breakpoint so the layout
    // switches between the tabbed mobile view and the dock/grid view.
    if (mobileMode() || (panelDock && panelDock.order.some((n: string | number) => panelDock[n].visible))) {
      applyPanelDock();
    }
  });
}

export function updateLineNumbers() {
  if (!editorState.cm) return;
  editorState.cm.dispatch({
    effects: setBreakpointsEffect.of(new Set(run.breakpoints))
  });
}

// Quotes are escaped as well as the tag characters: most callers here
// interpolate into a double-quoted attribute, where a bare quote in a
// signal path or a file name would end the attribute early.
export function escapeHtml(s: string | any[] | null) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function updateEditor() {
  resetExecutionForSourceChange();
  const code = editor.value;
  if (code.trim()) {
    try {
      const mc = assemble(code, layout.baseAddress, { language: editorState.language, report: log });
      program.machineCode = mc;
      updateMachineCode();
      updateDisassembly();
    } catch (e) { }
  }
}

// Every register can be written by its ABI name or as x<n> / f<n>, and
// each spelling gets an entry, so they are generated from one table.
export const INT_REG_DESC = [
    'Constant Zero (Hardware hardwired to 0)',
    'Return Address (Caller-saved)',
    'Stack Pointer (Callee-saved)',
    'Global Pointer',
    'Thread Pointer',
    'Temporary 0 / Alternate Link (Caller-saved)',
    'Temporary 1 (Caller-saved)',
    'Temporary 2 (Caller-saved)',
    'Saved Register 0 / Frame Pointer (Callee-saved)',
    'Saved Register 1 (Callee-saved)',
    'Function Arg 0 / Return Value 0 (Caller-saved)',
    'Function Arg 1 / Return Value 1 (Caller-saved)',
    'Function Arg 2 (Caller-saved)',
    'Function Arg 3 (Caller-saved)',
    'Function Arg 4 (Caller-saved)',
    'Function Arg 5 (Caller-saved)',
    'Function Arg 6 (Caller-saved)',
    'Function Arg 7 / Syscall Number (Caller-saved)',
    'Saved Register 2 (Callee-saved)',
    'Saved Register 3 (Callee-saved)',
    'Saved Register 4 (Callee-saved)',
    'Saved Register 5 (Callee-saved)',
    'Saved Register 6 (Callee-saved)',
    'Saved Register 7 (Callee-saved)',
    'Saved Register 8 (Callee-saved)',
    'Saved Register 9 (Callee-saved)',
    'Saved Register 10 (Callee-saved)',
    'Saved Register 11 (Callee-saved)',
    'Temporary Register 3 (Caller-saved)',
    'Temporary Register 4 (Caller-saved)',
    'Temporary Register 5 (Caller-saved)',
    'Temporary Register 6 (Caller-saved)'
];

export function fpRegDesc(i: string | number) {
  if (i < 8) return 'FP Temporary ' + i;
  if (i < 10) return 'FP Saved Register ' + (i - 8);
  if (i < 12) return 'FP Argument ' + (i - 10) + ' / Return ' + (i - 10);
  if (i < 18) return 'FP Argument ' + (i - 10);
  if (i < 28) return 'FP Saved Register ' + (i - 16);
  return 'FP Temporary ' + (i - 20);
}

export const FP_ABI_NAMES = [
  'ft0', 'ft1', 'ft2', 'ft3', 'ft4', 'ft5', 'ft6', 'ft7', 'fs0', 'fs1',
  'fa0', 'fa1', 'fa2', 'fa3', 'fa4', 'fa5', 'fa6', 'fa7',
  'fs2', 'fs3', 'fs4', 'fs5', 'fs6', 'fs7', 'fs8', 'fs9', 'fs10', 'fs11',
  'ft8', 'ft9', 'ft10', 'ft11'];

export function registerDocs() {
  const out: { name: string; type: string; format: string; desc: string; meta: string; }[] = [];
  const abiLabel = (i: number) => (i === 8 ? 's0/fp' : ABI_NAMES[i]);
  ABI_NAMES.forEach((abi, i) => {
    out.push({ name: abi, type: 'register', format: `${i === 8 ? 's0 / fp' : abi} (x${i})`,
               desc: INT_REG_DESC[i], meta: `ABI Register x${i}` });
    if (i === 8) out.push({ name: 'fp', type: 'register', format: 'fp (x8)',
                            desc: 'Frame Pointer / Saved Register 0 (Callee-saved)', meta: 'ABI Register x8' });
  });
  ABI_NAMES.forEach((abi, i) => {
    out.push({ name: 'x' + i, type: 'register', format: `x${i} (${abiLabel(i)})`,
               desc: INT_REG_DESC[i], meta: `Hardware Register x${i}` });
  });
  FP_ABI_NAMES.forEach((abi, i) => {
    out.push({ name: abi, type: 'register', format: `${abi} (f${i})`, desc: fpRegDesc(i), meta: `FP Register f${i}` });
  });
  FP_ABI_NAMES.forEach((abi, i) => {
    out.push({ name: 'f' + i, type: 'register', format: `f${i} (${abi})`, desc: fpRegDesc(i), meta: `FP Register f${i}` });
  });
  return out;
}

export const RISCV_AUTOCOMPLETE_DOCS = [
  // --- RV32I Arithmetic & Logical ---
  { name: 'add', type: 'inst', format: 'add rd, rs1, rs2', desc: 'Addition: rd = rs1 + rs2', meta: 'R-Type | Opcode: 0x33, Funct3: 0, Funct7: 0x00' },
  { name: 'addi', type: 'inst', format: 'addi rd, rs1, imm', desc: 'Add Immediate: rd = rs1 + sign_extend(imm12)', meta: 'I-Type | Opcode: 0x13, Funct3: 0' },
  { name: 'sub', type: 'inst', format: 'sub rd, rs1, rs2', desc: 'Subtraction: rd = rs1 - rs2', meta: 'R-Type | Opcode: 0x33, Funct3: 0, Funct7: 0x20' },
  { name: 'lui', type: 'inst', format: 'lui rd, imm20', desc: 'Load Upper Immediate: rd = imm20 << 12', meta: 'U-Type | Opcode: 0x37' },
  { name: 'auipc', type: 'inst', format: 'auipc rd, imm20', desc: 'Add Upper Immediate to PC: rd = PC + (imm20 << 12)', meta: 'U-Type | Opcode: 0x17' },
  { name: 'and', type: 'inst', format: 'and rd, rs1, rs2', desc: 'Bitwise AND: rd = rs1 & rs2', meta: 'R-Type | Opcode: 0x33, Funct3: 7, Funct7: 0x00' },
  { name: 'andi', type: 'inst', format: 'andi rd, rs1, imm', desc: 'Bitwise AND Immediate: rd = rs1 & sign_extend(imm12)', meta: 'I-Type | Opcode: 0x13, Funct3: 7' },
  { name: 'or', type: 'inst', format: 'or rd, rs1, rs2', desc: 'Bitwise OR: rd = rs1 | rs2', meta: 'R-Type | Opcode: 0x33, Funct3: 6, Funct7: 0x00' },
  { name: 'ori', type: 'inst', format: 'ori rd, rs1, imm', desc: 'Bitwise OR Immediate: rd = rs1 | sign_extend(imm12)', meta: 'I-Type | Opcode: 0x13, Funct3: 6' },
  { name: 'xor', type: 'inst', format: 'xor rd, rs1, rs2', desc: 'Bitwise XOR: rd = rs1 ^ rs2', meta: 'R-Type | Opcode: 0x33, Funct3: 4, Funct7: 0x00' },
  { name: 'xori', type: 'inst', format: 'xori rd, rs1, imm', desc: 'Bitwise XOR Immediate: rd = rs1 ^ sign_extend(imm12)', meta: 'I-Type | Opcode: 0x13, Funct3: 4' },
  { name: 'sll', type: 'inst', format: 'sll rd, rs1, rs2', desc: 'Shift Left Logical: rd = rs1 << (rs2 & 0x1F)', meta: 'R-Type | Opcode: 0x33, Funct3: 1, Funct7: 0x00' },
  { name: 'slli', type: 'inst', format: 'slli rd, rs1, shamt', desc: 'Shift Left Logical Immediate: rd = rs1 << shamt', meta: 'I-Type | Opcode: 0x13, Funct3: 1' },
  { name: 'srl', type: 'inst', format: 'srl rd, rs1, rs2', desc: 'Shift Right Logical: rd = (unsigned)rs1 >>> (rs2 & 0x1F)', meta: 'R-Type | Opcode: 0x33, Funct3: 5, Funct7: 0x00' },
  { name: 'srli', type: 'inst', format: 'srli rd, rs1, shamt', desc: 'Shift Right Logical Immediate: rd = (unsigned)rs1 >>> shamt', meta: 'I-Type | Opcode: 0x13, Funct3: 5' },
  { name: 'sra', type: 'inst', format: 'sra rd, rs1, rs2', desc: 'Shift Right Arithmetic: rd = rs1 >> (rs2 & 0x1F)', meta: 'R-Type | Opcode: 0x33, Funct3: 5, Funct7: 0x20' },
  { name: 'srai', type: 'inst', format: 'srai rd, rs1, shamt', desc: 'Shift Right Arithmetic Immediate: rd = rs1 >> shamt', meta: 'I-Type | Opcode: 0x13, Funct3: 5, Funct7: 0x20' },
  { name: 'slt', type: 'inst', format: 'slt rd, rs1, rs2', desc: 'Set Less Than (signed): rd = (rs1 < rs2) ? 1 : 0', meta: 'R-Type | Opcode: 0x33, Funct3: 2, Funct7: 0x00' },
  { name: 'slti', type: 'inst', format: 'slti rd, rs1, imm', desc: 'Set Less Than Immediate (signed): rd = (rs1 < imm) ? 1 : 0', meta: 'I-Type | Opcode: 0x13, Funct3: 2' },
  { name: 'sltu', type: 'inst', format: 'sltu rd, rs1, rs2', desc: 'Set Less Than Unsigned: rd = (unsigned)rs1 < (unsigned)rs2 ? 1 : 0', meta: 'R-Type | Opcode: 0x33, Funct3: 3, Funct7: 0x00' },
  { name: 'sltiu', type: 'inst', format: 'sltiu rd, rs1, imm', desc: 'Set Less Than Unsigned Immediate: rd = (unsigned)rs1 < (unsigned)imm ? 1 : 0', meta: 'I-Type | Opcode: 0x13, Funct3: 3' },

  // --- RV32I Loads & Stores (Native & Pseudo) ---
  { name: 'lb', type: 'inst', format: 'lb rd, offset(rs1) | lb rd, symbol', desc: 'Load Byte (signed): rd = sign_extend(M[rs1 + offset][7:0]) (Pseudo: loads from symbol address via auipc + lb)', meta: 'I-Type / Pseudo | Opcode: 0x03, Funct3: 0' },
  { name: 'lbu', type: 'inst', format: 'lbu rd, offset(rs1) | lbu rd, symbol', desc: 'Load Byte Unsigned: rd = zero_extend(M[rs1 + offset][7:0]) (Pseudo: loads from symbol address via auipc + lbu)', meta: 'I-Type / Pseudo | Opcode: 0x03, Funct3: 4' },
  { name: 'lh', type: 'inst', format: 'lh rd, offset(rs1) | lh rd, symbol', desc: 'Load Halfword (signed): rd = sign_extend(M[rs1 + offset][15:0]) (Pseudo: loads from symbol address via auipc + lh)', meta: 'I-Type / Pseudo | Opcode: 0x03, Funct3: 1' },
  { name: 'lhu', type: 'inst', format: 'lhu rd, offset(rs1) | lhu rd, symbol', desc: 'Load Halfword Unsigned: rd = zero_extend(M[rs1 + offset][15:0]) (Pseudo: loads from symbol address via auipc + lhu)', meta: 'I-Type / Pseudo | Opcode: 0x03, Funct3: 5' },
  { name: 'lw', type: 'inst', format: 'lw rd, offset(rs1) | lw rd, symbol', desc: 'Load Word: rd = M[rs1 + offset][31:0] (Pseudo: loads 32-bit word from symbol address via auipc + lw)', meta: 'I-Type / Pseudo | Opcode: 0x03, Funct3: 2' },
  { name: 'sb', type: 'inst', format: 'sb rs2, offset(rs1) | sb rs2, symbol[, rt]', desc: 'Store Byte: M[rs1 + offset][7:0] = rs2[7:0] (Pseudo: stores byte to symbol address via auipc + sb)', meta: 'S-Type / Pseudo | Opcode: 0x23, Funct3: 0' },
  { name: 'sh', type: 'inst', format: 'sh rs2, offset(rs1) | sh rs2, symbol[, rt]', desc: 'Store Halfword: M[rs1 + offset][15:0] = rs2[15:0] (Pseudo: stores halfword to symbol address via auipc + sh)', meta: 'S-Type / Pseudo | Opcode: 0x23, Funct3: 1' },
  { name: 'sw', type: 'inst', format: 'sw rs2, offset(rs1) | sw rs2, symbol[, rt]', desc: 'Store Word: M[rs1 + offset][31:0] = rs2[31:0] (Pseudo: stores 32-bit word to symbol address via auipc + sw)', meta: 'S-Type / Pseudo | Opcode: 0x23, Funct3: 2' },

  // --- RV32I Branches & Jumps ---
  { name: 'beq', type: 'inst', format: 'beq rs1, rs2, label', desc: 'Branch if Equal: if (rs1 == rs2) PC += offset', meta: 'B-Type | Opcode: 0x63, Funct3: 0' },
  { name: 'bne', type: 'inst', format: 'bne rs1, rs2, label', desc: 'Branch if Not Equal: if (rs1 != rs2) PC += offset', meta: 'B-Type | Opcode: 0x63, Funct3: 1' },
  { name: 'blt', type: 'inst', format: 'blt rs1, rs2, label', desc: 'Branch if Less Than (signed): if (rs1 < rs2) PC += offset', meta: 'B-Type | Opcode: 0x63, Funct3: 4' },
  { name: 'bge', type: 'inst', format: 'bge rs1, rs2, label', desc: 'Branch if Greater or Equal (signed): if (rs1 >= rs2) PC += offset', meta: 'B-Type | Opcode: 0x63, Funct3: 5' },
  { name: 'bltu', type: 'inst', format: 'bltu rs1, rs2, label', desc: 'Branch if Less Than Unsigned: if ((unsigned)rs1 < (unsigned)rs2) PC += offset', meta: 'B-Type | Opcode: 0x63, Funct3: 6' },
  { name: 'bgeu', type: 'inst', format: 'bgeu rs1, rs2, label', desc: 'Branch if Greater or Equal Unsigned: if ((unsigned)rs1 >= (unsigned)rs2) PC += offset', meta: 'B-Type | Opcode: 0x63, Funct3: 7' },
  { name: 'jal', type: 'inst', format: 'jal rd, label', desc: 'Jump and Link: rd = PC + 4; PC += offset', meta: 'J-Type | Opcode: 0x6F' },
  { name: 'jalr', type: 'inst', format: 'jalr rd, offset(rs1)', desc: 'Jump and Link Register: rd = PC + 4; PC = (rs1 + offset) & ~1', meta: 'I-Type | Opcode: 0x67, Funct3: 0' },

  // --- Environment & System ---
  { name: 'ecall', type: 'inst', format: 'ecall', desc: 'Environment Call: Invokes OS / RARS Syscall (a7 = service ID)', meta: 'I-Type | Opcode: 0x73 | RARS Syscalls: 1=print_int, 4=print_str, 10=exit, 34=print_hex' },
  { name: 'ebreak', type: 'inst', format: 'ebreak', desc: 'Environment Breakpoint: Triggers debugger halt', meta: 'I-Type | Opcode: 0x73' },
  { name: 'fence', type: 'inst', format: 'fence', desc: 'Device / Memory Barrier Fence', meta: 'I-Type | Opcode: 0x0F' },

  // --- RV32M Standard Extension (Multiply / Divide) ---
  { name: 'mul', type: 'inst', format: 'mul rd, rs1, rs2', desc: 'Multiply (lower 32-bits): rd = (rs1 * rs2)[31:0]', meta: 'RV32M | Opcode: 0x33, Funct7: 0x01, Funct3: 0' },
  { name: 'mulh', type: 'inst', format: 'mulh rd, rs1, rs2', desc: 'Multiply High Signed: rd = (rs1 * rs2)[63:32]', meta: 'RV32M | Opcode: 0x33, Funct7: 0x01, Funct3: 1' },
  { name: 'mulhsu', type: 'inst', format: 'mulhsu rd, rs1, rs2', desc: 'Multiply High Signed x Unsigned: rd = (signed rs1 * unsigned rs2)[63:32]', meta: 'RV32M | Opcode: 0x33, Funct7: 0x01, Funct3: 2' },
  { name: 'mulhu', type: 'inst', format: 'mulhu rd, rs1, rs2', desc: 'Multiply High Unsigned: rd = (unsigned rs1 * unsigned rs2)[63:32]', meta: 'RV32M | Opcode: 0x33, Funct7: 0x01, Funct3: 3' },
  { name: 'div', type: 'inst', format: 'div rd, rs1, rs2', desc: 'Division (signed): rd = rs1 / rs2', meta: 'RV32M | Opcode: 0x33, Funct7: 0x01, Funct3: 4' },
  { name: 'divu', type: 'inst', format: 'divu rd, rs1, rs2', desc: 'Division Unsigned: rd = (unsigned)rs1 / (unsigned)rs2', meta: 'RV32M | Opcode: 0x33, Funct7: 0x01, Funct3: 5' },
  { name: 'rem', type: 'inst', format: 'rem rd, rs1, rs2', desc: 'Remainder (signed): rd = rs1 % rs2', meta: 'RV32M | Opcode: 0x33, Funct7: 0x01, Funct3: 6' },
  { name: 'remu', type: 'inst', format: 'remu rd, rs1, rs2', desc: 'Remainder Unsigned: rd = (unsigned)rs1 % (unsigned)rs2', meta: 'RV32M | Opcode: 0x33, Funct7: 0x01, Funct3: 7' },

  // --- Pseudo-Instructions ---
  { name: 'li', type: 'pseudo', format: 'li rd, immediate', desc: 'Load Immediate: Loads 32-bit constant into rd (expands to addi / lui+addi)', meta: 'Pseudo-instruction -> addi or lui + addi' },
  { name: 'la', type: 'pseudo', format: 'la rd, label', desc: 'Load Address: Loads memory address of symbol/label into rd (auipc + addi)', meta: 'Pseudo-instruction -> auipc + addi' },
  { name: 'lla', type: 'pseudo', format: 'lla rd, label', desc: 'Load Local Address: Loads position-independent PC-relative address of symbol into rd', meta: 'Pseudo-instruction -> auipc + addi' },
  { name: 'lga', type: 'pseudo', format: 'lga rd, label', desc: 'Load Global Address: Loads global address of symbol into rd', meta: 'Pseudo-instruction -> auipc + addi' },
  { name: 'mv', type: 'pseudo', format: 'mv rd, rs', desc: 'Move Register: Copies rs into rd (addi rd, rs, 0)', meta: 'Pseudo-instruction -> addi rd, rs, 0' },
  { name: 'not', type: 'pseudo', format: 'not rd, rs', desc: 'Bitwise NOT: rd = ~rs (xori rd, rs, -1)', meta: 'Pseudo-instruction -> xori rd, rs, -1' },
  { name: 'neg', type: 'pseudo', format: 'neg rd, rs', desc: 'Negate (two\'s complement): rd = -rs (sub rd, x0, rs)', meta: 'Pseudo-instruction -> sub rd, x0, rs' },
  { name: 'negw', type: 'pseudo', format: 'negw rd, rs', desc: 'Negate Word (64-bit): rd = sext(-rs[31:0]) (subw rd, x0, rs)', meta: 'Pseudo-instruction -> subw rd, x0, rs' },
  { name: 'sext.w', type: 'pseudo', format: 'sext.w rd, rs', desc: 'Sign-extend Word: rd = sext(rs[31:0]) (addiw rd, rs, 0)', meta: 'Pseudo-instruction -> addiw rd, rs, 0' },
  { name: 'nop', type: 'pseudo', format: 'nop', desc: 'No Operation (addi x0, x0, 0)', meta: 'Pseudo-instruction -> addi x0, x0, 0' },
  { name: 'j', type: 'pseudo', format: 'j label', desc: 'Unconditional Jump: PC = label (jal x0, label)', meta: 'Pseudo-instruction -> jal x0, label' },
  { name: 'jr', type: 'pseudo', format: 'jr rs', desc: 'Jump Register: PC = rs (jalr x0, rs, 0)', meta: 'Pseudo-instruction -> jalr x0, rs, 0' },
  { name: 'ret', type: 'pseudo', format: 'ret', desc: 'Return from Subroutine: PC = ra (jalr x0, x1, 0)', meta: 'Pseudo-instruction -> jalr x0, x1, 0' },
  { name: 'call', type: 'pseudo', format: 'call symbol', desc: 'Call Far Subroutine: Link ra and jump to symbol (auipc + jalr)', meta: 'Pseudo-instruction -> auipc x6, hi + jalr x1, x6, lo' },
  { name: 'tail', type: 'pseudo', format: 'tail symbol', desc: 'Tail Call Subroutine: Jump without linking (auipc + jalr)', meta: 'Pseudo-instruction -> auipc x6, hi + jalr x0, x6, lo' },
  { name: 'beqz', type: 'pseudo', format: 'beqz rs, label', desc: 'Branch if Zero: if (rs == 0) PC = label (beq rs, x0, label)', meta: 'Pseudo-instruction -> beq rs, x0, label' },
  { name: 'bnez', type: 'pseudo', format: 'bnez rs, label', desc: 'Branch if Not Zero: if (rs != 0) PC = label (bne rs, x0, label)', meta: 'Pseudo-instruction -> bne rs, x0, label' },
  { name: 'blez', type: 'pseudo', format: 'blez rs, label', desc: 'Branch if <= Zero: if (rs <= 0) PC = label (bge x0, rs, label)', meta: 'Pseudo-instruction -> bge x0, rs, label' },
  { name: 'bgez', type: 'pseudo', format: 'bgez rs, label', desc: 'Branch if >= Zero: if (rs >= 0) PC = label (bge rs, x0, label)', meta: 'Pseudo-instruction -> bge rs, x0, label' },
  { name: 'bltz', type: 'pseudo', format: 'bltz rs, label', desc: 'Branch if < Zero: if (rs < 0) PC = label (blt rs, x0, label)', meta: 'Pseudo-instruction -> blt rs, x0, label' },
  { name: 'bgtz', type: 'pseudo', format: 'bgtz rs, label', desc: 'Branch if > Zero: if (rs > 0) PC = label (blt x0, rs, label)', meta: 'Pseudo-instruction -> blt x0, rs, label' },
  { name: 'bgt', type: 'pseudo', format: 'bgt rs1, rs2, label', desc: 'Branch if Greater Than (signed): if (rs1 > rs2) PC = label (blt rs2, rs1, label)', meta: 'Pseudo-instruction -> blt rs2, rs1, label' },
  { name: 'ble', type: 'pseudo', format: 'ble rs1, rs2, label', desc: 'Branch if Less or Equal (signed): if (rs1 <= rs2) PC = label (bge rs2, rs1, label)', meta: 'Pseudo-instruction -> bge rs2, rs1, label' },
  { name: 'bgtu', type: 'pseudo', format: 'bgtu rs1, rs2, label', desc: 'Branch if Greater Than Unsigned: if (rs1 > rs2) PC = label', meta: 'Pseudo-instruction -> bltu rs2, rs1, label' },
  { name: 'bleu', type: 'pseudo', format: 'bleu rs1, rs2, label', desc: 'Branch if Less or Equal Unsigned: if (rs1 <= rs2) PC = label', meta: 'Pseudo-instruction -> bgeu rs2, rs1, label' },
  { name: 'seqz', type: 'pseudo', format: 'seqz rd, rs', desc: 'Set if Equal to Zero: rd = (rs == 0) ? 1 : 0', meta: 'Pseudo-instruction -> sltiu rd, rs, 1' },
  { name: 'snez', type: 'pseudo', format: 'snez rd, rs', desc: 'Set if Not Equal to Zero: rd = (rs != 0) ? 1 : 0', meta: 'Pseudo-instruction -> sltu rd, x0, rs' },
  { name: 'sltz', type: 'pseudo', format: 'sltz rd, rs', desc: 'Set if < Zero: rd = (rs < 0) ? 1 : 0', meta: 'Pseudo-instruction -> slt rd, rs, x0' },
  { name: 'sgtz', type: 'pseudo', format: 'sgtz rd, rs', desc: 'Set if > Zero: rd = (rs > 0) ? 1 : 0', meta: 'Pseudo-instruction -> slt rd, x0, rs' },
  { name: 'fmv.s', type: 'pseudo', format: 'fmv.s frd, frs', desc: 'Move Single Float: Copies frs to frd (fsgnj.s frd, frs, frs)', meta: 'Pseudo-instruction -> fsgnj.s frd, frs, frs' },
  { name: 'fneg.s', type: 'pseudo', format: 'fneg.s frd, frs', desc: 'Negate Single Float: frd = -frs (fsgnjn.s frd, frs, frs)', meta: 'Pseudo-instruction -> fsgnjn.s frd, frs, frs' },
  { name: 'fabs.s', type: 'pseudo', format: 'fabs.s frd, frs', desc: 'Absolute Single Float: frd = |frs| (fsgnjx.s frd, frs, frs)', meta: 'Pseudo-instruction -> fsgnjx.s frd, frs, frs' },
  { name: 'fmv.d', type: 'pseudo', format: 'fmv.d frd, frs', desc: 'Move Double Float: Copies frs to frd (fsgnj.d frd, frs, frs)', meta: 'Pseudo-instruction -> fsgnj.d frd, frs, frs' },
  { name: 'fneg.d', type: 'pseudo', format: 'fneg.d frd, frs', desc: 'Negate Double Float: frd = -frs (fsgnjn.d frd, frs, frs)', meta: 'Pseudo-instruction -> fsgnjn.d frd, frs, frs' },
  { name: 'fabs.d', type: 'pseudo', format: 'fabs.d frd, frs', desc: 'Absolute Double Float: frd = |frs| (fsgnjx.d frd, frs, frs)', meta: 'Pseudo-instruction -> fsgnjx.d frd, frs, frs' },

  // --- Assembler Directives ---
  { name: '.text', type: 'directive', format: '.text', desc: 'Text Section: what follows goes in the code segment (Settings \u2192 Linker sets its base, 0x00400000 by default)', meta: 'Assembler Directive' },
  { name: '.data', type: 'directive', format: '.data', desc: 'Data Section: what follows goes in the data segment (Settings \u2192 Linker sets its base, 0x10010000 by default)', meta: 'Assembler Directive' },
  { name: '.word', type: 'directive', format: '.word val1, val2, ...', desc: 'Store 32-bit Words: Allocates 4 bytes per integer', meta: 'Assembler Directive' },
  { name: '.half', type: 'directive', format: '.half val1, val2, ...', desc: 'Store 16-bit Halfwords: Allocates 2 bytes per integer', meta: 'Assembler Directive' },
  { name: '.byte', type: 'directive', format: '.byte val1, val2, ...', desc: 'Store 8-bit Bytes: Allocates 1 byte per value', meta: 'Assembler Directive' },
  { name: '.dword', type: 'directive', format: '.dword val1, val2, ...', desc: 'Store 64-bit Doublewords: Allocates 8 bytes per value', meta: 'Assembler Directive' },
  { name: '.asciiz', type: 'directive', format: '.asciiz "string"', desc: 'Store Null-Terminated ASCII String', meta: 'Assembler Directive' },
  { name: '.ascii', type: 'directive', format: '.ascii "string"', desc: 'Store ASCII String (without trailing null terminator)', meta: 'Assembler Directive' },
  { name: '.string', type: 'directive', format: '.string "string"', desc: 'Store Null-Terminated String (synonym of .asciiz)', meta: 'Assembler Directive' },
  { name: '.space', type: 'directive', format: '.space bytes', desc: 'Reserve Uninitialized Bytes: Allocates N zero bytes', meta: 'Assembler Directive' },
  { name: '.align', type: 'directive', format: '.align n', desc: 'Align Location Counter to 2^n bytes boundary', meta: 'Assembler Directive' },
  { name: '.equ', type: 'directive', format: '.equ SYMBOL, value', desc: 'Equate Constant: Defines symbolic constant for immediate/address', meta: 'Assembler Directive' },
  { name: '.set', type: 'directive', format: '.set SYMBOL, value', desc: 'Set Constant: Defines symbolic constant (synonym of .equ)', meta: 'Assembler Directive' },
  { name: '.globl', type: 'directive', format: '.globl symbol', desc: 'Declare Global Symbol (e.g. .globl main)', meta: 'Assembler Directive' },
  { name: '.global', type: 'directive', format: '.global symbol', desc: 'Declare Global Symbol (synonym of .globl)', meta: 'Assembler Directive' },

  ...registerDocs()
];

export function getAssemblyLineContext(currentLine: string) {
  // Strip comments
  let codeOnly = currentLine.split('#')[0];

  // Strip leading label declaration if present (e.g. "main:  sw x" or "loop: addi a0, ")
  const labelMatch = codeOnly.match(/^(\s*[a-zA-Z_]\w*\s*:\s*)(.*)$/);
  if (labelMatch) {
    codeOnly = labelMatch[2];
  }

  // Check if we are typing the mnemonic or already in operands
  const trimmedStart = codeOnly.trimStart();
  if (!trimmedStart) {
    return { context: 'MNEMONIC', activeMnemonic: null, operandIndex: 0 };
  }

  // Extract first word (mnemonic or directive)
  const firstWordMatch = trimmedStart.match(/^([.\w]+)/);
  if (!firstWordMatch) {
    return { context: 'MNEMONIC', activeMnemonic: null, operandIndex: 0 };
  }

  const firstWord = firstWordMatch[1];
  const afterFirstWord = trimmedStart.slice(firstWord.length);

  // If there is no whitespace or delimiter after the first word, we are currently typing that first word (the mnemonic)
  if (!afterFirstWord) {
    return { context: 'MNEMONIC', activeMnemonic: firstWord.toLowerCase(), operandIndex: 0 };
  }

  // If whitespace or punctuation follows, the first word is established as the active mnemonic!
  const commaCount = (afterFirstWord.match(/,/g) || []).length;
  return { context: 'OPERAND', activeMnemonic: firstWord.toLowerCase(), operandIndex: commaCount };
}

// Hover and completion both ask for this on every event, with the whole
// document, which is usually the same document as last time.
export let editorSymbolsFor = null, editorSymbolsCache = [];

export function extractEditorSymbols(code: null) {
  if (code === editorSymbolsFor) return editorSymbolsCache;
  editorSymbolsFor = code;
  editorSymbolsCache = scanEditorSymbols(code);
  return editorSymbolsCache;
}

export function scanEditorSymbols(code: string) {
  const symbols = [];
  const seen = new Set();
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNum = i + 1;
    // Strip comments
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    // 1. Check for label declarations: label:
    const labelMatch = line.match(/^([a-zA-Z_]\w*)\s*:/);
    if (labelMatch) {
      const name = labelMatch[1];
      const nameLower = name.toLowerCase();
      if (!seen.has(nameLower) && !INSTRUCTIONS[nameLower] && !PSEUDO_INSTRUCTIONS[nameLower]) {
        seen.add(nameLower);
        symbols.push({
          name: name,
          type: 'label',
          format: `${name} (line ${lineNum})`,
          desc: `Declared at line ${lineNum}: "${rawLine.trim()}"`,
          meta: `User-defined code/data label`
        });
      }
    }

    // 2. Check for .equ / .set: .equ SYMBOL, val
    const equMatch = line.match(/^\.(?:equ|set)\s+([a-zA-Z_]\w*)\s*,\s*([^#]+)/i);
    if (equMatch) {
      const name = equMatch[1];
      const val = equMatch[2].trim();
      const nameLower = name.toLowerCase();
      if (!seen.has(nameLower)) {
        seen.add(nameLower);
        symbols.push({
          name: name,
          type: 'equ',
          format: `.equ ${name}, ${val}`,
          desc: `Equate constant defined at line ${lineNum}: ${name} = ${val}`,
          meta: `User-defined equate constant`
        });
      }
    }

    // 3. Direct assignment: SYMBOL = val
    const assignMatch = line.match(/^([a-zA-Z_]\w*)\s*=\s*([^#]+)/);
    if (assignMatch) {
      const name = assignMatch[1];
      const val = assignMatch[2].trim();
      const nameLower = name.toLowerCase();
      if (!seen.has(nameLower)) {
        seen.add(nameLower);
        symbols.push({
          name: name,
          type: 'equ',
          format: `${name} = ${val}`,
          desc: `Constant defined at line ${lineNum}: ${name} = ${val}`,
          meta: `User-defined constant`
        });
      }
    }
  }

  return symbols;
}

// In HDL mode the visible state is reconstructed by replaying the recording
// from reset on every seek, so an edit to a register or a memory word is
// discarded by the next Step. vvp cannot be paused and resumed from an
// altered state, so there is nothing to write an edit into: the honest
// thing is to show these read-only rather than accept a change that
// silently reverts. Inputs still work - they go through the Peripherals
// panel, which re-simulates the run with the new value.
export const REPLAYED_STATE_TITLE =
  'Read-only in HDL mode: state is replayed from the recording, so an edit ' +
  'would be discarded on the next Step. Change inputs in the Peripherals panel.';
export const TEXT_RO_TITLE =
  'Text segment is read-only in Memory View (edit in Code Editor and Assemble)';

// Every edit entry point (see ui/memory-register-views.ts) guards on this as
// well as rendering the cell read-only: a keyboard shortcut or a row
// rendered before the engine switched can still reach one.
export function stateIsReplayed() { return ui.engine === 'hdl'; }

export function updateRegisters() {
  let html = '';
  let shown = 0;
  for (let i = 0; i < 32; i++) {
    const name = ABI_NAMES[i];
    const val = cpu.regs[i];
    const uval = val >>> 0;
    const decVal = ui.regDecSigned ? val : uval;
    if (!panelFindMatch('registers',
      `x${i} ${name} ${uval.toString(16).padStart(8, '0')} ${decVal}`)) continue;
    shown++;
    const isChanged = i === cpu.lastChangedReg;
    const valClass = 'reg-val' + (isChanged ? ' reg-changed' : '');
    const hexTxt = uval.toString(16).padStart(8, '0');
    if (stateIsReplayed()) {
      html += `<tr><td class="reg-name col-id">x${i}</td><td class="reg-name col-name">${name}</td>
      <td class="${valClass} readonly-code col-val" title="${REPLAYED_STATE_TITLE}">${hexTxt}</td>
      <td class="${valClass} readonly-code col-val" title="${REPLAYED_STATE_TITLE}">${decVal}</td></tr>`;
      continue;
    }
    html += `<tr><td class="reg-name col-id">x${i}</td><td class="reg-name col-name">${name}</td>
      <td class="${valClass} reg-editable col-val" data-idx="${i}" data-val="${hexTxt}" data-type="hex" onclick="startRegEdit(this)" ondblclick="popRegEditModal(event,this)" onblur="commitRegEdit(this)" onkeydown="handleRegEditKey(event,this)" title="Single-click: edit inline | Double-click: open edit window">${hexTxt}</td>
      <td class="${valClass} reg-editable col-val" data-idx="${i}" data-val="${decVal.toString().padStart(11, ' ')}" data-type="dec" onclick="startRegEdit(this)" ondblclick="popRegEditModal(event,this)" onblur="commitRegEdit(this)" onkeydown="handleRegEditKey(event,this)" title="Single-click: edit inline | Double-click: open edit window">${decVal}</td></tr>`;
  }
  regBody.innerHTML = html;
  setPanelFindCount('registers', shown, 32);
  // The <thead> (and its column widths) survives this rebuild untouched
  // since only the <tbody> is replaced — nothing to reapply here.
  // Also update peripherals (PC LEDs, etc.) when registers are refreshed
  updatePeripherals();
  // Locals changes at the same moments as Registers, so refreshing it here
  // keeps it live from every updateRegisters() call site (step, run, reset,
  // edit...).
  if (typeof updateLocalsView === 'function') updateLocalsView();
  hdlMarkUnknownRegisters();
  dpOnStateChange();
}

export function setRegDecSigned(signed: any) {
  ui.regDecSigned = !!signed;
  updateRegisters();
}
