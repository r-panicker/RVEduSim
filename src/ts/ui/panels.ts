// The right-side panels: where each is (docked, floating, the 2×2 grid,
// the mobile tab view) and the splitters between them, as the model
// PanelDock.svelte draws; intra-panel column widths and the per-panel row
// filter. Also the shared escapeHtml(), the editor's autocomplete data and
// symbol scan, and the Registers table.
//
// The panels in PANEL_DEFS are independent, not mutually exclusive tabs:
// each can be shown on its own, stacked vertically in the right column,
// or detached to a floating window. Layout persists to localStorage.

import { assemble } from '../asm/assembler';
import { hdlRec } from '../hdl/state';
import { ABI_NAMES, INSTRUCTIONS, PSEUDO_INSTRUCTIONS } from '../isa/instructions';
import { cpu, layout, program, run, ui } from '../machine/state';
import { dpOnStateChange, syncDatapathPanelHost, updateDatapathPanelAvailability, updateFloatSteps } from './datapath';
import { updateDisassembly, updateMachineCode } from './disassembly';
import { editor, log, resetExecutionForSourceChange, setBreakpointsEffect } from './editor';
import { redraw } from './views.svelte';
import { pageLayout, setDockWidth } from './page-layout';
import { editorState } from './editor-state';
import { syncWaveformPanelHost, updateLocalsPanelAvailability, updateWaveformPanelAvailability } from './examples-language';
import { updateLocalsView } from './locals';
import { updateMemSubTabs, updateMemoryView } from './memory-register-views';
import { initPeripherals, updatePeripherals } from './peripherals';
import { byId, targetEl } from './dom';
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
// The defaults until initPanelDock() reads the saved layout.
export let panelDock: PanelDock = panelDockDefaults();
// The two rows' heights in the 2×2 grid, once the row splitter has set them.
export let dockRowHeights: number[] | null = null;
// A floating panel being dragged: where the pointer and the panel started.
export let floatDrag: { name: string; startX: number; startY: number; origX: number; origY: number } | null = null;
export let dockSavedWidth: number | null = null;
// In the tabbed mobile view (≤800px) exactly one panel is shown at a time;
// `mobileTab` tracks which one. It is ephemeral — it never changes the
// persisted desktop panel visibility/layout.
export let mobileTab: string | null = null;

export function panelDockDefaults(): PanelDock {
  // Per-panel seeds. Anything in PANEL_DEFS without an entry here still
  // gets a default below, so adding a panel can never leave the dock
  // holding an undefined state object.
  const seeds: Record<string, Partial<PanelState>> = {
    registers: { visible: true, x: 90, y: 90, w: 460, h: 360 },
    memory: { x: 130, y: 120, w: 540, h: 400 },
    peripherals: { x: 170, y: 150, w: 560, h: 440 },
    disassembly: { x: 210, y: 180, w: 580, h: 400 },
    locals: { x: 250, y: 210, w: 480, h: 360 },
  };
  const def = { order: PANEL_DEFS.map(p => p.name) } as PanelDock;
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
  let saved: Record<string, unknown> | null = null;
  try { saved = JSON.parse(localStorage.getItem(PANEL_DOCK_KEY) || 'null'); } catch (e) { saved = null; }
  if (!saved || typeof saved !== 'object') return def;
  dockRowHeights = Array.isArray(saved.rowHeights) && saved.rowHeights.every((h: unknown) => typeof h === 'number') ? saved.rowHeights as number[] : null;
  PANEL_DEFS.forEach(({ name }) => {
    if (saved[name] && typeof saved[name] === 'object') def[name] = Object.assign(def[name], saved[name]);
  });
  if (Array.isArray(saved.order) && saved.order.length) {
    // Keep the user's ordering for the panels it names, then append any
    // panel it does not know about (a layout saved before that panel
    // existed).
    const known = (saved.order as unknown[]).filter((n): n is string => PANEL_DEFS.some(p => p.name === n));
    const missing = PANEL_DEFS.map(p => p.name).filter(n => !known.includes(n));
    if (known.length) def.order = known.concat(missing);
  }
  return def;
}

