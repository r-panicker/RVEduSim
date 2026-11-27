// HDL mode's part in shared UI actions, which the shared functions call:
// the Registers panel's unknown values, the stats bar, the toolbar, the
// Memory view's MMIO rows and the console's Send. Also the window exports
// that the page's handlers and the tests call.

import { hdlVcdText } from './checkpoints';
import { hdlPlayTo, hdlResumeRun, hdlStatementBackTarget, hdlStatementTarget, hdlStepBack, hdlStepOnce, hdlStopPlay, runHdlSimulation } from './chunked';
import { hdlCompareWithJs, hdlLooksPipelined } from './compare';
import { HDL_STIM_DIP, hdlRxFile, hdlStimFile } from './compile';
import { hdlOnInputChanged, hdlOnUartInput } from './inputs';
import { hdlLintFile, hdlSynthLint } from './lint';
import { hdlLiveSend } from './live';
import { hdlDiscoverRegBank, hdlMemFiles, hdlRegBankPath, hdlRequiredDepths, hdlSyncReferenceWrapperDepths } from './memory-images';
import { hdlBreakAt } from './run';
import { hdlCurrentCycle, hdlSeek } from './seek';
import { hdlClearFiles, hdlLoadPrebuiltProcessor, hdlRemoveFile, hdlSourcesChanged } from './sources';
import { hdlActivity, hdlBuild, hdlConfig, hdlRec, hdlSources, TimedByte, TimedInput } from './state';
import { hdlAddParamShim, hdlCoreFiles, hdlFirstDifference, hdlModeLabel, hdlObservable, hdlSynthesise } from './synthesis';
import { hdlBuildTestbench, hdlHasDoubleBuffer } from './testbench';
import { hdlParseTrace } from './trace';
import { hdlWrappers } from './verilog';
import { cpuHz, fmtHz, fmtSimTime } from '../machine/clock';
import { pipeline } from '../machine/pipeline';
import { board, clock, cpu, program, run, uart, ui } from '../machine/state';
import { setUartCharInstr, setUartSendMode, uartGapInstr, uartTickDelivery } from '../machine/uart';
import { setClkDivBits, setRunPace } from '../ui/clock-controls';
import { dpNext, dpPlay, dpPrev, dpSetSpeed, dpSetView, dpToggleView, floatStep, toggleDpDock, toggleDpMax, toggleVisualisation, updateFloatSteps } from '../ui/datapath';
import { setSimEngineMode } from '../ui/engine-mode';
import { invalidateCompiledProgram } from '../ui/examples-language';
import { closeBpFigure, formatPC, handleDownloadPick, openBpFigure, refreshDownloadMenu, refreshSimSettingsScope } from '../ui/execution';
import { updateMemoryView } from '../ui/memory-register-views';
import { queueUartInput, setUartStatusNote, updatePeripherals } from '../ui/peripherals';
import { openPipeSettings, pipeSetMode } from '../ui/pipeline-controls';
import { drawWaveforms, hdlDownloadTestbench, hdlDownloadVcd, parseVcd, setHdlCompare, setHdlCycles, setHdlDumpVcd, setHdlRegPath, setHdlSynth, setHdlTrace, setHdlWaveTop, toggleWaveDock, toggleWavePicker, updateWaveAvailability, updateWaveView, waveAddSignal, waveCycleAtX, waveEnableVcdAndRerun, waveFit, waveFormatValue, waveGotoCycle, wavePan, waveParsed, waveRemoveSignal, waveResetSignals, waveSeekToCycle, waveSetSpan, waveSignals, waveSpan, waveStart, waveTicksPerCycle, waveToggleSignal, waveValueAt, waveZoom } from '../ui/waveform';
import { byId } from '../ui/dom';
import { redrawToolbar, toolbar, type StatSeg } from '../ui/toolbar-state';

