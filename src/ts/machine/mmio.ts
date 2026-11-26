// The memory-mapped registers: one table giving each register's address,
// the name the Memory view shows above it, its access, the Peripherals
// section a program touching it unfolds, and what a read or a write does.
// `read(offset, peek)` returns the whole register and the caller picks out
// the lanes the access covers; `write(offset, value, size)` sees the raw bus
// value. A register with no `read` reads as 0, one with no `write` ignores
// writes, as the hardware does for read-only registers. `editable` is true
// for all but RO registers, and for UART_RX, whose "write" puts a byte in
// the receive queue, as a way to feed input.

import {
  ACCEL_DATA, ACCEL_DREADY, CYCLECOUNT, OLED_COL, OLED_CTRL, OLED_DATA, OLED_ROW, OLED_STATUS,
  PERIPH_DIP, PERIPH_LED, PERIPH_PB, PERIPH_SEVENSEG, UART_RX, UART_RX_VALID, UART_TX, UART_TX_READY,
} from './memory-map';
import { accel, board, cpu, oled, uart } from './state';

import { isMMIOAddr } from './memory';
import { oledDataWrite, oledPresent, oledTrigger } from './oled';
import { sevsegValue } from './peripherals';
import { uartNow, uartTransmit } from './uart';

export type PanelSection = 'uart' | 'oled' | 'accel' | 'ledDip' | 'pb' | 'sevseg';

export interface MmioRegister {
  addr: number;
  name: string;
  access: 'RO' | 'WO' | 'RW';
  editable: boolean;
  panel?: PanelSection;
  read?: (offset: number, peek?: boolean) => number;
  write?: (offset: number, value: number, size: number) => void;
}

type MmioSpec = Omit<MmioRegister, 'editable'> & { editable?: boolean };

const SPECS: MmioSpec[] = [
  { addr: UART_RX_VALID, name: 'UART RX VALID', access: 'RO', panel: 'uart',
    read: () => (uart.rxFull ? 1 : 0) },
  { addr: UART_RX, name: 'UART RX', access: 'RO', editable: true, panel: 'uart',
    // A read with nothing waiting returns 0 and consumes nothing, which is
    // what the Wrapper's read mux does too.
    read: (off, peek) => {
      if (off !== 0 || !uart.rxFull) return 0;
      if (!peek) uart.rxFull = false;
      return uart.rxByte;
    },
    write: (off, val) => { uart.pending.push(val & 0xFF); uart.nextDeliveryInstr = uartNow(); } },
  { addr: UART_TX_READY, name: 'UART TX READY', access: 'RO', panel: 'uart', read: () => 1 },
  { addr: UART_TX, name: 'UART TX', access: 'WO', panel: 'uart', write: (off, val) => uartTransmit(val & 0xFF) },
  // Truncated to the register's 7 bits, not wrapped at 96: the panel, not
  // the Wrapper, decides where an out-of-range column lands.
  { addr: OLED_COL, name: 'OLED COL', access: 'WO', panel: 'oled', read: () => oled.col,
    write: (off, val) => { oled.col = val & 0x7F; oled.advCol = oled.advRow = false; oledTrigger(0x1); } },
  { addr: OLED_ROW, name: 'OLED ROW', access: 'WO', panel: 'oled', read: () => oled.row,
    write: (off, val) => { oled.row = val & 0x3F; oled.advCol = oled.advRow = false; oledTrigger(0x2); } },
  { addr: OLED_DATA, name: 'OLED DATA', access: 'WO', panel: 'oled', read: () => oled.data,
    write: (off, val, size) => oledDataWrite(off, val, size) },
  // Write-only on hardware; echoed back so the Memory view has something to
  // show. The Wrapper gates it on MemWrite_out[0], so only an access
  // covering the low byte lane lands, and bit 3 makes the write a present
  // with the other bits ignored, so software need not know the mode it set
  // to present a frame.
  { addr: OLED_CTRL, name: 'OLED CTRL', access: 'WO', panel: 'oled', read: () => oled.ctrl,
    write: (off, val) => {
      if (off !== 0) return;
      if (val & 0x08) oledPresent();
      else oled.ctrl = val & 0xFF;
    } },
  // Bit 0 is the swap-pending flag. Always clear here: with no scanout
  // modelled a present has already landed by the time software looks, so a
  // polling loop passes straight through. On hardware it would spin until
  // the next frame. The read is noted so that a program which never makes
  // one can be told what it is relying on.
  { addr: OLED_STATUS, name: 'OLED STATUS', access: 'RO', panel: 'oled',
    read: (off, peek) => { if (!peek) oled.swapUnpolled = false; return 0; } },
  { addr: ACCEL_DATA, name: 'ACCEL DATA', access: 'RO', panel: 'accel',
    read: () => ((accel.temp & 0xFF) << 24 | (accel.x & 0xFF) << 16 | (accel.y & 0xFF) << 8 | (accel.z & 0xFF)) },
  { addr: ACCEL_DREADY, name: 'ACCEL DREADY', access: 'RO', panel: 'accel', read: () => accel.dready & 1 },
  { addr: PERIPH_LED, name: 'LED', access: 'WO', panel: 'ledDip', read: () => board.leds,
    write: (off, val, size) => { if (size === 4 || off === 0) board.leds = val & 0xFF; } },
  // DIP and PB move only through the Peripherals panel; a write, from a
  // program or a Memory-view edit, is ignored as the hardware ignores it.
  { addr: PERIPH_DIP, name: 'DIP', access: 'RO', panel: 'ledDip', read: () => board.dip },
  { addr: PERIPH_PB, name: 'PB', access: 'RO', panel: 'pb', read: () => board.buttons },
  { addr: PERIPH_SEVENSEG, name: '7SEG', access: 'WO', panel: 'sevseg', read: () => sevsegValue(),
    write: (off, val, size) => {
      let v = sevsegValue();
      if (size === 4) v = val >>> 0;
      else v = (v & ~(0xFF << (off * 8))) | ((val & 0xFF) << (off * 8));
      board.sevseg = (v >>> 0).toString(16).padStart(8, '0').toUpperCase();
    } },
  { addr: CYCLECOUNT, name: 'CYCLECOUNT', access: 'RO', read: () => cpu.totalCycles },
];

export const MMIO_REGISTERS: MmioRegister[] = SPECS.map(r => ({ ...r, addr: r.addr >>> 0, editable: r.editable ?? (r.access !== 'RO') }));
export const MMIO_BY_ADDR = new Map(MMIO_REGISTERS.map(r => [r.addr, r]));

export function mmioRegisterAt(addr: number): MmioRegister | undefined {
  return MMIO_BY_ADDR.get(addr >>> 0);
}

// Why a Memory-view edit at this address would not land, or null if it
// would. An address in the MMIO window with no register behind it reads 0
// and drops writes, so it is as read-only as a named RO register.
export function mmioReadOnlyMessage(addr: number): string | null {
  if (!isMMIOAddr(addr)) return null;
  const r = mmioRegisterAt((addr >>> 0) & ~3);
  if (r && r.editable) return null;
  return r ? r.name + ' is a read-only MMIO register'
           : 'No MMIO register is mapped here: it reads 0 and ignores writes';
}
