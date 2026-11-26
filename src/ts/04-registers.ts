// Operand parsing shared by the assembler: register names, immediates
// (with %hi/%lo and character literals) and memory operands.

import { INSTRUCTIONS, REG_NAMES } from './02-isa';

// Read when an operand is parsed: the symbol tables (03-state.ts) and the
// label resolver (05-assembler.ts).
declare let symbolTable: Record<string, number>;
declare let labels: Record<string, number>;
declare function resolveAddrRef(s: string, allowForward?: boolean): number;

// Registers are named `x0`-`x31` or by their ABI name. A bare number is
// NOT a register: accepting it turns the typo `add t0, t0, 1` into a
// silent `add t0, t0, x1`, which is the hardest kind of bug to see.
export function parseReg(input: unknown): number {
  if (input == null) return -1;
  const s = String(input).toLowerCase().replace(/,/g, ' ').trim();
  if (s.startsWith('x')) {
    const n = parseInt(s.substring(1), 10);
    if (n >= 0 && n <= 31) return n;
  }
  if (s === 'fp') return 8;
  if (REG_NAMES[s] !== undefined) return parseInt(REG_NAMES[s].substring(1), 10);
  return -1;
}

// "Invalid register in add" does not tell a student that `1` was read as
// an operand at all. Name the token and, where there is one, the
// immediate-form instruction they almost certainly meant.
export function badRegOperand(mnemonic: string, args: unknown[]): string | null {
  for (const a of args) {
    const t = String(a == null ? '' : a).trim();
    if (!t) continue;
    if (parseReg(t) >= 0 || parseFReg(t) >= 0) continue;
    if (t.includes('(') || t.includes('%')) continue;   // memory operand
    if (/^[+-]?(\d+|0x[0-9a-f]+)$/i.test(t)) {
      const alt = INSTRUCTIONS[mnemonic + 'i'] ? ` Did you mean \`${mnemonic}i\`?` : '';
      return `'${t}' is a number, not a register. ${mnemonic} takes registers ` +
             `only \u2014 write x0\u2013x31 or an ABI name such as t0.${alt}`;
    }
    return `'${t}' is not a register. Write x0\u2013x31 or an ABI name such as t0.`;
  }
  return null;
}

export function parseFReg(input: unknown): number {
  if (input == null) return -1;
  const s = String(input).toLowerCase().replace(/,/g, ' ').trim();
  const fpAbi: Record<string, number> = { ft0: 0, ft1: 1, ft2: 2, ft3: 3, ft4: 4, ft5: 5, ft6: 6, ft7: 7, fs0: 8, fs1: 9, fa0: 10, fa1: 11, fa2: 12, fa3: 13, fa4: 14, fa5: 15, fa6: 16, fa7: 17, fs2: 18, fs3: 19, fs4: 20, fs5: 21, fs6: 22, fs7: 23, fs8: 24, fs9: 25, fs10: 26, fs11: 27, ft8: 28, ft9: 29, ft10: 30, ft11: 31 };
  if (fpAbi[s] !== undefined) return fpAbi[s];
  if (s.startsWith('f') || s.startsWith('d')) {
    const n = parseInt(s.substring(1), 10);
    if (!isNaN(n) && n >= 0 && n <= 31) return n;
  }
  // As with parseReg: a bare number is not a register name, and silently
  // reading `1` as f1 hides the typo instead of reporting it.
  return -1;
}

