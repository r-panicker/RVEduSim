// What the machine needs from the page around it: somewhere to write
// messages, and to be told when what the panels show has changed. The page
// installs these when it boots (setMachineHost); until then they do
// nothing, so the machine also runs with no page at all.

import type { MmioRegister } from './mmio';

export interface MachineHost {
  // A line for the console: syscall output and notices about the program.
  log(text: string, level: 'info' | 'warn' | 'warning' | 'error'): void;
  // A peripheral's state changed (LEDs, 7-segment, switches, UART counters).
  peripheralsChanged(): void;
  // The OLED's front page changed.
  oledChanged(): void;
  // The program sent a byte on the UART.
  uartOutput(): void;
  // The UART's send mode or character gap was set.
  uartSettingsChanged(): void;
  // The program touched a memory-mapped register, so its panel can unfold.
  peripheralUsed(reg: MmioRegister): void;
  // The machine was reset; the pipeline model starts empty.
  resetPipeline(): void;
  // A pipeline clock cycle ended: the UART delivers what has fallen due.
  clockTicked(): void;
  // The source line an address belongs to, or -1 (assembly or C, by the editor's mode).
  sourceLine(pc: number): number;
  // Input for a read syscall (read_int, read_string, ...); null if cancelled.
  readInput(message: string): string | null;
}

export const host: MachineHost = {
  log() {},
  peripheralsChanged() {},
  oledChanged() {},
  uartOutput() {},
  uartSettingsChanged() {},
  peripheralUsed() {},
  resetPipeline() {},
  clockTicked() {},
  sourceLine() { return -1; },
  readInput() { return null; },
};

export function setMachineHost(h: Partial<MachineHost>): void {
  Object.assign(host, h);
}
