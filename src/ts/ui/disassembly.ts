// Disassembly panel: the machine-code table with its Byte/Word and
// hex/binary display options, and the popover for multi-reading immediates.

import { nativeImmReadings } from '../asm/assembler';
import { getCurrentCFunction } from '../c/compile';
import { pipeline } from '../machine/pipeline';
import { cpu, MachineLine, program, run, ui } from '../machine/state';
import { PDP_COLOUR } from './datapath';
import { editor, setStatus } from './editor';
import { editorState } from './editor-state';
import { applyPanelColLayout, escapeHtml, panelFindActive, panelFindMatch, setPanelFindCount } from './panels';
import { redraw } from './views.svelte';
import { byId, targetEl } from './dom';
export function updateMachineCode() {
  updateDisassembly();
}

export function setDisasmViewMode(mode: string) {
  ui.disasmView = (mode === 'bytes') ? 'bytes' : 'word';
  updateDisassembly();
  setStatus(ui.disasmView === 'word' ? 'Disassembly: 32-bit word machine-code display' : 'Disassembly: separate byte machine-code display', 'info');
}

export function handleDisasmShowToggle(checkbox: { checked: boolean; }) {
  const showHexEl = byId<HTMLInputElement>('showHex');
  const showBinaryEl = byId<HTMLInputElement>('showBinary');
  if (showHexEl && showBinaryEl && !showHexEl.checked && !showBinaryEl.checked) {
    checkbox.checked = true;
  }
  updateDisassembly();
}

// A cell's content, in pieces: plain text, the <label> badge after a number
// that is a label's address, an immediate that reads more than one way, the
// C variable a stack access is, and the pipeline stage an instruction is in.
export type DisasmSeg =
  | { k: 'text'; s: string }
  | { k: 'label'; s: string }
  | { k: 'imm'; s: string; tip: string; data: string }
  | { k: 'cvar'; s: string; title: string }
  | { k: 'stage'; s: string; colour: string };

export type DisasmRow =
  | { kind: 'label'; key: string; name: string }
  | { kind: 'ins'; key: string; addr: string; current: boolean; pseudo: boolean;
      bytes: string[]; native: DisasmSeg[]; source: DisasmSeg[]; cLine: { s: string; title: string } | null };

// What the panel shows, rebuilt by updateDisassembly().
export let disasmModel: { rows: DisasmRow[]; view: 'bytes' | 'word' } = { rows: [], view: 'word' };

