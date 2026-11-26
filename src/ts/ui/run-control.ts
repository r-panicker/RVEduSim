// Assemble, Step, Back, Run, Pause and Reset for the JS engine, and the
// toolbar buttons' states.

import { assemble } from '../asm/assembler';
import { compileAndAssembleC, countInstructions } from '../c/compile';
import { hdlChunkedStop, hdlStepBack, hdlStepOnce, hdlStopPlay, runHdlSimulation } from '../hdl/chunked';
import { hdlLiveStop } from '../hdl/live';
import { hdlDiscardTrace } from '../hdl/run';
import { hdlUpdateToolbar } from '../hdl/shared-ui';
import { hdlActivity } from '../hdl/state';
import { RT_FOLLOW_HZ, cpuHz } from '../machine/clock';
import { fetchInstruction } from '../machine/execute';
import { fpBits } from '../machine/fpregs';
import { setMemByte } from '../machine/memory';
import { restoreOledPages } from '../machine/oled';
import { capturePeriphState, restorePeriphState } from '../machine/peripherals';
import { pipeDone, pipeEvents, pipeRestore, pipeSnapshot, pipeStatementStep, pipeStep, pipeline, type Signals } from '../machine/pipeline';
import { initializeState, loadProgram } from '../machine/reset';
import { accel, board, clock, cpu, layout, oled, program, run, stepHistory, uart, ui, type MachineLine } from '../machine/state';
import { dpOnStateChange, updateFloatSteps } from './datapath';
import { updateDisassembly, updateMachineCode } from './disassembly';
import { clearLog, editor, editorHistory, log, setStatus } from './editor';
import { editorState } from './editor-state';
import { executeOne, hideExecMarker, highlightCurrentLine, highlightFirstLine, prepareAssembly, refreshDownloadMenu, sourceLineForPc, updateStats } from './execution';
import { updateMemSubTabs, updateMemoryView } from './memory-register-views';
import { updateRegisters } from './panels';
import { clearOledDisplay, resetPeriphFoldState, updateOledCanvas, updatePeripherals } from './peripherals';
import { byId } from './dom';
import { errorMessage } from '../errors';

export function assembleOnly() {
  hdlDiscardTrace();
  clearLog();
  if (editorState.language === 'c') {
    return compileAndAssembleC();
  }
  const mc = prepareAssembly();
  if (!mc) {
    program.assembled = false;
    if (typeof updateToolbarButtonStates === 'function') updateToolbarButtonStates();
    return;
  }
  editorState.lastAssembledCode = editor.value;
  const nInstr = countInstructions(mc);
  log(`Assembly successful. ${nInstr} instructions.`, 'success');
  loadProgram(mc);
  updateMachineCode();
  updateDisassembly();
  updateMemoryView();
  updateMemSubTabs();
  updateStats();
  highlightFirstLine(mc);
  program.assembled = true;
  run.finished = false;
  resetPeriphFoldState();
  if (program.codeOverflowWords > 0) {
    setStatus(`Assembled ${nInstr} instructions — ${program.codeOverflowWords} too many ` +
      `for the Code segment. See the console.`, 'warn');
  } else {
    setStatus(`Assembled ${nInstr} instructions. Ready to run.`, 'success');
  }
  if (typeof updateToolbarButtonStates === 'function') updateToolbarButtonStates();
  return mc;
}

