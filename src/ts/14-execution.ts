// @ts-nocheck
// Main execution control: the cycle model, the Settings modal (Compiler,
// Linker, Simulator), memory-image downloads, current-line highlighting,
// breakpoints, assembly and single-instruction execution.

function instrCycles(instr32) {
  const opcode = instr32 & 0x7F;
  const funct7 = (instr32 >>> 25) & 0x7F;
  switch (opcode) {
    case 0b0000011: return cycleConfig.load;                    // loads
    case 0b0100011: case 0b0100111: return cycleConfig.store;   // stores
    case 0b1100011: return cycleConfig.branch;                  // branches
    case 0b1101111: case 0b1100111: return cycleConfig.jump;     // jumps
    case 0b0110011: return funct7 === 0b0000001 ? cycleConfig.muldiv : cycleConfig.basic;
    case 0b1010011: return cycleConfig.fp;                      // FP
    case 0b0101111: return cycleConfig.load;                    // atomic ≈ load/store
    case 0b1110011: return cycleConfig.system;                  // system / ecall
    default: return cycleConfig.basic;
  }
}

// The program counter is the number you actually watch while stepping, so
// it lives in the always-on metrics run rather than only in the status
// message, which any later message overwrites.
function formatPC() {
  return '0x' + ((typeof pc === 'number' ? pc : 0) >>> 0).toString(16).padStart(8, '0');
}

function updateStats() {
  const el = document.getElementById('statsBar');
  if (el) {
    el.innerHTML = `Cycles: ${totalCycles} &nbsp;|&nbsp; Instr: ${instructionCount}` +
      ` &nbsp;|&nbsp; PC: <span class="stat-pc">${formatPC()}</span>`;
  }
}

function hideExecMarker() {
  currentExecLine = -1;
  if (cmEditor) {
    cmEditor.dispatch({
      effects: [setExecLineEffect.of(-1), setPipeStagesEffect.of([])]
    });
  }
}

// Cycle configuration
const CYCLE_FIELD_DEFS = [
  ['basic', 'ALU / Shift / LUI / AUIPC'],
  ['muldiv', 'Multiply / Divide (M-extension)'],
  ['load', 'Load (LW / LH / FLW / FLD)'],
  ['store', 'Store (SW / SH / FSW / FSD)'],
  ['branch', 'Branch (BEQ / BNE …)'],
  ['jump', 'Jumps (JAL / JALR)'],
  ['fp', 'Floating-Point Ops'],
  ['system', 'System (ECALL / EBREAK)']
];

// Statement Stepping reaches both engines, so it is offered on both tabs.
// The two checkboxes are the same setting, and are kept identical.
const STMT_STEP_IDS = ['simStatementStep'];
function syncStatementStepBoxes() {
  STMT_STEP_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.checked = !!statementStepping;
  });
}

function buildCyclesPanel() {
  pipeInitControls();
  STMT_STEP_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.checked = !!statementStepping;
    el.onchange = () => { statementStepping = el.checked; syncStatementStepBoxes(); };
  });

  const maxInstrEl = document.getElementById('simMaxInstrPerRun');
  if (maxInstrEl) {
    maxInstrEl.value = (typeof maxInstructionsPerRun === 'number' && maxInstructionsPerRun > 0) ? maxInstructionsPerRun : 100000000;
    maxInstrEl.onchange = () => {
      const v = parseInt(maxInstrEl.value, 10);
      maxInstructionsPerRun = (v > 0) ? v : 100000000;
      maxInstrEl.value = maxInstructionsPerRun;
    };
  }

  const body = document.getElementById('cyclesConfigBody');
  let html = '';
  for (const [key, label] of CYCLE_FIELD_DEFS) {
    html += '<div class="cycle-field"><label for="cf-' + key + '">' + label + '</label>' +
      '<input id="cf-' + key + '" type="number" min="1" max="1000" value="' + cycleConfig[key] + '"></div>';
  }
  body.innerHTML = html;
  for (const [key] of CYCLE_FIELD_DEFS) {
    document.getElementById('cf-' + key).addEventListener('change', e => {
      const v = parseInt(e.target.value, 10);
      cycleConfig[key] = (v > 0 && v <= 1000) ? v : 1;
      e.target.value = cycleConfig[key];
    });
  }
}

