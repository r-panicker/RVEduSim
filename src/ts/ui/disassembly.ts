// @ts-nocheck
// Disassembly panel: the machine-code table with its Byte/Word and
// hex/binary display options, and the popover for multi-reading immediates.

import { nativeImmReadings } from '../asm/assembler';
import { getCurrentCFunction } from '../c/compile';
import { pipeline } from '../machine/pipeline';
import { cpu, program, run, ui } from '../machine/state';
import { PDP_COLOUR } from './datapath';
import { disassemblyDisplay, editor, setStatus } from './editor';
import { editorState } from './editor-state';
import { applyPanelColLayout, escapeHtml, panelFindActive, panelFindMatch, setPanelFindCount } from './panels';
export function updateMachineCode() {
  updateDisassembly();
}

export function updateDisasmViewButtons() {
  const bytesBtn = document.getElementById('disasmViewModeBytes');
  const wordBtn = document.getElementById('disasmViewModeWord');
  if (bytesBtn) bytesBtn.classList.toggle('active', ui.disasmView === 'bytes');
  if (wordBtn) wordBtn.classList.toggle('active', ui.disasmView === 'word');
}

export function setDisasmViewMode(mode) {
  ui.disasmView = (mode === 'bytes') ? 'bytes' : 'word';
  updateDisasmViewButtons();
  updateDisassembly();
  setStatus(ui.disasmView === 'word' ? 'Disassembly: 32-bit word machine-code display' : 'Disassembly: separate byte machine-code display', 'info');
}

export function handleDisasmShowToggle(checkbox) {
  const showHexEl = document.getElementById('showHex');
  const showBinaryEl = document.getElementById('showBinary');
  if (showHexEl && showBinaryEl && !showHexEl.checked && !showBinaryEl.checked) {
    checkbox.checked = true;
  }
  updateDisassembly();
}