export function stepOnce() {
  if (ui.engine === 'hdl') { hdlStepOnce(); return; }
  if (!program.assembled) {
    setStatus('Please assemble the program first (⚙ Assemble)', 'warn');
    log('Please assemble the program first.', 'warn');
    updateToolbarButtonStates();
    return;
  }
  if (run.running) return;
  if (run.finished) {
    setStatus('Program execution finished. Reset (⟲) or Assemble to step again.', 'info');
    updateToolbarButtonStates();
    return;
  }

  stepHistory.journalEnabled = true;
  stepHistory.writeLog = [];
  stepHistory.pixelLog = [];
  const prePeriph = capturePeriphState();
  const preRegs = Int32Array.from(cpu.regs);
  const preFp = fpBits.slice();
  const preReservation = cpu.reservation;
  const prePc = cpu.pc;
  const cycBefore = cpu.totalCycles;
  const instrBefore = cpu.instructionCount;
  const startSourceLine = sourceLineForPc(cpu.pc);
  let line = startSourceLine;   // of the last instruction executed
  let fault: unknown = null;
  const prePipe = pipeline.on ? pipeSnapshot() : null;
  let pipeSig: Signals | null = null;
  try {
    if (pipeline.on) {
      pipeSig = run.statementStepping ? pipeStatementStep() : pipeStep();
    } else if (run.statementStepping && startSourceLine > 0) {
      let stepsTaken = 0;
      while (!run.finished && stepsTaken < 10000) {
        line = sourceLineForPc(cpu.pc);
        executeOne();
        stepsTaken++;
        const nextLine = sourceLineForPc(cpu.pc);
        if (nextLine !== startSourceLine || run.finished || run.breakpoints.has(nextLine)) {
          break;
        }
      }
    } else {
      executeOne();
    }
  } catch (e) {
    fault = e;
  }
  stepHistory.journalEnabled = false;
  const instructionsExecuted = cpu.instructionCount - instrBefore;
  // Recorded for a step that faulted too: whatever it wrote before it
  // threw is still applied, and Back is how to take it out again.
  stepHistory.entries.push({
    pc: prePc, regs: preRegs, fp: preFp, reservation: preReservation,
    writes: stepHistory.writeLog.slice(), pixels: stepHistory.pixelLog.slice(), periph: prePeriph,
    cycles: cpu.totalCycles - cycBefore, instr: instructionsExecuted, line: line, pipe: prePipe
  });
  if (stepHistory.entries.length > stepHistory.cap) stepHistory.entries.shift();
  if (fault) {
    log(`Error at PC 0x${prePc.toString(16)}: ${errorMessage(fault)}`, 'error');
    updateRegisters(); updateMemoryView(); updateMachineCode(); updateDisassembly(); updateStats();
    updateToolbarButtonStates();
    return;
  }
  // Debugger convention: highlight the instruction that is about to execute (the new PC),
  // not the one that just ran.
  run.currentLine = sourceLineForPc(cpu.pc);
  highlightCurrentLine();
  updateRegisters(); updateMemoryView(); updateMachineCode(); updateDisassembly(); updateStats();
  if (pipeline.on && pipeSig) {
    const ev = pipeEvents(pipeSig);
    if (pipeDone()) {
      run.finished = true;
      run.currentLine = -1;
      highlightCurrentLine();
      log(`Program completed after ${cpu.totalCycles} cycles, ${cpu.instructionCount} instructions.`, 'success');
      setStatus('Program finished', 'success');
    } else if (run.statementStepping && cpu.totalCycles - cycBefore > 1) {
      setStatus(`Statement step over line ${pipeline.stmtLine}: ${cpu.totalCycles - cycBefore} cycles, now at cycle ${cpu.totalCycles}`);
    } else {
      setStatus(`Cycle ${cpu.totalCycles}` + (ev ? ': ' + ev : ''));
    }
    log(run.statementStepping && cpu.totalCycles - cycBefore > 1
      ? `Cycles ${cycBefore + 1}-${cpu.totalCycles}: statement at line ${pipeline.stmtLine} retired (${instructionsExecuted} instructions)`
      : `Cycle ${cpu.totalCycles}` + (ev ? ': ' + ev : ''), 'info');
  } else if (run.statementStepping && instructionsExecuted > 1) {
    setStatus(`Statement step over line ${startSourceLine} — ${instructionsExecuted} instruction` +
      `${instructionsExecuted === 1 ? '' : 's'}, now at line ${run.currentLine > 0 ? run.currentLine : '?'}`);
    log(`Executed statement at line ${startSourceLine} (${instructionsExecuted} instructions, next PC: 0x${cpu.pc.toString(16)}, Line: ${run.currentLine})`, 'info');
  } else {
    setStatus(`Stepped to line ${run.currentLine > 0 ? run.currentLine : '?'}`);
    log(`0x${prePc.toString(16)}: executed (next: 0x${cpu.pc.toString(16)})`, 'info');
  }
  updateToolbarButtonStates();
}

