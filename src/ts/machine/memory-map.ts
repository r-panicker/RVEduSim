// The memory map: page size of the sparse memory, the default segment
// bases, and the addresses of the memory-mapped registers.

export const PAGE_BITS = 16;
export const PAGE_SIZE = 1 << PAGE_BITS;
export const PAGE_MASK = PAGE_SIZE - 1;

// The defaults put .text at 0x00400000 and .data at 0x10010000, as SPIM and
// RARS do; MMIO starts at 0xFFFF0000.
export const DEFAULT_BASE = 0x00400000;
export const DEFAULT_DATA_BASE = 0x10010000;

// UART, 115200 8N1
export const UART_RX_VALID = 0xFFFF0000;   // RO: bit 0 set while a byte is held
export const UART_RX = 0xFFFF0004;         // RO: the held byte; reading it takes it
export const UART_TX_READY = 0xFFFF0008;   // RO: bit 0 set when a byte can be sent
export const UART_TX = 0xFFFF000C;         // WO: the byte to send

// OLED, 96x64
export const OLED_COL = 0xFFFF0020;        // WO: column, 0..95
export const OLED_ROW = 0xFFFF0024;        // WO: row, 0..63
export const OLED_DATA = 0xFFFF0028;       // WO: colour; the write draws the pixel
export const OLED_CTRL = 0xFFFF002C;       // WO: [2:0] auto-advance mode, [3] present, [7:4] colour format
export const OLED_STATUS = 0xFFFF0030;     // RO: bit 0 set while a present is pending

// Accelerometer and cycle counter
export const ACCEL_DATA = 0xFFFF0040;      // RO: [31:24] temperature, [23:16] X, [15:8] Y, [7:0] Z
export const ACCEL_DREADY = 0xFFFF0044;    // RO: bit 0 set when a new reading is ready
export const CYCLECOUNT = 0xFFFF00A0;      // RO: cycles since reset

// Board I/O
export const PERIPH_LED = 0xFFFF0060;      // WO: LED[7:0]
export const PERIPH_DIP = 0xFFFF0064;      // RO: the 16 switches
export const PERIPH_PB = 0xFFFF0068;       // RO: the 3 push buttons
export const PERIPH_SEVENSEG = 0xFFFF0080; // WO: the 7-segment display's 8 digits