export function updateDisassembly() {
  if (!disassemblyDisplay) return;
  const showHexEl = document.getElementById('showHex');
  const showBinaryEl = document.getElementById('showBinary');
  // Guard against being invoked before the disassembly toolbar DOM is
  // parsed (e.g. CodeMirror's very first editor dispatch on load).
  if (!showHexEl || !showBinaryEl) return;
  const showHex = showHexEl.checked;
  const showBinary = showBinaryEl.checked;
  updateDisasmViewButtons();
  // Byte mode = "LSB to the left" (bytes in memory order, low byte first),
  // Word mode = "LSB to the right" (one whole little-endian 32-bit word).
  const orderHintEl = document.getElementById('disasmOrderHint');
  if (orderHintEl) orderHintEl.textContent = (ui.disasmView === 'word') ? 'LSB to the right' : 'LSB to the left';

  // Build address-to-labels mapping for label headers and target annotations
  const addrToLabels = {};
  if (typeof program.labels === 'object' && program.labels) {
    for (const [name, addr] of Object.entries(program.labels)) {
      if (typeof addr === 'number' && !isNaN(addr)) {
        const uaddr = addr >>> 0;
        if (!addrToLabels[uaddr]) addrToLabels[uaddr] = [];
        if (!addrToLabels[uaddr].includes(name)) addrToLabels[uaddr].push(name);
      }
    }
  }

  function annotateLabels(text) {
    if (!text) return '';
    return text.replace(/\b(0x[0-9a-fA-F]+|\d+)\b/g, (match, numStr) => {
      const target = (numStr.startsWith('0x') || numStr.startsWith('0X')) ? parseInt(numStr, 16) : parseInt(numStr, 10);
      if (!isNaN(target) && addrToLabels[target >>> 0] && addrToLabels[target >>> 0].length > 0) {
        if (target >= 0x1000 || numStr.startsWith('0x') || numStr.startsWith('0X')) {
          return `${match} <span class="disasm-target-label">&lt;${escapeHtml(addrToLabels[target >>> 0][0])}&gt;</span>`;
        }
      }
      return match;
    });
  }

  // The operand text is untouched; an immediate that reads more than one
  // way just gains a marker carrying the other readings. Any label badge
  // annotateLabels would have added stays outside the marker, so the
  // underline covers the number alone.
  function renderNativeCell(item, native) {
    const readings = nativeImmReadings(item.imm);
    if (!readings.length || item.immFrom < 0 || item.immTo > native.length) {
      return annotateLabels(escapeHtml(native));
    }
    const tok = escapeHtml(native.slice(item.immFrom, item.immTo));
    const badge = annotateLabels(tok).slice(tok.length);
    const tip = readings.map(r => r[0] + ' ' + r[1]).join(' · ');
    // No `title`: the browser would draw its own tooltip alongside the
    // popover, and two tooltips for one token is worse than either. The
    // same text stays on aria-label for anything that reads the page.
    // JSON travels percent-encoded: the reader decodes and parses one
    // string rather than round-tripping entities out of an attribute.
    const data = encodeURIComponent(JSON.stringify(readings));
    return annotateLabels(escapeHtml(native.slice(0, item.immFrom))) +
      `<span class="disasm-imm" tabindex="0" aria-label="${escapeHtml(tip)}" data-imm="${data}">${tok}</span>` +
      badge +
      annotateLabels(escapeHtml(native.slice(item.immTo)));
  }

  // C mode only: annotate a stack-relative load/store's Native cell with
  // the C variable name it corresponds to, using the same best-effort
  // location table the Locals panel and the source hover use.
  function annotateCVar(nativeText, address) {
    if (editorState.language !== 'c') return '';
    const m = /\b(?:s[bhw]|lw|lh|lhu|lb|lbu)\s+[^,]+,\s*(-?\d+)\((s0|x8|sp|x2)\)/.exec(nativeText || '');
    if (!m) return '';
    const fn = getCurrentCFunction(address >>> 0);
    if (!fn) return '';
    const offset = parseInt(m[1], 10);
    const v = fn.vars.find(x => x.offset === offset);
    if (!v) return '';
    return ` <span class="disasm-cvar-tag" title="${v.kind} of ${escapeHtml(fn.name)}()">; ${escapeHtml(v.name)}</span>`;
  }

  // The <colgroup> is what sizes the columns; applyPanelColLayout()
  // fills in each <col>'s width after this table is inserted.
  const colTitle = 'Drag to resize this column · double-click to reset the panel\'s columns';
  let html = '<table class="code-list">';
  html += '<colgroup><col><col><col><col></colgroup>';
  // A real <thead> (rather than a bare <tr>) so the sticky header row
  // is unambiguous to the browser's table layout.
  html += '<thead><tr>' +
    `<th>Addr<span class="col-resizer" data-panel="disassembly" data-col="addr" title="${colTitle}"></span></th>` +
    `<th>Machine code<span class="col-resizer" data-panel="disassembly" data-col="mc" title="${colTitle}"></span></th>` +
    `<th>Native instruction<span class="col-resizer" data-panel="disassembly" data-col="native" title="${colTitle}"></span></th>` +
    '<th>Original source</th>' +
    '</tr></thead>';
  let built = 0, shown = 0;
  const filtering = panelFindActive('disassembly');
  const cLines = (editorState.language === 'c' && editor) ? editor.value.split('\n') : [];
  // Instructions carry the label of the block they are in, not just one at
  // their own address: searching a label is really asking to see the code
  // under it, and only the first instruction sits exactly on it.
  let blockLabels = '';
  const stageAt = new Map();
  if (pipeline.on && ui.engine !== 'hdl' && pipeline.regs) {
    ['W', 'M', 'E', 'D'].forEach(k => { if (pipeline.regs[k]) stageAt.set(pipeline.regs[k].pc >>> 0, k); });
    if (!run.finished) stageAt.set(cpu.pc >>> 0, (stageAt.has(cpu.pc >>> 0) ? stageAt.get(cpu.pc >>> 0) + ' ' : '') + 'F');
  }
  for (const item of program.machineCode) {
    if (!item.bytes || item.error) continue;

    const uaddr = item.address >>> 0;
    if (addrToLabels[uaddr]) blockLabels = addrToLabels[uaddr].join(' ');

    built++;
    if (filtering && !panelFindMatch('disassembly',
      `0x${item.address.toString(16).padStart(8, '0')} ${item.native || ''} ` +
      `${item.text || item.asmLine || ''} ${blockLabels}`)) continue;
    shown++;

    // A heading is kept when its own row survived the filter, so a search
    // for a label shows the label as well as the code under it.
    if (addrToLabels[uaddr]) {
      for (const lbl of addrToLabels[uaddr]) {
        html += `<tr class="disasm-label-row">
              <td colspan="4" class="disasm-label-cell">
                <span class="disasm-label-badge">
                  <span class="disasm-label-name">${escapeHtml(lbl)}:</span>
                </span>
              </td>
            </tr>`;
      }
    }

    const source = item.text || item.asmLine || '';
    const native = item.native || source;
    const expanded = !!item.isPseudo;
    const rowClass = item.address === cpu.pc ? 'current-native' : '';

    let cSrcTag = '';
    if (item.cLine && editorState.language === 'c') {
      const cText = (item.cLine >= 1 && item.cLine <= cLines.length) ? cLines[item.cLine - 1].trim() : '';
      cSrcTag = `<span class="disasm-cline-tag" title="C source line ${item.cLine}">Line ${item.cLine}${cText ? ': ' + escapeHtml(cText) : ''}</span>`;
    }

    let bytesStr = '';
    // Byte mode (default grouping): separate hex bytes, 4 per chunk.
    // Word mode: one whole 32-bit little-endian hex word per 4-byte chunk.
    const wordMode = (ui.disasmView === 'word');
    if (showHex) {
      const hexBytes = Array.from(item.bytes).map(b => b.toString(16).padStart(2, '0'));
      if (wordMode) {
        // One whole little-endian word per 4-byte chunk: bytes[3]<<24 | bytes[2]<<16 | bytes[1]<<8 | bytes[0]
        for (let i = 0; i < hexBytes.length; i += 4) {
          if (i > 0) bytesStr += '<br>';
          const chunk = item.bytes.slice(i, i + 4);
          if (chunk.length === 4) {
            const val = ((chunk[3] << 24) | (chunk[2] << 16) | (chunk[1] << 8) | chunk[0]) >>> 0;
            bytesStr += val.toString(16).padStart(8, '0');
          } else {
            // Trailing partial chunk (non-4-byte data): fall back to byte grouping
            bytesStr += chunk.map(b => b.toString(16).padStart(2, '0')).join(' ');
          }
        }
      } else {
        // Group bytes in chunks of 4
        for (let i = 0; i < hexBytes.length; i += 4) {
          const chunk = hexBytes.slice(i, i + 4);
          bytesStr += chunk.join(' ');
          if (i + 4 < hexBytes.length) bytesStr += '<br>';
        }
      }
      if (showBinary) bytesStr += ' ';
    }
    if (showBinary) {
      if (item.bytes.length === 4) {
        const val = ((item.bytes[3] << 24) | (item.bytes[2] << 16) | (item.bytes[1] << 8) | item.bytes[0]) >>> 0;
        if (wordMode) {
          // Whole 32-bit little-endian word; group the bits into the 4 bytes it
          // was stored as, separated by underscores (keeps the 8 digits of each
          // byte on one line and preserves the value across the full word).
          const bin = val.toString(2).padStart(32, '0');
          bytesStr += bin.slice(0, 8) + '_' + bin.slice(8, 16) + '_' + bin.slice(16, 24) + '_' + bin.slice(24, 32);
        } else {
          // Separate bytes (memory order), each byte's 8 digits kept together.
          bytesStr += item.bytes.map(b => b.toString(2).padStart(8, '0')).join(' ');
        }
      } else {
        // Group binary in chunks of 32 bits (4 bytes); word mode keeps the
        // underscore grouping between bytes, byte mode uses spaces.
        for (let i = 0; i < item.bytes.length; i += 4) {
          if (i > 0) bytesStr += '<br>';
          const chunk = item.bytes.slice(i, i + 4);
          const binChunk = chunk.map(b => b.toString(2).padStart(8, '0'));
          if (wordMode) {
            bytesStr += binChunk.join('_');
          } else {
            bytesStr += binChunk.join(' ');
          }
        }
      }
    }

    const nativeRendered = renderNativeCell(item, native) + annotateCVar(native, item.address);
    const sourceRendered = annotateLabels(escapeHtml(source));

    html += `<tr${rowClass ? ` class="${rowClass}"` : ''}>
      <td class="addr" data-col="addr">0x${item.address.toString(16).padStart(8, '0')}</td>
      <td class="bytes" data-col="bytes">${bytesStr}</td>
      <td class="native ${expanded ? 'native-expanded' : ''}" data-col="native">${nativeRendered}${stageAt.has(item.address >>> 0) ? stageAt.get(item.address >>> 0).split(' ').map(L => `<span class="disasm-stage" style="color:${PDP_COLOUR[L]}">${L}</span>`).join('') : ''}</td>
      <td class="source ${expanded ? 'pseudo' : ''}" data-col="source">${sourceRendered}${cSrcTag}</td>
    </tr>`;
  }
  html += '</table>';
  disassemblyDisplay.innerHTML = html;
  setPanelFindCount('disassembly', shown, built);
  // The table (and its <colgroup>) is brand new, so size its columns.
  applyPanelColLayout('disassembly');

  // Autoscroll active execution instruction into view while the Disassembly panel is shown
  const tabDisasm = document.getElementById('tab-disassembly');
  const disasmShown = tabDisasm &&
    (tabDisasm.classList.contains('panel-docked') || tabDisasm.classList.contains('panel-floating') ||
      tabDisasm.classList.contains('panel-mobile-active'));
  if (disasmShown) {
    // The panel body alone: scrollIntoView would scroll a phone's page too.
    const curRow = disassemblyDisplay.querySelector('.current-native');
    const sc = curRow && curRow.closest('.panel-body');
    if (sc && sc.clientHeight) {
      const head = disassemblyDisplay.querySelector('thead');
      const top = sc.getBoundingClientRect().top + (head ? head.offsetHeight : 0);
      const r = curRow.getBoundingClientRect(), bottom = sc.getBoundingClientRect().bottom;
      if (r.top < top) sc.scrollTop += r.top - top;
      else if (r.bottom > bottom) sc.scrollTop += r.bottom - bottom;
    }
  }
}

