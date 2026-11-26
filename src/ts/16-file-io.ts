// @ts-nocheck
// Loading a file from the file picker, and the page set-up that can run
// before the editor is mounted.

// Load file from file input
function loadFile(event) {
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
    currentFileName = file.name;
    editor.value = e.target.result;
    lastAssembledCode = null;
    assembled = false;
    editor.scrollTop = 0;
    editor.scrollLeft = 0;
    breakpoints.clear();
    resetAll();
    editorHistory.initialState();
    updateEditor();
    updateLineNumbers();
    clearLog();
    if (editorLanguageMode === 'asm') {
      assembleOnly(); // Auto-assemble on load so Run / Step are active immediately
    }
    log(`Loaded file: ${file.name}`, 'success');
    setStatus('File loaded: ' + file.name + (editorLanguageMode === 'asm' && assembled ? ' (auto-assembled — ready to Run/Step)' : ''));
    updateToolbarButtonStates();

    // Display loaded filename in example dropdown
    const select = document.getElementById('exampleSelect');
    if (select) {
      let opt = document.getElementById('tempFileOption');
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

// This runs before CodeMirror exists - editor.value's setter no-ops until
// cmEditor is mounted - so it can only wire up the splitters and panel
// docking. Anything touching the editor or the status line belongs in
// bootSimulator() (37-datapath.ts), which runs after the mount.
initSplitter();
initPanelDock();
