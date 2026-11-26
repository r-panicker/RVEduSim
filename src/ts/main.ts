// The page's entry point. It loads every module, puts their exports on
// window, where the markup's inline handlers (onclick="runProgram()") and
// the tests reach them by name, and then runs each module's load-time work
// in page order: the editor before the panels that show its program, and
// the boot (ui/datapath.ts) last.

import * as asmAssembler from './asm/assembler';
import * as asmOperands from './asm/operands';
import * as cCompile from './c/compile';
import * as cState from './c/state';
import * as hdlCheckpoints from './hdl/checkpoints';
import * as hdlChunked from './hdl/chunked';
import * as hdlCompare from './hdl/compare';
import * as hdlCompile from './hdl/compile';
import * as hdlEngine from './hdl/engine';
import * as hdlInputs from './hdl/inputs';
import * as hdlLint from './hdl/lint';
import * as hdlLive from './hdl/live';
import * as hdlMemoryImages from './hdl/memory-images';
import * as hdlRun from './hdl/run';
import * as hdlSeek from './hdl/seek';
import * as hdlSharedUi from './hdl/shared-ui';
import * as hdlSources from './hdl/sources';
import * as hdlState from './hdl/state';
import * as hdlSynthesis from './hdl/synthesis';
import * as hdlTestbench from './hdl/testbench';
import * as hdlTrace from './hdl/trace';
import * as hdlVerilog from './hdl/verilog';
import * as isaInstructions from './isa/instructions';
import * as machineClock from './machine/clock';
import * as machineControl from './machine/control';
import * as machineExecute from './machine/execute';
import * as machineFpregs from './machine/fpregs';
import * as machineHost from './machine/host';
import * as machineMemoryMap from './machine/memory-map';
import * as machineMemory from './machine/memory';
import * as machineMmio from './machine/mmio';
import * as machineOled from './machine/oled';
import * as machinePeripherals from './machine/peripherals';
import * as machinePipeline from './machine/pipeline';
import * as machineReset from './machine/reset';
import * as machineState from './machine/state';
import * as machineUart from './machine/uart';
import * as uiClockControls from './ui/clock-controls';
import * as uiCm6Loader from './ui/cm6-loader';
import * as uiDatapath from './ui/datapath';
import * as uiDisassembly from './ui/disassembly';
import * as uiEditorState from './ui/editor-state';
import * as uiEditor from './ui/editor';
import * as uiEngineMode from './ui/engine-mode';
import * as uiExamplesLanguage from './ui/examples-language';
import * as uiExecution from './ui/execution';
import * as uiFileIo from './ui/file-io';
import * as uiFindReplace from './ui/find-replace';
import * as uiLocals from './ui/locals';
import * as uiMachineHost from './ui/machine-host';
import * as uiMemoryRegisterViews from './ui/memory-register-views';
import * as uiPanels from './ui/panels';
import * as uiPeripherals from './ui/peripherals';
import * as uiPipelineControls from './ui/pipeline-controls';
import * as uiRunControl from './ui/run-control';
import * as uiUartControls from './ui/uart-controls';
import * as uiWaveform from './ui/waveform';

const modules: Record<string, unknown>[] = [
  asmAssembler,
  asmOperands,
  cCompile,
  cState,
  hdlCheckpoints,
  hdlChunked,
  hdlCompare,
  hdlCompile,
  hdlEngine,
  hdlInputs,
  hdlLint,
  hdlLive,
  hdlMemoryImages,
  hdlRun,
  hdlSeek,
  hdlSharedUi,
  hdlSources,
  hdlState,
  hdlSynthesis,
  hdlTestbench,
  hdlTrace,
  hdlVerilog,
  isaInstructions,
  machineClock,
  machineControl,
  machineExecute,
  machineFpregs,
  machineHost,
  machineMemoryMap,
  machineMemory,
  machineMmio,
  machineOled,
  machinePeripherals,
  machinePipeline,
  machineReset,
  machineState,
  machineUart,
  uiClockControls,
  uiCm6Loader,
  uiDatapath,
  uiDisassembly,
  uiEditorState,
  uiEditor,
  uiEngineMode,
  uiExamplesLanguage,
  uiExecution,
  uiFileIo,
  uiFindReplace,
  uiLocals,
  uiMachineHost,
  uiMemoryRegisterViews,
  uiPanels,
  uiPeripherals,
  uiPipelineControls,
  uiRunControl,
  uiUartControls,
  uiWaveform,
];

// Getters, not copies, so that window always shows a variable's current
// value.
for (const mod of modules) {
  for (const name of Object.keys(mod)) {
    Object.defineProperty(window, name, { get: () => mod[name], configurable: true, enumerable: true });
  }
}

uiCm6Loader.onCm6LoaderLoad();
uiMachineHost.onMachineHostLoad();
uiEditor.onEditorLoad();
uiDisassembly.onDisassemblyLoad();
uiFileIo.onFileIoLoad();
uiFindReplace.onFindReplaceLoad();
hdlEngine.onEngineLoad();
hdlLive.onLiveLoad();
hdlSharedUi.onSharedUiLoad();
uiDatapath.onDatapathLoad();