function resetCyclesConfig() {
  cycleConfig.basic = 1;
  cycleConfig.muldiv = 2;
  cycleConfig.load = 2;
  cycleConfig.store = 2;
  cycleConfig.branch = 1;
  cycleConfig.jump = 1;
  cycleConfig.fp = 4;
  cycleConfig.system = 1;
  statementStepping = false;
  maxInstructionsPerRun = 100000000;
  pipeHaz = Object.assign({}, PIPE_HAZ_DEFAULT);
  pipeBP = Object.assign({}, PIPE_BP_DEFAULT);
  pipeSetMode(false);
  buildCyclesPanel();
  setStatus('Simulator settings reset to defaults', 'success');
}

// --- Settings modal (Compiler, Linker, Simulator) ---
// The Simulation tab shows the active engine's settings only.
function refreshSimSettingsScope() {
  const hdl = (typeof simEngineMode !== 'undefined' && simEngineMode === 'hdl');
  const js = document.getElementById('simGroupJs'), hw = document.getElementById('simGroupHdl');
  if (js) js.hidden = hdl;
  if (hw) hw.hidden = !hdl;
  pipeSyncControls();
}

// Assembled here rather than written into the page, so the address is not
// there for a scraper to find.
function sendFeedback() {
  const to = ['rajesh', 'nus.edu.sg'].join('@');
  window.location.href = 'mailto:' + to + '?subject=' + encodeURIComponent('RISC-V simulator feedback');
}
window.sendFeedback = sendFeedback;

// Visits are counted by GoatCounter (goatcounter.com): open source, no
// cookies, ads or banners. Its image request counts the visit without
// running any of its script here; the total is shown in Credits. Empty
// turns it off. Nothing is sent from a local copy (file:, localhost).
const GOATCOUNTER_SITE = 'cg3207sim';
function visitCounterOn() {
  const h = location.hostname;
  return !!GOATCOUNTER_SITE && /^https?:$/.test(location.protocol) &&
    h !== 'localhost' && h !== '127.0.0.1' && h !== '[::1]' && !h.endsWith('.localhost');
}
function countVisit() {
  if (!visitCounterOn()) return;
  const img = new Image();
  img.referrerPolicy = 'no-referrer-when-downgrade';
  img.src = 'https://' + GOATCOUNTER_SITE + '.goatcounter.com/count?p=' +
    encodeURIComponent(location.pathname) + '&r=' + encodeURIComponent(document.referrer) + '&rnd=' + Date.now();
}
function showVisitCount() {
  const el = document.getElementById('visitCount');
  if (!el || !visitCounterOn()) return;
  fetch('https://' + GOATCOUNTER_SITE + '.goatcounter.com/counter/' + encodeURIComponent(location.pathname) + '.json')
    .then(r => r.ok ? r.json() : null)
    .then(j => { if (j && j.count) { el.textContent = j.count + ' visits'; el.hidden = false; } })
    .catch(() => { /* offline, or the site not set up: say nothing */ });
}

function openCreditsModal() {
  showVisitCount();
  const ov = document.getElementById('creditsOverlay');
  if (ov) { ov.classList.add('open'); ov.style.display = ''; }
}

function openBpFigure() {
  const ov = document.getElementById('bpFigOverlay');
  if (ov) ov.classList.add('open');
}

function closeBpFigure() {
  const ov = document.getElementById('bpFigOverlay');
  if (ov) ov.classList.remove('open');
}

function closeCreditsModal() {
  const ov = document.getElementById('creditsOverlay');
  if (ov) { ov.classList.remove('open'); ov.style.display = ''; }
}

function openSettingsModal(initialTab = 'compiler') {
  const ov = document.getElementById('settingsOverlay');
  if (!ov) return;
  buildMemSegmentsPanel();
  buildCyclesPanel();
  refreshSimSettingsScope();
  switchSettingsTab(initialTab);
  ov.classList.add('open');
  ov.style.display = '';
}

function closeSettingsModal() {
  const ov = document.getElementById('settingsOverlay');
  if (ov) {
    ov.classList.remove('open');
    ov.style.display = '';
  }
}

