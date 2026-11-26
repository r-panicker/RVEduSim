// The Pmod OLED as the Wrapper drives it: 96x64 pixels in two frame pages,
// the column and row registers with their auto-advance modes, the colour
// formats, and presenting a page.

import { cpuHz } from './clock';
import { host } from './host';
import { memory, oled, stepHistory, type OledPixelLogEntry } from './state';

export function oledBlankPage(buf: Uint8Array) {
  buf.fill(0);
  for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
}

// Back to a single blank page, which is where a reset leaves the panel.
export function oledResetPages() {
  oled.pages = [new Uint8Array(96 * 64 * 4), new Uint8Array(96 * 64 * 4)];
  oled.pages.forEach(oledBlankPage);
  oled.front = 0;
  oled.back = 0;
  oled.buffer = oled.pages[0];
  oled.swapUnpolled = false;
  oled.raceWarned = false;
}

// Present the page just drawn. The controller copies it into the new back
// page, so a program can go on updating only the pixels it cares about.
// On hardware the copy sits inside the window OLED_SwapPending covers;
// here there is no scanout to wait for, so it happens at once.
export function oledPresent() {
  if (oled.front === oled.back) {
    // First present: split the pages, leaving the drawn frame on screen.
    oled.back = 1 - oled.front;
  } else {
    const t = oled.front;
    oled.front = oled.back;
    oled.back = t;
  }
  if (stepHistory.journalEnabled) stepHistory.pixelLog.push({ page: oled.back, full: oled.pages[oled.back].slice() });
  oled.pages[oled.back].set(oled.pages[oled.front]);
  oled.buffer = oled.pages[oled.back];
  oled.swapUnpolled = true;
  host.oledChanged();
}

// The board makes a present take time: it waits up to a whole frame for the
// scanout to reach a boundary, then 12288 clocks to copy the shown page
// back. Pixels written before the boundary land in the page about to be
// shown, and pixels written during the copy are discarded outright - the
// copy engine owns the write port for its duration. OLED_STATUS is how
// software stays out of that window, and it is free here because neither
// delay is modelled, so a program that never reads it looks correct. Saying
// so is the only warning this page can give. An edit typed into the Memory
// panel is not the program racing anything (memory.panelEdit).

export function oledNotePixelWrite() {
  if (memory.panelEdit || !oled.swapUnpolled || oled.raceWarned) return;
  oled.raceWarned = true;
  host.log('OLED: pixels were written after a present, with no read of OLED_STATUS ' +
      'in between. That works here, where a present lands at once. On the board ' +
      'it waits up to a frame (15.73 ms) for the scanout boundary - ' +
      Math.round(cpuHz() * 0.01572864).toLocaleString('en-US') + ' cycles at the ' +
      'current clock - and then ' + Math.round(cpuHz() * 122.88e-6).toLocaleString('en-US') +
      ' more to copy the page back. ' +
      'Pixels written before the boundary appear in the frame being presented, ' +
      'and pixels written during the copy are lost. Poll OLED_STATUS until bit 0 ' +
      'clears before drawing again.', 'warning');
}

// OLED_Col is a 7-bit register, so software can set a column the 96-wide
// panel does not have. The panel does not wrap it: PmodOLEDrgb_bitmap
// addresses with (col[6] and not col[5]) & col[5:0], which folds 96..127
// back onto 32..63 and leaves everything below 96 alone. Kept as a
// separate step from the register itself because the Wrapper's
// auto-advance arithmetic works on the raw 7-bit value, not the folded one.
export function oledPanelCol(col: number) {
  const c = col & 0x7F;
  return ((c & 0x40) && !(c & 0x20)) ? (64 + (c & 0x3F)) : (c & 0x3F);
}

