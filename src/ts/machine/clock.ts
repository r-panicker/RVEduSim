// The board's CPU clock: the top level module for synthesis divides 100 MHz
// by 2^CLK_DIV_BITS.

import { clock } from './state';

// At this clock or slower (CLK_DIV_BITS 20 and up), Real time shows each
// instruction as it runs: the line, the registers and memory follow.
export const RT_FOLLOW_HZ = 100;

export function clkDivider(): number { return 2 ** clock.divBits; }
export function cpuHz(): number { return 100e6 / clkDivider(); }

export function fmtHz(f: number): string {
  return f >= 1e6 ? +(f / 1e6).toPrecision(3) + ' MHz' : f >= 1e3 ? +(f / 1e3).toPrecision(3) + ' kHz'
    : +f.toPrecision(3) + ' Hz';
}

export function fmtSimTime(cycles: number): string {
  const t = cycles / cpuHz();
  return t < 1e-3 ? +(t * 1e6).toFixed(1) + ' µs' : t < 1 ? +(t * 1e3).toFixed(2) + ' ms' : +t.toFixed(2) + ' s';
}

// One character at 115200 baud is 8640 clocks of the UART's 100 MHz.
export function uartCharCycles(): number { return Math.max(1, Math.round(8640 / clkDivider())); }