function switchSettingsTab(tabName) {
  currentSettingsTab = tabName;
  document.querySelectorAll('.settings-tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));

  const activeBtn = document.getElementById('settingsTabBtn-' + tabName);
  const activeContent = document.getElementById('settingsContent-' + tabName);
  if (activeBtn) activeBtn.classList.add('active');
  if (activeContent) activeContent.classList.add('active');
}

function parseHexAddr(str, fallback) {
  let v = parseInt(String(str || '').trim(), 16);
  if (isNaN(v) || v < 0) v = fallback;
  return v & ~3; // word align
}

function updateLinkerStackPreview() {
  const g = id => {
    const el = document.getElementById(id);
    return el ? el.value : '';
  };
  const dBase = parseHexAddr(g('ms-data'), dataBase);
  const dSize = parseHexAddr(g('ms-datasize'), dataSize);
  const stackTop = (dBase + dSize) >>> 0;
  const stackInput = document.getElementById('ms-stack');
  if (stackInput) {
    stackInput.value = '0x' + stackTop.toString(16);
  }
}

// An example declares the two memory depths it needs in examples/index.txt.
// The Linker segment sizes follow from them, and the stack pointer the C
// startup shim loads follows from the data size, so selecting an example is
// enough to set up a layout the program actually fits in.
function applyExampleMemoryConfig(key) {
  const d = EXAMPLE_DEPTHS[key];
  if (!d) return;
  const newCode = Math.pow(2, d.irom) >>> 0;
  const newData = Math.pow(2, d.dmem) >>> 0;
  if (codeSize === newCode && dataSize === newData) return;
  const stackWasDefault = stackBase === ((dataBase + dataSize) >>> 0);
  codeSize = newCode;
  dataSize = newData;
  if (stackWasDefault) stackBase = (dataBase + dataSize) >>> 0;
  buildMemSegmentsPanel();
  hdlSyncReferenceWrapperDepths();
  log('Memory layout for this example: IROM_DEPTH_BITS ' + d.irom + ' (code segment 0x' +
      newCode.toString(16) + '), DMEM_DEPTH_BITS ' + d.dmem + ' (data segment 0x' +
      newData.toString(16) + '), stack top 0x' + (stackBase >>> 0).toString(16) +
      '. Change these in Settings → Linker, and in Wrapper, if you change the program.', 'info');
}

function buildMemSegmentsPanel() {
  const codeEl = document.getElementById('ms-code');
  const codeSizeEl = document.getElementById('ms-codesize');
  const dataEl = document.getElementById('ms-data');
  const dataSizeEl = document.getElementById('ms-datasize');
  const stackEl = document.getElementById('ms-stack');
  const mmioEl = document.getElementById('ms-mmio');

  if (codeEl) codeEl.value = '0x' + (baseAddress >>> 0).toString(16);
  if (codeSizeEl) codeSizeEl.value = '0x' + (codeSize >>> 0).toString(16);
  if (dataEl) dataEl.value = '0x' + (dataBase >>> 0).toString(16);
  if (dataSizeEl) dataSizeEl.value = '0x' + (dataSize >>> 0).toString(16);
  if (stackEl) stackEl.value = '0x' + (stackBase >>> 0).toString(16);
  if (mmioEl) mmioEl.value = '0x' + (mmioBase >>> 0).toString(16);
}

function getCyclesFromPanel() {
  for (const [key] of CYCLE_FIELD_DEFS) {
    const el = document.getElementById('cf-' + key);
    if (el) {
      const v = parseInt(el.value, 10);
      cycleConfig[key] = (v > 0 && v <= 1000) ? v : 1;
    }
  }
}

function applyAndCloseSettings() {
  // 1. Apply Linker / Memory Segments
  const g = id => {
    const el = document.getElementById(id);
    return el ? el.value : '';
  };
  // Only a changed memory layout needs the program reassembled;
  // reloading otherwise would discard an HDL recording for nothing.
  // Compared unsigned: the word-align mask turns an address at or above
  // 0x80000000 (the MMIO base) negative.
  const layoutKey = () => [baseAddress, codeSize, dataBase, dataSize, stackBase, mmioBase]
    .map(v => v >>> 0).join(',');
  const layoutBefore = layoutKey();
  baseAddress = parseHexAddr(g('ms-code'), baseAddress);
  codeSize = parseHexAddr(g('ms-codesize'), codeSize);
  dataBase = parseHexAddr(g('ms-data'), dataBase);
  dataSize = parseHexAddr(g('ms-datasize'), dataSize);
  const defaultStack = (dataBase + dataSize) >>> 0;
  stackBase = parseHexAddr(g('ms-stack'), defaultStack);
  mmioBase = parseHexAddr(g('ms-mmio'), mmioBase);

  const memAddrEl = document.getElementById('memAddr');
  if (memAddrEl) memAddrEl.value = '0x' + (baseAddress >>> 0).toString(16);

  // 2. Apply Simulator CPI, Statement Stepping & Max Instructions
  getCyclesFromPanel();
  // Either copy is authoritative; they are mirrored on change.
  const stmtEl = document.getElementById('simStatementStep');
  if (stmtEl) statementStepping = stmtEl.checked;
  syncStatementStepBoxes();

  const maxInstrEl = document.getElementById('simMaxInstrPerRun');
  if (maxInstrEl) {
    const v = parseInt(maxInstrEl.value, 10);
    maxInstructionsPerRun = (v > 0) ? v : 100000000;
    maxInstrEl.value = maxInstructionsPerRun;
  }

  closeSettingsModal();
  if (layoutKey() !== layoutBefore) reloadAfterLayoutChange();
  setStatus('Settings updated successfully', 'success');
}

function resetCurrentSettingsTab() {
  if (currentSettingsTab === 'compiler') {
    const compSelect = document.getElementById('godboltCompilerSelect');
    const optSelect = document.getElementById('godboltOptSelect');
    const archInput = document.getElementById('godboltArchFlags');
    const useMCheck = document.getElementById('godboltUseM');
    const flags = () => [compSelect, optSelect, archInput].map(el => el ? el.value : '').join('|') +
      (useMCheck && useMCheck.checked ? '|M' : '');
    const before = flags();
    if (compSelect) compSelect.value = 'rv32-cclang2010';
    if (optSelect) optSelect.value = '-O0';
    if (useMCheck) useMCheck.checked = false;
    if (archInput) archInput.value = '-march=rv32i -mabi=ilp32';
    // Setting a value from script raises no change event, so the
    // watchers that retire a stale build have to be stood in for.
    if (flags() !== before) invalidateCompiledProgram('Compiler settings');
    setStatus('Compiler settings reset to defaults (Clang 20.1, -O0)', 'info');
  } else if (currentSettingsTab === 'linker') {
    // Only the fields: Apply compares them against the live layout to
    // decide whether to reassemble, so it must still see the old one.
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.value = '0x' + (v >>> 0).toString(16);
    };
    set('ms-code', DEFAULT_BASE);
    set('ms-codesize', 0x200);
    set('ms-data', DEFAULT_DATA_BASE);
    set('ms-datasize', 0x200);
    set('ms-stack', DEFAULT_DATA_BASE + 0x200);
    set('ms-mmio', 0xFFFF0000);
    setStatus('Linker defaults filled in - Apply to use them', 'info');
  } else if (currentSettingsTab === 'simulator' && simEngineMode !== 'hdl') {
    resetCyclesConfig();
  } else if (currentSettingsTab === 'simulator') {
    // Settings only - the loaded sources are the user's work, and Clear
    // files is right there for them.
    const set = (id, v, prop) => {
      const el = document.getElementById(id);
      if (el) el[prop] = v;
    };
    Object.assign(hdlCyclesFor, HDL_CYCLES_DEFAULT);
    set('hdlGeneration', '2005', 'value');
    set('hdlRegPath', '', 'value');
    setHdlSimulator('icarus');
    setHdlDetail('full', true);
    hdlShowCycles();
    setHdlRegPath();
    hdlRefreshRegPathHint();
    setStatus('HDL settings reset to defaults (sources kept)', 'info');
  }
}

