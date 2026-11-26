// @ts-nocheck
// HDL mode's hooks into the shared UI, and the window exports that the
// page's handlers and the tests call.

// These wrap the shared functions rather than editing them, so the
// functional engine's own path stays untouched.
const hdlBaseStepOnce = stepOnce;
stepOnce = function () {
  if (ui.engine === 'hdl') { hdlStepOnce(); return; }
  hdlBaseStepOnce();
};

const hdlBaseStepBack = stepBack;
stepBack = function () {
  if (ui.engine === 'hdl') { hdlStepBack(); return; }
  hdlBaseStepBack();
};

const hdlBaseResetAll = resetAll;
resetAll = function () {
  if (ui.engine === 'hdl') hdlDiscardTrace();
  hdlBaseResetAll();
};

// Hardware registers power up undefined. The functional model can
// afford to show them as zero; the RTL cannot, and papering over that
// would hide exactly the kind of bug this mode exists to find.
const hdlBaseUpdateRegisters = updateRegisters;
updateRegisters = function () {
  hdlBaseUpdateRegisters();
  // If the register file could not be reached inside the uploaded design,
  // every value here would be a guess. Say so plainly instead: the PC,
  // the instruction stream, memory and the peripherals all come from the
  // fixed Wrapper and are unaffected.
  const notice = document.getElementById('hdlRegNotice');
  if (notice) {
    const missing = (ui.engine === 'hdl' && hdlRec.trace && !hdlRec.trace.regBank);
    notice.style.display = missing ? '' : 'none';
    if (missing && !notice.dataset.filled) {
      notice.innerHTML = '<b>Register values are not available for this design.</b> ' +
        'No 32 x 32-bit register array could be found in the uploaded sources, ' +
        'so nothing here is read from your hardware. Everything else - the PC, ' +
        'the instruction stream, memory and the peripherals - comes from the ' +
        'fixed Wrapper and is unaffected. Name the array under ' +
        '<b>\u2699 Settings \u2192 HDL</b>, in the ' +
        '<b>Register file</b> field (for example <code>dut.RV1.RegFile1.RegBank</code>) ' +
        'to bring this view back.';
      notice.dataset.filled = '1';
    }
  }
  if (ui.engine !== 'hdl' || !hdlRec.trace || !hdlRec.regKnown || !regBody) return;
  const rows = regBody.querySelectorAll('tr');
  for (let i = 1; i < 32 && i < rows.length; i++) {
    if (hdlRec.regKnown[i]) continue;
    const cells = rows[i].querySelectorAll('td.col-val');
    if (cells[0]) { cells[0].textContent = 'xxxxxxxx'; cells[0].classList.add('reg-unknown'); }
    if (cells[1]) { cells[1].textContent = '?'; cells[1].classList.add('reg-unknown'); }
  }
};

// "Cycles" depends on the model: one per instruction single-cycle, the
// table's count multi-cycle, clock edges pipelined and in HDL mode.
const hdlBaseUpdateStats = updateStats;
updateStats = function () {
  hdlBaseUpdateStats();
  const el = document.getElementById('statsBar');
  if (!el) return;
  const hdl = ui.engine === 'hdl';
  const piped = !hdl && pipeline.on;
  const multi = !hdl && pipeline.arch === 'multi';
  const pacing = clock.pace === 'real' && (hdl ? !!(hdlActivity.play || hdlActivity.live || hdlActivity.chunked) : run.running);
  const SEP = '&nbsp;|&nbsp; ';
  const lead = [fmtSimTime(cpu.totalCycles) +
    (pacing && clock.rtRatio < 0.95 ? ' <span class="stat-lag" title="The browser cannot keep up with this clock">×' +
      clock.rtRatio.toFixed(2) + ' real time</span>' : ''),
    'Cycles: ' + cpu.totalCycles +
    ' <span class="stat-tag">' + (hdl ? 'hw' : piped ? 'pipe' : multi ? 'multi' : 'single') + '</span>'];
  const tail = ['Instr: ' + cpu.instructionCount];
  if ((piped || multi) && cpu.instructionCount) tail.push('CPI: ' + (cpu.totalCycles / cpu.instructionCount).toFixed(2));
  if (piped && pipeline.predictor.on && pipeline.regs) tail.push('Mispredicts: ' + pipeline.regs.mispredicts);
  tail.push('PC: <span class="stat-pc">' + formatPC() + '</span>');
  // Two halves of about equal width, which a phone stacks rather than
  // squeeze the status message beside them.
  if (tail.length > 2) lead.push(tail.shift());
  el.innerHTML = '<span class="stat-half">' + lead.join(SEP) + '</span><span class="stat-sep">' + SEP +
    '</span><span class="stat-half">' + tail.join(SEP) + '</span>';
  el.title = (hdl
    ? 'Clock cycles counted by your Verilog simulation, and instructions retired'
    : piped
    ? 'Clock cycles of the 5-stage pipeline, instructions retired, and cycles per instruction'
    : multi
    ? 'Cycles from the per-category table in Settings > Simulation, instructions executed, ' +
      'and cycles per instruction'
    : 'One cycle per instruction, and instructions executed') +
    '. The time is those cycles at ' + fmtHz(cpuHz()) + ' (CLK_DIV_BITS ' + clock.divBits + ', in Settings)' +
    '. PC is ' + (piped ? 'PCF, the address being fetched.' : 'the address of the instruction about to execute.');
};

