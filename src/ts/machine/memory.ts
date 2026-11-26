// Memory as the program sees it: sparse pages of RAM, and the window of
// memory-mapped registers above mmioBase, whose reads and writes go to the
// peripheral models. Writes are journalled while a step is being recorded,
// so Back can undo them.

import { host } from './host';
import { PAGE_BITS, PAGE_MASK, PAGE_SIZE } from './memory-map';
import { MMIO_BY_ADDR } from './mmio';
import { cpu, memory, stepHistory } from './state';

export function getMemByte(addr: number) {
  const u = addr >>> 0;
  if (isMMIOAddr(u)) return handleMMIORead(u, 1);
  const p = memory.pages.get(u >>> PAGE_BITS);
  return p ? p[u & PAGE_MASK] : 0;
}

export function setMemByte(addr: number, val: number) {
  const u = addr >>> 0;
  if (isMMIOAddr(u)) {
    handleMMIOWrite(u, val & 0xFF, 1);
    return;
  }
  const pageIdx = u >>> PAGE_BITS;
  let p = memory.pages.get(pageIdx);
  if (!p) {
    p = new Uint8Array(PAGE_SIZE);
    memory.pages.set(pageIdx, p);
  }
  p[u & PAGE_MASK] = val & 0xFF;
}

export function isMMIOAddr(addr: number) {
  const u = addr >>> 0;
  return (u >= 0xFFFF0000 && u < 0xFFFF0100);
}

// True when an access touches the MMIO window without lying inside one
// register: a misaligned word at its edge, or one spanning two registers.
// Those go byte by byte, each byte to wherever its own address decodes,
// rather than all of it to wherever the first byte happened to fall.
export function mmioSplitAccess(uaddr: number, size: number) {
  const last = (uaddr + size - 1) >>> 0;
  const first = isMMIOAddr(uaddr), lastIn = isMMIOAddr(last);
  if (!first && !lastIn) return false;
  return !(first && lastIn && (uaddr & ~3) === (last & ~3));
}

export function readMem(addr: number, size: number, peekOnly: boolean = false) {
  const uaddr = addr >>> 0;
  if (mmioSplitAccess(uaddr, size)) {
    let val = 0;
    for (let i = 0; i < size; i++) {
      const a = (uaddr + i) >>> 0;
      const b = isMMIOAddr(a) ? handleMMIORead(a, 1, peekOnly) : getMemByte(a);
      val |= (b & 0xFF) << (i * 8);
    }
    return val >>> 0;
  }
  if (isMMIOAddr(uaddr)) return handleMMIORead(uaddr, size, peekOnly);
  const pageIdx = uaddr >>> PAGE_BITS;
  const offset = uaddr & PAGE_MASK;
  const page = memory.pages.get(pageIdx);
  if (offset + size <= PAGE_SIZE) {
    if (!page) return 0;
    if (size === 4) {
      return ((page[offset] | (page[offset + 1] << 8) | (page[offset + 2] << 16) | (page[offset + 3] << 24)) >>> 0);
    } else if (size === 1) {
      return page[offset];
    } else if (size === 2) {
      return page[offset] | (page[offset + 1] << 8);
    }
    let val = 0;
    for (let i = 0; i < size; i++) {
      val |= (page[offset + i] << (i * 8));
    }
    return val >>> 0;
  }
  let val = 0;
  for (let i = 0; i < size; i++) {
    const a = (uaddr + i) >>> 0;
    const p = memory.pages.get(a >>> PAGE_BITS);
    const b = p ? p[a & PAGE_MASK] : 0;
    val |= (b << (i * 8));
  }
  return val >>> 0;
}

export function readMemSigned(addr: number, size: number, peekOnly: boolean = false) {
  const val = readMem(addr, size, peekOnly);
  if (size === 4) return val | 0;
  const signBit = 1 << (size * 8 - 1);
  if (val & signBit) return (val - (1 << (size * 8))) | 0;
  return val;
}

// Told of each write the program makes, while set: the HDL cross-check
// records what the functional model writes this way.
let writeObserver: ((addr: number, val: number, size: number) => void) | null = null;
export function observeWrites(fn: ((addr: number, val: number, size: number) => void) | null): void {
  writeObserver = fn;
}

export function writeMem(addr: number, val: number, size: number) {
  if (writeObserver) writeObserver(addr, val, size);
  const uaddr = addr >>> 0;
  if (mmioSplitAccess(uaddr, size)) {
    for (let i = 0; i < size; i++) writeMem((uaddr + i) >>> 0, (val >>> (i * 8)) & 0xFF, 1);
    cpu.lastChangedMem = [{ addr: uaddr, size }];
    return;
  }
  if (isMMIOAddr(uaddr)) {
    handleMMIOWrite(uaddr, val, size);
    cpu.lastChangedMem = [{ addr: uaddr, size }];
    return;
  }
  // Journal old bytes for back-step (only during single-stepping execution)
  if (stepHistory.journalEnabled) {
    for (let i = 0; i < size; i++) {
      const a = (uaddr + i) >>> 0;
      const p = memory.pages.get(a >>> PAGE_BITS);
      const old = p ? p[a & PAGE_MASK] : 0;
      stepHistory.writeLog.push({ addr: a, old });
    }
  }
  const pageIdx = uaddr >>> PAGE_BITS;
  const offset = uaddr & PAGE_MASK;
  if (offset + size <= PAGE_SIZE) {
    let page = memory.pages.get(pageIdx);
    if (!page) {
      page = new Uint8Array(PAGE_SIZE);
      memory.pages.set(pageIdx, page);
    }
    if (size === 4) {
      page[offset] = val & 0xFF;
      page[offset + 1] = (val >> 8) & 0xFF;
      page[offset + 2] = (val >> 16) & 0xFF;
      page[offset + 3] = (val >> 24) & 0xFF;
    } else if (size === 1) {
      page[offset] = val & 0xFF;
    } else if (size === 2) {
      page[offset] = val & 0xFF;
      page[offset + 1] = (val >> 8) & 0xFF;
    } else {
      for (let i = 0; i < size; i++) {
        page[offset + i] = (val >> (i * 8)) & 0xFF;
      }
    }
  } else {
    for (let i = 0; i < size; i++) {
      const a = (uaddr + i) >>> 0;
      const pIdx = a >>> PAGE_BITS;
      let page = memory.pages.get(pIdx);
      if (!page) {
        page = new Uint8Array(PAGE_SIZE);
        memory.pages.set(pIdx, page);
      }
      page[a & PAGE_MASK] = (val >> (i * 8)) & 0xFF;
    }
  }
  cpu.lastChangedMem = [{ addr: uaddr, size }];
}

export function mmioRegisterFor(u: number) {
  return MMIO_BY_ADDR.get((u & ~3) >>> 0);
}

export function handleMMIOWrite(addr: number, val: number, size: number) {
  const u = addr >>> 0;
  const reg = mmioRegisterFor(u);
  if (!reg) return;
  host.peripheralUsed(reg);
  if (reg.write) reg.write(u & 3, val, size);
}

export function handleMMIORead(addr: number, size: number, peekOnly: boolean = false) {
  const u = addr >>> 0;
  const reg = mmioRegisterFor(u);
  if (!reg || !reg.read) return 0;
  if (!peekOnly) host.peripheralUsed(reg);
  const off = u & 3;
  const v = reg.read(off, peekOnly) >>> 0;
  const bits = Math.min(size, 4 - off) * 8;
  return bits >= 32 ? v : (v >>> (off * 8)) & ((1 << bits) - 1);
}