// The Settings modal itself is not exported; these two are, and are the
// only handle anything outside the page has on it.
function toggleCompilerConfigPanel() { openSettingsModal('compiler'); }
function closeCompilerConfigPanel() { closeSettingsModal(); }

// Reset execution state, then re-assemble and load the program so the memory
// view reflects the current segment addresses.
function reloadAfterLayoutChange() {
  resetAll();
  if (editor.value.trim()) {
    assembleOnly();
  }
}

function downloadTextFile(name, text) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Build a Verilog $readmemh-format dump of code and data memories.
function buildMemFileText(items) {
  if (!items.length) return '';
  let result = '';
  let lastAddr = -1;
  for (const item of items) {
    const wordCount = Math.max(1, Math.ceil(item.bytes.length / 4));
    for (let w = 0; w < wordCount; w++) {
      const addr = item.address + w * 4;
      if (addr !== lastAddr + 4) {
        // Comment out the @ address directive in Verilog .mem format (relative addressing handled elsewhere)
        result += '// @' + addr.toString(16).padStart(8, '0').toUpperCase() + '\n';
      }
      const b = item.bytes;
      const word = (b[w * 4] || 0) | ((b[w * 4 + 1] || 0) << 8) | ((b[w * 4 + 2] || 0) << 16) | ((b[w * 4 + 3] || 0) << 24);
      result += (word >>> 0).toString(16).padStart(8, '0').toUpperCase() + '\n';
      lastAddr = addr;
    }
  }
  return result;
}