export function savePanelDock() {
  const saved = dockRowHeights ? Object.assign({}, panelDock, { rowHeights: dockRowHeights }) : panelDock;
  try { localStorage.setItem(PANEL_DOCK_KEY, JSON.stringify(saved)); } catch (e) { /* storage unavailable */ }
}

// True when the 2×2 grid is active (more than two docked panels on a wide
// enough viewport). On ≤800px the mobile tabbed view takes over.
export function dockUsesTwoColumns() {
  if ((window.innerWidth || 1200) <= 800) return false;
  const docked = panelDock.order.filter(n => panelDock[n].visible && !panelDock[n].floating);
  return docked.length > 2;
}

export function mobileMode() {
  return (window.innerWidth || 1200) <= 800;
}

// Pick a sensible default active tab for the mobile tabbed view: the first
// visible panel in dock order, falling back to the last used mobile tab if
// it is still visible, then to 'registers'.
export function ensureMobileTab() {
  if (mobileTab && panelDock[mobileTab] && panelDock[mobileTab].visible) return;
  const first = panelDock.order.find(n => panelDock[n] && panelDock[n].visible);
  mobileTab = first || 'registers';
}

// Mobile chip clicks switch the single visible tab, mutually exclusive,
// without touching the persisted desktop panel visibility.
export function setMobileTab(name: string | null) {
  if (!name || !panelDock[name]) return;
  mobileTab = name;
  applyPanelDock();
  refreshPanel(name);
  if (typeof updateFloatSteps === 'function') updateFloatSteps();
}

export function currentDockWidth() {
  const rp = document.querySelector<HTMLElement>('.right-panel');
  if (!rp) return 0;
  const rectW = rp.getBoundingClientRect().width;
  if (rectW > 0) return rectW;
  // jsdom (and layouts where getBoundingClientRect is stubbed) returns 0 for
  // the rendered width; fall back to the width it was given so
  // `updateDockWidthForGrid` still computes a sensible target instead of
  // collapsing the dock.
  return pageLayout.dockW ?? 0;
}

