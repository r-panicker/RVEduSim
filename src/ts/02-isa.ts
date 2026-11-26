// The RV32GC instruction table, the pseudo-instruction expansions and the
// register names.

import { parseImm } from './04-registers';

// The assembler's labels, defined by 03-state.ts.
declare let labels: Record<string, number>;

// One instruction's encoding: its format and the fixed fields of that format.
export interface InstrDef {
  type: string;
  opcode: number;
  funct3?: number;
  funct7?: number;
  funct2?: number;
  rs2?: number;
  imm12?: number;
  isSpecial?: boolean;
}

// A pseudo-instruction expands to a template of lines (%0, %1, ... are its
// operands), or to whatever lines a function returns for its operands.
export type PseudoExpansion = string[] | ((...operands: string[]) => string[]);

export const INSTRUCTIONS: Record<string, InstrDef> = {
  // RV32I Base Integer Instructions
  'lui': { type: 'U', opcode: 0b0110111, funct3: 0 },
  'auipc': { type: 'U', opcode: 0b0010111, funct3: 0 },
  'jal': { type: 'J', opcode: 0b1101111, funct3: 0 },
  'jalr': { type: 'I', opcode: 0b1100111, funct3: 0 },
  'beq': { type: 'B', opcode: 0b1100011, funct3: 0b000 },
  'bne': { type: 'B', opcode: 0b1100011, funct3: 0b001 },
  'blt': { type: 'B', opcode: 0b1100011, funct3: 0b100 },
  'bge': { type: 'B', opcode: 0b1100011, funct3: 0b101 },
  'bltu': { type: 'B', opcode: 0b1100011, funct3: 0b110 },
  'bgeu': { type: 'B', opcode: 0b1100011, funct3: 0b111 },
  'lb': { type: 'I', opcode: 0b0000011, funct3: 0b000 },
  'lh': { type: 'I', opcode: 0b0000011, funct3: 0b001 },
  'lw': { type: 'I', opcode: 0b0000011, funct3: 0b010 },
  'lbu': { type: 'I', opcode: 0b0000011, funct3: 0b100 },
  'lhu': { type: 'I', opcode: 0b0000011, funct3: 0b101 },
  'sb': { type: 'S', opcode: 0b0100011, funct3: 0b000 },
  'sh': { type: 'S', opcode: 0b0100011, funct3: 0b001 },
  'sw': { type: 'S', opcode: 0b0100011, funct3: 0b010 },
  'addi': { type: 'I', opcode: 0b0010011, funct3: 0b000 },
  'slti': { type: 'I', opcode: 0b0010011, funct3: 0b010 },
  'sltiu': { type: 'I', opcode: 0b0010011, funct3: 0b011 },
  'xori': { type: 'I', opcode: 0b0010011, funct3: 0b100 },
  'ori': { type: 'I', opcode: 0b0010011, funct3: 0b110 },
  'andi': { type: 'I', opcode: 0b0010011, funct3: 0b111 },
  'slli': { type: 'I', opcode: 0b0010011, funct3: 0b001, funct7: 0b0000000 },
  'srli': { type: 'I', opcode: 0b0010011, funct3: 0b101, funct7: 0b0000000 },
  'srai': { type: 'I', opcode: 0b0010011, funct3: 0b101, funct7: 0b0100000 },
  'add': { type: 'R', opcode: 0b0110011, funct3: 0b000, funct7: 0b0000000 },
  'sub': { type: 'R', opcode: 0b0110011, funct3: 0b000, funct7: 0b0100000 },
  'sll': { type: 'R', opcode: 0b0110011, funct3: 0b001, funct7: 0b0000000 },
  'slt': { type: 'R', opcode: 0b0110011, funct3: 0b010, funct7: 0b0000000 },
  'sltu': { type: 'R', opcode: 0b0110011, funct3: 0b011, funct7: 0b0000000 },
  'xor': { type: 'R', opcode: 0b0110011, funct3: 0b100, funct7: 0b0000000 },
  'srl': { type: 'R', opcode: 0b0110011, funct3: 0b101, funct7: 0b0000000 },
  'sra': { type: 'R', opcode: 0b0110011, funct3: 0b101, funct7: 0b0100000 },
  'or': { type: 'R', opcode: 0b0110011, funct3: 0b110, funct7: 0b0000000 },
  'and': { type: 'R', opcode: 0b0110011, funct3: 0b111, funct7: 0b0000000 },
  'fence': { type: 'I', opcode: 0b0001111, funct3: 0b000 },
  'ecall': { type: 'I', opcode: 0b1110011, funct3: 0b000, isSpecial: true, imm12: 0 },
  'ebreak': { type: 'I', opcode: 0b1110011, funct3: 0b000, isSpecial: true, imm12: 1 },

  // RV64I additions (we keep them for compatibility but they work as RV32I)
  'addiw': { type: 'I', opcode: 0b0011011, funct3: 0b000 },
  'slliw': { type: 'I', opcode: 0b0011011, funct3: 0b001, funct7: 0b0000000 },
  'srliw': { type: 'I', opcode: 0b0011011, funct3: 0b101, funct7: 0b0000000 },
  'sraiw': { type: 'I', opcode: 0b0011011, funct3: 0b101, funct7: 0b0100000 },
  'addw': { type: 'R', opcode: 0b0111011, funct3: 0b000, funct7: 0b0000000 },
  'subw': { type: 'R', opcode: 0b0111011, funct3: 0b000, funct7: 0b0100000 },
  'sllw': { type: 'R', opcode: 0b0111011, funct3: 0b001, funct7: 0b0000000 },
  'srlw': { type: 'R', opcode: 0b0111011, funct3: 0b101, funct7: 0b0000000 },
  'sraw': { type: 'R', opcode: 0b0111011, funct3: 0b101, funct7: 0b0100000 },

  // RV32M Standard Extension
  'mul': { type: 'R', opcode: 0b0110011, funct3: 0b000, funct7: 0b0000001 },
  'mulh': { type: 'R', opcode: 0b0110011, funct3: 0b001, funct7: 0b0000001 },
  'mulhsu': { type: 'R', opcode: 0b0110011, funct3: 0b010, funct7: 0b0000001 },
  'mulhu': { type: 'R', opcode: 0b0110011, funct3: 0b011, funct7: 0b0000001 },
  'div': { type: 'R', opcode: 0b0110011, funct3: 0b100, funct7: 0b0000001 },
  'divu': { type: 'R', opcode: 0b0110011, funct3: 0b101, funct7: 0b0000001 },
  'rem': { type: 'R', opcode: 0b0110011, funct3: 0b110, funct7: 0b0000001 },
  'remu': { type: 'R', opcode: 0b0110011, funct3: 0b111, funct7: 0b0000001 },

  // RV32F Standard Extension (Single-Precision Floating Point)
  'flw': { type: 'I', opcode: 0b0000111, funct3: 0b010 },
  'fsw': { type: 'S', opcode: 0b0100111, funct3: 0b010 },
  'fmadd.s': { type: 'R4', opcode: 0b1000011, funct2: 0b00 },
  'fmsub.s': { type: 'R4', opcode: 0b1000111, funct2: 0b00 },
  'fnmsub.s': { type: 'R4', opcode: 0b1001011, funct2: 0b00 },
  'fnmadd.s': { type: 'R4', opcode: 0b1001111, funct2: 0b00 },
  'fadd.s': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b0000000 },
  'fsub.s': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b0000100 },
  'fmul.s': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b0001000 },
  'fdiv.s': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b0001100 },
  'fsqrt.s': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b0101100, rs2: 0 },
  'fsgnj.s': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b0010000 },
  'fsgnjn.s': { type: 'R', opcode: 0b1010011, funct3: 0b001, funct7: 0b0010000 },
  'fsgnjx.s': { type: 'R', opcode: 0b1010011, funct3: 0b010, funct7: 0b0010000 },
  'fmin.s': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b0010100 },
  'fmax.s': { type: 'R', opcode: 0b1010011, funct3: 0b001, funct7: 0b0010100 },
  'fcvt.w.s': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b1100000, rs2: 0 },
  'fcvt.wu.s': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b1100000, rs2: 1 },
  'fmv.x.w': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b1110000 },
  'feq.s': { type: 'R', opcode: 0b1010011, funct3: 0b010, funct7: 0b1010000 },
  'flt.s': { type: 'R', opcode: 0b1010011, funct3: 0b001, funct7: 0b1010000 },
  'fle.s': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b1010000 },
  'fclass.s': { type: 'R', opcode: 0b1010011, funct3: 0b001, funct7: 0b1110000 },
  'fcvt.s.w': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b1101000, rs2: 0 },
  'fcvt.s.wu': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b1101000, rs2: 1 },
  'fmv.w.x': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b1111000 },

  // RV32D Standard Extension (Double-Precision Floating Point)
  'fld': { type: 'I', opcode: 0b0000111, funct3: 0b011 },
  'fsd': { type: 'S', opcode: 0b0100111, funct3: 0b011 },
  'fmadd.d': { type: 'R4', opcode: 0b1000011, funct2: 0b01 },
  'fmsub.d': { type: 'R4', opcode: 0b1000111, funct2: 0b01 },
  'fnmsub.d': { type: 'R4', opcode: 0b1001011, funct2: 0b01 },
  'fnmadd.d': { type: 'R4', opcode: 0b1001111, funct2: 0b01 },
  'fadd.d': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b0000001 },
  'fsub.d': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b0000101 },
  'fmul.d': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b0001001 },
  'fdiv.d': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b0001101 },
  'fsqrt.d': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b0101101, rs2: 0 },
  'fsgnj.d': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b0010001 },
  'fsgnjn.d': { type: 'R', opcode: 0b1010011, funct3: 0b001, funct7: 0b0010001 },
  'fsgnjx.d': { type: 'R', opcode: 0b1010011, funct3: 0b010, funct7: 0b0010001 },
  'fmin.d': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b0010101 },
  'fmax.d': { type: 'R', opcode: 0b1010011, funct3: 0b001, funct7: 0b0010101 },
  'fcvt.s.d': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b0100000, rs2: 1 },
  'fcvt.d.s': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b0100001, rs2: 0 },
  'feq.d': { type: 'R', opcode: 0b1010011, funct3: 0b010, funct7: 0b1010001 },
  'flt.d': { type: 'R', opcode: 0b1010011, funct3: 0b001, funct7: 0b1010001 },
  'fle.d': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b1010001 },
  'fclass.d': { type: 'R', opcode: 0b1010011, funct3: 0b001, funct7: 0b1110001 },
  'fcvt.w.d': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b1100001, rs2: 0 },
  'fcvt.wu.d': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b1100001, rs2: 1 },
  'fcvt.d.w': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b1101001, rs2: 0 },
  'fcvt.d.wu': { type: 'R', opcode: 0b1010011, funct3: 0b000, funct7: 0b1101001, rs2: 1 },

  // RV32A Standard Extension (Atomic). funct7 is funct5 followed by the
  // aq and rl bits, which are always 0 here.
  'lr.w': { type: 'R', opcode: 0b0101111, funct3: 0b010, funct7: 0b0001000 },
  'sc.w': { type: 'R', opcode: 0b0101111, funct3: 0b010, funct7: 0b0001100 },
  'amoswap.w': { type: 'R', opcode: 0b0101111, funct3: 0b010, funct7: 0b0000100 },
  'amoadd.w': { type: 'R', opcode: 0b0101111, funct3: 0b010, funct7: 0b0000000 },
  'amoxor.w': { type: 'R', opcode: 0b0101111, funct3: 0b010, funct7: 0b0010000 },
  'amoand.w': { type: 'R', opcode: 0b0101111, funct3: 0b010, funct7: 0b0110000 },
  'amoor.w': { type: 'R', opcode: 0b0101111, funct3: 0b010, funct7: 0b0100000 },
  'amomin.w': { type: 'R', opcode: 0b0101111, funct3: 0b010, funct7: 0b1000000 },
  'amomax.w': { type: 'R', opcode: 0b0101111, funct3: 0b010, funct7: 0b1010000 },
  'amominu.w': { type: 'R', opcode: 0b0101111, funct3: 0b010, funct7: 0b1100000 },
  'amomaxu.w': { type: 'R', opcode: 0b0101111, funct3: 0b010, funct7: 0b1110000 },
};

