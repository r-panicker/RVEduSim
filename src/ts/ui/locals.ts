// The Locals panel (C mode): each variable of the current function with its
// stack address and live value.

import { getCurrentCFunction } from '../c/compile';
import { cProgram } from '../c/state';
import { readMem, readMemSigned } from '../machine/memory';
import { cpu } from '../machine/state';
import { editorState } from './editor-state';
import { isPanelVisible, mobileMode, panelFindMatch, setMobileTab, setPanelFindCount, setPanelVisible } from './panels';
import { redraw } from './views.svelte';
export let localsDecSigned = true;

// Why the panel has no rows, when it has none.
export type LocalsNotice =
  | { k: 'notC' } | { k: 'none' } | { k: 'noFn' }
  | { k: 'noVars'; fn: string } | { k: 'entering'; fn: string; addr: string };

export type LocalsRow = { name: string; title: string; addr: string; hex: string; dec: number };

// What the panel shows, rebuilt by updateLocalsView().
export let localsModel: { notice: LocalsNotice | null; rows: LocalsRow[]; signed: boolean } =
  { notice: null, rows: [], signed: true };

function buildLocals(): { notice: LocalsNotice | null; rows: LocalsRow[] } {
  if (editorState.language !== 'c' || !cProgram.functionLocals || cProgram.functionLocals.size === 0) {
    return { notice: { k: editorState.language !== 'c' ? 'notC' : 'none' }, rows: [] };
  }
  const curPc = (typeof cpu.pc !== 'undefined') ? (cpu.pc >>> 0) : 0;
  const fn = getCurrentCFunction(curPc);
  if (!fn || !fn.vars.length) return { notice: fn ? { k: 'noVars', fn: fn.name } : { k: 'noFn' }, rows: [] };
  if (curPc <= fn.framePtrAddr) {
    return { notice: { k: 'entering', fn: fn.name, addr: '0x' + fn.framePtrAddr.toString(16).padStart(8, '0') }, rows: [] };
  }
  const s0 = (typeof cpu.regs !== 'undefined') ? (cpu.regs[8] >>> 0) : 0;
  const rows: LocalsRow[] = [];
  fn.vars.forEach(v => {
    const addr = (s0 + v.offset) >>> 0;
    const uval = readMem(addr, 4, true) >>> 0;
    const decVal = localsDecSigned ? readMemSigned(addr, 4, true) : uval;
    const row = {
      name: v.name, addr: '0x' + addr.toString(16).padStart(8, '0'), hex: '0x' + uval.toString(16).padStart(8, '0'), dec: decVal,
      title: `${v.kind === 'param' ? 'param' : 'local'} of ${fn.name}() — s0 ${v.offset >= 0 ? '+' : '-'} ${Math.abs(v.offset)}`,
    };
    if (panelFindMatch('locals', `${row.name} ${row.addr} ${row.hex} ${row.dec}`)) rows.push(row);
  });
  return { notice: null, rows };
}

export function updateLocalsView() {
  const { notice, rows } = buildLocals();
  localsModel = { notice, rows, signed: localsDecSigned };
  redraw('locals');
  const fn = notice ? null : getCurrentCFunction(cpu.pc >>> 0);
  setPanelFindCount('locals', rows.length, fn ? fn.vars.length : 0);
}

export function setLocalsDecSigned(signed: boolean) {
  localsDecSigned = !!signed;
  updateLocalsView();
}

// Click a variable in the C source -> bring the Locals panel forward and
// flash its row, so the source <-> memory correspondence is one click,
// not just a hover.
export function focusLocalsVar(name: string) {
  if (mobileMode()) {
    setMobileTab('locals');
  } else if (!isPanelVisible('locals')) {
    setPanelVisible('locals', true);
  }
  updateLocalsView();
  requestAnimationFrame(() => {
    const rows = document.querySelectorAll('#localsBody tr');
    for (const row of rows) {
      const cell = row.firstElementChild;
      if (cell && cell.textContent === name) {
        row.scrollIntoView({ block: 'center' });
        row.classList.add('locals-row-flash');
        setTimeout(() => row.classList.remove('locals-row-flash'), 1200);
        break;
      }
    }
  });
}
