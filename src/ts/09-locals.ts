// @ts-nocheck
// The Locals panel (C mode): each variable of the current function with its
// stack address and live value.
let localsDecSigned = true;

function updateLocalsView() {
  const body = document.getElementById('localsBody');
  const notice = document.getElementById('localsNotice');
  if (!body) return;
  // Seeded here so the several early returns below all leave an honest
  // count behind; the tail of the function overwrites it with the real one.
  setPanelFindCount('locals', 0, 0);
  if (editorLanguageMode !== 'c' || !cFunctionLocals || cFunctionLocals.size === 0) {
    body.innerHTML = '';
    if (notice) {
      notice.style.display = '';
      notice.innerHTML = editorLanguageMode !== 'c'
        ? 'Locals is a C-mode feature — switch to <b>C</b> to see variable-to-memory correspondence here.'
        : 'No local C variables were resolved from this program (best-effort — see the panel header for how).';
    }
    return;
  }
  const curPc = (typeof pc !== 'undefined') ? (pc >>> 0) : 0;
  const fn = getCurrentCFunction(curPc);
  if (!fn || !fn.vars.length) {
    body.innerHTML = '';
    if (notice) {
      notice.style.display = '';
      notice.innerHTML = fn
        ? `<b>${escapeHtml(fn.name)}</b> has no locals this view could resolve.`
        : 'PC is not currently inside a function this view has a variable table for (e.g. it is in the CRT0 startup shim or the <code>__halt</code> trap).';
    }
    return;
  }
  if (curPc <= fn.framePtrAddr) {
    body.innerHTML = '';
    if (notice) {
      notice.style.display = '';
      notice.innerHTML = `Entering <b>${escapeHtml(fn.name)}</b>() — its locals will show correct addresses once execution reaches 0x${fn.framePtrAddr.toString(16).padStart(8, '0')}, where the frame pointer (<code>s0</code>) is set up.`;
    }
    return;
  }
  if (notice) notice.style.display = 'none';
  const s0 = (typeof regs !== 'undefined') ? (regs[8] >>> 0) : 0;
  let html = '';
  let shown = 0;
  fn.vars.forEach(v => {
    const addr = (s0 + v.offset) >>> 0;
    const uval = readMem(addr, 4, true) >>> 0;
    const sval = readMemSigned(addr, 4, true);
    const decVal = localsDecSigned ? sval : uval;
    if (!panelFindMatch('locals',
      `${v.name} 0x${addr.toString(16).padStart(8, '0')} 0x${uval.toString(16).padStart(8, '0')} ${decVal}`)) return;
    shown++;
    const kindLabel = v.kind === 'param' ? 'param' : 'local';
    html += `<tr><td class="reg-name col-name" title="${kindLabel} of ${escapeHtml(fn.name)}() — s0 ${v.offset >= 0 ? '+' : '-'} ${Math.abs(v.offset)}">${escapeHtml(v.name)}</td>` +
      `<td class="reg-name col-id">0x${addr.toString(16).padStart(8, '0')}</td>` +
      `<td class="reg-val col-val">0x${uval.toString(16).padStart(8, '0')}</td>` +
      `<td class="reg-val col-val">${decVal}</td></tr>`;
  });
  body.innerHTML = html || '';
  setPanelFindCount('locals', shown, fn.vars.length);
}

function setLocalsDecSigned(signed) {
  localsDecSigned = !!signed;
  updateLocalsView();
}

// Click a variable in the C source -> bring the Locals panel forward and
// flash its row, so the source <-> memory correspondence is one click,
// not just a hover.
function focusLocalsVar(name) {
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