// Pseudo-instructions mapping
export const PSEUDO_INSTRUCTIONS: Record<string, PseudoExpansion> = {
  'nop': ['addi x0, x0, 0'],
  'mv': ['addi %0, %1, 0'],
  'not': ['xori %0, %1, -1'],
  'neg': ['sub %0, x0, %1'],
  'negw': ['subw %0, x0, %1'],
  'sext.w': ['addiw %0, %1, 0'],
  'seqz': ['sltiu %0, %1, 1'],
  'snez': ['sltu %0, x0, %1'],
  'sltz': ['slt %0, %1, x0'],
  'sgtz': ['slt %0, x0, %1'],
  'beqz': ['beq %0, x0, %1'],
  'bnez': ['bne %0, x0, %1'],
  'blez': ['bge x0, %0, %1'],
  'bgez': ['bge %0, x0, %1'],
  'bltz': ['blt %0, x0, %1'],
  'bgtz': ['blt x0, %0, %1'],
  'bgt': ['blt %1, %0, %2'],
  'ble': ['bge %1, %0, %2'],
  'bgtu': ['bltu %1, %0, %2'],
  'bleu': ['bgeu %1, %0, %2'],
  'j': ['jal x0, %0'],
  'jr': ['jalr x0, %0, 0'],
  'ret': ['jalr x0, x1, 0'],
  'call': ['auipc x6, %0', 'jalr x1, x6, %1'],
  'tail': ['auipc x6, %0', 'jalr x0, x6, %1'],
  'la': [],
  'lla': [],
  'lga': [],
  'fmv.s': ['fsgnj.s %0, %1, %1'],
  'fneg.s': ['fsgnjn.s %0, %1, %1'],
  'fabs.s': ['fsgnjx.s %0, %1, %1'],
  'fmv.d': ['fsgnj.d %0, %1, %1'],
  'fneg.d': ['fsgnjn.d %0, %1, %1'],
  'fabs.d': ['fsgnjx.d %0, %1, %1'],
  'li': function (rd: string, operand: string) {
    const imm = parseImm(String(operand));
    if (isNaN(imm)) throw new Error(`Unknown symbol '${operand}'`);
    if (imm < -0x80000000 || imm > 0xFFFFFFFF) {
      throw new Error(`li ${rd}, ${operand}: ${imm} does not fit in a 32-bit register.`);
    }
    // A label is an address, and a later label is unknown when pass 1
    // sizes this line, so it is always the two-instruction form, as GNU
    // as makes it. Otherwise the two passes could disagree on its size.
    const op = String(operand).trim();
    const isLabel = labels[op] !== undefined || labels[op.toLowerCase()] !== undefined;
    if (!isLabel && imm >= -2048 && imm <= 2047) return [`addi ${rd}, x0, ${imm}`];
    let upper = imm >>> 12;
    let lower = imm & 0xFFF;
    if (lower & 0x800) {
      upper = (upper + 1) & 0xFFFFF;
    }
    const signExtended = (lower & 0x800) ? (lower - 0x1000) : lower;
    return [`lui ${rd}, ${upper}`, `addi ${rd}, ${rd}, ${signExtended}`];
  }
};

