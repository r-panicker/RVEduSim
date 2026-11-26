// The console's send-mode selector and character-gap box, kept in step with
// the UART model when its settings change from anywhere else.

import { uart } from '../machine/state';

export function syncUartSendControls(): void {
  const sel = document.getElementById('uartSendMode') as HTMLSelectElement | null;
  if (sel && sel.value !== uart.sendMode) sel.value = uart.sendMode;
  // The box sets whichever gap the mode uses, so it follows the mode rather
  // than sitting there meaning nothing.
  const el = document.getElementById('uartCharInstr') as HTMLInputElement | null;
  if (el) {
    el.value = String(uart.sendMode === 'typed' ? uart.typedInstr : uart.charInstr);
    el.disabled = uart.sendMode !== 'typed';
    el.style.opacity = el.disabled ? '0.5' : '';
  }
}