export function stepBack() {
  if (ui.engine === 'hdl') { hdlStepBack(); return; }
  if (run.running) return;
  if (!program.assembled) {
    log('Please assemble the program first before stepping.', 'warn');
    updateToolbarButtonStates();
    return;
  }
  if (stepHistory.entries.length === 0) {
    log('Nothing to step back to.', 'warn');
    updateToolbarButtonStates();
    return;
  }
  const st = stepHistory.entries.pop();
  if (!st) return;
  for (let i = st.writes.length - 1; i >= 0; i--) {
    const w = st.writes[i];
    setMemByte(w.addr, w.old);
  }
  restoreOledPages(st.pixels);
  restorePeriphState(st.periph);
  cpu.regs.set(st.regs);
  fpBits.set(st.fp);
  cpu.reservation = st.reservation;
  cpu.pc = st.pc;
  if (st.pipe) { pipeRestore(st.pipe); run.finished = false; }
  run.currentLine = st.line;
  cpu.totalCycles = Math.max(0, cpu.totalCycles - st.cycles);
  cpu.instructionCount = Math.max(0, cpu.instructionCount - st.instr);
  cpu.lastChangedReg = -1;
  highlightCurrentLine();
  updateRegisters(); updateMemoryView(); updateMachineCode(); updateDisassembly(); updateStats();
  updatePeripherals(); updateOledCanvas();
  if (st.pipe) {
    setStatus(`Back to cycle ${cpu.totalCycles}`);
    log(`Back to cycle ${cpu.totalCycles}`, 'info');
  } else {
    setStatus(`Stepped back to line ${run.currentLine > 0 ? run.currentLine : '?'}`);
    log(`Back to 0x${st.pc.toString(16)}`, 'info');
  }
  updateToolbarButtonStates();
}


