// Memory panel (region sub-tabs, Byte/Word display, in-place byte and
// word editing) and register-panel editing.

import { ABI_NAMES } from '../isa/instructions';
import { getMemByte, isMMIOAddr, readMem, writeMem } from '../machine/memory';
import { mmioReadOnlyMessage, mmioRegisterAt } from '../machine/mmio';
import { cpu, layout, memory, program, ui } from '../machine/state';
import { setStatus } from './editor';
import { REPLAYED_STATE_TITLE, TEXT_RO_TITLE, applyPanelColLayout, bumpRegEditGen, escapeHtml, measureMemHexNatural, panelFindMatch, setPanelFindCount, stateIsReplayed, updateRegisters } from './panels';
import { closeEditPopup, openEditPopup } from './edit-popup';
import { redraw } from './views.svelte';
import { updatePeripherals } from './peripherals';
import { byId } from './dom';

export let activeMemRegion = 'code';
export let memViewMode = 'word'; // 'word' = one whole 32-bit word per 4-byte group (default), 'bytes' = separate editable bytes
export let memDecSigned = true; // sign of the Word-mode Content(DEC) column; irrelevant in Byte mode (always ASCII)

export function isCodeSegmentAddress(addr: number) {
  return (addr >= layout.baseAddress && addr < layout.dataBase) || (activeMemRegion === 'code' && addr < layout.dataBase);
}

// A byte in the Byte view, and the 32-bit word in the Word view. `title`
// says how to edit it, or why it cannot be.
export type MemByte = { addr: number; hex: string; ch: string; changed: boolean; editable: boolean; title: string;
  asciiTitle: string };
export type MemWord = { addr: number; hex: string; dec: string; changed: boolean; editable: boolean; title: string;
  decTitle: string };
// The names shown above a row's word: the program's labels, or an MMIO
// register's own name.
export type MemLabel = { text: string; title: string | null; mmio: boolean };
export type MemRow = { key: string; start: number; addr: string; label: MemLabel | null;
  word: MemWord | null; bytes: MemByte[] | null };

// What the Memory panel shows, rebuilt by updateMemoryView().
export let memModel = {
  rows: [] as MemRow[], wordMode: true, signed: true, segment: 'code', editable: 'Read only',
};

// A row's version, raised when an edit in it ends: the cell was typed into,
// so it holds what was typed rather than the text the panel drew, and the
// row is drawn afresh.
const memRowGen = new Map<number, number>();
function memRowKey(start: number) { return start + '.' + (memRowGen.get(start) ?? 0); }

// The editability note in the legend. Nothing is editable while HDL state
// is replayed, so the whole note goes rather than reading "Editable" over
// cells that are not.
function memEditableNote() {
  return stateIsReplayed() ? ''
    : ui.memSegment === 'code' ? 'Read only'
    : ui.memSegment === 'mmio' ? 'Editable except RO'
    : 'Editable';
}