// An immediate's other readings open in a small popover: on hover with a
// mouse, and on tap with a touch screen, where a `title` would show nothing.
// The tap is bound to click rather than touchstart: a scroll gesture does
// not fire click, so dragging the disassembly still scrolls it instead of
// opening a bubble every time.
export let immPopoverFor = null;

export function immPopover() {
  let el = document.getElementById('immPopover');
  if (!el) {
    el = document.createElement('div');
    el.id = 'immPopover';
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

export function hideImmPopover() {
  immPopoverFor = null;
  const el = document.getElementById('immPopover');
  if (el) el.hidden = true;
}

export function showImmPopover(span) {
  let readings;
  try { readings = JSON.parse(decodeURIComponent(span.dataset.imm || '')) || []; } catch (e) { return; }
  if (!readings.length) return;
  const el = immPopover();
  el.innerHTML = readings
    .map(r => `<div class="imm-row"><span class="imm-key">${escapeHtml(r[0])}</span> <span class="imm-val">${escapeHtml(r[1])}</span></div>`)
    .join('');
  el.hidden = false;
  immPopoverFor = span;

  // Measured after it is visible, then clamped so it stays on screen at
  // phone width, where the panel is nearly as wide as the viewport.
  const r = span.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = r.left;
  let top = r.bottom + 6;
  if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}




// Capture, so a scroll inside the panel closes it too, not just the page.

// Run once the page has loaded every module (main.ts), in page order.
export function onDisassemblyLoad() {
  document.addEventListener('mouseover', e => {
    const span = e.target.closest && e.target.closest('.disasm-imm');
    if (span) showImmPopover(span);
    else if (immPopoverFor && !(e.target.closest && e.target.closest('#immPopover'))) hideImmPopover();
  });
  document.addEventListener('click', e => {
    const span = e.target.closest && e.target.closest('.disasm-imm');
    if (span) {
      if (immPopoverFor === span) hideImmPopover();
      else showImmPopover(span);
      return;
    }
    hideImmPopover();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') hideImmPopover();
  }, true);
  document.addEventListener('scroll', hideImmPopover, true);
  window.addEventListener('resize', hideImmPopover);
}