function segmentItems(isData) {
  return machineCode
    .filter(i => !i.error && i.bytes && (i.address >= dataBase) === isData)
    .sort((a, b) => a.address - b.address);
}

function dumpSegment(isData) {
  const items = segmentItems(isData);
  const what = isData ? 'data' : 'text';
  if (!items.length) { setStatus(`No ${isData ? 'data' : 'code'} segment loaded`, 'error'); return; }
  const name = isData ? 'AA_DMEM.mem' : 'AA_IROM.mem';
  downloadTextFile(name, buildMemFileText(items));
  setStatus(`Dumped ${what} memory segment to ${name}`, 'success');
}

// Everything the page can hand back as a file. `ready` decides whether the
// entry is offered; picking one saves it and the menu snaps back to its
// label, so it reads as a menu of actions rather than a setting.
const DOWNLOADS = {
  irom: {
    ready: () => segmentItems(false).length > 0,
    save: () => dumpSegment(false)
  },
  dmem: {
    ready: () => segmentItems(true).length > 0,
    save: () => dumpSegment(true)
  },
  tb: {
    ready: () => !!hdlFindWrapper(),
    save: () => hdlDownloadTestbench()
  },
  vcd: {
    ready: () => !!hdlLastVcd,
    save: () => hdlDownloadVcd()
  }
};

function refreshDownloadMenu() {
  const sel = document.getElementById('downloadSelect');
  if (!sel) return;
  for (const opt of sel.options) {
    if (!opt.value) continue;
    const d = DOWNLOADS[opt.value];
    opt.disabled = !(d && d.ready());
  }
}

function handleDownloadPick(sel) {
  const d = DOWNLOADS[sel.value];
  sel.value = '';
  if (d) d.save();
}

function saveFile() {
  const content = editor.value;
  if (!content.trim()) { setStatus('Editor is empty — nothing to save', 'error'); return; }
  const defaultExt = (editorLanguageMode === 'c') ? '.c' : '.asm';
  let filename = currentFileName || ('program' + defaultExt);
  if (!filename.toLowerCase().endsWith('.asm') && !filename.toLowerCase().endsWith('.s') && !filename.toLowerCase().endsWith('.c') && !filename.toLowerCase().endsWith('.h') && !filename.toLowerCase().endsWith('.txt')) {
    filename += defaultExt;
  }
  downloadTextFile(filename, content);
  setStatus(`Saved ${filename}`, 'success');
}

function sourceLineForPc(addr) {
  if (editorLanguageMode === 'c') {
    if (pcToCLineMap && pcToCLineMap.has(addr)) return pcToCLineMap.get(addr);
    if (labels && labels['main'] !== undefined && addr < labels['main'] && pcToCLineMap) {
      const mainAddr = labels['main'];
      if (pcToCLineMap.has(mainAddr)) return pcToCLineMap.get(mainAddr);
    }
    return -1;
  }
  const line = pcToLineMap.get(addr);
  return line === undefined ? -1 : line;
}

function pipeStageLines() {
  if (!pipeMode || simEngineMode === 'hdl' || !pipe || !assembled) return [];
  const byLine = new Map();
  const add = (addr, letter) => {
    const line = sourceLineForPc(addr >>> 0);
    if (line < 1) return;
    byLine.set(line, (byLine.has(line) ? byLine.get(line) + ' ' : '') + letter);
  };
  if (!programFinished && readMem(pc >>> 0, 4, true)) add(pc, 'F');
  ['D', 'E', 'M', 'W'].forEach(k => { if (pipe[k]) add(pipe[k].pc, k); });
  return Array.from(byLine.entries()).sort((a, b) => a[0] - b[0]);
}

