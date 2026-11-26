// Loading a file from the file picker, and the page set-up that can run
// before the editor is mounted.

import { hdlAddFiles } from '../hdl/sources';
import { program, run } from '../machine/state';
import { clearLog, editor, editorHistory, initSplitter, log, setStatus } from './editor';
import { editorState } from './editor-state';
import { setLanguageMode } from './examples-language';
import { openSettingsModal } from './execution';
import { initPanelDock, updateEditor, updateLineNumbers } from './panels';
import { assembleOnly, resetAll, updateToolbarButtonStates } from './run-control';
import { byId } from './dom';

// Load file from file input
export function loadFile(event: { target: { files: any[]; value: string; }; }) {
  const file = event.target.files[0];
  if (!file) return;

  const ext = file.name.split('.').pop().toLowerCase();
  // Verilog is a processor description, not a program: it belongs to the
  // HDL engine's source list, not in the editor.
  if (/^(v|sv|vh|svh)$/.test(ext)) {
    hdlAddFiles(event.target.files).then(() => {
      openSettingsModal('simulator');
      setStatus('Loaded ' + event.target.files.length + ' Verilog file(s)', 'success');
    });
    event.target.value = '';
    return;
  }
  if (ext === 'c' || ext === 'h') {
    if (typeof setLanguageMode === 'function') setLanguageMode('c');
  } else if (ext === 'asm' || ext === 's') {
    if (typeof setLanguageMode === 'function') setLanguageMode('asm');
  }

  const reader = new FileReader();
  reader.onload = function (e) {
    editorState.fileName = file.name;
    editor.value = reader.result as string;
    editorState.lastAssembledCode = null;
    program.assembled = false;
    editor.scrollTop = 0;
    editor.scrollLeft = 0;
    run.breakpoints.clear();
    resetAll();
    editorHistory.initialState();
    updateEditor();
    updateLineNumbers();
    clearLog();
    if (editorState.language === 'asm') {
      assembleOnly(); // Auto-assemble on load so Run / Step are active immediately
    }
    log(`Loaded file: ${file.name}`, 'success');
    setStatus('File loaded: ' + file.name + (editorState.language === 'asm' && program.assembled ? ' (auto-assembled — ready to Run/Step)' : ''));
    updateToolbarButtonStates();

    // Display loaded filename in example dropdown
    const select = byId<HTMLSelectElement>('exampleSelect');
    if (select) {
      let opt = document.getElementById('tempFileOption') as HTMLOptionElement | null;
      if (!opt) {
        opt = document.createElement('option');
        opt.id = 'tempFileOption';
        opt.value = 'user_file';
        select.appendChild(opt);
      }
      opt.textContent = `📁 ${file.name}`;
      select.value = 'user_file';
    }
  };
  reader.onerror = function () {
    log('Error reading file: ' + file.name, 'error');
    setStatus('Error loading file', 'error');
  };
  reader.readAsText(file);

  // Reset the file input so the same file can be loaded again
  event.target.value = '';
}

// Run once the page has loaded every module (main.ts), in page order. It
// runs before CodeMirror exists (editor.value's setter does nothing until
// the editor is mounted), so it only wires up the splitters and panel
// docking. Anything touching the editor or the status line belongs in
// bootSimulator() (ui/datapath.ts), which runs after the mount.
export function onFileIoLoad() {
  initSplitter();
  initPanelDock();
}
