// @ts-nocheck
// Memory panel (region sub-tabs, Byte/Word display, in-place byte and
// word editing) and register-panel editing.

import { ABI_NAMES } from '../isa/instructions';
import { getMemByte, isMMIOAddr, readMem, writeMem } from '../machine/memory';
import { mmioReadOnlyMessage, mmioRegisterAt } from '../machine/mmio';
import { cpu, layout, memory, program, ui } from '../machine/state';
import { memView, setStatus } from './editor';
import { REPLAYED_STATE_TITLE, TEXT_RO_TITLE, applyPanelColLayout, escapeHtml, measureMemHexNatural, panelFindMatch, setPanelFindCount, stateIsReplayed, updateRegisters } from './panels';
import { updatePeripherals } from './peripherals';

export let activeMemRegion = 'code';
export let memViewMode = 'word'; // 'word' = one whole 32-bit word per 4-byte group (default), 'bytes' = separate editable bytes
export let memDecSigned = true; // sign of the Word-mode Content(DEC) column; irrelevant in Byte mode (always ASCII)

export function isCodeSegmentAddress(addr) {
  return (addr >= layout.baseAddress && addr < layout.dataBase) || (activeMemRegion === 'code' && addr < layout.dataBase);
}

export function updateMemoryView() {
  const addrEl = document.getElementById('memAddr');
  const rowsEl = document.getElementById('memRows');
  // Guard against being invoked before the memory-view DOM is parsed
  // (e.g. CodeMirror's very first editor dispatch on document load).
  if (!addrEl || !rowsEl) return;
  const addrStr = addrEl.value;
  const rows = parseInt(rowsEl.value) || 16;
  let addr = parseInt(addrStr, 16);
  if (isNaN(addr)) addr = (activeMemRegion === 'stack' || ui.memSegment === 'stack') ? layout.stackBase : layout.baseAddress;
  addr = (addr >>> 0) & ~0x3;  // Align to 4-byte (one word) boundary unsigned

  const isStackView = (activeMemRegion === 'stack' || ui.memSegment === 'stack');
  const wordMode = (memViewMode === 'word');

  // Build address -> label-name map (same approach as the disassembly view)
  const labelsByAddr = {};
  if (program.labels && typeof program.labels === 'object') {
    for (const [name, addr] of Object.entries(program.labels)) {
      if (typeof addr === 'number' && !isNaN(addr)) {
        const uaddr = addr >>> 0;
        if (!labelsByAddr[uaddr]) labelsByAddr[uaddr] = [];
        if (!labelsByAddr[uaddr].includes(name)) labelsByAddr[uaddr].push(name);
      }
    }
  }

  // Returns an anchored orange "label" annotation that sits directly ABOVE
  // the 4-byte word at `wordStart` ('' when no label falls inside it). The
  // wrapper (.mem-row-label-anchor) stacks the label above the wrapped
  // group of bytes/word cell so they share an exact column — this works in
  // both byte and word display modes and for stack-view rows. `inner`
  // carries the rendered cell(s) so they sit directly under the label.
  // When a label is NOT word-aligned, a title tooltip reveals the exact
  // byte address (hover only — zero visual clutter).
  const labelAnnotationHtml = (wordStart, inner) => {
    const names = [];
    const offsets = [];
    for (let c = 0; c < 4; c++) {
      const offset = isStackView ? ((wordStart - c) >>> 0) : ((wordStart + c) >>> 0);
      if (labelsByAddr[offset]) {
        for (const n of labelsByAddr[offset]) if (!names.includes(n)) names.push(n);
        if (!offsets.includes(offset)) offsets.push(offset);
      }
    }
    if (!names.length) return inner;
    // Tooltip only when a label's byte offset within the word is non-zero,
    // i.e. the symbol is not word-aligned (its exact byte matters).
    const unaligned = offsets.some(o => (o - wordStart) % 4 !== 0);
    const title = unaligned
      ? ` title="Symbol${offsets.length > 1 ? 's' : ''} at ${offsets.map(o => '0x' + o.toString(16).padStart(8, '0')).join(', ')}"` : '';
    // Trailing ':' to match how a label reads in the program itself.
    return '<span class="mem-row-label-anchor"><span class="mem-row-label"' + title + '>' +
      names.map(escapeHtml).join(', ') + ':</span>' + inner + '</span>';
  };

  // Same anchored-above placement as labelAnnotationHtml, but for an
  // MMIO register's own name instead of a user symbol - "UART RX VALID
  // (RO):", no address (the register IS the address). One register per
  // word, so this is a straight lookup rather than a byte scan.
  const mmioLabelAnnotationHtml = (wordStart, inner) => {
    const reg = mmioRegisterAt(wordStart);
    if (!reg) return inner;
    return '<span class="mem-row-label-anchor"><span class="mem-row-label mmio-row-label">' +
      escapeHtml(reg.name) + ' (' + reg.access + '):</span>' + inner + '</span>';
  };

  // Content column header/toggle: Byte mode is always ASCII; Word mode
  // is decimal, with a signed/unsigned switch that only makes sense there.
  const contentLabelEl = document.getElementById('memContentColLabel');
  const signToggleWrap = document.getElementById('memDecSignToggleWrap');
  const signToggleInput = document.getElementById('memDecSignToggle');
  if (contentLabelEl) contentLabelEl.textContent = wordMode ? 'Content (DEC)' : 'Content (ASCII)';
  if (signToggleWrap) signToggleWrap.hidden = !wordMode;
  if (signToggleInput) signToggleInput.checked = memDecSigned;

  // Update legend hint for the active view mode
  const legendEl = document.getElementById('memLegendText');
  if (legendEl) {
    legendEl.innerHTML = wordMode
      ? '<span class="mem-legend-endian">Full word (LSB to the right)</span>'
      : '<span class="mem-legend-endian">Little endian (LSB to the left)</span>';
  }

  // One 32-bit word per row - each row's Hex and Content cells are the
  // one word at that address, so wrapping (a narrow panel) drops the
  // Content cell to its own line below the Hex cell but never splits a
  // word's hex from its own ASCII/DEC, and never has a second word's
  // data to be confused with.
  let html = '';
  let built = 0, shown = 0;
  // The names a row displays above its word - user labels, or an MMIO
  // register's own name. Searching for `main` or `UART` is at least as
  // likely as searching for an address, so they join the row's text.
  const memRowNames = (rowStart) => {
    const names = [];
    for (let c = 0; c < 4; c++) {
      const offset = isStackView ? ((rowStart - c) >>> 0) : ((rowStart + c) >>> 0);
      for (const n of (labelsByAddr[offset] || [])) if (!names.includes(n)) names.push(n);
    }
    const reg = typeof mmioRegisterAt === 'function' ? mmioRegisterAt(rowStart) : null;
    if (reg && reg.name) names.push(reg.name);
    return names.join(' ');
  };

  // A byte can be read-only for either reason, and the tooltip should say
  // which; HDL replay wins because it applies to every segment.
  const roByteTitle = (offset) => stateIsReplayed()
    ? REPLAYED_STATE_TITLE
    : (isCodeSegmentAddress(offset) ? TEXT_RO_TITLE : '');

  // Every branch below emits the same row shape, so they share one exit
  // point - which is also where the panel's row filter gets applied.
  const emitMemRow = (rowStart, hexVals, contentVals, text) => {
    built++;
    if (!panelFindMatch('memory', text + ' ' + memRowNames(rowStart))) return;
    shown++;
    html += `<div><span class="addr" data-col="addr">0x${rowStart.toString(16).padStart(8, '0')}</span><span class="mem-hex-block">${hexVals}</span><span class="mem-ascii-block">${contentVals}</span></div>`;
  };
  for (let r = 0; r < rows; r++) {
    if (isStackView && addr < r * 4) break;
    // Stack grows downwards -> rows step downwards by 4 bytes; all other regions step upwards
    const wordStart = isStackView ? ((addr - r * 4) >>> 0) : ((addr + r * 4) >>> 0);

    if (isMMIOAddr(wordStart)) {
      const reg = mmioRegisterAt(wordStart);
      // Replayed HDL state is read-only throughout; see REPLAYED_STATE_TITLE.
      const editable = !stateIsReplayed() && !!reg && reg.editable;
      const roTitle = `title="${escapeHtml(stateIsReplayed() ? REPLAYED_STATE_TITLE
        : reg ? `${reg.name} (${reg.access}) is read-only` : mmioReadOnlyMessage(wordStart))}"`;

      if (wordMode) {
        let wordVal = 0;
        let isChanged = false;
        for (let i = 0; i < 4; i++) {
          const offset = (wordStart + i) >>> 0;
          const bv = readMem(offset, 1, true) & 0xFF;
          wordVal |= bv << (i * 8);
          if (cpu.lastChangedMem.some(m => offset >= m.addr && offset < m.addr + m.size)) isChanged = true;
        }
        const cls = isChanged ? ' changed' : '';
        const wordHex = (wordVal >>> 0).toString(16).padStart(8, '0');
        const cell = editable
          ? `<span class="val word-cell${cls}" data-addr="${wordStart}" data-size="4" onclick="startMemWordCellEdit(event,${wordStart})" title="Click to edit 32-bit word (little-endian)">${wordHex}</span>`
          : `<span class="val word-cell${cls} readonly-code" data-addr="${wordStart}" data-size="4" ${roTitle}>${wordHex}</span>`;
        const hexVals = mmioLabelAnnotationHtml(wordStart, cell);

        const decText = (memDecSigned ? (wordVal | 0) : (wordVal >>> 0)).toString();
        const contentVals = editable
          ? `<span class="val-dec${cls}" onclick="startMemWordCellEdit(event,${wordStart})" title="Click to edit 32-bit word">${decText}</span>`
          : `<span class="val-dec${cls} readonly-code" ${roTitle}>${decText}</span>`;
        emitMemRow(wordStart, hexVals, contentVals,
          `0x${wordStart.toString(16).padStart(8, '0')} ${wordHex} ${decText}`);
        continue;
      }

      // Byte view: one 4-byte group, so a label can be anchored above it
      let groupBytes = '';
      let groupAscii = '';
      // Hex and ASCII are kept apart so a search for "dead" matches the
      // hex run and a search for "Hell" matches the characters.
      let hexText = '', asciiText = '';
      for (let i = 0; i < 4; i++) {
        const offset = (wordStart + i) >>> 0;
        const val = readMem(offset, 1, true) & 0xFF;
        hexText += val.toString(16).padStart(2, '0');
        const isChanged = cpu.lastChangedMem.some(m => offset >= m.addr && offset < m.addr + m.size);
        const cls = isChanged ? ' changed' : '';
        if (editable) {
          groupBytes += `<span class="val${cls}" contenteditable="true" spellcheck="false" data-addr="${offset}" data-size="1" data-old="${val.toString(16).padStart(2, '0')}" onfocus="startMemByteEdit(this)" ondblclick="startMemWordEdit(event,${offset})" onkeydown="handleMemByteEditKey(event,this)" onblur="commitMemByteEdit(this)" title="Single-click: edit byte | Double-click: edit word">${val.toString(16).padStart(2, '0')}</span>`;
        } else {
          groupBytes += `<span class="val${cls} readonly-code" data-addr="${offset}" data-size="1" style="cursor:default;opacity:0.88;" ${roTitle}>${val.toString(16).padStart(2, '0')}</span>`;
        }

        const ch = val >= 32 && val <= 126 ? String.fromCharCode(val) : '.';
        asciiText += ch;
        const asciiAttrs = editable
          ? `onclick="focusMemByte(${offset})" title="Click matching hex byte to edit"`
          : roTitle;
        groupAscii += `<span class="ascii${cls}" ${asciiAttrs}>${escapeHtml(ch)}</span>`;
      }
      const hexVals = mmioLabelAnnotationHtml(wordStart, '<span class="mem-row-bytes">' + groupBytes + '</span>');
      const contentVals = '<span class="mem-ascii-group">' + groupAscii + '</span>';
      emitMemRow(wordStart, hexVals, contentVals,
        `0x${wordStart.toString(16).padStart(8, '0')} ${hexText} ${asciiText}`);
    } else if (wordMode) {
      // Word view: the one 32-bit word at this row (little-endian)
      const offsets = [];
      let wordVal = 0;
      let isChanged = false;
      let allReadonly = true;
      const replayed = stateIsReplayed();
      // Two different reasons to be read-only, so two different tooltips.
      const roWordTitle = replayed ? REPLAYED_STATE_TITLE : TEXT_RO_TITLE;
      for (let c = 0; c < 4; c++) {
        const offset = isStackView ? ((wordStart - c) >>> 0) : ((wordStart + c) >>> 0);
        offsets.push(offset);
        const bv = getMemByte(offset);
        wordVal |= bv << (c * 8);
        if (cpu.lastChangedMem.some(m => offset >= m.addr && offset < m.addr + m.size)) isChanged = true;
        if (!replayed && !isCodeSegmentAddress(offset)) allReadonly = false;
      }
      const cls = isChanged ? ' changed' : '';
      const rowAddr = offsets[0];
      const wordHex = (wordVal >>> 0).toString(16).padStart(8, '0');
      const cell = allReadonly
        ? `<span class="val word-cell${cls} readonly-code" data-addr="${rowAddr}" data-size="4" title="${roWordTitle}">${wordHex}</span>`
        : `<span class="val word-cell${cls}" data-addr="${rowAddr}" data-size="4" onclick="startMemWordCellEdit(event,${rowAddr})" title="Click to edit 32-bit word (little-endian)">${wordHex}</span>`;
      const hexVals = labelAnnotationHtml(rowAddr, cell);

      const decText = (memDecSigned ? (wordVal | 0) : (wordVal >>> 0)).toString();
      const contentVals = allReadonly
        ? `<span class="val-dec${cls} readonly-code" title="${roWordTitle}">${decText}</span>`
        : `<span class="val-dec${cls}" onclick="startMemWordCellEdit(event,${rowAddr})" title="Click to edit 32-bit word">${decText}</span>`;
      emitMemRow(wordStart, hexVals, contentVals,
        `0x${wordStart.toString(16).padStart(8, '0')} ${wordHex} ${decText}`);
    } else {
      // Byte view: the one 4-byte group at this row, so a label can be anchored above it
      let groupBytes = '';
      let groupAscii = '';
      let hexText = '', asciiText = '';
      for (let i = 0; i < 4; i++) {
        const offset = isStackView ? ((wordStart - i) >>> 0) : ((wordStart + i) >>> 0);
        const val = getMemByte(offset);
        hexText += val.toString(16).padStart(2, '0');
        asciiText += (val >= 32 && val <= 126) ? String.fromCharCode(val) : '.';
        const isChanged = cpu.lastChangedMem.some(m => offset >= m.addr && offset < m.addr + m.size);
        const cls = isChanged ? ' changed' : '';
        const isCodeSegment = stateIsReplayed() || isCodeSegmentAddress(offset);

        if (isCodeSegment) {
          groupBytes += `<span class="val${cls} readonly-code" data-addr="${offset}" data-size="1" style="cursor:default;opacity:0.88;" title="${roByteTitle(offset)}">${val.toString(16).padStart(2, '0')}</span>`;
          const ch = val >= 32 && val <= 126 ? String.fromCharCode(val) : '.';
          groupAscii += `<span class="ascii${cls}" title="${roByteTitle(offset)}">${escapeHtml(ch)}</span>`;
        } else {
          groupBytes += `<span class="val${cls}" contenteditable="true" spellcheck="false" data-addr="${offset}" data-size="1" data-old="${val.toString(16).padStart(2, '0')}" onfocus="startMemByteEdit(this)" ondblclick="startMemWordEdit(event,${offset})" onkeydown="handleMemByteEditKey(event,this)" onblur="commitMemByteEdit(this)" title="Single-click: edit byte (00-ff) | Double-click: edit word (Enter commits, Esc cancels)">${val.toString(16).padStart(2, '0')}</span>`;
          const ch = val >= 32 && val <= 126 ? String.fromCharCode(val) : '.';
          const asciiOnclick = `onclick="focusMemByte(${offset})" title="Click matching hex byte to edit"`;
          groupAscii += `<span class="ascii${cls}" ${asciiOnclick}>${escapeHtml(ch)}</span>`;
        }
      }
      const hexVals = labelAnnotationHtml(wordStart, '<span class="mem-row-bytes">' + groupBytes + '</span>');
      const contentVals = '<span class="mem-ascii-group">' + groupAscii + '</span>';
      emitMemRow(wordStart, hexVals, contentVals,
        `0x${wordStart.toString(16).padStart(8, '0')} ${hexText} ${asciiText}`);
    }
  }
  memView.innerHTML = html;
  setPanelFindCount('memory', shown, built);
  // Re-measure the hex data's natural width (it changes with the
  // Byte/Word mode) so the Hex column's drag floor stays honest, then
  // re-run the layout against it.
  measureMemHexNatural();
  applyPanelColLayout('memory');
}