const hdlBaseToolbarStates = updateToolbarButtonStates;
updateToolbarButtonStates = function () {
  hdlBaseToolbarStates();
  // Applies in both modes: switching engines mid-run would let the two
  // of them execute at the same time.
  ['engBtnJs', 'engBtnHdl'].forEach(id => {
    const b = document.getElementById(id);
    if (!b) return;
    b.disabled = hdlActivity.running;
    b.classList.toggle('inactive', hdlActivity.running);
  });
  if (ui.engine !== 'hdl') return;
  const ready = !!(program.assembled && hdlFindWrapper() && !hdlActivity.running);
  const set = (id, on, title) => {
    const b = document.getElementById(id);
    if (!b) return;
    b.disabled = !on;
    b.classList.toggle('inactive', !on);
    if (title) b.title = title;
  };
  const resuming = !!(hdlRec.trace && hdlConfig.traceEnabled);
  set('runPauseBtn', ready || !!hdlActivity.live || !!hdlActivity.chunked, hdlActivity.running && hdlConfig.synthEnabled && !hdlActivity.live && !hdlActivity.chunked
    ? 'A run with post-synthesis simulation on is simulated in one go and cannot be paused; Reset stops it'
    : resuming
    ? 'Continue the hardware run to the next breakpoint, recording another ' +
      hdlConfig.cycleBudget + ' cycles if it reaches the end (Reset to start over)'
    : 'Simulate your Verilog, stopping at the first breakpoint or after ' +
      hdlConfig.cycleBudget + ' cycles');
  const runBtn = document.getElementById('runPauseBtn');
  if (runBtn) {
    runBtn.innerHTML = (hdlActivity.play || hdlActivity.live || hdlActivity.chunked) ? '\u23F8 Pause' : (resuming && hdlRec.idx > 0) ? '\u25B6 Resume' : '\u25B6 Run HDL';
    runBtn.style.opacity = (ready || hdlActivity.live || hdlActivity.chunked) ? '1' : '0.45';
    runBtn.style.cursor = (ready || hdlActivity.live || hdlActivity.chunked) ? 'pointer' : 'not-allowed';
  }
  set('btnStep', ready && hdlConfig.traceEnabled,
    hdlConfig.traceEnabled ? 'Advance one instruction through the recorded hardware trace'
                    : 'Stepping needs the Trace option under Settings > Simulation');
  set('btnBack', ready && hdlConfig.traceEnabled && !!hdlRec.trace && hdlRec.idx > 0,
    'Step back - possible because the run is a recording, not a live simulation');
  if (hdlActivity.running) set('btnReset', true, 'Stop this simulation and discard the recording');
  updateFloatSteps();
};

// Changing an input while a trace is live re-simulates from the current
// point rather than silently doing nothing until the next run.
const hdlBaseToggleDip = toggleDip;
toggleDip = function (idx) {
  hdlBaseToggleDip(idx);
  hdlOnInputChanged(HDL_STIM_DIP, board.dip & 0xFFFF);
};

const hdlBasePbToggle = pbToggle;
pbToggle = function (btn) {
  hdlBasePbToggle(btn);
  hdlOnInputChanged(HDL_STIM_PB, board.buttons & 0x7);
};

const hdlBaseUpdateAccelValues = updateAccelValues;
updateAccelValues = function () {
  hdlBaseUpdateAccelValues();
  hdlOnInputChanged(HDL_STIM_ACCEL, hdlAccelWord());
};

// The preset buttons move the accelerometer just as the sliders do, so
// they have to raise the same stimulus.
const hdlBaseSetAccelPreset = setAccelPreset;
setAccelPreset = function (preset) {
  hdlBaseSetAccelPreset(preset);
  hdlOnInputChanged(HDL_STIM_ACCEL, hdlAccelWord());
};

