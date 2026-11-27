// The Clock setting: CLK_DIV_BITS and Max speed or Real time. Settings
// shows them, and the frequency, from the clock state.

import { clock, uart } from '../machine/state';
import { uartCharCycles } from '../machine/clock';
import { setUartSendMode } from '../machine/uart';
import { redraw } from './views.svelte';

declare function updateStats(): void;

const listeners: Array<() => void> = [];

// Called after the clock or the pacing changes, e.g. to pace a live run.
export function onClockChange(fn: () => void): void { listeners.push(fn); }

function changed(): void {
  redraw('settings');
  updateStats();
  for (const fn of listeners) fn();
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