export function setMemViewMode(mode) {
  memViewMode = (mode === 'word') ? 'word' : 'bytes';
  const bytesBtn = document.getElementById('memViewModeBytes');
  const wordBtn = document.getElementById('memViewModeWord');
  if (bytesBtn) bytesBtn.classList.toggle('active', memViewMode === 'bytes');
  if (wordBtn) wordBtn.classList.toggle('active', memViewMode === 'word');
  updateMemoryView();
  setStatus(memViewMode === 'word' ? 'Memory view: 32-bit word display' : 'Memory view: separate byte display', 'info');
}

export function setMemDecSigned(signed) {
  memDecSigned = !!signed;
  updateMemoryView();
}

export function editMemByte(addr) {
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

export function startMemByteEdit(el) {
  if (stateIsReplayed()) { setStatus(REPLAYED_STATE_TITLE, 'warning'); return; }

  const addr = parseInt(el.dataset.addr, 10);
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

export function handleMemByteEditKey(event, el) {
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

export function writeMemFromPanel(addr, val, size) {
  memory.panelEdit = true;
  try { writeMem(addr, val, size); } finally { memory.panelEdit = false; }
}

export function commitMemByteEdit(el) {
  if (!el || !el.classList || !el.classList.contains('editing')) return;
  const addr = parseInt(el.dataset.addr, 10);
  if (isCodeSegmentAddress(addr)) {
    el.textContent = el.dataset.old || '00';
    el.classList.remove('editing');
    setStatus('Text segment is read-only in Memory View', 'warning');
    return;
  }
  const roMsg = mmioReadOnlyMessage(addr);
  if (roMsg) {
    el.textContent = el.dataset.old || '00';
    el.classList.remove('editing');
    setStatus(roMsg, 'warning');
    return;
  }
  const text = (el.textContent || '').trim();
  const normalized = text.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{1,2}$/.test(normalized)) {
    const oldText = el.dataset.old || '00';
    el.textContent = oldText;
    el.classList.remove('editing');
    setStatus('Invalid byte value; use hex 00-ff', 'error');
    return;
  }
  const val = parseInt(normalized, 16);
  if (isNaN(addr) || addr < 0 || isNaN(val) || val < 0 || val > 255) {
    el.textContent = el.dataset.old || '00';
    el.classList.remove('editing');
    setStatus('Invalid memory edit', 'error');
    return;
  }
  writeMemFromPanel(addr, val, 1);
  cpu.lastChangedMem = [{ addr, size: 1 }];
  updateMemoryView();
  updatePeripherals();
  setStatus('Memory updated at 0x' + addr.toString(16).padStart(8, '0'), 'success');
}

export function cancelMemByteEdit(el) {
  el.textContent = el.dataset.old || '00';
  el.classList.remove('editing');
  el.blur();
}

// ---- Word-level editing (4 bytes at a time) ----

export function startMemWordEdit(event, wordStartAddr) {
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
  // Collect the 4 byte spans
  const spans = [];
  for (let i = 0; i < 4; i++) {
    const el = memView.querySelector(`[data-addr="${alignedAddr + i}"]`);
    if (el) spans.push(el);
  }
  if (spans.length < 4) return;
  openMemWordOverlay(alignedAddr, spans);
}

// Word-cell click handler for the "word view" memory display mode.
export function startMemWordCellEdit(event, wordStartAddr) {
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
  openMemWordOverlay(wordStartAddr & ~0x3, null);
}

// The edit popups take `0x` as hex and bare digits as decimal, so a value
// typed as it reads in a decimal column means what it looks like. Hex
// without the prefix is still taken once a letter makes it unambiguous.
// Returns the 32-bit pattern, or null when the text is neither.
export function parseEditedWord(text) {
  const t = String(text == null ? '' : text).trim();
  let v = NaN;
  if (/^[+-]?0x[0-9a-f]+$/i.test(t)) v = parseInt(t, 16);
  else if (/^[+-]?\d+$/.test(t)) v = parseInt(t, 10);
  else if (/^[0-9a-f]+$/i.test(t)) v = parseInt(t, 16);
  if (!Number.isFinite(v) || v < -0x80000000 || v > 0xFFFFFFFF) return null;
  return v >>> 0;
}

export function openMemWordOverlay(alignedAddr, spans) {
  // Read current word value (little-endian)
  let wordVal = 0;
  if (spans && spans.length >= 4) {
    for (let i = 0; i < 4; i++) {
      wordVal |= (parseInt(spans[i].textContent || '00', 16) & 0xFF) << (i * 8);
    }
  } else {
    for (let i = 0; i < 4; i++) {
      const off = (alignedAddr + i) >>> 0;
      wordVal |= (getMemByte(off) & 0xFF) << (i * 8);
    }
  }
  const wordHex = (wordVal >>> 0).toString(16).padStart(8, '0');

  // Create overlay with input
  let overlay = document.getElementById('memWordEditOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'memWordEditOverlay';
    overlay.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1e1e2e;border:2px solid #cba6f7;border-radius:8px;padding:16px 24px;z-index:10000;display:flex;flex-direction:column;align-items:center;gap:8px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = `
    <span style="color:#9aa3c4;font-size:12px;">Word at 0x${alignedAddr.toString(16).padStart(8, '0')} (${alignedAddr}..${alignedAddr + 3}):</span>
    <input type="text" id="memWordEditInput" value="0x${wordHex}" style="background:#181825;color:#f5c2e7;border:1px solid #585b70;border-radius:4px;padding:6px 12px;font-size:16px;font-family:'Consolas',monospace;text-align:center;width:200px;outline:none;" spellcheck="false" autocomplete="off" autofocus>
    <span style="color:#6c7086;font-size:10px;">Hex (0x…) or decimal. Enter=commit, Esc=cancel</span>
  `;

  const input = document.getElementById('memWordEditInput');
  input.focus();
  input.select();

  // Store context for commit
  overlay._wordAddr = alignedAddr;
  overlay._spans = spans || [];

  const handleKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitMemWordEdit(overlay);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelMemWordEdit(overlay);
    }
  };
  const handleBlur = () => {
    // Only cancel if input still exists (blur from clicking elsewhere)
    const input2 = document.getElementById('memWordEditInput');
    if (input2) cancelMemWordEdit(overlay);
  };

  input.addEventListener('keydown', handleKey);
  input.addEventListener('blur', handleBlur, { once: true });

  // Also handle clicks outside to cancel
  const handleOutsideClick = (e) => {
    if (!overlay.contains(e.target)) {
      cancelMemWordEdit(overlay);
      document.removeEventListener('mousedown', handleOutsideClick);
    }
  };
  document.addEventListener('mousedown', handleOutsideClick);
}

export function commitMemWordEdit(overlay) {
  if (!overlay || !overlay._wordAddr) return;
  const input = document.getElementById('memWordEditInput');
  if (!input) return;

  const addr = overlay._wordAddr;
  if (isCodeSegmentAddress(addr)) {
    cancelMemWordEdit(overlay);
    setStatus('Text segment is read-only in Memory View', 'warning');
    return;
  }
  const roMsg = mmioReadOnlyMessage(addr);
  if (roMsg) {
    cancelMemWordEdit(overlay);
    setStatus(roMsg, 'warning');
    return;
  }

  const val = parseEditedWord(input.value);
  if (val === null) {
    setStatus('Invalid word value; use hex (0x…) or decimal, within 32 bits', 'error');
    return;
  }

  const spans = overlay._spans;

  writeMemFromPanel(addr, val, 4);
  cpu.lastChangedMem = [{ addr, size: 4 }];

  // Update the individual byte spans visually
  for (let i = 0; i < 4; i++) {
    if (spans[i]) {
      const byteVal = (val >> (i * 8)) & 0xFF;
      spans[i].textContent = byteVal.toString(16).padStart(2, '0');
      spans[i].classList.add('changed');
      spans[i].dataset.old = byteVal.toString(16).padStart(2, '0');
    }
  }

  cancelMemWordEdit(overlay);
  updateMemoryView();
  updatePeripherals();
  setStatus(`Word updated at 0x${addr.toString(16).padStart(8, '0')}: 0x${(val >>> 0).toString(16).padStart(8, '0')}`, 'success');
}

export function cancelMemWordEdit(overlay) {
  if (!overlay) return;
  // Clear spans changed class
  if (overlay._spans) {
    overlay._spans.forEach(el => { if (el && el.classList) el.classList.remove('changed'); });
  }
  overlay.remove();
}

export function focusMemByte(addr) {
  const el = memView.querySelector(`[data-addr="${addr}"]`);
  if (!el) return;
  el.focus();
  selectElementText(el);
}

export function selectElementText(el) {
  if (!window.getSelection || !document.createRange) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

export function startRegEdit(el) {
  if (stateIsReplayed()) { setStatus(REPLAYED_STATE_TITLE, 'warning'); return; }

  if (!el) return;
  el.contentEditable = "true";
  el.classList.add('editing');
  el.dataset.old = el.textContent.trim();
  el.focus();
  selectElementText(el);
}

export function commitRegEdit(el) {
  if (!el || !el.classList || !el.classList.contains('editing')) return;
  el.contentEditable = "false";
  el.classList.remove('editing');
  const idx = parseInt(el.dataset.idx, 10);
  if (isNaN(idx) || idx < 0 || idx > 31) return;
  if (idx === 0) {
    cpu.regs[0] = 0;
    updateRegisters();
    return;
  }
  const type = el.dataset.type;
  const text = (el.textContent || '').trim();
  let newVal;
  if (type === 'hex') {
    const hexStr = text.replace(/^0x/i, '');
    newVal = parseInt(hexStr, 16);
    if (isNaN(newVal)) {
      el.textContent = el.dataset.old;
      return;
    }
  } else {
    newVal = parseInt(text, 10);
    if (isNaN(newVal)) {
      el.textContent = el.dataset.old;
      return;
    }
  }
  const uval = newVal >>> 0;
  cpu.regs[idx] = uval;
  cpu.lastChangedReg = idx;
  updateRegisters();
  updateMemoryView();
}

export function cancelRegEdit(el) {
  if (!el || !el.classList || !el.classList.contains('editing')) return;
  el.contentEditable = "false";
  el.classList.remove('editing');
  el.textContent = el.dataset.old;
}

export function handleRegEditKey(event, el) {
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

export function popRegEditModal(event, el) {
  if (stateIsReplayed()) { setStatus(REPLAYED_STATE_TITLE, 'warning'); return; }

  if (event) { event.preventDefault(); event.stopPropagation(); }
  if (!el) return;
  const idx = parseInt(el.dataset.idx, 10);
  if (isNaN(idx) || idx < 0 || idx > 31) return;
  const name = ABI_NAMES[idx] || `x${idx}`;
  const type = el.dataset.type || 'hex';
  const val = cpu.regs[idx];
  const uval = val >>> 0;
  const initVal = (type === 'hex') ? '0x' + uval.toString(16).padStart(8, '0') : val.toString();

  let overlay = document.getElementById('regEditOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'regEditOverlay';
    overlay.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1e1e2e;border:2px solid #89b4fa;border-radius:8px;padding:16px 24px;z-index:10000;display:flex;flex-direction:column;align-items:center;gap:10px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = `
    <span style="color:#89b4fa;font-size:13px;font-weight:600;">Edit Register x${idx} (${name}):</span>
    <input type="text" id="regEditModalInput" value="${initVal}" style="background:#181825;color:#f5c2e7;border:1px solid #585b70;border-radius:4px;padding:6px 12px;font-size:16px;font-family:'Consolas',monospace;text-align:center;width:220px;outline:none;" spellcheck="false" autocomplete="off" autofocus>
    <span style="color:#6c7086;font-size:10px;">Hex (0x…) or decimal. Enter = commit, Esc = cancel</span>
  `;

  const input = document.getElementById('regEditModalInput');
  input.focus();
  input.select();

  const handleKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRegEditModal(idx, input.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeRegEditModal();
    }
  };

  const handleBlur = () => {
    const inp = document.getElementById('regEditModalInput');
    if (inp) closeRegEditModal();
  };

  input.addEventListener('keydown', handleKey);
  input.addEventListener('blur', handleBlur, { once: true });

  const handleOutsideClick = (e) => {
    if (overlay && !overlay.contains(e.target)) {
      closeRegEditModal();
      document.removeEventListener('mousedown', handleOutsideClick);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', handleOutsideClick), 10);
}

export function commitRegEditModal(idx, text) {
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
  const overlay = document.getElementById('regEditOverlay');
  if (overlay) {
    try { overlay.remove(); } catch (e) { }
  }
}

export function memGo(region) {
  ui.memSegment = region;
  activeMemRegion = region;
  const el = document.getElementById('memAddr');
  const rowsEl = document.getElementById('memRows');
  if (region === 'code') { if (el) el.value = '0x' + (layout.baseAddress >>> 0).toString(16); }
  else if (region === 'data') { if (el) el.value = '0x' + (layout.dataBase >>> 0).toString(16); }
  else if (region === 'stack') { if (el) el.value = '0x' + (layout.stackBase >>> 0).toString(16); }
  else if (region === 'mmio') { if (el) el.value = '0x' + (layout.mmioBase >>> 0).toString(16); if (rowsEl) rowsEl.value = '24'; }
  updateMemSubTabs();
  updateMemoryView();
}

export function updateMemSubTabs() {
  const tabs = ['code', 'data', 'stack', 'mmio'];
  tabs.forEach(t => {
    const btn = document.getElementById('memTabBtn-' + t);
    if (btn) {
      if (t === ui.memSegment) btn.classList.add('active');
      else btn.classList.remove('active');
    }
  });
  // Sync the segmented Byte/Word display-mode buttons
  const bytesBtn = document.getElementById('memViewModeBytes');
  const wordBtn = document.getElementById('memViewModeWord');
  if (bytesBtn) bytesBtn.classList.toggle('active', memViewMode === 'bytes');
  if (wordBtn) wordBtn.classList.toggle('active', memViewMode === 'word');

  const editableEl = document.getElementById('memLegendEditable');
  if (editableEl) {
    // Nothing is editable while HDL state is replayed, so the whole
    // editability note goes rather than reading "Editable" over cells
    // that are not.
    const text = stateIsReplayed() ? ''
      : ui.memSegment === 'code' ? 'Read only'
      : ui.memSegment === 'mmio' ? 'Editable except RO'
      : 'Editable';
    editableEl.innerHTML = text ? `<span class="mem-legend-editable">${text}</span>` : '';
    const sep = document.getElementById('memLegendSep');
    if (sep) sep.hidden = !text;
  }
}
