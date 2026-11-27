// Find/replace in the editor, the global keyboard shortcuts, and the
// CodeMirror editor's set-up.

import { getCVarAtSourceLine } from '../c/compile';
import { pipeline } from '../machine/pipeline';
import { ui } from '../machine/state';
import { dpBlocker, dpModel, dpNext, dpPrev, vizShown } from './datapath';
import { breakpointGutter, buildEditorExtensions, cLanguage, editor, execLineField, log, pipeStagesField, riscvAutocomplete, riscvEditorTheme, riscvHighlightStyle, riscvHoverTooltip, riscvLanguage, signatureHelpField } from './editor';
import { editorState } from './editor-state';
import { BAKED_ASM_EXAMPLE } from './examples-language';
import { bpFigureOpen, closeBpFigure, closeCreditsModal, closeSettingsModal, creditsModel, editorCursorLine, saveFile, settingsModel, toggleBreakpoint } from './execution';
import { focusLocalsVar } from './locals';
import { updateEditor } from './panels';
import { bumpAccelAxis, pbSetState } from './peripherals';
import { assembleOnly, stepBack, stepOnce, toggleRunPause } from './run-control';
import { byId, targetEl } from './dom';
import { redraw } from './views.svelte';
import type { EditorState, Line, SelectionRange } from '@codemirror/state';
import type { BlockInfo, EditorView, ViewUpdate } from '@codemirror/view';

// Whether the find bar is open, its match count and its Match case switch
// (FindReplace.svelte).
export let findView = { open: false, count: '0/0', caseOn: false };
function setFindView(part: Partial<typeof findView>) {
  findView = { ...findView, ...part };
  redraw('find');
}

export function openFindReplace(focusReplace = false) {
  setFindView({ open: true });
  const findInput = byId<HTMLInputElement>('findInput');
  const replaceInput = byId<HTMLInputElement>('replaceInput');

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

export function closeFindReplace() {
  editorState.find.matches = [];
  editorState.find.activeIndex = -1;
  setFindView({ open: false });
  editor.focus();
}

export function toggleFindCase() {
  editorState.find.caseSensitive = !editorState.find.caseSensitive;
  setFindView({ caseOn: editorState.find.caseSensitive });
  updateFindMatches();
}

export function updateFindMatches() {
  const findInput = byId<HTMLInputElement>('findInput');
  if (!findInput) return;

  const query = findInput.value;
  editorState.find.matches = [];
  editorState.find.activeIndex = -1;

  if (!query) {
    setFindView({ count: '0/0' });
    return;
  }

  const text = editor.value;
  const src = editorState.find.caseSensitive ? text : text.toLowerCase();
  const q = editorState.find.caseSensitive ? query : query.toLowerCase();

  let pos = 0;
  while ((pos = src.indexOf(q, pos)) !== -1) {
    editorState.find.matches.push({ start: pos, end: pos + query.length });
    pos += q.length;
  }

  if (editorState.find.matches.length === 0) {
    setFindView({ count: '0/0' });
    return;
  }

  // Find closest match at or after cursor
  const curPos = editor.selectionStart || 0;
  let bestIdx = 0;
  for (let i = 0; i < editorState.find.matches.length; i++) {
    if (editorState.find.matches[i].start >= curPos) {
      bestIdx = i;
      break;
    }
  }
  editorState.find.activeIndex = bestIdx;
  setFindView({ count: `${editorState.find.activeIndex + 1}/${editorState.find.matches.length}` });
  // DO NOT steal focus from findInput while typing!
  selectFindMatch(editorState.find.activeIndex, false);
}

export function selectFindMatch(idx: number, shouldFocusEditor = false) {
  if (idx < 0 || idx >= editorState.find.matches.length) return;
  editorState.find.activeIndex = idx;
  const m = editorState.find.matches[idx];
  if (typeof editor.setSelectionRange === 'function') {
    editor.setSelectionRange(m.start, m.end);
  }
  scrollToCursor(editor);
  if (shouldFocusEditor) {
    editor.focus();
  }
  setFindView({ count: `${idx + 1}/${editorState.find.matches.length}` });
}

export function findNext() {
  if (editorState.find.matches.length === 0) {
    updateFindMatches();
    return;
  }
  editorState.find.activeIndex = (editorState.find.activeIndex + 1) % editorState.find.matches.length;
  selectFindMatch(editorState.find.activeIndex, false);
}

export function findPrev() {
  if (editorState.find.matches.length === 0) {
    updateFindMatches();
    return;
  }
  editorState.find.activeIndex = (editorState.find.activeIndex - 1 + editorState.find.matches.length) % editorState.find.matches.length;
  selectFindMatch(editorState.find.activeIndex, false);
}

export function handleFindKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) findPrev();
    else findNext();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFindReplace();
  }
}

export function replaceCurrent() {
  const replaceInput = byId<HTMLInputElement>('replaceInput');
  if (!replaceInput || editorState.find.activeIndex < 0 || editorState.find.activeIndex >= editorState.find.matches.length) return;
  const repVal = replaceInput.value;
  const m = editorState.find.matches[editorState.find.activeIndex];

  const val = editor.value;
  editor.value = val.substring(0, m.start) + repVal + val.substring(m.end);
  editor.selectionStart = m.start;
  editor.selectionEnd = m.start + repVal.length;
  updateEditor();
  updateFindMatches();
}