// Operand counts for the pseudo-instructions. Most are read straight off
// their expansion template (the highest %N used), but the ones that
// emitPseudo() handles specially do not match their template, so they are
// listed. Without this, `nop t0` and `ret t0` would quietly ignore the
// operand and `li t0` would crash inside the expansion rather than report.
export const PSEUDO_ARITY_OVERRIDE: Record<string, number> = {
  la: 2, lla: 2, lga: 2, call: 1, tail: 1, li: 2,
};

export function pseudoArity(mn: string): number | null {
  if (PSEUDO_ARITY_OVERRIDE[mn] !== undefined) return PSEUDO_ARITY_OVERRIDE[mn];
  const p = PSEUDO_INSTRUCTIONS[mn];
  if (!Array.isArray(p)) return null;
  let highest = -1;
  for (const line of p) {
    for (const m of String(line).matchAll(/%(\d+)/g)) {
      highest = Math.max(highest, parseInt(m[1], 10));
    }
  }
  return highest + 1;
}

export function checkPseudoArity(mn: string, args: unknown[]): void {
  const want = pseudoArity(mn);
  if (want === null) return;
  if (args.length === want) return;
  throw new Error(
    `${mn} takes ${want} operand${want === 1 ? '' : 's'}, but ${args.length} ` +
    `${args.length === 1 ? 'was' : 'were'} given.`);
}

// Register names
export const REG_NAMES: Record<string, string> = {
  'zero': 'x0', 'ra': 'x1', 'sp': 'x2', 'gp': 'x3', 'tp': 'x4',
  't0': 'x5', 't1': 'x6', 't2': 'x7', 's0': 'x8', 'fp': 'x8',
  's1': 'x9', 'a0': 'x10', 'a1': 'x11', 'a2': 'x12', 'a3': 'x13',
  'a4': 'x14', 'a5': 'x15', 'a6': 'x16', 'a7': 'x17',
  's2': 'x18', 's3': 'x19', 's4': 'x20', 's5': 'x21', 's6': 'x22',
  's7': 'x23', 's8': 'x24', 's9': 'x25', 's10': 'x26', 's11': 'x27',
  't3': 'x28', 't4': 'x29', 't5': 'x30', 't6': 'x31'
};

export const ABI_NAMES: string[] = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1',
  'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 's2', 's3', 's4', 's5', 's6',
  's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'];