export function updateMemoryView() {
  const addrEl = byId<HTMLInputElement>('memAddr');
  const rowsEl = byId<HTMLInputElement>('memRows');
  // Guard against being invoked before the panel is mounted.
  if (!addrEl || !rowsEl) return;
  const addrStr = addrEl.value;
  const rows = parseInt(rowsEl.value) || 16;
  let addr = parseInt(addrStr, 16);
  if (isNaN(addr)) addr = (activeMemRegion === 'stack' || ui.memSegment === 'stack') ? layout.stackBase : layout.baseAddress;
  addr = (addr >>> 0) & ~0x3;  // Align to 4-byte (one word) boundary unsigned

  const isStackView = (activeMemRegion === 'stack' || ui.memSegment === 'stack');
  const wordMode = (memViewMode === 'word');
  const replayed = stateIsReplayed();
  const hex2 = (v: number) => v.toString(16).padStart(2, '0');
  const hex8 = (v: number) => (v >>> 0).toString(16).padStart(8, '0');
  const changedAt = (offset: number) => cpu.lastChangedMem.some(m => offset >= m.addr && offset < m.addr + m.size);
  const asciiOf = (v: number) => v >= 32 && v <= 126 ? String.fromCharCode(v) : '.';

  // Build address -> label-name map (same approach as the disassembly view)
  const labelsByAddr: Record<number, string[]> = {};
  if (program.labels && typeof program.labels === 'object') {
    for (const [name, addr] of Object.entries(program.labels)) {
      if (typeof addr === 'number' && !isNaN(addr)) {
        const uaddr = addr >>> 0;
        if (!labelsByAddr[uaddr]) labelsByAddr[uaddr] = [];
        if (!labelsByAddr[uaddr].includes(name)) labelsByAddr[uaddr].push(name);
      }
    }
  }

  // The labels in the word at `wordStart`, shown directly above it. When a
  // label is not word-aligned, a tooltip gives its exact byte address.
  const programLabel = (wordStart: number): MemLabel | null => {
    const names: string[] = [];
    const offsets: number[] = [];
    for (let c = 0; c < 4; c++) {
      const offset = isStackView ? ((wordStart - c) >>> 0) : ((wordStart + c) >>> 0);
      if (labelsByAddr[offset]) {
        for (const n of labelsByAddr[offset]) if (!names.includes(n)) names.push(n);
        if (!offsets.includes(offset)) offsets.push(offset);
      }
    }
    if (!names.length) return null;
    const unaligned = offsets.some(o => (o - wordStart) % 4 !== 0);
    // Trailing ':' to match how a label reads in the program itself.
    return { text: names.join(', ') + ':', mmio: false,
      title: unaligned ? `Symbol${offsets.length > 1 ? 's' : ''} at ${offsets.map(o => '0x' + hex8(o)).join(', ')}` : null };
  };

  // An MMIO register's own name, "UART RX VALID (RO):", in the same place.
  const mmioLabel = (wordStart: number): MemLabel | null => {
    const reg = mmioRegisterAt(wordStart);
    return reg ? { text: `${reg.name} (${reg.access}):`, title: null, mmio: true } : null;
  };

  // The names a row displays above its word join the row's text for the
  // panel's filter: searching for `main` or `UART` is at least as likely as
  // searching for an address.
  const memRowNames = (rowStart: number) => {
    const names: string[] = [];
    for (let c = 0; c < 4; c++) {
      const offset = isStackView ? ((rowStart - c) >>> 0) : ((rowStart + c) >>> 0);
      for (const n of (labelsByAddr[offset] || [])) if (!names.includes(n)) names.push(n);
    }
    const reg = mmioRegisterAt(rowStart);
    if (reg && reg.name) names.push(reg.name);
    return names.join(' ');
  };

  // One 32-bit word per row - each row's Hex and Content cells are the one
  // word at that address, so wrapping (a narrow panel) drops the Content
  // cell below the Hex cell but never splits a word's hex from its own
  // ASCII/DEC. Hex and ASCII are kept apart in the filter text so a search
  // for "dead" matches the hex run and a search for "Hell" the characters.
  const out: MemRow[] = [];
  let built = 0;
  for (let r = 0; r < rows; r++) {
    if (isStackView && addr < r * 4) break;
    // Stack grows downwards -> rows step downwards by 4 bytes; all other regions step upwards
    const wordStart = isStackView ? ((addr - r * 4) >>> 0) : ((addr + r * 4) >>> 0);
    const mmio = isMMIOAddr(wordStart);
    const reg = mmio ? mmioRegisterAt(wordStart) : null;
    // Replayed HDL state is read-only throughout; see REPLAYED_STATE_TITLE.
    const mmioEditable = mmio && !replayed && !!reg && reg.editable;
    const mmioRoTitle = replayed ? REPLAYED_STATE_TITLE
      : reg ? `${reg.name} (${reg.access}) is read-only` : (mmioReadOnlyMessage(wordStart) || '');
    // Words and bytes of the row, in the order they are shown.
    const offsets = [0, 1, 2, 3].map(c => (mmio || !isStackView) ? ((wordStart + c) >>> 0) : ((wordStart - c) >>> 0));
    const vals = offsets.map(o => mmio ? readMem(o, 1, true) & 0xFF : getMemByte(o));
    const label = mmio ? mmioLabel(wordStart) : programLabel(wordStart);
    let text: string, word: MemWord | null = null, bytes: MemByte[] | null = null;

    if (wordMode) {
      const wordVal = (vals[0] | (vals[1] << 8) | (vals[2] << 16) | (vals[3] << 24)) >>> 0;
      // A word in the text segment, or replayed HDL state, is read-only,
      // and the tooltip says which.
      const editable = mmio ? mmioEditable : !replayed && offsets.some(o => !isCodeSegmentAddress(o));
      const roTitle = mmio ? mmioRoTitle : replayed ? REPLAYED_STATE_TITLE : TEXT_RO_TITLE;
      word = {
        addr: offsets[0], hex: hex8(wordVal), dec: String(memDecSigned ? (wordVal | 0) : wordVal),
        changed: offsets.some(changedAt), editable,
        title: editable ? 'Click to edit 32-bit word (little-endian)' : roTitle,
        decTitle: editable ? 'Click to edit 32-bit word' : roTitle,
      };
      text = `0x${hex8(wordStart)} ${word.hex} ${word.dec}`;
    } else {
      bytes = offsets.map((o, i) => {
        // A byte can be read-only for either reason, and the tooltip should
        // say which; HDL replay wins because it applies to every segment.
        const editable = mmio ? mmioEditable : !replayed && !isCodeSegmentAddress(o);
        const roTitle = mmio ? mmioRoTitle : replayed ? REPLAYED_STATE_TITLE : TEXT_RO_TITLE;
        return {
          addr: o, hex: hex2(vals[i]), ch: asciiOf(vals[i]), changed: changedAt(o), editable,
          title: !editable ? roTitle : mmio ? 'Single-click: edit byte | Double-click: edit word'
            : 'Single-click: edit byte (00-ff) | Double-click: edit word (Enter commits, Esc cancels)',
          asciiTitle: editable ? 'Click matching hex byte to edit' : roTitle,
        };
      });
      text = `0x${hex8(wordStart)} ${bytes.map(b => b.hex).join('')} ${bytes.map(b => b.ch).join('')}`;
    }
    built++;
    if (!panelFindMatch('memory', text + ' ' + memRowNames(wordStart))) continue;
    out.push({ key: memRowKey(wordStart), start: wordStart, addr: '0x' + hex8(wordStart), label, word, bytes });
  }
  memModel = { rows: out, wordMode, signed: memDecSigned, segment: ui.memSegment, editable: memEditableNote() };
  redraw('memory');
  setPanelFindCount('memory', out.length, built);
  // Re-measure the hex data's natural width (it changes with the
  // Byte/Word mode) so the Hex column's drag floor stays honest, then
  // re-run the layout against it.
  measureMemHexNatural();
  applyPanelColLayout('memory');
}