// An MMIO input register (DIP, buttons, the accelerometer word) is read
// straight out of live peripheral state, so the memory view is stale the
// moment an input moves. Refresh it here rather than in each handler, so
// no future input path can be forgotten. Skipped while the functional
// engine is running, where it would cost a re-render per batch.
let hdlInPeriphRefresh = false;
const hdlBaseUpdatePeripherals = updatePeripherals;
updatePeripherals = function () {
  hdlBaseUpdatePeripherals();
  if (hdlInPeriphRefresh || run.running) return;
  const addrEl = document.getElementById('memAddr');
  if (!addrEl) return;
  const base = parseInt(addrEl.value, 16);
  if (!(base >= 0xFFF00000)) return;
  hdlInPeriphRefresh = true;
  try { updateMemoryView(); } finally { hdlInPeriphRefresh = false; }
};

// Bytes typed into the console are stamped with the cycle they will
// actually arrive at and appended to the timeline the testbench reads.
// The JS engine's per-instruction delivery cannot run here - nothing
// steps its counter - so the whole send is placed on the timeline at
// once, one character time apart, and the testbench does the rest.
const hdlBaseSendUartInput = sendUartInput;
sendUartInput = function () {
  if (ui.engine !== 'hdl' || !hdlRec.trace) { hdlBaseSendUartInput(); return; }
  const before = uart.pending.length;
  hdlBaseSendUartInput();
  // Take everything the base handler queued, plus anything it managed to
  // hand straight to the holding register, and put it on the timeline.
  const added = uart.pending.slice();
  if (uart.rxFull && uart.pending.length >= before) added.unshift(uart.rxByte & 0xFF);
  uart.pending = [];
  uart.rxFull = false;
  const btn = document.getElementById('uartSendBtn');
  if (btn) { btn.innerText = 'Send'; btn.style.background = ''; }
  if (!added.length) { hdlOnUartInput(); return; }
  const gap = uartGapInstr();
  if (hdlActivity.live) {
    for (const b of added) hdlLiveSend('in 5 ' + (((b & 0xFF) | (gap << 8)) >>> 0));
    return;
  }
  const at = hdlCurrentCycle();
  added.forEach((b, i) => hdlRec.rx.push({ cycle: at + i * gap, byte: b & 0xFF }));
  const st = document.getElementById('uartAutoSendStatus');
  if (st) st.innerText = added.length > 1
    ? 'Queued ' + added.length + ' bytes, ' + gap + ' cycles apart' : '';
  hdlOnUartInput(added.length);
};

// Re-assembling produces a different program, so the recording made
// against the old one no longer describes anything.
const hdlBaseAssembleOnly = assembleOnly;
assembleOnly = function () {
  hdlDiscardTrace();
  return hdlBaseAssembleOnly();
};

