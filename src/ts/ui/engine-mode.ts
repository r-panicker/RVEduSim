// @ts-nocheck
// Switching between the functional and HDL engines, the console's
// resizable height, and Verilog dropped anywhere on the page.

import { hdlLog, loadHdlEngine } from '../hdl/engine';
import { hdlSeek } from '../hdl/seek';
import { hdlAddFiles, hdlInitFolder, renderHdlFileList, updateHdlReadiness } from '../hdl/sources';
import { hdlActivity, hdlRec, hdlSources } from '../hdl/state';
import { cpu, program, run, ui } from '../machine/state';
import { log, setStatus } from './editor';
import { openSettingsModal, refreshSimSettingsScope, updateStats } from './execution';
import { updateRegisters } from './panels';
import { updateToolbarButtonStates } from './run-control';
import { hdlInitSimulator, hdlRefreshRegPathHint, hdlSimulatorName, initWaveCanvas, initWavePicker, initWaveResizer, updateWaveAvailability } from './waveform';

export function setSimEngineMode(mode) {
  const want = (mode === 'hdl') ? 'hdl' : 'js';
  if (want === ui.engine) return;

  // An HDL run cannot be paused, so the switch waits rather than landing
  // the result in the wrong engine. The toggle is disabled while this
  // is true.
  if (hdlActivity.running) {
    setStatus('Wait for the HDL simulation to finish before switching engines', 'warn');
    return;
  }
  // The functional engine runs on a timer chain; stop it so it cannot
  // keep executing underneath the HDL view. Its state is kept, so
  // switching back and pressing Resume carries on from here.
  if (run.running) {
    run.running = false;
    if (run.timerId) { clearTimeout(run.timerId); run.timerId = null; }
    log('Paused the functional run - switching to the ' +
        (want === 'hdl' ? 'HDL' : 'JavaScript') + ' engine.', 'info');
  }

  ui.engine = want;
  const jsBtn = document.getElementById('engBtnJs');
  const hdlBtn = document.getElementById('engBtnHdl');
  if (jsBtn) jsBtn.classList.toggle('active', ui.engine === 'js');
  if (hdlBtn) hdlBtn.classList.toggle('active', ui.engine === 'hdl');
  document.body.classList.toggle('hdl-mode', ui.engine === 'hdl');
  if (ui.engine === 'hdl') {
    // Nothing can happen in HDL mode without the sources, so ask for them
    // straight away rather than waiting for Run to fail.
    if (!hdlSources.files.length) {
      openSettingsModal('simulator');
      setStatus('HDL mode needs your Verilog sources - drop them here to begin', 'info');
    }
    // A recording survives a trip through the functional engine, so
    // coming back does not mean re-running the hardware from reset. Land
    // on whichever instruction the other engine reached, so the two hand
    // over at the same point in the program.
    if (hdlRec.trace && hdlRec.trace.steps.length && program.machineCode && program.machineCode.length) {
      hdlSeek(Math.max(0, Math.min(cpu.instructionCount - (hdlRec.trace.offset || 0), hdlRec.trace.steps.length)));
      setStatus('HDL mode - resumed the recording at instruction ' + hdlRec.idx, 'info');
    } else {
      setStatus('HDL mode - Run and Step execute your Verilog through ' + hdlSimulatorName(), 'info');
    }
    loadHdlEngine().catch(e => hdlLog(String(e.message || e), 'err'));
  } else {
    // Leave registers, memory and peripherals exactly as the recording
    // left them: the functional engine carries straight on from here.
    setStatus('Functional mode - Run executes the JavaScript model', 'info');
  }
  updateRegisters();
  updateStats();
  updateHdlReadiness();
  updateWaveAvailability();
  if (typeof refreshSimSettingsScope === 'function') refreshSimSettingsScope();
  if (typeof updateToolbarButtonStates === 'function') updateToolbarButtonStates();
}

// ---- Console height --------------------------------------------------
export const CONSOLE_H_KEY = 'rvsim.consoleHeight.v1';
export const CONSOLE_H_DEFAULT = 140;

export function setConsoleHeight(px, persist) {
  const el = document.getElementById('console');
  if (!el) return;
  const h = Math.max(40, Math.min(px, Math.round((window.innerHeight || 800) * 0.7)));
  el.style.height = h + 'px';
  el.style.maxHeight = h + 'px';
  if (persist) {
    try { localStorage.setItem(CONSOLE_H_KEY, String(h)); } catch (e) { /* no storage */ }
  }
}

export function initConsoleResizer() {
  const bar = document.getElementById('consoleResizer');
  const el = document.getElementById('console');
  if (!bar || !el) return;
  let saved = null;
  try { saved = parseInt(localStorage.getItem(CONSOLE_H_KEY) || '', 10); } catch (e) { saved = null; }
  if (Number.isFinite(saved)) setConsoleHeight(saved, false);

  let startY = 0, startH = 0;
  const move = e => {
    // The console grows upwards, so a drag up is a taller console.
    setConsoleHeight(startH + (startY - e.clientY), false);
  };
  const up = () => {
    bar.classList.remove('dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    setConsoleHeight(el.getBoundingClientRect().height, true);
  };
  bar.addEventListener('pointerdown', e => {
    startY = e.clientY;
    startH = el.getBoundingClientRect().height;
    bar.classList.add('dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  });
  bar.addEventListener('dblclick', () => setConsoleHeight(CONSOLE_H_DEFAULT, true));
}

// Verilog dropped anywhere on the page goes to the HDL source list. The
// sources are the one thing HDL mode cannot do without, so getting them in
// should not depend on finding the right drop target first.
export function initGlobalVerilogDrop() {
  document.addEventListener('dragover', e => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
    }
  });
  document.addEventListener('drop', e => {
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
      .filter(f => /\.(v|sv|vh|svh)$/i.test(f.name));
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    hdlAddFiles(files).then(() => {
      if (ui.engine !== 'hdl') setSimEngineMode('hdl');
      setStatus('Loaded ' + files.length + ' Verilog file(s)', 'success');
    });
  });
}

export function hdlInitSources() {
  const drop = document.getElementById('hdlDropZone');
  const input = document.getElementById('hdlFileInput');
  if (input) input.addEventListener('change', e => {
    hdlAddFiles(e.target.files);
    e.target.value = '';
  });
  hdlInitFolder();
  hdlInitSimulator();
  if (drop) {
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation();
      drop.classList.add('hdl-drop-active');
    }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation();
      drop.classList.remove('hdl-drop-active');
    }));
    drop.addEventListener('drop', e => {
      if (e.dataTransfer && e.dataTransfer.files) hdlAddFiles(e.dataTransfer.files);
    });
  }
  renderHdlFileList();
  hdlRefreshRegPathHint();
  initConsoleResizer();
  initWaveResizer();
  initWavePicker();
  initWaveCanvas();
  updateWaveAvailability();
  initGlobalVerilogDrop();
}
