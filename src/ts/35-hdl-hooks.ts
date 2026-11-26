// @ts-nocheck
// HDL mode's hooks into the shared UI, and the window exports that the
// page's handlers and the tests call.

// These wrap the shared functions rather than editing them, so the
// functional engine's own path stays untouched.
const hdlBaseStepOnce = stepOnce;
stepOnce = function () {
  if (simEngineMode === 'hdl') { hdlStepOnce(); return; }
  hdlBaseStepOnce();
};

const hdlBaseStepBack = stepBack;
stepBack = function () {
  if (simEngineMode === 'hdl') { hdlStepBack(); return; }
  hdlBaseStepBack();
};

const hdlBaseResetAll = resetAll;
resetAll = function () {
  if (simEngineMode === 'hdl') hdlDiscardTrace();
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
    const missing = (simEngineMode === 'hdl' && hdlTrace && !hdlTrace.regBank);
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
  if (simEngineMode !== 'hdl' || !hdlTrace || !hdlRegKnown || !regBody) return;
  const rows = regBody.querySelectorAll('tr');
  for (let i = 1; i < 32 && i < rows.length; i++) {
    if (hdlRegKnown[i]) continue;
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
  const hdl = simEngineMode === 'hdl';
  const piped = !hdl && pipeMode;
  const multi = !hdl && jsArch === 'multi';
  const pacing = runPace === 'real' && (hdl ? !!(hdlPlay || hdlLive || hdlChunked) : running);
  const SEP = '&nbsp;|&nbsp; ';
  const lead = [fmtSimTime(totalCycles) +
    (pacing && rtRatio < 0.95 ? ' <span class="stat-lag" title="The browser cannot keep up with this clock">×' +
      rtRatio.toFixed(2) + ' real time</span>' : ''),
    'Cycles: ' + totalCycles +
    ' <span class="stat-tag">' + (hdl ? 'hw' : piped ? 'pipe' : multi ? 'multi' : 'single') + '</span>'];
  const tail = ['Instr: ' + instructionCount];
  if ((piped || multi) && instructionCount) tail.push('CPI: ' + (totalCycles / instructionCount).toFixed(2));
  if (piped && pipeBP.on && pipe) tail.push('Mispredicts: ' + pipe.mispredicts);
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
    '. The time is those cycles at ' + fmtHz(cpuHz()) + ' (CLK_DIV_BITS ' + clkDivBits + ', in Settings)' +
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
    b.disabled = hdlRunning;
    b.classList.toggle('inactive', hdlRunning);
  });
  if (simEngineMode !== 'hdl') return;
  const ready = !!(assembled && hdlFindWrapper() && !hdlRunning);
  const set = (id, on, title) => {
    const b = document.getElementById(id);
    if (!b) return;
    b.disabled = !on;
    b.classList.toggle('inactive', !on);
    if (title) b.title = title;
  };
  const resuming = !!(hdlTrace && hdlTraceEnabled);
  set('runPauseBtn', ready || !!hdlLive || !!hdlChunked, hdlRunning && hdlSynthEnabled && !hdlLive && !hdlChunked
    ? 'A run with post-synthesis simulation on is simulated in one go and cannot be paused; Reset stops it'
    : resuming
    ? 'Continue the hardware run to the next breakpoint, recording another ' +
      hdlCycleBudget + ' cycles if it reaches the end (Reset to start over)'
    : 'Simulate your Verilog, stopping at the first breakpoint or after ' +
      hdlCycleBudget + ' cycles');
  const runBtn = document.getElementById('runPauseBtn');
  if (runBtn) {
    runBtn.innerHTML = (hdlPlay || hdlLive || hdlChunked) ? '\u23F8 Pause' : (resuming && hdlIdx > 0) ? '\u25B6 Resume' : '\u25B6 Run HDL';
    runBtn.style.opacity = (ready || hdlLive || hdlChunked) ? '1' : '0.45';
    runBtn.style.cursor = (ready || hdlLive || hdlChunked) ? 'pointer' : 'not-allowed';
  }
  set('btnStep', ready && hdlTraceEnabled,
    hdlTraceEnabled ? 'Advance one instruction through the recorded hardware trace'
                    : 'Stepping needs the Trace option under Settings > Simulation');
  set('btnBack', ready && hdlTraceEnabled && !!hdlTrace && hdlIdx > 0,
    'Step back - possible because the run is a recording, not a live simulation');
  if (hdlRunning) set('btnReset', true, 'Stop this simulation and discard the recording');
  updateFloatSteps();
};

