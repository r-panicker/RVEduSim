// The UART: sending, and receiving into the one-byte holding register at
// the pace the console's send mode sets.

import { host } from './host';
import { cpu, run, uart } from './state';

export function setUartSendMode(mode: string): void {
  uart.sendMode = (mode === 'typed' || mode === 'forgiving') ? mode : 'paste';
  host.uartSettingsChanged();
  host.peripheralsChanged();
}

export function setUartCharInstr(v: number | string): void {
  const n = parseInt(String(v), 10);
  if (!Number.isFinite(n) || n < 1) return;
  if (uart.sendMode === 'typed') uart.typedInstr = n; else uart.charInstr = n;
  host.peripheralsChanged();
}

export function uartGapInstr() {
  return uart.sendMode === 'typed' ? Math.max(1, uart.typedInstr)
       : Math.max(1, uart.charInstr);
}

// Hand one byte to the FPGA's holding register. If the program has not
// taken the previous one, the new byte is lost and the old one kept -
// The top level module for synthesis acks the UART to release it but leaves
// UART_RX alone, and raises no flag. Counted here only so the console can say
// what happened.
export function uartDeliverByte(b: number) {
  if (uart.rxFull) { uart.rxDropped++; uart.rxDroppedTotal++; return false; }
  uart.rxByte = b & 0xFF;
  uart.rxFull = true;
  return true;
}

export function uartReportDrops() {
  if (!uart.rxDropped || uart.pending.length) return;
  host.log(`UART RX: ${uart.rxDropped} byte${uart.rxDropped > 1 ? 's' : ''} lost - ` +
      `the program did not read UART_RX before the next character arrived ` +
      `(${uartGapInstr()} cycles apart). The hardware holds one byte and ` +
      `discards the rest without any flag, so this would be silent on the board.`, 'warning');
  uart.rxDropped = 0;
}

// The UART's clock. A character time is a count of single-cycle
// instructions, which is a count of cycles once the pipeline is on.
export function uartNow() { return cpu.totalCycles; }

// Called once per executed instruction, or per cycle when pipelined.
// Moves bytes from the PC's buffer into the holding register as their
// time comes.
export function uartTickDelivery() {
  if (!uart.pending.length) return;
  if (uart.sendMode === 'forgiving') {
    // Hand over only once the program has taken the previous byte, so
    // nothing is ever lost. The wire does not do this; see the guide.
    if (!uart.rxFull) uartDeliverByte(uart.pending.shift()!);
    return;
  }
  while (uart.pending.length && uartNow() >= uart.nextDeliveryInstr) {
    uartDeliverByte(uart.pending.shift()!);
    uart.nextDeliveryInstr = uartNow() + uartGapInstr();
  }
  uartReportDrops();
}

export function uartTransmit(ch: number) {
  uart.txBytes.push(ch);
  uart.txText += String.fromCharCode(ch);
  // A run repaints the terminal once per batch; doing it per byte
  // re-sets the whole transcript each time, which grows as n squared.
  if (!run.running) host.uartOutput();
}
