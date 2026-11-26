// The Clock controls in Settings and in the stats bar: CLK_DIV_BITS, the
// frequency it gives, and Max speed or Real time. Every control marked
// data-clk is kept in step with the clock state.

import { clock, uart } from '../machine/state';
import { cpuHz, fmtHz, uartCharCycles } from '../machine/clock';

declare function setUartSendMode(mode: string): void;
declare function updateStats(): void;

const listeners: Array<() => void> = [];

// Called after the clock or the pacing changes, e.g. to pace a live run.
export function onClockChange(fn: () => void): void { listeners.push(fn); }

function changed(): void {
  syncClockControls();
  updateStats();
  for (const fn of listeners) fn();
}

export function syncClockControls(): void {
  document.querySelectorAll<HTMLInputElement>('[data-clk="div"]').forEach(el => { el.value = String(clock.divBits); });
  document.querySelectorAll<HTMLElement>('[data-clk="hz"]').forEach(el => { el.textContent = fmtHz(cpuHz()); });
  document.querySelectorAll<HTMLSelectElement>('[data-clk="pace"]').forEach(el => { el.value = clock.pace; });
}

export function setClkDivBits(v: number | string): void {
  const n = parseInt(String(v), 10);
  if (Number.isFinite(n)) clock.divBits = Math.max(0, Math.min(26, n));
  uart.charInstr = uartCharCycles();
  setUartSendMode(uart.sendMode);
  changed();
}

export function setRunPace(v: string): void {
  clock.pace = v === 'real' ? 'real' : 'max';
  changed();
}

export function clockInitControls(): void {
  document.querySelectorAll<HTMLInputElement>('[data-clk="div"]').forEach(el => { el.onchange = () => setClkDivBits(el.value); });
  document.querySelectorAll<HTMLSelectElement>('[data-clk="pace"]').forEach(el => { el.onchange = () => setRunPace(el.value); });
  syncClockControls();
}
