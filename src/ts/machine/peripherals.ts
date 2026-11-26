// Snapshots of the peripherals' state, which Back restores, and the
// 7-segment display's value.

import { board, oled, uart } from './state';

// Everything one step can change on the peripheral side, bar the OLED
// pages. Snapshotting the scalars whole keeps the undo in one place
// instead of a hook at every write site, so a new peripheral only has to
// be listed here; the cost is one small object per single-step.
export function capturePeriphState() {
  return {
    ledState: board.leds, sevsegState: board.sevseg,
    oledCol: oled.col, oledRow: oled.row, oledCtrl: oled.ctrl, oledDataVal: oled.data, oledAdvCol: oled.advCol, oledAdvRow: oled.advRow,
    oledFrontPage: oled.front, oledBackPage: oled.back, oledSwapUnpolled: oled.swapUnpolled, oledRaceWarned: oled.raceWarned,
    uartPending: uart.pending.slice(),
    uartRxByte: uart.rxByte, uartRxFull: uart.rxFull, uartRxDropped: uart.rxDropped, uartRxDroppedTotal: uart.rxDroppedTotal,
    uartNextDeliveryInstr: uart.nextDeliveryInstr,
    uartTxBuffer: uart.txText, uartTxLen: uart.txBytes.length
  };
}

export type PeriphSnapshot = ReturnType<typeof capturePeriphState>;

export function restorePeriphState(s: PeriphSnapshot) {
  board.leds = s.ledState; board.sevseg = s.sevsegState;
  oled.col = s.oledCol; oled.row = s.oledRow;
  oled.ctrl = s.oledCtrl; oled.data = s.oledDataVal;
  oled.advCol = s.oledAdvCol; oled.advRow = s.oledAdvRow;
  oled.front = s.oledFrontPage; oled.back = s.oledBackPage;
  oled.buffer = oled.pages[oled.back];
  oled.swapUnpolled = s.oledSwapUnpolled; oled.raceWarned = s.oledRaceWarned;
  uart.pending = s.uartPending.slice();
  uart.rxByte = s.uartRxByte; uart.rxFull = s.uartRxFull;
  uart.rxDropped = s.uartRxDropped; uart.rxDroppedTotal = s.uartRxDroppedTotal;
  uart.nextDeliveryInstr = s.uartNextDeliveryInstr;
  uart.txText = s.uartTxBuffer; uart.txBytes.length = s.uartTxLen;
}

export function sevsegValue() {
  return parseInt(board.sevseg, 16) || 0;
}
