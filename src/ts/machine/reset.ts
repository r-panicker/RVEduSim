// Resetting the machine and loading an assembled program into memory.

import { fpBits } from './fpregs';
import { host } from './host';
import { setMemByte } from './memory';
import { oledResetPages } from './oled';
import { cpu, layout, memory, oled, program, run, stepHistory, type MachineLine } from './state';

export function initializeState() {
  cpu.regs = new Int32Array(32);
  fpBits.fill(0);
  cpu.reservation = null;
  memory.pages = new Map();
  cpu.pc = layout.baseAddress;
  cpu.lastChangedReg = -1;
  cpu.lastChangedMem = [];
  cpu.totalCycles = 0;
  cpu.instructionCount = 0;
  host.resetPipeline();
  run.currentLine = -1;
  memory.heapPointer = (typeof layout.dataBase !== 'undefined' ? layout.dataBase : 0x20000) + 0x4000;
  // Note: In RISC-V hardware, integer registers (including sp / x2) are initialized to 0 on reset
  oled.col = 0;
  oled.row = 0;
  oled.ctrl = 0;
  oled.data = 0;
  oled.advCol = false;
  oled.advRow = false;
  oledResetPages();
  host.oledChanged();
}


export function buildPcToLineMap(mc: MachineLine[]) {
  program.pcToLine = new Map();
  if (Array.isArray(mc)) {
    for (let k = 0; k < mc.length; k++) {
      const item = mc[k];
      if (!item.error && item.bytes && typeof item.address === 'number' && typeof item.line === 'number') {
        program.pcToLine.set(item.address, item.line);
      }
    }
  }
}

export function loadProgram(mc: MachineLine[]) {
  initializeState();
  stepHistory.entries = [];
  stepHistory.writeLog = [];
  stepHistory.pixelLog = [];
  buildPcToLineMap(mc);
  for (let k = 0; k < mc.length; k++) {
    const item = mc[k];
    if (item.bytes && !item.error) {
      const addr = item.address;
      for (let i = 0; i < item.bytes.length; i++) {
        setMemByte(addr + i, item.bytes[i]);
      }
    }
  }
  if (program.labels['_start'] !== undefined) {
    cpu.pc = program.labels['_start'];
  } else if (program.labels['main'] !== undefined) {
    cpu.pc = program.labels['main'];
  } else {
    cpu.pc = layout.baseAddress;
  }
}