function highlightCurrentLine() {
  if (!cmEditor) return;
  cmEditor.dispatch({
    effects: [setExecLineEffect.of(currentExecLine), setPipeStagesEffect.of(pipeStageLines())]
  });
  if (currentExecLine >= 1 && currentExecLine <= cmEditor.state.doc.lines) {
    centreEditorLine(cmEditor.state.doc.line(currentExecLine).from);
  }
}

// CodeMirror's scrollIntoView also scrolls every scrollable ancestor, so
// on a phone each step would drag the page back up to the editor.
function centreEditorLine(pos) {
  const sc = cmEditor.scrollDOM;
  if (!sc.clientHeight) return;
  const blk = cmEditor.lineBlockAt(pos);
  const docTop = cmEditor.documentTop - sc.getBoundingClientRect().top + sc.scrollTop;
  sc.scrollTop = Math.max(0, docTop + blk.top + blk.height / 2 - sc.clientHeight / 2);
  sc.scrollLeft = 0;
}

function findNextValidInstructionLine(targetLine) {
  const totalLines = cmEditor ? cmEditor.state.doc.lines : (editor ? editor.value.split('\n').length : 1);
  if (targetLine < 1) targetLine = 1;
  if (targetLine > totalLines) targetLine = totalLines;

  if (editorLanguageMode === 'c') {
    if (assembled && cLineToFirstPcMap && cLineToFirstPcMap.size > 0 && lastAssembledCode === (editor ? editor.value : null)) {
      if (cLineToFirstPcMap.has(targetLine)) return targetLine;
      const validCLines = Array.from(cLineToFirstPcMap.keys()).sort((a, b) => a - b);
      const next = validCLines.find(l => l >= targetLine);
      if (next !== undefined) return next;
      return validCLines[validCLines.length - 1] || targetLine;
    }
    let current = targetLine;
    while (current <= totalLines) {
      let lineText = '';
      if (cmEditor && current <= cmEditor.state.doc.lines) {
        lineText = cmEditor.state.doc.line(current).text.trim();
      } else {
        const allLines = editor ? editor.value.split('\n') : [];
        lineText = (allLines[current - 1] || '').trim();
      }
      if (lineText && !lineText.startsWith('//') && !lineText.startsWith('/*') && !lineText.startsWith('*') && lineText !== '{' && lineText !== '}') {
        return current;
      }
      current++;
    }
    return targetLine;
  }

  // 1. If currently assembled and code is up to date, use machineCode source mapping
  if (assembled && Array.isArray(machineCode) && machineCode.length > 0 && lastAssembledCode === (editor ? editor.value : null)) {
    const validLines = [];
    for (const item of machineCode) {
      if (!item.error && item.line && !validLines.includes(item.line)) {
        validLines.push(item.line);
      }
    }
    validLines.sort((a, b) => a - b);
    if (validLines.length > 0) {
      if (validLines.includes(targetLine)) return targetLine;
      const next = validLines.find(l => l >= targetLine);
      if (next !== undefined) return next;
      return validLines[validLines.length - 1];
    }
  }

  // 2. Parse source lines to find next executable instruction
  function checkLineIsInstruction(lineNo) {
    let text = '';
    if (cmEditor) {
      if (lineNo < 1 || lineNo > cmEditor.state.doc.lines) return false;
      text = cmEditor.state.doc.line(lineNo).text;
    } else {
      const allLines = editor ? editor.value.split('\n') : [];
      if (lineNo < 1 || lineNo > allLines.length) return false;
      text = allLines[lineNo - 1];
    }

    let code = text.split('#')[0].split(';')[0].trim();
    if (!code) return false;

    const labelMatch = code.match(/^([a-zA-Z_.$][\w.$]*\s*:\s*)(.*)$/);
    if (labelMatch) {
      code = labelMatch[2].trim();
      if (!code) return false;
    }

    if (code.includes('=')) return false;
    if (code.startsWith('.')) return false;

    const m = code.match(/^([a-zA-Z_.$][\w.$]*)/);
    if (!m) return false;
    const mnem = m[1].toLowerCase();

    if (typeof INSTRUCTIONS !== 'undefined' && INSTRUCTIONS[mnem]) return true;
    if (typeof PSEUDO_INSTRUCTIONS !== 'undefined' && PSEUDO_INSTRUCTIONS[mnem]) return true;
    if (typeof RISCV_INSTRUCTIONS_SET !== 'undefined' && RISCV_INSTRUCTIONS_SET.has(mnem)) return true;

    return false;
  }

  if (checkLineIsInstruction(targetLine)) {
    return targetLine;
  }

  for (let i = targetLine + 1; i <= totalLines; i++) {
    if (checkLineIsInstruction(i)) {
      return i;
    }
  }

  for (let i = targetLine - 1; i >= 1; i--) {
    if (checkLineIsInstruction(i)) {
      return i;
    }
  }

  return targetLine;
}