function buildDisasmRows(showHex: boolean, showBinary: boolean) {
  // Build address-to-labels mapping for label headers and target annotations
  const addrToLabels: Record<number, string[]> = {};
  if (typeof program.labels === 'object' && program.labels) {
    for (const [name, addr] of Object.entries(program.labels)) {
      if (typeof addr === 'number' && !isNaN(addr)) {
        const uaddr = addr >>> 0;
        if (!addrToLabels[uaddr]) addrToLabels[uaddr] = [];
        if (!addrToLabels[uaddr].includes(name)) addrToLabels[uaddr].push(name);
      }
    }
  }

  // A number that is a label's address gains the label after it.
  function annotateLabels(text: string): DisasmSeg[] {
    const segs: DisasmSeg[] = [];
    let last = 0, pending = '';
    for (const m of text.matchAll(/\b(0x[0-9a-fA-F]+|\d+)\b/g)) {
      const numStr = m[1];
      const target = (numStr.startsWith('0x') || numStr.startsWith('0X')) ? parseInt(numStr, 16) : parseInt(numStr, 10);
      const names = !isNaN(target) && addrToLabels[target >>> 0];
      if (names && names.length > 0 && (target >= 0x1000 || numStr.startsWith('0x') || numStr.startsWith('0X'))) {
        const end = m.index! + m[0].length;
        segs.push({ k: 'text', s: pending + text.slice(last, end) + ' ' });
        segs.push({ k: 'label', s: `<${names[0]}>` });
        pending = '';
        last = end;
      }
    }
    if (last < text.length || !segs.length) segs.push({ k: 'text', s: pending + text.slice(last) });
    return segs.filter(g => g.k !== 'text' || g.s);
  }

  // The operand text is untouched; an immediate that reads more than one
  // way just gains a marker carrying the other readings. Any label badge
  // annotateLabels would have added stays outside the marker, so the
  // underline covers the number alone.
  function nativeCell(item: MachineLine, native: string): DisasmSeg[] {
    const readings = nativeImmReadings(item.imm ?? null);
    const from = item.immFrom ?? -1, to = item.immTo ?? -1;
    if (!readings.length || from < 0 || to > native.length) return annotateLabels(native);
    const tok = native.slice(from, to);
    const a = annotateLabels(tok);
    const badge: DisasmSeg[] = a.length > 1 ? [{ k: 'text', s: (a[0] as { s: string }).s.slice(tok.length) }, ...a.slice(1)] : [];
    // JSON travels percent-encoded: the reader decodes and parses one
    // string rather than round-tripping entities out of an attribute.
    return [
      ...annotateLabels(native.slice(0, from)),
      { k: 'imm', s: tok, tip: readings.map(r => r[0] + ' ' + r[1]).join(' · '), data: encodeURIComponent(JSON.stringify(readings)) },
      ...badge,
      ...annotateLabels(native.slice(to)),
    ];
  }

  // C mode only: annotate a stack-relative load/store's Native cell with
  // the C variable name it corresponds to, using the same best-effort
  // location table the Locals panel and the source hover use.
  function cVar(nativeText: string, address: number): DisasmSeg[] {
    if (editorState.language !== 'c') return [];
    const m = /\b(?:s[bhw]|lw|lh|lhu|lb|lbu)\s+[^,]+,\s*(-?\d+)\((s0|x8|sp|x2)\)/.exec(nativeText || '');
    if (!m) return [];
    const fn = getCurrentCFunction(address >>> 0);
    if (!fn) return [];
    const offset = parseInt(m[1], 10);
    const v = fn.vars.find(x => x.offset === offset);
    if (!v) return [];
    return [{ k: 'text', s: ' ' }, { k: 'cvar', s: '; ' + v.name, title: `${v.kind} of ${fn.name}()` }];
  }

  const rows: DisasmRow[] = [];
  let built = 0, shown = 0;
  const filtering = panelFindActive('disassembly');
  const cLines = (editorState.language === 'c' && editor) ? editor.value.split('\n') : [];
  // Instructions carry the label of the block they are in, not just one at
  // their own address: searching a label is really asking to see the code
  // under it, and only the first instruction sits exactly on it.
  let blockLabels = '';
  const stageAt = new Map<number, string>();
  if (pipeline.on && ui.engine !== 'hdl' && pipeline.regs) {
    const regs = pipeline.regs;
    (['W', 'M', 'E', 'D'] as const).forEach(k => { const r = regs[k]; if (r) stageAt.set(r.pc >>> 0, k); });
    if (!run.finished) stageAt.set(cpu.pc >>> 0, (stageAt.has(cpu.pc >>> 0) ? stageAt.get(cpu.pc >>> 0) + ' ' : '') + 'F');
  }
  const wordMode = (ui.disasmView === 'word');
  program.machineCode.forEach((item, idx) => {
    if (!item.bytes || item.error) return;

    const uaddr = item.address >>> 0;
    if (addrToLabels[uaddr]) blockLabels = addrToLabels[uaddr].join(' ');

    built++;
    const addrText = '0x' + item.address.toString(16).padStart(8, '0');
    if (filtering && !panelFindMatch('disassembly',
      `${addrText} ${item.native || ''} ${item.text || item.asmLine || ''} ${blockLabels}`)) return;
    shown++;

    // A heading is kept when its own row survived the filter, so a search
    // for a label shows the label as well as the code under it.
    for (const lbl of addrToLabels[uaddr] || []) rows.push({ kind: 'label', key: `l${idx}:${lbl}`, name: lbl });

    const source = item.text || item.asmLine || '';
    const native = item.native || source;

    let cLine = null;
    if (item.cLine && editorState.language === 'c') {
      const cText = (item.cLine >= 1 && item.cLine <= cLines.length) ? cLines[item.cLine - 1].trim() : '';
      cLine = { s: `Line ${item.cLine}${cText ? ': ' + cText : ''}`, title: `C source line ${item.cLine}` };
    }

    // The machine code, a line per 32-bit chunk. Word mode shows each chunk
    // as one little-endian word; byte mode as its bytes in memory order.
    const lines: string[] = [];
    const word = (c: number[]) => ((c[3] << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
    const chunks: number[][] = [];
    for (let i = 0; i < item.bytes.length; i += 4) chunks.push(item.bytes.slice(i, i + 4));
    if (showHex) {
      chunks.forEach(c => lines.push(wordMode && c.length === 4 ? word(c).toString(16).padStart(8, '0')
        : c.map(b => b.toString(16).padStart(2, '0')).join(' ')));
    }
    if (showBinary) {
      // Word mode keeps the 8 digits of each byte together, separated by
      // underscores; byte mode separates the bytes with spaces.
      const bin = chunks.map(c => c.map(b => b.toString(2).padStart(8, '0')).join(wordMode ? '_' : ' '));
      if (wordMode && item.bytes.length === 4) {
        const b = word(chunks[0]).toString(2).padStart(32, '0');
        bin[0] = b.slice(0, 8) + '_' + b.slice(8, 16) + '_' + b.slice(16, 24) + '_' + b.slice(24, 32);
      }
      // With both shown, the binary carries on from the end of the hex.
      if (lines.length) { lines[lines.length - 1] += ' ' + bin[0]; lines.push(...bin.slice(1)); }
      else lines.push(...bin);
    }

    const stages: DisasmSeg[] = (stageAt.get(uaddr) ?? '').split(' ').filter(Boolean)
      .map(L => ({ k: 'stage', s: L, colour: PDP_COLOUR[L as keyof typeof PDP_COLOUR] }));
    rows.push({
      kind: 'ins', key: `i${idx}`, addr: addrText, current: item.address === cpu.pc, pseudo: !!item.isPseudo,
      bytes: lines, native: [...nativeCell(item, native), ...cVar(native, item.address), ...stages],
      source: annotateLabels(source), cLine,
    });
  });
  return { rows, shown, built };
}

export function updateDisassembly() {
  const showHexEl = byId<HTMLInputElement>('showHex');
  const showBinaryEl = byId<HTMLInputElement>('showBinary');
  // Guard against being invoked before the panel is mounted.
  if (!showHexEl || !showBinaryEl) return;
  const { rows, shown, built } = buildDisasmRows(showHexEl.checked, showBinaryEl.checked);
  disasmModel = { rows, view: ui.disasmView === 'bytes' ? 'bytes' : 'word' };
  redraw('disassembly');
  setPanelFindCount('disassembly', shown, built);
  applyPanelColLayout('disassembly');

  // Autoscroll active execution instruction into view while the Disassembly panel is shown
  const tabDisasm = byId('tab-disassembly');
  const disasmShown = tabDisasm &&
    (tabDisasm.classList.contains('panel-docked') || tabDisasm.classList.contains('panel-floating') ||
      tabDisasm.classList.contains('panel-mobile-active'));
  const display = byId('disassemblyDisplay');
  if (disasmShown && display) {
    // The panel body alone: scrollIntoView would scroll a phone's page too.
    const curRow = display.querySelector('.current-native');
    const sc = curRow && curRow.closest('.panel-body');
    if (sc && sc.clientHeight) {
      const head = display.querySelector('thead');
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
export let immPopoverFor: HTMLElement | null = null;

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

export function showImmPopover(span: HTMLElement) {
  let readings: [string, string][];
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

// Run once the page has loaded every module (main.ts), in page order.
export function onDisassemblyLoad() {
  document.addEventListener('mouseover', e => {
    const t = targetEl(e);
    const span = t?.closest<HTMLElement>('.disasm-imm');
    if (span) showImmPopover(span);
    else if (immPopoverFor && !t?.closest('#immPopover')) hideImmPopover();
  });
  document.addEventListener('click', e => {
    const span = targetEl(e)?.closest<HTMLElement>('.disasm-imm');
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
  // Capture, so a scroll inside the panel closes it too, not just the page.
  document.addEventListener('scroll', hideImmPopover, true);
  window.addEventListener('resize', hideImmPopover);
}