export function updateToolbarButtonStates() {
  refreshDownloadMenu();
  const source = editor.value;   // the whole document, so read it once
  const isCodeModifiedOrUnassembled = (editorState.lastAssembledCode === null || source !== editorState.lastAssembledCode || !program.assembled);

  // 1. Assemble button: enabled ONLY when a program is loaded or modified, disabled once assembled
  const assembleBtn = byId<HTMLButtonElement>('btnAssemble');
  if (assembleBtn) {
    const hasCode = source.trim().length > 0;
    const canAssemble = hasCode && isCodeModifiedOrUnassembled;
    assembleBtn.disabled = !canAssemble;
    assembleBtn.classList.toggle('inactive', !canAssemble);
    if (editorState.language === 'c') {
      assembleBtn.innerHTML = '⚙ Compile';
      if (!hasCode) {
        assembleBtn.title = 'No C code in editor';
      } else if (canAssemble) {
        assembleBtn.title = 'Compile with Godbolt Compiler Explorer & load into memory (Ctrl+Enter)';
      } else {
        assembleBtn.title = 'Program is already compiled and up to date';
      }
    } else {
      assembleBtn.innerHTML = '⚙ Assemble';
      if (!hasCode) {
        assembleBtn.title = 'No assembly code in editor';
      } else if (canAssemble) {
        assembleBtn.title = 'Assemble and load program into memory (Ctrl+Enter)';
      } else {
        assembleBtn.title = 'Program is already assembled and up to date';
      }
    }
  }

  // 2. Undo / Redo buttons
  const undoBtn = byId<HTMLButtonElement>('btnUndo');
  const redoBtn = byId<HTMLButtonElement>('btnRedo');
  if (undoBtn) {
    const canUndo = !!(editorHistory && editorHistory.currentIndex > 0);
    undoBtn.disabled = !canUndo;
    undoBtn.classList.toggle('inactive', !canUndo);
    undoBtn.title = canUndo ? 'Undo last edit (Ctrl+Z)' : 'Nothing to undo';
  }
  if (redoBtn) {
    const canRedo = !!(editorHistory && editorHistory.currentIndex < editorHistory.history.length - 1);
    redoBtn.disabled = !canRedo;
    redoBtn.classList.toggle('inactive', !canRedo);
    redoBtn.title = canRedo ? 'Redo last undone edit (Ctrl+Y)' : 'Nothing to redo';
  }

  // 3. Run / Pause button (Standard button styling, not distinct primary color)
  const runBtn = byId<HTMLButtonElement>('runPauseBtn');
  if (runBtn) {
    runBtn.classList.remove('primary');
    runBtn.classList.remove('danger');

    if (run.running) {
      runBtn.innerHTML = '⏸ Pause';
      runBtn.title = 'Pause program execution (F5)';
      runBtn.disabled = false;
      runBtn.classList.remove('inactive');
      runBtn.style.opacity = '1';
      runBtn.style.cursor = 'pointer';
    } else {
      if (!program.assembled) {
        runBtn.innerHTML = '▶ Run';
        runBtn.title = 'Please assemble the program first (⚙ Assemble or Ctrl+Enter) before running';
        runBtn.disabled = true;
        runBtn.classList.add('inactive');
        runBtn.style.opacity = '0.45';
        runBtn.style.cursor = 'not-allowed';
      } else if (run.finished) {
        runBtn.innerHTML = '▶ Run';
        runBtn.title = 'Run program from start (F5)';
        runBtn.disabled = false;
        runBtn.classList.remove('inactive');
        runBtn.style.opacity = '1';
        runBtn.style.cursor = 'pointer';
      } else if (cpu.pc !== layout.baseAddress || cpu.instructionCount > 0) {
        runBtn.innerHTML = '▶ Resume';
        runBtn.title = `Resume execution from line ${run.currentLine > 0 ? run.currentLine : 'current PC'} (F5)`;
        runBtn.disabled = false;
        runBtn.classList.remove('inactive');
        runBtn.style.opacity = '1';
        runBtn.style.cursor = 'pointer';
      } else {
        runBtn.innerHTML = '▶ Run';
        runBtn.title = 'Run assembled program (F5)';
        runBtn.disabled = false;
        runBtn.classList.remove('inactive');
        runBtn.style.opacity = '1';
        runBtn.style.cursor = 'pointer';
      }
    }
  }

  // 4. Step forward button
  const stepBtn = byId<HTMLButtonElement>('btnStep');
  if (stepBtn) {
    const canStep = (program.assembled && !run.running && !run.finished);
    stepBtn.disabled = !canStep;
    stepBtn.classList.toggle('inactive', !canStep);
    if (!program.assembled) {
      stepBtn.title = 'Please assemble the program first (⚙ Assemble or Ctrl+Enter) to step (F8)';
    } else if (run.running) {
      stepBtn.title = 'Cannot step while program is running (pause first)';
    } else if (run.finished) {
      stepBtn.title = 'Program execution finished. Reset (⟲) or Assemble to step again.';
    } else {
      stepBtn.title = 'Single step forward (F8)';
    }
  }

  // 5. Step back button
  const backBtn = byId<HTMLButtonElement>('btnBack');
  if (backBtn) {
    const canBack = (program.assembled && !run.running && stepHistory.entries && stepHistory.entries.length > 0);
    backBtn.disabled = !canBack;
    backBtn.classList.toggle('inactive', !canBack);
    if (!program.assembled) {
      backBtn.title = 'Please assemble the program first before stepping (Shift+F8)';
    } else if (run.running) {
      backBtn.title = 'Cannot step back while program is running';
    } else if (!stepHistory.entries || stepHistory.entries.length === 0) {
      backBtn.title = 'No previous execution history to step back to';
    } else {
      backBtn.title = `Step back 1 instruction (${stepHistory.entries.length} step${stepHistory.entries.length > 1 ? 's' : ''} available) (Shift+F8)`;
    }
  }

  // 6. Reset button: active only after starting to Run or Step, or if state is dirty
  const resetBtn = byId<HTMLButtonElement>('btnReset');
  if (resetBtn) {
    const isDirty = (cpu.instructionCount > 0 || (stepHistory.entries && stepHistory.entries.length > 0) || run.running || run.finished || cpu.pc !== layout.baseAddress || (typeof board.leds !== 'undefined' && board.leds !== 0) || (typeof board.sevseg !== 'undefined' && parseInt(board.sevseg, 16) !== 0) || (typeof uart.txText !== 'undefined' && uart.txText !== '') || (typeof uart.pending !== 'undefined' && (uart.pending.length > 0 || uart.rxFull)));
    resetBtn.disabled = !isDirty;
    resetBtn.classList.toggle('inactive', !isDirty);
    resetBtn.title = isDirty ? 'Reset CPU state, registers, memory, and peripherals to initial conditions' : 'Reset becomes active once execution begins (Run or Step)';
  }

  // 7. Find & Replace action buttons
  const findPrevBtn = byId<HTMLButtonElement>('findPrevBtn');
  const findNextBtn = byId<HTMLButtonElement>('findNextBtn');
  const replaceBtn = byId<HTMLButtonElement>('findReplaceBtn');
  const replaceAllBtn = byId<HTMLButtonElement>('findReplaceAllBtn');
  const hasMatches = (typeof editorState.find.matches !== 'undefined' && editorState.find.matches.length > 0);
  if (findPrevBtn) { findPrevBtn.disabled = !hasMatches; findPrevBtn.classList.toggle('inactive', !hasMatches); }
  if (findNextBtn) { findNextBtn.disabled = !hasMatches; findNextBtn.classList.toggle('inactive', !hasMatches); }
  if (replaceBtn) { replaceBtn.disabled = !hasMatches; replaceBtn.classList.toggle('inactive', !hasMatches); }
  if (replaceAllBtn) { replaceAllBtn.disabled = !hasMatches; replaceAllBtn.classList.toggle('inactive', !hasMatches); }

  // 8. UART Clear button
  const uartClearBtn = byId<HTMLButtonElement>('uartClearBtn');
  if (uartClearBtn) {
    const hasUartText = !!(typeof uart.txText !== 'undefined' && uart.txText.length > 0);
    uartClearBtn.disabled = !hasUartText;
    uartClearBtn.classList.toggle('inactive', !hasUartText);
    uartClearBtn.title = hasUartText ? 'Clear Terminal display output' : 'Terminal output is already empty';
  }

  if (typeof updateFloatSteps === 'function') updateFloatSteps();
  hdlUpdateToolbar();
  dpOnStateChange();
}