// When the 2×2 grid is active the dock expands to half of the window
// width; otherwise it returns to the user's manually chosen width.
// The target is applied as an absolute width, never as a grow-only
// `Math.max(current, target)`: a grow-only clamp would make the panels
// area jump left, leaving blank space on the right, whenever a relayout
// follows a main-splitter drag narrower than 50%.
export function updateDockWidthForGrid() {
  if (dockUsesTwoColumns()) {
    const target = Math.round((window.innerWidth || 1200) * DOCK_TWO_COL_WIDTH_PCT);
    if (dockSavedWidth === null) dockSavedWidth = currentDockWidth();
    setDockWidth(Math.max(target, 220));
  } else if (dockSavedWidth !== null) {
    setDockWidth(Math.max(220, dockSavedWidth));
    dockSavedWidth = null;
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
  if (!dockUsesTwoColumns()) return;
  if (mobileMode()) return;
  const rp = document.querySelector<HTMLElement>('.right-panel');
  if (!rp) return;
  const availW = rp.clientWidth;
  if (!(availW > 0)) return;
  const dockedNames = panelDock.order.filter(n => panelDock[n].visible && !panelDock[n].floating);
  const mid = Math.ceil(dockedNames.length / 2);
  const row1 = dockedNames.slice(0, mid);
  const row2 = dockedNames.slice(mid);
  let changed = false;
  [row1, row2].forEach((rowNames) => {
    if (rowNames.length < 2) return; // single panel row — full width
    let total = 0;
    rowNames.forEach(n => { total += (panelDock[n].wbasis || 0); });
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
// A resizable column: its key, narrowest width, natural width, and its share
// of any spare width.
export interface PanelCol { key: string; min: number; fit: number; grow: number }
export const PANEL_COLS: Record<string, PanelCol[]> = {
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
export const panelColWidthCache: Record<string, Record<string, number>> = {};
// Pinned (user-dragged) widths for a panel, keyed by column. A column
// absent from this map is laid out automatically.
export function panelColWidths(panel: string) {
  if (!panelColWidthCache[panel]) {
    let out = {};
    try {
      const raw = localStorage.getItem(panelColWidthKey(panel));
      const o: unknown = raw ? JSON.parse(raw) : null;
      if (o && typeof o === 'object') out = o as Record<string, number>;
    } catch (e) { /* corrupt storage → automatic layout */ }
    panelColWidthCache[panel] = out;
  }
  return panelColWidthCache[panel];
}
export function savePanelColWidths(panel: string) {
  try { localStorage.setItem(panelColWidthKey(panel), JSON.stringify(panelColWidths(panel))); }
  catch (e) { /* storage unavailable */ }
}

export function panelBodyEl(panel: string) {
  const el = panelEl(panel);
  return el ? (el.querySelector<HTMLElement>(':scope > .panel-body') || el) : null;
}
// Usable width inside the panel: clientWidth includes padding (and
// already excludes any vertical scrollbar), so take the padding off.
export function panelContentWidth(panel: string) {
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
  const blk = document.querySelector<HTMLElement>('#memView .mem-hex-block');
  if (!blk) return memHexNaturalW;
  const prev = blk.style.width;
  blk.style.width = 'max-content';
  const w = Math.ceil(blk.getBoundingClientRect().width);
  blk.style.width = prev;
  if (w > 0) memHexNaturalW = w;
  return memHexNaturalW;
}

export function columnFloor(panel: string, key: string) {
  const c = PANEL_COLS[panel].find(x => x.key === key);
  let floor = c ? c.min : 40;
  if (panel === 'memory' && key === 'hex' && memHexNaturalW > 0) {
    floor = Math.max(floor, memHexNaturalW);
  }
  return floor;
}

// Resolve every column to a px width for the panel's current size.
export function computedColWidths(panel: string) {
  const cols = PANEL_COLS[panel];
  const pinned = panelColWidths(panel);
  const isPinned = (c: { key: string }) => Number.isFinite(Number(pinned[c.key]));
  const w = cols.map((c) => isPinned(c)
    ? Math.max(columnFloor(panel, c.key), Number(pinned[c.key]))
    : c.fit);
  const total = w.reduce((a, b) => a + b, 0);
  const avail = panelContentWidth(panel);
  // Surplus goes only to the unpinned grow columns; a pinned column
  // keeps exactly the width it was dragged to.
  const growTotal = cols.reduce((s, c) => s + (isPinned(c) ? 0 : c.grow), 0);
  if (avail > total && growTotal > 0) {
    const extra = avail - total;
    cols.forEach((c, i) => { if (!isPinned(c) && c.grow) w[i] += extra * c.grow / growTotal; });
  }
  return w.map((x: number) => Math.round(x));
}

// Push the computed widths into the DOM. The tables carry a <colgroup>
// (one <col> per column) and the Memory panel a set of custom
// properties; both also get a min-width equal to the column total, so a
// panel too narrow to hold them scrolls instead of crushing a column.
export function applyPanelColLayout(panel: string) {
  const w = computedColWidths(panel);
  const total = w.reduce((a, b) => a + b, 0);
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
    : document.querySelector<HTMLElement>('#disassemblyDisplay .code-list');
  if (!tbl) return;
  const colEls = tbl.querySelectorAll<HTMLElement>('colgroup > col');
  if (colEls.length !== w.length) return;
  colEls.forEach((c, i) => { c.style.width = w[i] + 'px'; });
  tbl.style.minWidth = total + 'px';
}

export function resetPanelColWidths(panel: string) {
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
    let drag: { pinnedAll: boolean; panel: string; key: string; startW: number; startX: number; handle: HTMLElement; idx: number } | null = null;
    document.addEventListener('pointerdown', (e) => {
      const handle = targetEl(e)?.closest<HTMLElement>('.col-resizer');
      if (!handle) return;
      const panel = handle.dataset.panel, key = handle.dataset.col;
      if (!panel || !PANEL_COLS[panel] || !key) return;
      e.preventDefault();
      const idx = PANEL_COLS[panel].findIndex(c => c.key === key);
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
        PANEL_COLS[drag.panel].forEach((c, i) => { pinned[c.key] = widths[i]; });
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
      const handle = targetEl(e)?.closest<HTMLElement>('.col-resizer');
      if (!handle) return;
      const panel = handle.dataset.panel;
      if (panel && PANEL_COLS[panel]) resetPanelColWidths(panel);
    });

    // Re-flow the columns whenever a panel is resized (dock splitter,
    // window resize, floating-panel resize), so the grow columns keep
    // absorbing the surplus. Guarded on the measured width so the
    // observer cannot retrigger itself off its own writes.
    if (typeof ResizeObserver !== 'undefined') {
      const lastW: Record<string, number> = {};
      const ro = new ResizeObserver((entries) => {
        entries.forEach(entry => {
          const panel = (entry.target as HTMLElement).dataset.colPanel;
          if (!panel) return;
          const w = panelContentWidth(panel);
          if (lastW[panel] === w) return;
          lastW[panel] = w;
          applyPanelColLayout(panel);
        });
      });
      Object.keys(PANEL_COLS).forEach(panel => {
        const body = panelBodyEl(panel);
        if (!body || body.dataset.colPanel) return;
        body.dataset.colPanel = panel;
        ro.observe(body);
      });
    }
  }
  Object.keys(PANEL_COLS).forEach(applyPanelColLayout);
}

export function panelEl(name: string) { return document.getElementById('tab-' + name); }

export function isPanelVisible(name: string) {
  return !!(panelDock[name] && panelDock[name].visible);
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
export const PANEL_FIND_PLACEHOLDER: Record<string, string> = {
  registers: 'Filter registers',
  memory: 'Filter the rows shown',
  disassembly: 'Filter instructions',
  locals: 'Filter locals'
};

// Not persisted: a filter that silently survived a reload would look like
// missing data rather than a filter.
export const panelFindText: Record<string, string> = {};
// Which panels' filter bars are open, and each one's "n of m".
export const panelFindOpen: Record<string, boolean> = {};
export const panelFindCount: Record<string, string> = {};

export function setPanelFind(name: string, text: string) {
  panelFindText[name] = text || '';
  redraw('dock');
  refreshPanel(name);
}

export function togglePanelFind(name: string) {
  if (!PANEL_FIND.has(name)) return;
  if (!panelFindOpen[name]) {
    panelFindOpen[name] = true;
    redraw('dock');
    document.querySelector<HTMLInputElement>('#panelFind-' + name + ' input')?.focus();
  } else {
    closePanelFind(name);
  }
}

export function closePanelFind(name: string) {
  panelFindOpen[name] = false;
  setPanelFind(name, '');
}

// True when there is no filter, so callers can guard a row unconditionally.
export function panelFindMatch(name: string, haystack: string) {
  const q = panelFindText[name];
  if (!q) return true;
  return String(haystack).toLowerCase().includes(q.toLowerCase());
}

export function panelFindActive(name: string) { return !!panelFindText[name]; }

export function setPanelFindCount(name: string, shown: number, total: number) {
  const text = panelFindText[name] ? shown + ' of ' + total : '';
  if (panelFindCount[name] === text) return;
  panelFindCount[name] = text;
  redraw('dock');
}

// What the dock shows (PanelDock.svelte): every panel in dock order, each
// with its place, and the splitters between them. Panels never change
// parent: the 2×2 grid is the stack wrapping, a full-width row splitter
// being the line break, so relaying out moves no panel's contents.
export type DockPanel = {
  kind: 'panel'; key: string; name: string; label: string; findable: boolean;
  mode: 'hidden' | 'docked' | 'floating' | 'mobile' | 'mobile-hidden';
  row: number; flex: string | null; height: string | null;
  rect: { x: number; y: number; w: number; h: number } | null;
};
export type DockSplitter =
  | { kind: 'hsplit'; key: string; left: string; right: string }
  | { kind: 'vsplit'; key: string; above: string[]; below: string[]; grid: boolean };
// Until the dock is laid out at boot, every panel is there and hidden, so
// that its elements exist from load on.
export let dockView = {
  items: PANEL_DEFS.map((d): DockPanel | DockSplitter => ({
    kind: 'panel', key: d.name, name: d.name, label: d.label, findable: PANEL_FIND.has(d.name),
    mode: mobileMode() ? 'mobile-hidden' : 'hidden',
    row: 0, flex: null, height: null, rect: null,
  })),
  grid: false, mobile: mobileMode(), empty: false,
  mobileTab: null as string | null,
  focusedFloat: null as string | null,
  // Each panel shown or not, and floating or not, for its chip.
  shown: {} as Record<string, { visible: boolean; floating: boolean }>,
  // The chips of panels that only exist in some modes (Locals in C, the
  // waveform and datapath tabs on a phone).
  chipShown: {} as Record<string, boolean>,
};

export function setPanelChipShown(name: string, shown: boolean) {
  if (dockView.chipShown[name] === shown) return;
  dockView = { ...dockView, chipShown: { ...dockView.chipShown, [name]: shown } };
  redraw('dock');
}

export function applyPanelDock() {
  if (!panelDock) return;

  // Keep the focus and the caret where they are: a relayout that moves a
  // panel can drop the focus, which on a phone closes the soft keyboard in
  // the middle of typing into the UART console or any other field.
  const activeEl = document.activeElement as HTMLInputElement | null;
  let restoreFocus: { el: HTMLInputElement; selStart: number | null; selEnd: number | null } | null = null;
  if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT' || activeEl.isContentEditable)) {
    const text = activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA';
    restoreFocus = { el: activeEl, selStart: text ? activeEl.selectionStart : null, selEnd: text ? activeEl.selectionEnd : null };
  }

  const dockedNames = panelDock.order.filter(n => panelDock[n].visible && !panelDock[n].floating);
  const twoCols = dockUsesTwoColumns();
  const mobile = mobileMode();
  syncWaveformPanelHost();
  if (document.body.dataset.booted) syncDatapathPanelHost();
  if (mobile) ensureMobileTab();

  // Set the dock width before laying out the grid: the row-fit clamp below
  // reads the actual available width.
  updateDockWidthForGrid();
  clampGridRowWidths();

  const mid = Math.ceil(dockedNames.length / 2);
  const rowOf = (n: string) => !twoCols ? 0 : dockedNames.indexOf(n) < mid ? 1 : 2;
  const labels = Object.fromEntries(PANEL_DEFS.map(d => [d.name, d.label]));
  const items: (DockPanel | DockSplitter)[] = [];
  const lastDocked = dockedNames[dockedNames.length - 1];
  panelDock.order.forEach(name => {
    const st = panelDock[name];
    const docked = st.visible && !st.floating;
    let flex: string | null = null, height: string | null = null;
    if (!mobile && docked) {
      if (twoCols) {
        // A dragged width is a shrinkable basis (`0 1 Npx`), so the row
        // still fits a dock narrower than the dragged total. A panel alone
        // in its row (the 3rd of 3) always spans the row.
        const row = rowOf(name);
        const rowHasPair = (row === 1 ? mid : dockedNames.length - mid) > 1;
        flex = (rowHasPair && st.wbasis && st.wbasis > 0) ? '0 1 ' + st.wbasis + 'px' : '1 1 0px';
        height = dockRowHeights && dockRowHeights[row - 1] ? dockRowHeights[row - 1] + 'px' : 'calc(50% - 3px)';
      } else {
        flex = (st.basis && st.basis > 0) ? '0 0 ' + st.basis + 'px' : '1 1 0px';
      }
    }
    // In the tabbed mobile view only the active tab is shown, even when its
    // desktop visibility is off; that is only changed by tapping a chip.
    const mode: DockPanel['mode'] = mobile ? (name === mobileTab ? 'mobile' : 'mobile-hidden')
      : !st.visible ? 'hidden' : st.floating ? 'floating' : 'docked';
    items.push({
      kind: 'panel', key: name, name, label: labels[name], findable: PANEL_FIND.has(name), mode,
      row: docked ? rowOf(name) : 0, flex, height,
      rect: mode === 'floating' ? { x: st.x, y: st.y, w: st.w, h: st.h } : null,
    });
    if (!docked || name === lastDocked) return;
    const i = dockedNames.indexOf(name);
    const next = dockedNames[i + 1];
    if (twoCols && !mobile) {
      // Between two panels of a row a column splitter; after the first
      // row the row splitter, which also breaks the line.
      if (rowOf(next) === rowOf(name)) items.push({ kind: 'hsplit', key: 'h:' + name, left: name, right: next });
      else items.push({ kind: 'vsplit', key: 'v:grid', above: dockedNames.slice(0, mid), below: dockedNames.slice(mid), grid: true });
    } else {
      items.push({ kind: 'vsplit', key: 'v:' + name, above: [name], below: [next], grid: false });
    }
  });
  dockView = {
    ...dockView, items, grid: twoCols && !mobile, mobile, mobileTab,
    shown: Object.fromEntries(panelDock.order.map(n => [n, { visible: panelDock[n].visible, floating: panelDock[n].floating }])),
    // On a phone a tab is always shown, so the "all hidden" hint never applies.
    empty: !mobile && dockedNames.length === 0,
  };
  redraw('dock');

  panelDock.order.filter(n => panelDock[n].visible && panelDock[n].floating).forEach(keepFloatInView);
  savePanelDock();
  if (restoreFocus && restoreFocus.el.isConnected && document.activeElement !== restoreFocus.el) {
    try {
      restoreFocus.el.focus();
      if (restoreFocus.selStart !== null && restoreFocus.selEnd !== null) {
        restoreFocus.el.setSelectionRange(restoreFocus.selStart, restoreFocus.selEnd);
      }
    } catch (e) { /* not focusable any more */ }
  }
}

export function keepFloatInView(name: string) {
  const st = panelDock[name];
  const el = panelEl(name);
  if (!st || !el) return;
  const maxX = window.innerWidth - 60;
  const maxY = window.innerHeight - 32;
  const x0 = st.x, y0 = st.y;
  if (st.x > maxX) st.x = Math.max(0, maxX);
  if (st.y > maxY) st.y = Math.max(0, maxY);
  if (st.x < -el.offsetWidth + 60) st.x = 0;
  if (st.y < 0) st.y = 0;
  if (st.x !== x0 || st.y !== y0) moveFloat(name);
}

// A floating panel's rectangle changed: redraw just that.
function moveFloat(name: string) {
  const st = panelDock[name];
  dockView = { ...dockView, items: dockView.items.map(it => it.kind === 'panel' && it.name === name && it.rect
    ? { ...it, rect: { x: st.x, y: st.y, w: st.w, h: st.h } } : it) };
  redraw('dock');
}

// The browser's own resize handle sized a floating panel.
let floatSaveTimer: ReturnType<typeof setTimeout> | undefined;
export function noteFloatResized(name: string, w: number, h: number) {
  const st = panelDock[name];
  if (!st || !st.floating || (st.w === w && st.h === h)) return;
  st.w = w;
  st.h = h;
  clearTimeout(floatSaveTimer);
  floatSaveTimer = setTimeout(savePanelDock, 300);
}

export function setPanelVisible(name: string, vis: boolean) {
  if (!panelDock[name]) return;
  panelDock[name].visible = vis;
  if (!vis) panelDock[name].floating = false;
  applyPanelDock();
  if (vis) refreshPanel(name);
}

export function togglePanel(name: string) {
  if (!panelDock[name]) return;
  setPanelVisible(name, !panelDock[name].visible);
}

export function togglePanelFloat(name: string) {
  const st = panelDock[name];
  if (!st || !st.visible) return;
  st.floating = !st.floating;
  if (st.floating) {
    if (st.x > window.innerWidth - 120 || st.x < 0) st.x = Math.max(20, (window.innerWidth - st.w) / 2);
    if (st.y > window.innerHeight - 80 || st.y < 0) st.y = Math.max(20, (window.innerHeight - st.h) / 3);
  }
  applyPanelDock();
  refreshPanel(name);
}

// Dragging a floating panel by its header.
export function onFloatDragStart(e: PointerEvent, name: string) {
  const st = panelDock[name];
  if (!st || !st.floating) return;
  if (targetEl(e)?.closest('.panel-hdr-btn')) return;
  floatDrag = { name, startX: e.clientX, startY: e.clientY, origX: st.x, origY: st.y };
  dockView = { ...dockView, focusedFloat: name };
  redraw('dock');
  (e.currentTarget as Element | null)?.setPointerCapture?.(e.pointerId);
  e.preventDefault();
}

export function onFloatDragMove(e: PointerEvent) {
  if (!floatDrag) return;
  const st = panelDock[floatDrag.name];
  const el = panelEl(floatDrag.name);
  if (!el) return;
  st.x = Math.max(-el.offsetWidth + 60, Math.min(floatDrag.origX + (e.clientX - floatDrag.startX), window.innerWidth - 60));
  st.y = Math.max(0, Math.min(floatDrag.origY + (e.clientY - floatDrag.startY), window.innerHeight - 32));
  moveFloat(floatDrag.name);
}

export function onFloatDragEnd() {
  if (!floatDrag) return;
  floatDrag = null;
  savePanelDock();
}

// A splitter being dragged: which, where the pointer started, and the
// sizes it started from. A dragged size is always the start size plus the
// whole distance moved, never accumulated move by move, so a small drag
// cannot run away.
let splitDrag: { sp: DockSplitter; start: number; a: number; b: number } | null = null;

function dragCursor(cursor: string) {
  document.body.style.cursor = cursor;
  document.body.style.userSelect = cursor ? 'none' : '';
}

export function onSplitterDown(e: PointerEvent, sp: DockSplitter) {
  const h = (n: string) => panelEl(n)?.offsetHeight ?? 0;
  const w = (n: string) => panelEl(n)?.offsetWidth ?? 0;
  if (sp.kind === 'hsplit') {
    splitDrag = { sp, start: e.clientX, a: w(sp.left), b: w(sp.right) };
  } else {
    splitDrag = { sp, start: e.clientY, a: h(sp.above[0]), b: h(sp.below[0]) };
  }
  (e.currentTarget as Element | null)?.setPointerCapture?.(e.pointerId);
  dragCursor(sp.kind === 'hsplit' ? 'col-resize' : 'row-resize');
  e.preventDefault();
}

export function onSplitterMove(e: PointerEvent) {
  if (!splitDrag) return;
  const { sp, start, a, b } = splitDrag;
  if (sp.kind === 'hsplit') {
    const dx = e.clientX - start;
    panelDock[sp.left].wbasis = Math.max(MIN_COL_W, a + dx);
    panelDock[sp.right].wbasis = Math.max(MIN_COL_W, b - dx);
  } else {
    const dy = e.clientY - start;
    if (sp.grid) dockRowHeights = [Math.max(90, a + dy), Math.max(90, b - dy)];
    else {
      panelDock[sp.above[0]].basis = Math.max(90, a + dy);
      panelDock[sp.below[0]].basis = Math.max(90, b - dy);
    }
  }
  applyPanelDock();
}

export function onSplitterUp() {
  if (!splitDrag) return;
  const { sp } = splitDrag;
  splitDrag = null;
  dragCursor('');
  if (sp.kind === 'hsplit') {
    // Never persist a pair wider than its row: scale it down to fit, each
    // column keeping at least MIN_COL_W and the pair its dragged ratio.
    const available = byId('panelStack')?.clientWidth ?? 0;
    const l = panelDock[sp.left], r = panelDock[sp.right];
    const total = l.wbasis + r.wbasis;
    if (available > 0 && total + 6 > available) {
      const extra = Math.max(0, available - 6 - 2 * MIN_COL_W);
      l.wbasis = MIN_COL_W + Math.round((l.wbasis / total) * extra);
      r.wbasis = Math.max(MIN_COL_W, available - 6 - l.wbasis);
    }
  } else if (!sp.grid) {
    // The single column: every docked panel keeps the height it now has.
    panelDock.order.forEach(n => {
      const st = panelDock[n];
      const el = panelEl(n);
      if (el && st.visible && !st.floating) st.basis = el.offsetHeight;
    });
  }
  applyPanelDock();
}

// A double click evens out what the splitter divides.
export function onSplitterReset(sp: DockSplitter) {
  if (sp.kind === 'hsplit') panelDock.order.forEach(n => { panelDock[n].wbasis = 0; });
  else {
    dockRowHeights = null;
    panelDock.order.forEach(n => { panelDock[n].basis = 0; });
  }
  applyPanelDock();
}

// A chip in the tab strip: on a phone it shows that one panel, as a tab;
// otherwise it shows or hides it.
export function onPanelChip(name: string) {
  if (mobileMode()) {
    if (!panelDock[name].visible) setPanelVisible(name, true);
    setMobileTab(name);
  } else {
    togglePanel(name);
  }
}

export function initPanelDock() {
  panelDock = loadPanelDock();
  applyPanelDock();
  panelDock.order.forEach((name: string) => { if (isPanelVisible(name)) refreshPanel(name); });
  updateLocalsPanelAvailability();
  updateWaveformPanelAvailability();
  // Wire up the intra-panel column-resize separators (Registers /
  // Memory / Disassembly) and apply any persisted per-panel widths.
  initPanelColResizers();
  let lastLayoutWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    // While a form field is focused (UART console, memory address box,
    // find/replace, …), a mobile on-screen keyboard open/close fires a
    // window resize (visual viewport). Relayouting the panel stack during
    // typing would move the focused node and can dismiss the keyboard, so
    // skip every panel/layout adjustment in that case.
    // A keyboard changes only the height, so a change of width (a window
    // resized, a phone turned) is always laid out, or the page could stay
    // in the other side's layout.
    const ae = document.activeElement as HTMLElement | null;
    const widthChanged = window.innerWidth !== lastLayoutWidth;
    lastLayoutWidth = window.innerWidth;
    if (!widthChanged && ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) {
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
    // switches between the tabbed mobile view and the dock/grid view, even
    // with every panel hidden.
    if (mobileMode() !== dockView.mobile || mobileMode() || panelDock.order.some(n => panelDock[n].visible)) {
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
export function escapeHtml(s: unknown) {
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

export function fpRegDesc(i: number) {
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

// A name the editor offers: a label, register or the like, with its hover text.
export interface EditorSymbol { name: string; type: string; format: string; desc: string; meta: string }

// Hover and completion both ask for this on every event, with the whole
// document, which is usually the same document as last time.
export let editorSymbolsFor: string | null = null, editorSymbolsCache: EditorSymbol[] = [];

export function extractEditorSymbols(code: string) {
  if (code === editorSymbolsFor) return editorSymbolsCache;
  editorSymbolsFor = code;
  editorSymbolsCache = scanEditorSymbols(code);
  return editorSymbolsCache;
}

export function scanEditorSymbols(code: string): EditorSymbol[] {
  const symbols: EditorSymbol[] = [];
  const seen = new Set<string>();
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

export type RegRow = { i: number; name: string; hex: string; dec: string; changed: boolean; unknown: boolean };

// What the Registers panel shows, rebuilt by updateRegisters(). `editGen`
// changes when an inline edit ends, so the rows are drawn afresh.
export let regModel = { rows: [] as RegRow[], signed: true, readOnly: false, regMissing: false, editGen: 0 };
export let regEditGen = 0;
export function bumpRegEditGen() { regEditGen++; }

export function updateRegisters() {
  const rows: RegRow[] = [];
  // Hardware registers power up undefined. The functional model can afford
  // to show them as zero; the RTL cannot, and papering over that would hide
  // exactly the kind of bug HDL mode exists to find.
  const known = ui.engine === 'hdl' && hdlRec.trace ? hdlRec.regKnown : null;
  for (let i = 0; i < 32; i++) {
    const name = ABI_NAMES[i];
    const val = cpu.regs[i];
    const uval = val >>> 0;
    const decVal = ui.regDecSigned ? val : uval;
    if (!panelFindMatch('registers',
      `x${i} ${name} ${uval.toString(16).padStart(8, '0')} ${decVal}`)) continue;
    const unknown = !!known && i > 0 && !known[i];
    rows.push({
      i, name, changed: i === cpu.lastChangedReg, unknown,
      hex: unknown ? 'xxxxxxxx' : uval.toString(16).padStart(8, '0'), dec: unknown ? '?' : String(decVal),
    });
  }
  // If the register file could not be reached inside the uploaded design,
  // every value here would be a guess, and the panel says so instead.
  regModel = {
    rows, signed: ui.regDecSigned, readOnly: stateIsReplayed(), editGen: regEditGen,
    regMissing: !!(ui.engine === 'hdl' && hdlRec.trace && !hdlRec.trace.regBank),
  };
  redraw('registers');
  setPanelFindCount('registers', rows.length, 32);
  // Also update peripherals (PC LEDs, etc.) when registers are refreshed
  updatePeripherals();
  // Locals changes at the same moments as Registers, so refreshing it here
  // keeps it live from every updateRegisters() call site (step, run, reset,
  // edit...).
  if (typeof updateLocalsView === 'function') updateLocalsView();
  dpOnStateChange();
}

export function setRegDecSigned(signed: boolean) {
  ui.regDecSigned = !!signed;
  updateRegisters();
}