// "Cycles" depends on the model: one per instruction single-cycle, the
// table's count multi-cycle, clock edges pipelined and in HDL mode.
export function hdlUpdateStatsBar() {
  const hdl = ui.engine === 'hdl';
  const piped = !hdl && pipeline.on;
  const multi = !hdl && pipeline.arch === 'multi';
  const pacing = clock.pace === 'real' && (hdl ? !!(hdlActivity.play || hdlActivity.live || hdlActivity.chunked) : run.running);
  const text = (s: string): StatSeg => ({ k: 'text', s });
  const lead: StatSeg[][] = [
    [text(fmtSimTime(cpu.totalCycles)), ...(pacing && clock.rtRatio < 0.95
      ? [text(' '), { k: 'lag', s: '×' + clock.rtRatio.toFixed(2) + ' real time' } as StatSeg] : [])],
    [text('Cycles: ' + cpu.totalCycles + ' '), { k: 'tag', s: hdl ? 'hw' : piped ? 'pipe' : multi ? 'multi' : 'single' }],
  ];
  const tail: StatSeg[][] = [[text('Instr: ' + cpu.instructionCount)]];
  if ((piped || multi) && cpu.instructionCount) tail.push([text('CPI: ' + (cpu.totalCycles / cpu.instructionCount).toFixed(2))]);
  if (piped && pipeline.predictor.on && pipeline.regs) tail.push([text('Mispredicts: ' + pipeline.regs.mispredicts)]);
  tail.push([text('PC: '), { k: 'pc', s: formatPC() }]);
  // Two halves of about equal width, which a phone stacks rather than
  // squeeze the status message beside them.
  if (tail.length > 2) lead.push(tail.shift()!);
  const title = (hdl
    ? 'Clock cycles counted by your Verilog simulation, and instructions retired'
    : piped
    ? 'Clock cycles of the 5-stage pipeline, instructions retired, and cycles per instruction'
    : multi
    ? 'Cycles from the per-category table in Settings > Simulation, instructions executed, ' +
      'and cycles per instruction'
    : 'One cycle per instruction, and instructions executed') +
    '. The time is those cycles at ' + fmtHz(cpuHz()) + ' (CLK_DIV_BITS ' + clock.divBits + ', in Settings)' +
    '. PC is ' + (piped ? 'PCF, the address being fetched.' : 'the address of the instruction about to execute.');
  toolbar.stats = { lead, tail, title };
  redrawToolbar();
}

export function hdlUpdateToolbar() {
  // Applies in both modes: switching engines mid-run would let the two
  // of them execute at the same time.
  toolbar.engLocked = hdlActivity.running;
  if (ui.engine !== 'hdl') { redrawToolbar(); return; }
  const ready = !!(program.assembled && hdlWrappers().length === 1 && !hdlActivity.running);
  const resuming = !!(hdlRec.trace && hdlConfig.traceEnabled);
  const runOn = ready || !!hdlActivity.live || !!hdlActivity.chunked;
  toolbar.run = {
    on: runOn, dim: !runOn,
    label: (hdlActivity.play || hdlActivity.live || hdlActivity.chunked) ? 'Pause' : (resuming && hdlRec.idx > 0) ? 'Resume' : 'Run HDL',
    title: hdlActivity.running && hdlConfig.synthEnabled && !hdlActivity.live && !hdlActivity.chunked
      ? 'A run with post-synthesis simulation on is simulated in one go and cannot be paused; Reset stops it'
      : resuming
      ? 'Continue the hardware run to the next breakpoint, recording another ' +
        hdlConfig.cycleBudget + ' cycles if it reaches the end (Reset to start over)'
      : 'Simulate your Verilog, stopping at the first breakpoint or after ' +
        hdlConfig.cycleBudget + ' cycles',
  };
  toolbar.step = { on: ready && hdlConfig.traceEnabled,
    title: hdlConfig.traceEnabled ? 'Advance one instruction through the recorded hardware trace'
                                  : 'Stepping needs the Trace option under Settings > Simulation' };
  toolbar.back = { on: ready && hdlConfig.traceEnabled && !!hdlRec.trace && hdlRec.idx > 0,
    title: 'Step back - possible because the run is a recording, not a live simulation' };
  if (hdlActivity.running) toolbar.reset = { on: true, title: 'Stop this simulation and discard the recording' };
  redrawToolbar();
  updateFloatSteps();
}

