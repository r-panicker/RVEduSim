// The entry point of the page's modules. The rest of the page is classic
// scripts sharing one global scope (see tools/page.js); they, the markup's
// inline handlers and the tests reach the modules' exports through window,
// which this puts them on before the classic scripts run.

import * as operands from './asm/operands';
import * as instructions from './isa/instructions';
import * as clockMath from './machine/clock';
import * as fpregs from './machine/fpregs';
import * as memoryMap from './machine/memory-map';
import * as mmio from './machine/mmio';
import * as state from './machine/state';
import * as clockControls from './ui/clock-controls';

Object.assign(window, instructions, operands, state, memoryMap, fpregs, mmio, clockMath, clockControls);
