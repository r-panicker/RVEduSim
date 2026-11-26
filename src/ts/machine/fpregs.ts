// One FP register file, 64 bits a register, as RV32D has: an F instruction
// reads and writes the low half of the same f register a D instruction sees
// whole. A single is stored NaN-boxed (upper half all ones), and a single
// read from a register that is not boxed reads as the canonical NaN, as the
// spec requires. Views over one buffer, so the raw bits are never
// round-tripped through a JS number, which would lose a NaN's payload and
// with it the boxing; the Float32 view's low-half indexing assumes a
// little-endian host, which every browser is.

export const fpFile = new ArrayBuffer(32 * 8);
export const fpBits = new Uint32Array(fpFile);    // [2i] low word, [2i+1] high word
export const fpLow32 = new Float32Array(fpFile);  // [2i] the single in register i
export const dregs = new Float64Array(fpFile);    // [i] the double in register i

export function getS(i: number): number { return fpBits[2 * i + 1] === 0xFFFFFFFF ? fpLow32[2 * i] : NaN; }
export function setS(i: number, v: number): void { fpLow32[2 * i] = v; fpBits[2 * i + 1] = 0xFFFFFFFF; }
// A single's bit pattern: the canonical NaN if the register is not boxed.
export function getSBits(i: number): number { return fpBits[2 * i + 1] === 0xFFFFFFFF ? fpBits[2 * i] : 0x7FC00000; }
export function setSBits(i: number, bits: number): void { fpBits[2 * i] = bits >>> 0; fpBits[2 * i + 1] = 0xFFFFFFFF; }