export function setMemViewMode(mode: string) {
  memViewMode = (mode === 'word') ? 'word' : 'bytes';
  updateMemoryView();
  setStatus(memViewMode === 'word' ? 'Memory view: 32-bit word display' : 'Memory view: separate byte display', 'info');
}

export function setMemDecSigned(signed: boolean) {
  memDecSigned = !!signed;
  updateMemoryView();
}

export function editMemByte(addr: number) {
  if (isCodeSegmentAddress(addr)) {
    setStatus('Text segment is read-only in Memory View (edit in Code Editor and Assemble)', 'warning');
    return;
  }
  const roMsg = mmioReadOnlyMessage(addr);
  if (roMsg) {
    setStatus(roMsg, 'warning');
    return;
  }
  focusMemByte(addr);
}

export function startMemByteEdit(el: HTMLElement) {
  if (stateIsReplayed()) { setStatus(REPLAYED_STATE_TITLE, 'warning'); return; }

  const addr = parseInt(el.dataset.addr ?? '', 10);
  if (isCodeSegmentAddress(addr)) {
    el.blur();
    setStatus('Text segment is read-only in Memory View (edit in Code Editor and Assemble)', 'warning');
    return;
  }
  const roMsg = mmioReadOnlyMessage(addr);
  if (roMsg) {
    el.blur();
    setStatus(roMsg, 'warning');
    return;
  }
  el.dataset.old = (el.textContent || '').trim().padStart(2, '0').slice(-2);
  el.classList.add('editing');
  selectElementText(el);
}