// An MMIO input register (DIP, buttons, the accelerometer word) is read
// straight out of live peripheral state, so the memory view is stale the
// moment an input moves. Refresh it here rather than in each handler, so
// no future input path can be forgotten. Skipped while the functional
// engine is running, where it would cost a re-render per batch.
export let hdlInPeriphRefresh = false;
export function hdlRefreshMmioView() {
  if (hdlInPeriphRefresh || run.running) return;
  const addrEl = byId<HTMLInputElement>('memAddr');
  if (!addrEl) return;
  const base = parseInt(addrEl.value, 16);
  if (!(base >= 0xFFF00000)) return;
  hdlInPeriphRefresh = true;
  try { updateMemoryView(); } finally { hdlInPeriphRefresh = false; }
}

// Bytes typed into the console are stamped with the cycle they will
// actually arrive at and appended to the timeline the testbench reads.
// The JS engine's per-instruction delivery cannot run here - nothing
// steps its counter - so the whole send is placed on the timeline at
// once, one character time apart, and the testbench does the rest.
export function hdlSendUartInput() {
  const before = uart.pending.length;
  queueUartInput();
  // Take everything the base handler queued, plus anything it managed to
  // hand straight to the holding register, and put it on the timeline.
  const added = uart.pending.slice();
  if (uart.rxFull && uart.pending.length >= before) added.unshift(uart.rxByte & 0xFF);
  uart.pending = [];
  uart.rxFull = false;
  if (!added.length) { hdlOnUartInput(); return; }
  const gap = uartGapInstr();
  if (hdlActivity.live) {
    for (const b of added) hdlLiveSend('in 5 ' + (((b & 0xFF) | (gap << 8)) >>> 0));
    return;
  }
  const at = hdlCurrentCycle();
  added.forEach((b, i) => hdlRec.rx.push({ cycle: at + i * gap, byte: b & 0xFF }));
  setUartStatusNote(added.length > 1 ? 'Queued ' + added.length + ' bytes, ' + gap + ' cycles apart' : '');
  hdlOnUartInput(added.length);
}

// Hooks for the test suites, which drive the page from Node: read the
// machine and the recording, install a recording captured elsewhere so
// seeking can be exercised without a browser, and load sources without a
// FileList (the drop zone and file picker go through hdlAddFiles).
// Run once the page has loaded every module (main.ts), in page order.
export function onSharedUiLoad() {
  Object.assign(window, {
    getHdlLastVcd: () => hdlVcdText(hdlBuild.lastVcd),
    getWaveState: () => ({
    parsed: waveParsed,
    signals: waveSignals.slice(),
    start: waveStart,
    span: waveSpan,
    ticksPerCycle: waveParsed ? waveTicksPerCycle(waveParsed) : null
    }),
    getHdlFiles: () => hdlSources.files,
    setDipSwitches: (v: number) => {
      board.dip = v & 0xFFFF;
      if (typeof updatePeripherals === 'function') updatePeripherals();
      hdlOnInputChanged(HDL_STIM_DIP, board.dip & 0xFFFF);
    },
    getLedState: () => board.leds,
    getSevsegState: () => board.sevseg,
    getSimEngineMode: () => ui.engine,
    getHdlTrace: () => hdlRec.trace,
    getHdlIndex: () => hdlRec.idx,
    hdlLoadTrace: (stdout: string, budget: number) => {
      hdlRec.trace = hdlParseTrace(stdout);
      hdlRec.trace.budget = budget || hdlConfig.cycleBudget;
      hdlRec.trace.regBank = hdlRegBankPath();
      hdlRec.idx = 0;
      return hdlRec.trace;
    },
    hdlSetBase: (b: Partial<typeof hdlRec.base>) => { hdlRec.base = Object.assign({}, hdlRec.base, b); },
    hdlSetStim: (list: TimedInput[]) => { hdlRec.stim = list.slice(); },
    hdlSetRx: (list: TimedByte[]) => { hdlRec.rx = list.slice(); },
    getUartPending: () => uart.pending.slice(),
    getUartRxState: () => ({ byte: uart.rxByte, full: uart.rxFull, dropped: uart.rxDroppedTotal }),
    hdlSetSources: (list: { name: string; src: string }[]) => {
      hdlSources.files = list.map(f => ({ name: f.name, src: f.src }));
      hdlSourcesChanged();
    },
  });
}