// Resolves a write to OLED_DATA into the Wrapper's 24-bit OLED_Data
// register. Two things this has to copy exactly, because the HDL engine
// paints the Wrapper's own OLED_Data and the two engines must agree:
//
//  - Narrow components are LEFT-ALIGNED and zero-filled, not scaled to
//    full range. 3-bit red 0b111 is 0xE0, not 0xFF.
//  - Each colour mode has its own byte-enable rule. 8-bit needs the low
//    byte, 16-bit needs the low two, and 24-bit takes whichever lanes
//    the access covers, leaving the rest of the register alone.
//
// Returns false when the access does not satisfy the mode's rule, in
// which case the register keeps its previous value - the pixel is still
// painted (the Wrapper triggers on the access, not on the update), just
// with the colour that was already there.
export function oledStoreData(offset: number, val: number, size: number) {
  let be = 0;
  for (let i = 0; i < size; i++) be |= 1 << ((offset + i) & 3);
  // The bus presents the data on the lanes the address selects.
  const wd = (((val >>> 0) << (8 * (offset & 3))) >>> 0);
  const colorMode = (oled.ctrl >> 4) & 0x0F;

  if (colorMode === 0x1) {          // 16-bit 5R-6G-5B
    if ((be & 0x3) !== 0x3) return false;
    oled.data = ((((wd >>> 11) & 0x1F) << 19) |
                   (((wd >>> 5) & 0x3F) << 10) |
                   ((wd & 0x1F) << 3)) >>> 0;
  } else if (colorMode === 0x2) {   // 24-bit, one byte lane at a time
    if (!(be & 0x7)) return false;
    let v = oled.data >>> 0;
    if (be & 0x4) v = (v & ~0xFF0000) | (wd & 0xFF0000);
    if (be & 0x2) v = (v & ~0x00FF00) | (wd & 0x00FF00);
    if (be & 0x1) v = (v & ~0x0000FF) | (wd & 0x0000FF);
    oled.data = v >>> 0;
  } else {                          // 8-bit 3R-3G-2B
    if (!(be & 0x1)) return false;
    oled.data = ((((wd >>> 5) & 0x7) << 21) |
                   (((wd >>> 2) & 0x7) << 13) |
                   ((wd & 0x3) << 6)) >>> 0;
  }
  return true;
}

export function writeOledPixel(val: number) {
  oledNotePixelWrite();
  // `val` is already the resolved 24-bit OLED_Data register.
  const r = (val >>> 16) & 0xFF;
  const g = (val >>> 8) & 0xFF;
  const b = val & 0xFF;

  const c = oledPanelCol(oled.col);
  const rIdx = oled.row & 0x3F;
  const pixelIdx = (rIdx * 96 + c) * 4;
  if (stepHistory.journalEnabled) stepHistory.pixelLog.push({ page: oled.back, idx: pixelIdx, old: oled.buffer.slice(pixelIdx, pixelIdx + 4) });
  oled.buffer[pixelIdx] = r;
  oled.buffer[pixelIdx + 1] = g;
  oled.buffer[pixelIdx + 2] = b;
  oled.buffer[pixelIdx + 3] = 255;
}

// Undo one step's OLED page edits, newest first: a whole-page entry is a
// present's copy, a short one is a single pixel.
export function restoreOledPages(entries: OledPixelLogEntry[]) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.full) oled.pages[e.page].set(e.full);
    else if (e.old) oled.pages[e.page].set(e.old, e.idx);
  }
}

// vary_col / vary_row: writing the coordinate paints the stored colour.
export function oledTrigger(mode: number) {
  if ((oled.ctrl & 0x0F) !== mode) return;
  oled.advCol = oled.advRow = false;
  writeOledPixel(oled.data);
}

// The colour mode is resolved here, on the write, not when the pixel is
// painted: a later mode change must not retint a stored colour, and
// vary_col/vary_row paint this register some writes afterwards.
//
// Auto-advance steps BEFORE painting, and only once the mode has already
// seen a write: the Wrapper arms a flag on the first write and gates the
// increment on its previous value. That ordering is what puts the first
// pixel on the column you set, and leaves the register on the last pixel
// drawn rather than one past it. Writing OLED_COL or OLED_ROW disarms the
// flag, so the next pixel lands where it was set.
export function oledDataWrite(off: number, val: number, size: number) {
  oledStoreData(off, val, size);
  const triggerMode = oled.ctrl & 0x0F;
  if (triggerMode === 0x4) {          // autoadvance_col (row major)
    if (oled.advCol) {
      if (oled.col >= 95) {
        oled.col = 0;
        oled.row = (oled.row + 1) & 0x3F;
      } else {
        oled.col++;
      }
    }
    oled.advCol = true;
    oled.advRow = false;
    writeOledPixel(oled.data);
  } else if (triggerMode === 0x5) {   // autoadvance_row (column major)
    if (oled.advRow) {
      if (oled.row >= 63) {
        oled.row = 0;
        oled.col = (oled.col >= 95) ? 0 : oled.col + 1;
      } else {
        oled.row++;
      }
    }
    oled.advRow = true;
    oled.advCol = false;
    writeOledPixel(oled.data);
  } else if (triggerMode === 0x0) {   // vary_pixel_data
    oled.advCol = oled.advRow = false;
    writeOledPixel(oled.data);
  }
}