export function updateRunButtonState() {
  updateToolbarButtonStates();
}

export function runProgram() {
  if (!program.assembled) {
    clearLog();
    const mc = assembleOnly();
    if (!mc) return;
    run.finished = false;
  } else if (run.finished) {
    resetAll();
    run.finished = false;
    log(`Running program from start (PC 0x${cpu.pc.toString(16)})...`, 'info');
  } else {
    log(`Resuming execution from PC 0x${cpu.pc.toString(16)} (line ${sourceLineForPc(cpu.pc)})...`, 'info');
  }

  run.running = true;
  updateToolbarButtonStates();
  let count = 0;
  const INFINITE_LOOP_CAP = 100000000;
  const maxRunLimit = (typeof run.maxInstructions === 'number' && run.maxInstructions > 0) ? run.maxInstructions : 100000000;
  const BATCH_SIZE = Math.min(10000, maxRunLimit); // per-tick chunk for UI responsiveness
  // Real time: each tick runs the cycles the clock has owed since the run
  // started. More than a quarter second behind, the debt is dropped and
  // the shortfall shows as a fraction of real time.
  let rt: { cyc: number; wall: number; lastWall: number; lastCyc: number } | null = null;
  clock.rtRatio = 1;
  const initialLine = sourceLineForPc(cpu.pc);
  let resumeLine = (initialLine >= 1 && run.breakpoints.has(initialLine)) ? initialLine : -1;

  function finishRun(stopReason: string | null, cycleCount: number) {
    run.running = false;
    if (run.timerId) { clearTimeout(run.timerId); run.timerId = null; }
    program.assembled = true;
    // Where the run stopped, for the highlight. The branches below override
    // it only when there is no instruction to point at.
    run.currentLine = sourceLineForPc(cpu.pc);

    if (cycleCount >= INFINITE_LOOP_CAP) {
      log('Max cycles reached (possible infinite loop).', 'warn');
      setStatus('Stopped (max cycles)', 'warn');
      run.finished = false;
    } else if (cycleCount >= maxRunLimit) {
      run.finished = false;
      log(`Paused after ${maxRunLimit.toLocaleString()} instructions. Click Run to continue.`, 'info');
      setStatus(`Paused after ${maxRunLimit.toLocaleString()} instructions`, 'info');
    } else if (stopReason === 'exit' || stopReason === 'bounds') {
      run.currentLine = -1;
      run.finished = true;
      log(`Program completed after ${cpu.totalCycles} cycles, ${cpu.instructionCount} instructions.`, 'success');
      setStatus('Program finished', 'success');
    } else if (stopReason === 'breakpoint') {
      run.finished = false;
      if (pipeline.on && pipeline.regs.E) setStatus(`Stopped at breakpoint (line ${sourceLineForPc(pipeline.regs.E.pc)}, in Execute)`, 'warn');
      else setStatus(`Stopped at breakpoint (line ${run.currentLine})`, 'warn');
    } else if (stopReason === 'paused') {
      run.finished = false;
      setStatus('Paused', 'info');
    } else {
      run.finished = false;
    }
    updateRegisters();
    updateMemoryView();
    updateStats();
    highlightCurrentLine();
    updateMachineCode();
    updateDisassembly();
    updateToolbarButtonStates();
  }

  function runBatch() {
    if (!run.running) {
      finishRun('paused', count);
      return;
    }

    let batchCount = 0;
    let stopReason: string | null = null;
    const hasBreakpoints = run.breakpoints.size > 0;
    const paced = clock.pace === 'real';
    const tick0 = performance.now(), hz = cpuHz();
    const pace = paced ? (rt ??= { wall: tick0, cyc: cpu.totalCycles, lastWall: tick0, lastCyc: cpu.totalCycles }) : null;
    const due = pace ? pace.cyc + (tick0 - pace.wall) / 1000 * hz : Infinity;

    while (run.running && count < INFINITE_LOOP_CAP && count < maxRunLimit &&
           (paced ? cpu.totalCycles < due && ((batchCount & 1023) || performance.now() - tick0 < 30)
                  : batchCount < BATCH_SIZE)) {
      const execAddr = cpu.pc;

      // Pipelined, a count is a cycle, and a breakpoint stops the run
      // once its instruction has entered Execute: from there on nothing
      // can flush it.
      if (pipeline.on) {
        try {
          pipeStep();
        } catch (e) {
          log(`Error in cycle ${cpu.totalCycles}: ${errorMessage(e)}`, 'error');
          stopReason = 'error';
          run.running = false;
          break;
        }
        count++;
        batchCount++;
        if (!run.running || pipeDone()) { stopReason = 'exit'; break; }
        if (hasBreakpoints && pipeline.regs.E) {
          const line = sourceLineForPc(pipeline.regs.E.pc);
          if (line >= 1 && run.breakpoints.has(line)) {
            log(`Breakpoint hit at line ${line}, now in Execute`, 'warn');
            stopReason = 'breakpoint';
            run.running = false;
            break;
          }
        }
        continue;
      }

      if (hasBreakpoints) {
        const line = sourceLineForPc(execAddr);
        if (line >= 1 && run.breakpoints.has(line)) {
          if (line !== resumeLine) {
            run.currentLine = line;
            log(`Breakpoint hit at line ${line}`, 'warn');
            stopReason = 'breakpoint';
            run.running = false;
            break;
          }
        } else {
          resumeLine = -1;
        }
      }

      try {
        executeOne();
      } catch (e) {
        log(`Error executing at PC 0x${execAddr.toString(16)}: ${errorMessage(e)}`, 'error');
        stopReason = 'error';
        run.running = false;
        break;
      }

      if (hasBreakpoints && cpu.pc !== execAddr + 4) {
        resumeLine = -1;
      }

      count++;
      batchCount++;

      if (!run.running) { stopReason = 'exit'; break; }
      if ((cpu.pc >>> 0) < (layout.baseAddress >>> 0) || (cpu.pc >>> 0) >= (layout.mmioBase >>> 0)) { stopReason = 'bounds'; break; }
      if (sourceLineForPc(cpu.pc) === -1 && fetchInstruction(cpu.pc) === 0) { stopReason = 'exit'; break; }
    }

    updatePeripherals();

    let wait = 0;
    if (pace) {
      const t = performance.now();
      if (cpu.totalCycles < due - hz / 4) { pace.wall = t; pace.cyc = cpu.totalCycles; }
      // Measured over at least 50 cycles: on a slow clock a shorter window
      // can end between two whole cycles and read as lag.
      if (t - pace.lastWall >= Math.max(500, 50000 / hz)) {
        clock.rtRatio = Math.min(1, (cpu.totalCycles - pace.lastCyc) / ((t - pace.lastWall) / 1000 * hz));
        pace.lastWall = t; pace.lastCyc = cpu.totalCycles;
      }
      if (cpu.totalCycles >= due) wait = Math.max(0, Math.min(100, pace.wall + (cpu.totalCycles + 1 - pace.cyc) / hz * 1000 - t));
      updateStats();
      // A clock slow enough to watch: show each instruction as it runs.
      if (hz <= RT_FOLLOW_HZ) { run.currentLine = sourceLineForPc(cpu.pc); highlightCurrentLine(); updateRegisters(); }
    }

    if (run.running && count < INFINITE_LOOP_CAP && count < maxRunLimit && !stopReason) {
      run.timerId = setTimeout(runBatch, wait);
    } else {
      finishRun(stopReason || (count >= maxRunLimit ? 'paused' : null), count);
    }
  }

  runBatch();
}