// A missing operand reads as "not a number" rather than crashing the
// assembler with "Cannot read properties of undefined" - the arity check
// is what produces the message a student can act on.
export function parseImm(input: unknown, allowForward = false): number {
  if (input == null) return NaN;
  const s = String(input).trim().replace(/,/g, '');
  if (s === '') return NaN;

  // Handle GNU RISC-V Relocation Operators: %hi(symbol) and %lo(symbol)
  const hiMatch = s.match(/^%hi\((.+)\)$/i);
  if (hiMatch) {
    const sym = hiMatch[1].trim();
    const targetAddr = resolveAddrRef(sym, allowForward);
    if (!isNaN(targetAddr)) {
      return Math.floor((targetAddr + 0x800) / 4096) & 0xFFFFF;
    }
  }

  // The low 12 bits read as signed, which is what %hi's rounding
  // compensates for. Subtracting hi20 << 12 instead goes wrong for an
  // address with bit 31 set, where the shift comes out negative.
  const loMatch = s.match(/^%lo\((.+)\)$/i);
  if (loMatch) {
    const sym = loMatch[1].trim();
    const targetAddr = resolveAddrRef(sym, allowForward);
    if (!isNaN(targetAddr)) return sext(targetAddr & 0xFFF, 12);
  }

  // Character literal format: 'c' or '\c' or '\xHH'
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    const inner = s.substring(1, s.length - 1);
    if (inner.length === 1) return inner.charCodeAt(0);
    if (inner.length === 2 && inner[0] === '\\') {
      switch (inner[1]) {
        case 'n': return 10;   // LF Line Feed (0x0A)
        case 'r': return 13;   // CR Carriage Return (0x0D)
        case 't': return 9;    // TAB Horizontal Tab (0x09)
        case '0': return 0;    // NUL Null Byte (0x00)
        case 'b': return 8;    // BS Backspace (0x08)
        case 'f': return 12;   // FF Form Feed (0x0C)
        case 'v': return 11;   // VT Vertical Tab (0x0B)
        case 'e': return 27;   // ESC Escape (0x1B)
        case '\\': return 92;  // Backslash
        case "'": return 39;   // Single quote
        case '"': return 34;   // Double quote
        default: return inner.charCodeAt(1);
      }
    }
    if (inner.startsWith('\\x') || inner.startsWith('\\X')) {
      const h = parseInt(inner.substring(2), 16);
      if (!isNaN(h)) return h;
    }
  }

  const sign = (s[0] === '-') ? -1 : (s[0] === '+' ? 1 : 1);
  const body = s.replace(/^[+-]/, '');
  const low = body.toLowerCase();
  const hexM = low.match(/^0x([0-9a-f]+)$/);
  if (hexM) return sign * parseInt(hexM[1], 16);
  const binM = low.match(/^0b([01]+)$/);
  if (binM) return sign * parseInt(binM[1], 2);
  if (/^\d+$/.test(body)) return sign * parseInt(body, 10);
  // Symbolic constant (.equ) or label used as an immediate (case-insensitive)
  if (symbolTable[body] !== undefined) return sign * symbolTable[body];
  if (symbolTable[low] !== undefined) return sign * symbolTable[low];
  if (labels[body] !== undefined) return sign * labels[body];
  if (labels[low] !== undefined) return sign * labels[low];
  if (allowForward) return 0;
  return NaN;
}

export function parseMemOp(input: unknown, allowForward = false): { offset: number; reg: number } | null {
  // Formats: "offset(reg)" or "%lo(sym)(reg)" or "reg" or plain label/symbol
  let s = String(input).trim();
  if (s.startsWith('(') && s.endsWith(')')) {
    s = s.substring(1, s.length - 1);
  }
  const m = s.match(/^(.+)\s*\(\s*(\w+)\s*\)$/i);
  if (m) {
    const offsetStr = m[1].trim();
    const offset = parseImm(offsetStr, allowForward);
    const reg = parseReg(m[2].trim());
    if (!isNaN(offset) && reg >= 0 && reg <= 31) {
      return { offset, reg };
    }
  }
  // Try as a plain register
  const reg = parseReg(s);
  if (reg >= 0 && reg <= 31) return { offset: 0, reg };
  // Try as a label/symbol reference (resolved to address)
  const target = resolveAddrRef(s, allowForward);
  if (!isNaN(target)) return { offset: target, reg: 0 };
  return null;
}

export function sext(value: number, bits: number): number {
  const sign = 1 << (bits - 1);
  return (value & (sign - 1)) - (value & sign);
}
