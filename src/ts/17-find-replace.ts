// @ts-nocheck
// Find/replace in the editor, the global keyboard shortcuts, and the
// CodeMirror editor's set-up.

function openFindReplace(focusReplace = false) {
  const panel = document.getElementById('findReplacePanel');
  if (!panel) return;
  panel.style.display = 'flex';
  const findInput = document.getElementById('findInput');
  const replaceInput = document.getElementById('replaceInput');
  const replaceRow = document.getElementById('replaceRow');
  if (replaceRow) replaceRow.style.display = 'flex';

  // If text is selected on a single line, prefill find query
  const sel = editor.value.substring(editor.selectionStart, editor.selectionEnd);
  if (sel && !sel.includes('\n') && findInput) {
    findInput.value = sel;
  }

  if (focusReplace && replaceInput) {
    if (typeof replaceInput.focus === 'function') replaceInput.focus();
    if (typeof replaceInput.select === 'function') replaceInput.select();
  } else if (findInput) {
    if (typeof findInput.focus === 'function') findInput.focus();
    if (typeof findInput.select === 'function') findInput.select();
  }
  updateFindMatches();
}

function closeFindReplace() {
  const panel = document.getElementById('findReplacePanel');
  if (panel) panel.style.display = 'none';
  findMatches = [];
  activeFindIndex = -1;
  editor.focus();
}

function toggleFindCase() {
  findCaseSensitive = !findCaseSensitive;
  const btn = document.getElementById('findCaseBtn');
  if (btn) btn.classList.toggle('active', findCaseSensitive);
  updateFindMatches();
}

function updateFindMatches() {
  const findInput = document.getElementById('findInput');
  const countEl = document.getElementById('findCount');
  if (!findInput || !countEl) return;

  const query = findInput.value;
  findMatches = [];
  activeFindIndex = -1;

  if (!query) {
    countEl.textContent = '0/0';
      return;
  }

  const text = editor.value;
  const src = findCaseSensitive ? text : text.toLowerCase();
  const q = findCaseSensitive ? query : query.toLowerCase();

  let pos = 0;
  while ((pos = src.indexOf(q, pos)) !== -1) {
    findMatches.push({ start: pos, end: pos + query.length });
    pos += q.length;
  }

  if (findMatches.length === 0) {
    countEl.textContent = '0/0';
      return;
  }

  // Find closest match at or after cursor
  const curPos = editor.selectionStart || 0;
  let bestIdx = 0;
  for (let i = 0; i < findMatches.length; i++) {
    if (findMatches[i].start >= curPos) {
      bestIdx = i;
      break;
    }
  }
  activeFindIndex = bestIdx;
  countEl.textContent = `${activeFindIndex + 1}/${findMatches.length}`;
  // DO NOT steal focus from findInput while typing!
  selectFindMatch(activeFindIndex, false);
}

function selectFindMatch(idx, shouldFocusEditor = false) {
  if (idx < 0 || idx >= findMatches.length) return;
  activeFindIndex = idx;
  const m = findMatches[idx];
  if (typeof editor.setSelectionRange === 'function') {
    editor.setSelectionRange(m.start, m.end);
  }
  scrollToCursor(editor);
  if (shouldFocusEditor) {
    editor.focus();
  }
  const countEl = document.getElementById('findCount');
  if (countEl) countEl.textContent = `${idx + 1}/${findMatches.length}`;
}

function findNext() {
  if (findMatches.length === 0) {
    updateFindMatches();
    return;
  }
  activeFindIndex = (activeFindIndex + 1) % findMatches.length;
  selectFindMatch(activeFindIndex, false);
}

function findPrev() {
  if (findMatches.length === 0) {
    updateFindMatches();
    return;
  }
  activeFindIndex = (activeFindIndex - 1 + findMatches.length) % findMatches.length;
  selectFindMatch(activeFindIndex, false);
}

function handleFindKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) findPrev();
    else findNext();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFindReplace();
  }
}

function replaceCurrent() {
  const replaceInput = document.getElementById('replaceInput');
  if (!replaceInput || activeFindIndex < 0 || activeFindIndex >= findMatches.length) return;
  const repVal = replaceInput.value;
  const m = findMatches[activeFindIndex];

  const val = editor.value;
  editor.value = val.substring(0, m.start) + repVal + val.substring(m.end);
  editor.selectionStart = m.start;
  editor.selectionEnd = m.start + repVal.length;
  updateEditor();
  updateFindMatches();
}

function replaceAll() {
  const findInput = document.getElementById('findInput');
  const replaceInput = document.getElementById('replaceInput');
  if (!findInput || !replaceInput || !findInput.value) return;

  const query = findInput.value;
  const repVal = replaceInput.value;
  const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), findCaseSensitive ? 'g' : 'gi');

  const original = editor.value;
  const matches = original.match(regex);
  const count = matches ? matches.length : 0;

  if (count > 0) {
    editor.value = original.replace(regex, repVal);
    updateEditor();
    updateFindMatches();
    log(`Replaced ${count} occurrence${count === 1 ? '' : 's'}.`, 'success');
  } else {
    log('No occurrences found to replace.', 'info');
  }
}