export function toggleRunPause() {
  // In HDL mode the Run button drives the Verilog engine instead of the
  // JavaScript model. Pause ends a live Verilator run, or a chunked Icarus
  // run after its current chunk, or else playback of the recording.
  if (ui.engine === 'hdl') {
    if (hdlActivity.live) { hdlLiveStop(); return; }
    if (hdlChunkedStop()) return;
    if (hdlStopPlay()) {
      setStatus('HDL playback paused at cycle ' + cpu.totalCycles + ' - Run carries on', 'info');
      return;
    }
    if (!program.assembled) {
      setStatus('Please assemble the program first — the Wrapper loads it via $readmemh', 'warn');
      return;
    }
    runHdlSimulation();
    return;
  }
  if (run.running) {
    run.running = false;
    if (run.timerId) { clearTimeout(run.timerId); run.timerId = null; }
    // Cancelling the pending batch means the run loop never reaches its own
    // exit path, so the highlight is moved to the paused instruction here.
    run.currentLine = sourceLineForPc(cpu.pc);
    setStatus('Paused', 'info');
    log('Execution paused by user.', 'info');
    updateRegisters();
    updateMemoryView();
    updateStats();
    highlightCurrentLine();
    updateMachineCode();
    updateDisassembly();
    updateToolbarButtonStates();
  } else {
    if (!program.assembled) {
      setStatus('Please assemble the program first (⚙ Assemble or Ctrl+Enter)', 'warn');
      log('Please assemble the program first before running.', 'warn');
      updateToolbarButtonStates();
      return;
    }
    runProgram();
  }
}