// Changing an input while a trace is live re-simulates from the current
// point rather than silently doing nothing until the next run.
const hdlBaseToggleDip = toggleDip;
toggleDip = function (idx) {
  hdlBaseToggleDip(idx);
  hdlOnInputChanged(HDL_STIM_DIP, dipSwitches & 0xFFFF);
};

const hdlBasePbToggle = pbToggle;
pbToggle = function (btn) {
  hdlBasePbToggle(btn);
  hdlOnInputChanged(HDL_STIM_PB, pbState & 0x7);
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
  if (hdlInPeriphRefresh || running) return;
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
  if (simEngineMode !== 'hdl' || !hdlTrace) { hdlBaseSendUartInput(); return; }
  const before = uartPending.length;
  hdlBaseSendUartInput();
  // Take everything the base handler queued, plus anything it managed to
  // hand straight to the holding register, and put it on the timeline.
  const added = uartPending.slice();
  if (uartRxFull && uartPending.length >= before) added.unshift(uartRxByte & 0xFF);
  uartPending = [];
  uartRxFull = false;
  const btn = document.getElementById('uartSendBtn');
  if (btn) { btn.innerText = 'Send'; btn.style.background = ''; }
  if (!added.length) { hdlOnUartInput(); return; }
  const gap = uartGapInstr();
  if (hdlLive) {
    for (const b of added) hdlLiveSend('in 5 ' + (((b & 0xFF) | (gap << 8)) >>> 0));
    return;
  }
  const at = hdlCurrentCycle();
  added.forEach((b, i) => hdlRx.push({ cycle: at + i * gap, byte: b & 0xFF }));
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
window.getHdlLastVcd = () => hdlVcdText(hdlLastVcd);
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
window.getHdlFiles = () => hdlFiles;
window.setDipSwitches = (v) => {
  dipSwitches = v & 0xFFFF;
  if (typeof updatePeripherals === 'function') updatePeripherals();
  hdlOnInputChanged(HDL_STIM_DIP, dipSwitches & 0xFFFF);
};
window.getLedState = () => ledState;
window.getSevsegState = () => sevsegState;
window.getSimEngineMode = () => simEngineMode;
window.hdlBuildTestbench = hdlBuildTestbench;
window.hdlHasDoubleBuffer = hdlHasDoubleBuffer;
window.hdlMemFiles = hdlMemFiles;
window.hdlRequiredDepths = hdlRequiredDepths;
window.hdlSyncReferenceWrapperDepths = hdlSyncReferenceWrapperDepths;
window.hdlParseTrace = hdlParseTrace;
window.hdlDiscoverRegBank = hdlDiscoverRegBank;
window.hdlStimFile = hdlStimFile;
window.hdlRxFile = hdlRxFile;
window.getHdlTrace = () => hdlTrace;
window.getHdlIndex = () => hdlIdx;
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
  hdlTrace = hdlParseTrace(stdout);
  hdlTrace.budget = budget || hdlCycleBudget;
  hdlTrace.regBank = hdlRegBankPath();
  hdlIdx = 0;
  return hdlTrace;
};
window.hdlCompareWithJs = hdlCompareWithJs;
window.hdlPlayTo = hdlPlayTo;
window.hdlStopPlay = hdlStopPlay;
window.hdlLooksPipelined = hdlLooksPipelined;
window.hdlSetBase = (b) => { hdlBase = Object.assign({}, hdlBase, b); };
window.hdlSetStim = (list) => { hdlStim = list.slice(); };
window.hdlSetRx = (list) => { hdlRx = list.slice(); };
window.uartTickDelivery = uartTickDelivery;
window.setUartSendMode = setUartSendMode;
window.setUartCharInstr = setUartCharInstr;
window.setClkDivBits = setClkDivBits;
window.setRunPace = setRunPace;
window.getUartPending = () => uartPending.slice();
window.getUartRxState = () => ({ byte: uartRxByte, full: uartRxFull, dropped: uartRxDroppedTotal });
window.hdlLoadPrebuiltProcessor = hdlLoadPrebuiltProcessor;
// Load sources programmatically (the drop zone and file picker route
// through hdlAddFiles; this is the same thing without a FileList).
window.hdlSetSources = (list) => {
  hdlFiles = list.map(f => ({ name: f.name, src: f.src }));
  renderHdlFileList();
};