window.dpNext = dpNext;
window.dpPrev = dpPrev;
window.dpPlay = dpPlay;
window.dpSetSpeed = dpSetSpeed;
window.toggleDpDock = toggleDpDock;
window.toggleVisualisation = toggleVisualisation;
window.floatStep = floatStep;
window.openBpFigure = openBpFigure;
window.closeBpFigure = closeBpFigure;
window.toggleDpMax = toggleDpMax;
window.dpToggleView = dpToggleView;
window.dpSetView = dpSetView;
window.openPipeSettings = openPipeSettings;
window.pipeSetMode = pipeSetMode;
window.hdlRemoveFile = hdlRemoveFile;
window.hdlClearFiles = hdlClearFiles;
window.runHdlSimulation = runHdlSimulation;
window.hdlDownloadVcd = hdlDownloadVcd;
window.handleDownloadPick = handleDownloadPick;
window.refreshDownloadMenu = refreshDownloadMenu;
window.parseVcd = parseVcd;
window.toggleWaveDock = toggleWaveDock;
window.updateWaveView = updateWaveView;
window.updateWaveAvailability = updateWaveAvailability;
window.drawWaveforms = drawWaveforms;
window.waveEnableVcdAndRerun = waveEnableVcdAndRerun;
window.toggleWavePicker = toggleWavePicker;
window.waveAddSignal = waveAddSignal;
window.waveRemoveSignal = waveRemoveSignal;
window.waveToggleSignal = waveToggleSignal;
window.waveResetSignals = waveResetSignals;
window.waveZoom = waveZoom;
window.wavePan = wavePan;
window.waveFit = waveFit;
window.waveSetSpan = waveSetSpan;
window.waveSeekToCycle = waveSeekToCycle;
window.waveGotoCycle = waveGotoCycle;
window.waveCycleAtX = waveCycleAtX;
window.waveTicksPerCycle = waveTicksPerCycle;
window.waveValueAt = waveValueAt;
window.waveFormatValue = waveFormatValue;
window.getHdlLastVcd = () => hdlVcdText(hdlBuild.lastVcd);
window.getWaveState = () => ({
  parsed: waveParsed,
  signals: waveSignals.slice(),
  start: waveStart,
  span: waveSpan,
  ticksPerCycle: waveParsed ? waveTicksPerCycle(waveParsed) : null
});
window.hdlDownloadTestbench = hdlDownloadTestbench;
window.setHdlCycles = setHdlCycles;
window.setHdlDumpVcd = setHdlDumpVcd;
window.setHdlWaveTop = setHdlWaveTop;
window.setHdlTrace = setHdlTrace;
window.setHdlCompare = setHdlCompare;
window.setHdlSynth = setHdlSynth;
window.hdlModeLabel = hdlModeLabel;
window.invalidateCompiledProgram = invalidateCompiledProgram;
window.hdlSynthesise = hdlSynthesise;
window.hdlAddParamShim = hdlAddParamShim;
window.hdlObservable = hdlObservable;
window.hdlFirstDifference = hdlFirstDifference;
window.hdlCoreFiles = hdlCoreFiles;
window.setHdlRegPath = setHdlRegPath;
window.setSimEngineMode = setSimEngineMode;
window.getHdlFiles = () => hdlSources.files;
window.setDipSwitches = (v) => {
  board.dip = v & 0xFFFF;
  if (typeof updatePeripherals === 'function') updatePeripherals();
  hdlOnInputChanged(HDL_STIM_DIP, board.dip & 0xFFFF);
};
window.getLedState = () => board.leds;
window.getSevsegState = () => board.sevseg;
window.getSimEngineMode = () => ui.engine;
window.hdlBuildTestbench = hdlBuildTestbench;
window.hdlHasDoubleBuffer = hdlHasDoubleBuffer;
window.hdlMemFiles = hdlMemFiles;
window.hdlRequiredDepths = hdlRequiredDepths;
window.hdlSyncReferenceWrapperDepths = hdlSyncReferenceWrapperDepths;
window.hdlParseTrace = hdlParseTrace;
window.hdlDiscoverRegBank = hdlDiscoverRegBank;
window.hdlStimFile = hdlStimFile;
window.hdlRxFile = hdlRxFile;
window.getHdlTrace = () => hdlRec.trace;
window.getHdlIndex = () => hdlRec.idx;
window.hdlSeek = hdlSeek;
window.hdlSynthLint = hdlSynthLint;
window.hdlLintFile = hdlLintFile;
window.hdlBreakAt = hdlBreakAt;
window.hdlResumeRun = hdlResumeRun;
window.hdlStatementTarget = hdlStatementTarget;
window.hdlStatementBackTarget = hdlStatementBackTarget;
window.refreshSimSettingsScope = refreshSimSettingsScope;
window.hdlStepOnce = hdlStepOnce;
window.hdlStepBack = hdlStepBack;
// Install a recording captured elsewhere (used by the tests, which run
// the engine from Node) so seeking can be exercised without a browser.
window.hdlLoadTrace = (stdout, budget) => {
  hdlRec.trace = hdlParseTrace(stdout);
  hdlRec.trace.budget = budget || hdlConfig.cycleBudget;
  hdlRec.trace.regBank = hdlRegBankPath();
  hdlRec.idx = 0;
  return hdlRec.trace;
};
window.hdlCompareWithJs = hdlCompareWithJs;
window.hdlPlayTo = hdlPlayTo;
window.hdlStopPlay = hdlStopPlay;
window.hdlLooksPipelined = hdlLooksPipelined;
window.hdlSetBase = (b) => { hdlRec.base = Object.assign({}, hdlRec.base, b); };
window.hdlSetStim = (list) => { hdlRec.stim = list.slice(); };
window.hdlSetRx = (list) => { hdlRec.rx = list.slice(); };
window.uartTickDelivery = uartTickDelivery;
window.setUartSendMode = setUartSendMode;
window.setUartCharInstr = setUartCharInstr;
window.setClkDivBits = setClkDivBits;
window.setRunPace = setRunPace;
window.getUartPending = () => uart.pending.slice();
window.getUartRxState = () => ({ byte: uart.rxByte, full: uart.rxFull, dropped: uart.rxDroppedTotal });
window.hdlLoadPrebuiltProcessor = hdlLoadPrebuiltProcessor;
// Load sources programmatically (the drop zone and file picker route
// through hdlAddFiles; this is the same thing without a FileList).
window.hdlSetSources = (list) => {
  hdlSources.files = list.map(f => ({ name: f.name, src: f.src }));
  renderHdlFileList();
};