function scrollToCursor(ed) {
  if (cmEditor) {
    const pos = cmEditor.state.selection.main.head;
    cmEditor.dispatch({
      effects: CM6.EditorView.scrollIntoView(pos, { y: 'center' })
    });
  }
}

// Accelerometer axis keys currently held (X/Y/Z/T) - see the keydown
// handler below.
let heldAxisKeys = new Set();
const PB_KEYS = { j: 2, k: 1, l: 0 };   // BTNL, BTNC, BTNR, left to right

// --- Master Keyboard shortcuts for the Editor & Simulator ---
document.addEventListener('keydown', (e) => {
  // Find/Replace shortcuts
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    openFindReplace(false);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
    e.preventDefault();
    openFindReplace(true);
    return;
  }
  if (e.key === 'Escape') {
    const findPanel = document.getElementById('findReplacePanel');
    if (findPanel && findPanel.style.display !== 'none') {
      e.preventDefault();
      closeFindReplace();
      return;
    }
    const bpOv = document.getElementById('bpFigOverlay');
    if (bpOv && bpOv.classList.contains('open')) {
      e.preventDefault();
      closeBpFigure();
      return;
    }
    const creditsOv = document.getElementById('creditsOverlay');
    if (creditsOv && creditsOv.classList.contains('open')) {
      e.preventDefault();
      closeCreditsModal();
      return;
    }
    const settingsOv = document.getElementById('settingsOverlay');
    if (settingsOv && settingsOv.classList.contains('open')) {
      e.preventDefault();
      closeSettingsModal();
      return;
    }
  }

  // If a form field other than the code editor is focused (UART console input,
  // memory address box, find/replace fields, etc.), don't let the global
  // simulator shortcuts (F5/F8/F9/Ctrl+Enter/Ctrl+S) fire while typing.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
    return;
  }

  // One meaning per key, outside the editor (where they edit):
  //   ← →            Back and Step (phases, with the single-cycle datapath shown)
  //   J K L (held)   push buttons L, C, R, pressed while held
  //   X/Y/Z/T + , .  that accelerometer axis down or up by 5
  const inEditor = !!(t && cmEditor && cmEditor.contentDOM && cmEditor.contentDOM.contains(t));
  if (!inEditor && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const lower = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const nudge = { ',': -5, '<': -5, '.': 5, '>': 5 }[e.key];
    if (['x', 'y', 'z', 't'].includes(lower)) heldAxisKeys.add(lower);
    if (nudge && heldAxisKeys.size) {
      e.preventDefault();
      const delta = nudge;
      heldAxisKeys.forEach(axis => bumpAccelAxis(axis, delta));
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      // With the single-cycle datapath on screen, the arrows walk its
      // phases, as its ▶ and ◀ do.
      const phases = !pipeMode && simEngineMode !== 'hdl' && dpModel && vizShown() && !dpBlocker();
      if (e.key === 'ArrowRight') phases ? dpNext() : stepOnce();
      else phases ? dpPrev() : stepBack();
      return;
    }
    const pbKey = PB_KEYS[lower];
    if (pbKey !== undefined) {
      e.preventDefault();
      pbSetState(pbKey, true);
      return;
    }
  }

  // Simulator Global Action Shortcuts
  if (e.key === 'F5') { e.preventDefault(); toggleRunPause(); }
  else if (e.key === 'F8' && e.shiftKey) { e.preventDefault(); stepBack(); }
  else if (e.key === 'F8') { e.preventDefault(); stepOnce(); }
  else if (e.key === 'F9') { e.preventDefault(); toggleBreakpoint(editorCursorLine()); }
  else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); assembleOnly(); }
  else if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveFile(); }
});

// Releases whichever push-button key was held, and un-arms any released
// accelerometer axis key. Not gated on focus like the keydown handler -
// a key released after focus moved away (e.g. the user Tabbed elsewhere
// mid-press) must still let go of the button / axis.
document.addEventListener('keyup', (e) => {
  const lower = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const pbKey = PB_KEYS[lower];
  if (pbKey !== undefined) pbSetState(pbKey, false);
  if (['x', 'y', 'z', 't'].includes(lower)) heldAxisKeys.delete(lower);
});

// Safety net: if the window loses focus while a key is held down (alt-tab,
// clicking into another app), no keyup ever arrives. Release all three
// rather than leave a button stuck pressed.
window.addEventListener('blur', () => {
  pbSetState(0, false);
  pbSetState(1, false);
  pbSetState(2, false);
  heldAxisKeys.clear();
});