export function togglePause() {
  toggleRunPause();
}

export function resetAll() {
  if (ui.engine === 'hdl') hdlDiscardTrace();
  run.running = false;
  if (run.timerId) { clearTimeout(run.timerId); run.timerId = null; }

  const wasAssembled = program.assembled && program.machineCode && program.machineCode.length > 0 && (editorState.lastAssembledCode !== null && editor.value === editorState.lastAssembledCode);
  resetState();
  clearLog();
  run.finished = false;
  run.currentLine = -1;

  if (wasAssembled) {
    loadProgram(program.machineCode);
    highlightFirstLine(program.machineCode);
    program.assembled = true;
    setStatus('Reset to start of program. Ready to run or step.');
    log('Simulator reset to start of program. Ready to run or step.', 'info');
  } else {
    program.assembled = false;
    highlightCurrentLine();
    setStatus('Reset');
    let mc: MachineLine[] = [];
    try { if (editor.value.trim()) mc = assemble(editor.value, undefined, { language: editorState.language, report: log }); } catch (e) { }
    highlightFirstLine(mc);
  }
  updateRegisters();
  updateMemoryView();
  updateStats();
  updateMachineCode();
  updateDisassembly();
  updateToolbarButtonStates();
}

export function resetState() {
  run.running = false;
  if (run.timerId) { clearTimeout(run.timerId); run.timerId = null; }
  initializeState();
  stepHistory.entries = [];
  stepHistory.writeLog = [];
  stepHistory.pixelLog = [];
  // Reset all peripheral state
  board.leds = 0;
  ui.clockLedLit = true;
  board.sevseg = '00000000';
  board.dip = 0;
  board.buttons = 0;
  // Reset UART Terminal display & RX queue
  uart.txText = '';
  uart.txBytes = [];
  uart.pending = [];
  uart.rxFull = false;
  uart.rxByte = 0;
  uart.rxDropped = 0;
  uart.rxDroppedTotal = 0;
  const btnEl = byId<HTMLButtonElement>('uartSendBtn');
  if (btnEl) {
    btnEl.innerText = 'Send';
    btnEl.style.background = '';
  }
  const statusEl = byId('uartAutoSendStatus');
  if (statusEl) statusEl.innerText = '';
  oled.col = 0;
  oled.row = 0;
  oled.ctrl = 0;
  oled.advCol = false;
  oled.advRow = false;
  clearOledDisplay();
  accel.x = 0;
  accel.y = 0;
  accel.z = 64;
  accel.temp = 25;
  accel.dready = 1;
  const xS = byId<HTMLInputElement>('accelXSlider');
  const yS = byId<HTMLInputElement>('accelYSlider');
  const zS = byId<HTMLInputElement>('accelZSlider');
  const tS = byId<HTMLInputElement>('accelTempSlider');
  if (xS) xS.value = '0';
  if (yS) yS.value = '0';
  if (zS) zS.value = '64';
  if (tS) tS.value = '25';
  updatePeripherals();
  updateRegisters();
  updateMemoryView();
  updateDisassembly();
  updateStats();
  hideExecMarker();
}
