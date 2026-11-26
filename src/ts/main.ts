// The entry point of the page's modules. The rest of the page is classic
// scripts sharing one global scope (see tools/page.js); they, the markup's
// inline handlers and the tests reach the modules' exports through window,
// which this puts them on before the classic scripts run.

import * as assembler from './asm/assembler';
import * as operands from './asm/operands';
import * as hdlState from './hdl/state';
import * as hdlTestbench from './hdl/testbench';
import * as hdlVerilog from './hdl/verilog';
import * as instructions from './isa/instructions';
import * as clockMath from './machine/clock';
import * as control from './machine/control';
import * as execute from './machine/execute';
import * as fpregs from './machine/fpregs';
import * as host from './machine/host';
import * as memory from './machine/memory';
import * as memoryMap from './machine/memory-map';
import * as mmio from './machine/mmio';
import * as oled from './machine/oled';
import * as peripherals from './machine/peripherals';
import * as pipelineModel from './machine/pipeline';
import * as reset from './machine/reset';
import * as state from './machine/state';
import * as uart from './machine/uart';
import * as clockControls from './ui/clock-controls';
import * as uartControls from './ui/uart-controls';

Object.assign(window, instructions, operands, assembler, state, memoryMap, fpregs, mmio, clockMath, host,
  memory, reset, oled, uart, peripherals, execute, control, pipelineModel, hdlState, hdlVerilog, hdlTestbench,
  clockControls, uartControls);