function initCodeMirrorEditor() {
  if (cmEditor) return;
  buildEditorExtensions(); // ensure CM6-derived extensions exist before use
  if (!languageCompartment) {
    languageCompartment = new CM6.Compartment();
    window.languageCompartment = languageCompartment;
  }
  const container = document.getElementById('cmEditorContainer');
  if (!container) return;

  // The very first thing shown, before any explicit example selection -
  // same content loadExample('dip_led') would show, kept as a literal
  // reference to BAKED_ASM_EXAMPLE rather than a second copy of it.
  const initialText = BAKED_ASM_EXAMPLE;

  const startState = CM6.EditorState.create({
    doc: initialText,
    extensions: [
      CM6.lineNumbers({
        domEventHandlers: {
          mousedown(view, line, event) {
            const lineNo = view.state.doc.lineAt(line.from).number;
            toggleBreakpoint(lineNo);
            return true;
          }
        }
      }),
      breakpointGutter,
      execLineField,
      pipeStagesField,
      CM6.gutter({ class: 'cm-pipe-gutter', markers: v => v.state.field(pipeStagesField) }),
      signatureHelpField,
      riscvHoverTooltip,
      CM6.EditorView.domEventHandlers({
        click(event, view) {
          if (editorLanguageMode !== 'c') return false;
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos == null) return false;
          const line = view.state.doc.lineAt(pos);
          const col = pos - line.from;
          const lineText = line.text;
          const commentIdx = lineText.indexOf('//');
          if (commentIdx !== -1 && col >= commentIdx) return false;
          const before = lineText.slice(0, col).match(/(\w+)$/);
          const wordStart = before ? col - before[1].length : col;
          const after = lineText.slice(col).match(/^(\w+)/);
          const wordEnd = after ? col + after[1].length : col;
          if (wordStart === wordEnd) return false;
          const word = lineText.slice(wordStart, wordEnd);
          const varInfo = getCVarAtSourceLine(line.number, word);
          if (!varInfo) return false;
          focusLocalsVar(word);
          return false; // let CM6 still place the cursor normally
        }
      }),
      CM6.highlightActiveLineGutter(),
      CM6.highlightActiveLine(),
      CM6.history(),
      CM6.drawSelection(),
      CM6.dropCursor(),
      CM6.bracketMatching(),
      languageCompartment.of(editorLanguageMode === 'c' ? cLanguage : riscvLanguage),
      CM6.syntaxHighlighting(riscvHighlightStyle),
      riscvEditorTheme,
      CM6.autocompletion({
        override: [riscvAutocomplete],
        defaultKeymap: true,
        activateOnTyping: true,
        maxRenderedOptions: 40
      }),
      CM6.keymap.of([
        ...CM6.historyKeymap,
        ...CM6.defaultKeymap,
        ...CM6.completionKeymap,
        {
          key: "Tab",
          run: (view) => {
            if (CM6.acceptCompletion && CM6.acceptCompletion(view)) return true;
            const { state, dispatch } = view;
            if (state.selection.ranges.every(r => r.empty)) {
              dispatch(state.changeByRange(range => ({
                changes: { from: range.from, insert: '	' },
                range: CM6.EditorSelection.cursor(range.from + 1)
              })));
              return true;
            }
            return CM6.indentMore(view);
          },
          shift: CM6.indentLess
        },
        {
          key: "Ctrl-Space",
          run: CM6.startCompletion
        },
        {
          key: "Mod-f",
          run: () => { openFindReplace(false); return true; }
        },
        {
          key: "Mod-h",
          run: () => { openFindReplace(true); return true; }
        },
        {
          key: "Escape",
          run: () => {
            const panel = document.getElementById('findReplacePanel');
            if (panel && panel.style.display !== 'none') {
              closeFindReplace();
              return true;
            }
            return false;
          }
        },
        {
          key: "F5",
          run: () => { toggleRunPause(); return true; }
        },
        {
          key: "F8",
          run: () => { stepOnce(); return true; }
        },
        {
          key: "Shift-F8",
          run: () => { stepBack(); return true; }
        },
        {
          key: "F9",
          run: (view) => {
            const lineNo = view.state.doc.lineAt(view.state.selection.main.head).number;
            toggleBreakpoint(lineNo);
            return true;
          }
        },
        {
          key: "Mod-Enter",
          run: () => { assembleOnly(); return true; }
        },
        {
          key: "Mod-s",
          run: () => { saveFile(); return true; }
        }
      ]),
      CM6.EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          updateEditor();
        }
      })
    ]
  });

  cmEditor = new CM6.EditorView({
    state: startState,
    parent: container
  });
  window.cmEditor = cmEditor;

  updateEditor();
}

window.initCodeMirrorEditor = initCodeMirrorEditor;

// Initialize CodeMirror 6 after DOM load AND once window.CM6 is available
// (CDN-loaded with a local fallback). The loader (01-cm6-loader.ts) runs
// first, but the CDN import is async, so poll until the global exists.