export function handleMemByteEditKey(event: KeyboardEvent, el: HTMLElement) {
  if (event.key === 'Enter') {
    event.preventDefault();
    el.blur();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelMemByteEdit(el);
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
  if (!/[0-9a-fA-F]/.test(event.key)) {
    event.preventDefault();
    return;
  }
  // Typing over a selection replaces it, so selected digits do not count.
  const sel = window.getSelection();
  const selected = sel && el.contains(sel.anchorNode) ? sel.toString().length : 0;
  const currentLen = (el.textContent || '').trim().length;
  if (currentLen - selected >= 2) event.preventDefault();
}

export function writeMemFromPanel(addr: number, val: number, size: number) {
  memory.panelEdit = true;
  try { writeMem(addr, val, size); } finally { memory.panelEdit = false; }
}

// The byte was typed into: its row is drawn afresh, whether the edit was
// kept or not.
function endMemByteEdit(el: HTMLElement) {
  el.classList.remove('editing');
  const row = Number(el.closest<HTMLElement>('[data-row]')?.dataset.row);
  if (Number.isFinite(row)) memRowGen.set(row, (memRowGen.get(row) ?? 0) + 1);
  updateMemoryView();
}

export function commitMemByteEdit(el: HTMLElement) {
  if (!el || !el.classList || !el.classList.contains('editing')) return;
  const addr = parseInt(el.dataset.addr ?? '', 10);
  const roMsg = isCodeSegmentAddress(addr) ? 'Text segment is read-only in Memory View' : mmioReadOnlyMessage(addr);
  if (roMsg) {
    endMemByteEdit(el);
    setStatus(roMsg, 'warning');
    return;
  }
  const normalized = (el.textContent || '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{1,2}$/.test(normalized)) {
    endMemByteEdit(el);
    setStatus('Invalid byte value; use hex 00-ff', 'error');
    return;
  }
  const val = parseInt(normalized, 16);
  if (isNaN(addr) || addr < 0) {
    endMemByteEdit(el);
    setStatus('Invalid memory edit', 'error');
    return;
  }
  writeMemFromPanel(addr, val, 1);
  cpu.lastChangedMem = [{ addr, size: 1 }];
  endMemByteEdit(el);
  updatePeripherals();
  setStatus('Memory updated at 0x' + addr.toString(16).padStart(8, '0'), 'success');
}

export function cancelMemByteEdit(el: HTMLElement) {
  if (el.classList.contains('editing')) endMemByteEdit(el);
  el.blur();
}

// ---- Word-level editing (4 bytes at a time) ----

export function startMemWordEdit(event: Event, wordStartAddr: number) {
  if (stateIsReplayed()) { setStatus(REPLAYED_STATE_TITLE, 'warning'); return; }

  event.preventDefault();
  event.stopPropagation();
  if (isCodeSegmentAddress(wordStartAddr)) {
    setStatus('Text segment is read-only in Memory View (edit in Code Editor and Assemble)', 'warning');
    return;
  }
  const roMsg = mmioReadOnlyMessage(wordStartAddr);
  if (roMsg) {
    setStatus(roMsg, 'warning');
    return;
  }
  // Find the four bytes in this word (aligned to 4-byte boundary)
  const alignedAddr = wordStartAddr & ~0x3;
  openMemWordOverlay(alignedAddr);
}

// Word-cell click handler for the "word view" memory display mode.
export function startMemWordCellEdit(event: Event, wordStartAddr: number) {
  if (stateIsReplayed()) { setStatus(REPLAYED_STATE_TITLE, 'warning'); return; }

  event.preventDefault();
  event.stopPropagation();
  if (isCodeSegmentAddress(wordStartAddr)) {
    setStatus('Text segment is read-only in Memory View (edit in Code Editor and Assemble)', 'warning');
    return;
  }
  const roMsg = mmioReadOnlyMessage(wordStartAddr);
  if (roMsg) {
    setStatus(roMsg, 'warning');
    return;
  }
  openMemWordOverlay(wordStartAddr & ~0x3);
}

// The edit popups take `0x` as hex and bare digits as decimal, so a value
// typed as it reads in a decimal column means what it looks like. Hex
// without the prefix is still taken once a letter makes it unambiguous.
// Returns the 32-bit pattern, or null when the text is neither.
export function parseEditedWord(text: string | null) {
  const t = String(text == null ? '' : text).trim();
  let v = NaN;
  if (/^[+-]?0x[0-9a-f]+$/i.test(t)) v = parseInt(t, 16);
  else if (/^[+-]?\d+$/.test(t)) v = parseInt(t, 10);
  else if (/^[0-9a-f]+$/i.test(t)) v = parseInt(t, 16);
  if (!Number.isFinite(v) || v < -0x80000000 || v > 0xFFFFFFFF) return null;
  return v >>> 0;
}

// The address of the word being edited in the popup.
let wordEditAddr: number | null = null;

export function openMemWordOverlay(alignedAddr: number) {
  let wordVal = 0;
  for (let i = 0; i < 4; i++) wordVal |= (getMemByte((alignedAddr + i) >>> 0) & 0xFF) << (i * 8);
  wordEditAddr = alignedAddr;
  openEditPopup({
    id: 'memWordEditOverlay', inputId: 'memWordEditInput',
    label: `Word at 0x${alignedAddr.toString(16).padStart(8, '0')} (${alignedAddr}..${alignedAddr + 3}):`,
    value: '0x' + (wordVal >>> 0).toString(16).padStart(8, '0'),
    hint: 'Hex (0x…) or decimal. Enter=commit, Esc=cancel',
    accent: '#cba6f7', labelStyle: 'color:#9aa3c4;font-size:12px;', gap: 8, width: 200,
    oncommit: commitMemWordEdit, onclose: cancelMemWordEdit,
  });
}

export function commitMemWordEdit(text?: string) {
  if (wordEditAddr === null) return;
  const input = byId<HTMLInputElement>('memWordEditInput');
  const value = text ?? (input ? input.value : '');

  const addr = wordEditAddr;
  if (isCodeSegmentAddress(addr)) {
    cancelMemWordEdit();
    setStatus('Text segment is read-only in Memory View', 'warning');
    return;
  }
  const roMsg = mmioReadOnlyMessage(addr);
  if (roMsg) {
    cancelMemWordEdit();
    setStatus(roMsg, 'warning');
    return;
  }

  const val = parseEditedWord(value);
  if (val === null) {
    setStatus('Invalid word value; use hex (0x…) or decimal, within 32 bits', 'error');
    return;
  }

  writeMemFromPanel(addr, val, 4);
  cpu.lastChangedMem = [{ addr, size: 4 }];
  cancelMemWordEdit();
  updateMemoryView();
  updatePeripherals();
  setStatus(`Word updated at 0x${addr.toString(16).padStart(8, '0')}: 0x${(val >>> 0).toString(16).padStart(8, '0')}`, 'success');
}

export function cancelMemWordEdit() {
  wordEditAddr = null;
  closeEditPopup();
}

export function focusMemByte(addr: number) {
  const el = document.querySelector<HTMLElement>(`#memView [data-addr="${addr}"]`);
  if (!el) return;
  el.focus();
  selectElementText(el);
}

export function selectElementText(el: Node) {
  if (!window.getSelection || !document.createRange) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

export function startRegEdit(el: HTMLElement) {
  if (stateIsReplayed()) { setStatus(REPLAYED_STATE_TITLE, 'warning'); return; }

  if (!el) return;
  el.contentEditable = "true";
  el.classList.add('editing');
  el.dataset.old = el.textContent.trim();
  el.focus();
  selectElementText(el);
}

// The cell was typed into, which leaves it holding what was typed rather
// than the text the panel drew: the panel draws its rows afresh. `editing`
// goes first: a focused cell that stops being editable loses the focus at
// once, and its blur commits whatever is still being edited.
function endRegEdit(el: HTMLElement) {
  el.classList.remove('editing');
  el.contentEditable = "false";
  bumpRegEditGen();
  updateRegisters();
}

export function commitRegEdit(el: HTMLElement) {
  if (!el || !el.classList || !el.classList.contains('editing')) return;
  const idx = parseInt(el.dataset.idx ?? '', 10);
  if (isNaN(idx) || idx < 0 || idx > 31) { endRegEdit(el); return; }
  const text = (el.textContent || '').trim();
  const newVal = el.dataset.type === 'hex' ? parseInt(text.replace(/^0x/i, ''), 16) : parseInt(text, 10);
  // x0 stays 0, and text that is not a number leaves the register as it was.
  const changed = idx !== 0 && !isNaN(newVal);
  if (changed) {
    cpu.regs[idx] = newVal >>> 0;
    cpu.lastChangedReg = idx;
  }
  endRegEdit(el);
  if (changed) updateMemoryView();
}

export function cancelRegEdit(el: HTMLElement) {
  if (!el || !el.classList || !el.classList.contains('editing')) return;
  endRegEdit(el);
}

export function handleRegEditKey(event: KeyboardEvent, el: HTMLElement) {
  if (event.key === 'Enter') {
    event.preventDefault();
    commitRegEdit(el);
    el.blur();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelRegEdit(el);
    el.blur();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.length !== 1) return;
  if (el.dataset.type === 'hex') {
    if (!/[0-9a-fA-FxX]/.test(event.key)) {
      event.preventDefault();
    }
  } else {
    if (!/[-+0-9]/.test(event.key)) {
      event.preventDefault();
    }
  }
}

export function popRegEditModal(event: { preventDefault: () => void; stopPropagation: () => void; }, el: HTMLElement) {
  if (stateIsReplayed()) { setStatus(REPLAYED_STATE_TITLE, 'warning'); return; }

  if (event) { event.preventDefault(); event.stopPropagation(); }
  if (!el) return;
  const idx = parseInt(el.dataset.idx ?? '', 10);
  if (isNaN(idx) || idx < 0 || idx > 31) return;
  const name = ABI_NAMES[idx] || `x${idx}`;
  const val = cpu.regs[idx];
  openEditPopup({
    id: 'regEditOverlay', inputId: 'regEditModalInput',
    label: `Edit Register x${idx} (${name}):`,
    value: el.dataset.type === 'dec' ? val.toString() : '0x' + (val >>> 0).toString(16).padStart(8, '0'),
    hint: 'Hex (0x…) or decimal. Enter = commit, Esc = cancel',
    accent: '#89b4fa', labelStyle: 'color:#89b4fa;font-size:13px;font-weight:600;', gap: 10, width: 220,
    oncommit: text => commitRegEditModal(idx, text), onclose: closeRegEditModal,
  });
}

export function commitRegEditModal(idx: number, text: string) {
  closeRegEditModal();
  if (idx < 0 || idx > 31) return;
  if (idx === 0) {
    cpu.regs[0] = 0;
    updateRegisters();
    return;
  }
  const uval = parseEditedWord(text);
  if (uval === null) {
    setStatus('Invalid register value; use hex (0x…) or decimal, within 32 bits', 'error');
    return;
  }
  cpu.regs[idx] = uval;
  cpu.lastChangedReg = idx;
  updateRegisters();
  updateMemoryView();
  setStatus(`Register x${idx} updated to 0x${uval.toString(16).padStart(8, '0')} (${uval})`, 'success');
}

export function closeRegEditModal() {
  closeEditPopup();
}

export function memGo(region: string) {
  ui.memSegment = region;
  activeMemRegion = region;
  const el = byId<HTMLInputElement>('memAddr');
  const rowsEl = byId<HTMLInputElement>('memRows');
  if (region === 'code') { if (el) el.value = '0x' + (layout.baseAddress >>> 0).toString(16); }
  else if (region === 'data') { if (el) el.value = '0x' + (layout.dataBase >>> 0).toString(16); }
  else if (region === 'stack') { if (el) el.value = '0x' + (layout.stackBase >>> 0).toString(16); }
  else if (region === 'mmio') { if (el) el.value = '0x' + (layout.mmioBase >>> 0).toString(16); if (rowsEl) rowsEl.value = '24'; }
  updateMemSubTabs();
  updateMemoryView();
}

// The region buttons and the legend, after the region or the engine changed.
export function updateMemSubTabs() {
  memModel = { ...memModel, segment: ui.memSegment, wordMode: memViewMode === 'word', editable: memEditableNote() };
  redraw('memory');
}