function toggleBreakpoint(requestedLine) {
  if (!requestedLine || requestedLine < 1) {
    log('Invalid breakpoint line number.', 'warn');
    return;
  }

  const effectiveLine = findNextValidInstructionLine(requestedLine);
  const isMoved = (effectiveLine !== requestedLine);

  if (breakpoints.has(effectiveLine)) {
    breakpoints.delete(effectiveLine);
    log(`Breakpoint removed at line ${effectiveLine}.`, 'info');
  } else {
    breakpoints.add(effectiveLine);
    if (isMoved) {
      log(`Breakpoint set at line ${effectiveLine} (moved from line ${requestedLine} to next valid instruction).`, 'info');
    } else {
      log(`Breakpoint set at line ${effectiveLine}.`, 'info');
    }
  }
  updateLineNumbers();
  highlightCurrentLine();
}

function editorCursorLine() {
  return editor.value.substring(0, editor.selectionStart || 0).split('\n').length;
}

function prepareAssembly() {
  const source = editor.value;
  if (!source.trim()) {
    log('No assembly code to assemble.', 'error');
    setStatus('Error: No code', 'error');
    return null;
  }
  cFunctionLocals = new Map();
  try {
    log('Assembling...', 'info');
    const mc = assemble(source, baseAddress);
    machineCode = mc;
    let hasError = false;
    for (const item of mc) {
      if (item.error) {
        log(`Line ${item.line}: ${item.error}`, 'error');
        hasError = true;
      }
    }
    if (hasError) {
      setStatus('Assembly failed — see errors below', 'error');
      updateMachineCode();
      updateDisassembly();
      return null;
    }
    return mc;
  } catch (e) {
    log(`Assembly error: ${e.message}`, 'error');
    setStatus('Error: ' + e.message, 'error');
    return null;
  }
}

function executeOne() {
  const addr = pc;
  const instr32 = fetchInstruction(addr);
  if (instr32 === 0) { pc += 4; return; }
  totalCycles += jsArch === 'multi' ? instrCycles(instr32) : 1;
  instructionCount++;
  pc = decodeAndExecute(instr32, addr);
  lastChangedReg = lastExecutedRd;
  uartClockTick();
}

// Clock pending UART input onto the wire as each character's time comes.
function uartClockTick() {
  if (uartPending.length) {
    const before = uartPending.length;
    uartTickDelivery();
    if (uartPending.length !== before) {
      if (!uartPending.length) {
        const btn = document.getElementById('uartSendBtn');
        const statusEl = document.getElementById('uartAutoSendStatus');
        if (btn) {
          btn.innerText = 'Send';
          btn.style.background = '';
        }
        if (statusEl) statusEl.innerText = 'Send complete';
      }
      // A run refreshes the panels once per batch instead.
      if (!running) {
        updatePeripherals();
        updateMemoryView();
      }
    }
  }
}

function firstExecutableLine(mc) {
  for (const item of mc) {
    if (!item.error && item.bytes) return item.line;
  }
  return -1;
}

function highlightFirstLine(mc) {
  currentExecLine = firstExecutableLine(mc);
  highlightCurrentLine();
}

let pcToCLineMap = new Map();
let cLineToPcsMap = new Map();
let cLineToFirstPcMap = new Map();
let lastCompiledCSource = null;
let lastGeneratedAsm = '';