export function replaceAll() {
  const findInput = byId<HTMLInputElement>('findInput');
  const replaceInput = byId<HTMLInputElement>('replaceInput');
  if (!findInput || !replaceInput || !findInput.value) return;

  const query = findInput.value;
  const repVal = replaceInput.value;
  const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), editorState.find.caseSensitive ? 'g' : 'gi');

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

export function scrollToCursor(_ed: typeof editor) {
  if (editorState.cm) {
    const pos: number = editorState.cm.state.selection.main.head;
    editorState.cm.dispatch({
      effects: CM6.EditorView.scrollIntoView(pos, { y: 'center' })
    });
  }
}

// Accelerometer axis keys currently held (X/Y/Z/T) - see the keydown
// handler below.
export let heldAxisKeys = new Set();
export const PB_KEYS: Record<string, number> = { j: 2, k: 1, l: 0 };   // BTNL, BTNC, BTNR, left to right

export function initCodeMirrorEditor() {
  if (editorState.cm) return;
  buildEditorExtensions(); // ensure CM6-derived extensions exist before use
  if (!editorState.languageCompartment) {
    editorState.languageCompartment = new CM6.Compartment();
    window.languageCompartment = editorState.languageCompartment;
  }
  const container = byId('cmEditorContainer');
  if (!container) return;

  // The very first thing shown, before any explicit example selection -
  // same content loadExample('dip_led') would show, kept as a literal
  // reference to BAKED_ASM_EXAMPLE rather than a second copy of it.
  const initialText = BAKED_ASM_EXAMPLE;

  const startState: EditorState = CM6.EditorState.create({
    doc: initialText,
    extensions: [
      CM6.lineNumbers({
        domEventHandlers: {
          mousedown(view: EditorView, line: BlockInfo) {
            const lineNo: number = view.state.doc.lineAt(line.from).number;
            toggleBreakpoint(lineNo);
            return true;
          }
        }
      }),
      breakpointGutter,
      execLineField,
      pipeStagesField,
      CM6.gutter({ class: 'cm-pipe-gutter', markers: (v: EditorView) => v.state.field(pipeStagesField) }),
      signatureHelpField,
      riscvHoverTooltip,
      CM6.EditorView.domEventHandlers({
        click(event: MouseEvent, view: EditorView) {
          if (editorState.language !== 'c') return false;
          const pos: number | null = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos == null) return false;
          const line: Line = view.state.doc.lineAt(pos);
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
      editorState.languageCompartment.of(editorState.language === 'c' ? cLanguage : riscvLanguage),
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
          run: (view: EditorView) => {
            if (CM6.acceptCompletion && CM6.acceptCompletion(view)) return true;
            const { state, dispatch } = view;
            if (state.selection.ranges.every((r: SelectionRange) => r.empty)) {
              dispatch(state.changeByRange((range: SelectionRange) => ({
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
            if (findView.open) {
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
          run: (view: EditorView) => {
            const lineNo: number = view.state.doc.lineAt(view.state.selection.main.head).number;
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
      CM6.EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged) {
          updateEditor();
        }
      })
    ]
  });

  editorState.cm = new CM6.EditorView({
    state: startState,
    parent: container
  });
  window.cmEditor = editorState.cm;

  updateEditor();
}

// Run once the page has loaded every module (main.ts), in page order.
export function onFindReplaceLoad() {
  // Keyboard shortcuts for the editor and the simulator.
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
      if (findView.open) {
        e.preventDefault();
        closeFindReplace();
        return;
      }
      if (bpFigureOpen) {
        e.preventDefault();
        closeBpFigure();
        return;
      }
      if (creditsModel.open) {
        e.preventDefault();
        closeCreditsModal();
        return;
      }
      if (settingsModel.open) {
        e.preventDefault();
        closeSettingsModal();
        return;
      }
    }

    // If a form field other than the code editor is focused (UART console input,
    // memory address box, find/replace fields, etc.), don't let the global
    // simulator shortcuts (F5/F8/F9/Ctrl+Enter/Ctrl+S) fire while typing.
    const t = targetEl(e);
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
      return;
    }

    // One meaning per key, outside the editor (where they edit):
    //   ← →            Back and Step (phases, with the single-cycle datapath shown)
    //   J K L (held)   push buttons L, C, R, pressed while held
    //   X/Y/Z/T + , .  that accelerometer axis down or up by 5
    const inEditor = !!(t && editorState.cm && editorState.cm.contentDOM && editorState.cm.contentDOM.contains(t));
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
        const phases = !pipeline.on && ui.engine !== 'hdl' && dpModel && vizShown() && !dpBlocker();
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
  // accelerometer axis key. Not gated on focus like the keydown handler:
  // a key released after focus moved away (Tab mid-press) must still let
  // go of the button or axis.
  document.addEventListener('keyup', (e) => {
    const lower = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const pbKey = PB_KEYS[lower];
    if (pbKey !== undefined) pbSetState(pbKey, false);
    if (['x', 'y', 'z', 't'].includes(lower)) heldAxisKeys.delete(lower);
  });
  // If the window loses focus while a key is held down (alt-tab, clicking
  // into another app), no keyup ever arrives: release all three rather
  // than leave a button stuck pressed.
  window.addEventListener('blur', () => {
    pbSetState(0, false);
    pbSetState(1, false);
    pbSetState(2, false);
    heldAxisKeys.clear();
  });
}
