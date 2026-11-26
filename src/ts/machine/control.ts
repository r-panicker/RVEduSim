// The single-cycle processor's control and arithmetic as the course's RTL
// computes them: the decoder's table (Decoder.v), the immediate extender
// (Extend.v), the ALU with its flags (ALU.v) and the PC logic (PC_Logic.v).
// The datapath drawing shows these values on its wires, and the pipeline
// model computes with them.

export interface DecoderRow {
  row: string;
  PCS: string;
  MemtoReg: string;
  RegWrite: string;
  MemWrite: string;
  ALUSrcA: string;
  ALUSrcB: string;
  ImmSrc: string;
}

export interface AluFlags { eq: number; lt: number; ltu: number }
export interface AluOutput { result: number | null; flags: AluFlags }

// The decoder's table, row for row: the course's Decoder.v. Values are
// strings, written MSB first, so a don't-care bit can be shown as x.
export const DECODER_TABLE: Record<number, DecoderRow> = {
  0x33: { row: 'DP Reg', PCS: '00', MemtoReg: '0', RegWrite: '1', MemWrite: '0', ALUSrcA: 'x0', ALUSrcB: 'x0', ImmSrc: 'xxx' },
  0x13: { row: 'DP Imm', PCS: '00', MemtoReg: '0', RegWrite: '1', MemWrite: '0', ALUSrcA: 'x0', ALUSrcB: '11', ImmSrc: '011' },
  0x03: { row: 'load',   PCS: '00', MemtoReg: '1', RegWrite: '1', MemWrite: '0', ALUSrcA: 'x0', ALUSrcB: '11', ImmSrc: '011' },
  0x23: { row: 'store',  PCS: '00', MemtoReg: 'x', RegWrite: '0', MemWrite: '1', ALUSrcA: 'x0', ALUSrcB: '11', ImmSrc: '110' },
  0x63: { row: 'branch', PCS: '01', MemtoReg: 'x', RegWrite: '0', MemWrite: '0', ALUSrcA: 'x0', ALUSrcB: 'x0', ImmSrc: '111' },
  0x6F: { row: 'jal',    PCS: '10', MemtoReg: '0', RegWrite: '1', MemWrite: '0', ALUSrcA: '11', ALUSrcB: '01', ImmSrc: '010' },
  0x17: { row: 'auipc',  PCS: '00', MemtoReg: '0', RegWrite: '1', MemWrite: '0', ALUSrcA: '11', ALUSrcB: '11', ImmSrc: '000' },
  0x37: { row: 'lui',    PCS: '00', MemtoReg: '0', RegWrite: '1', MemWrite: '0', ALUSrcA: '01', ALUSrcB: '11', ImmSrc: '000' },
  0x67: { row: 'jalr',   PCS: '11', MemtoReg: '0', RegWrite: '1', MemWrite: '0', ALUSrcA: '11', ALUSrcB: '01', ImmSrc: '011' },
};

export const ALU_OP_NAMES: Record<number, string> = {
  0b0000: 'add', 0b0001: 'sub', 0b0010: 'sll', 0b0100: 'slt', 0b0110: 'sltu',
  0b1000: 'xor', 0b1010: 'srl', 0b1011: 'sra', 0b1100: 'or', 0b1110: 'and',
};

export const IMM_SRC_NAMES: Record<string, string> = { '000': 'U', '010': 'J', '011': 'I', '110': 'S', '111': 'B' };

// Bit n of a control value written MSB first, as the tables write it.
export function ctlBit(v: string, n: number): string { return v[v.length - 1 - n]; }

// Extend.v: the immediate, or null where the hardware leaves it undefined.
export function extendImm(instr: number, immSrc: string): number | null {
  const i = instr | 0;
  switch (immSrc) {
    case '000': return (i & 0xFFFFF000) >>> 0;
    case '010': return (((i >> 31) << 20) | (((i >>> 12) & 0xFF) << 12) |
                        (((i >>> 20) & 1) << 11) | (((i >>> 21) & 0x3FF) << 1)) >>> 0;
    case '011': return (i >> 20) >>> 0;
    case '110': return (((i >> 25) << 5) | ((i >>> 7) & 0x1F)) >>> 0;
    case '111': return (((i >> 31) << 12) | (((i >>> 7) & 1) << 11) |
                        (((i >>> 25) & 0x3F) << 5) | (((i >>> 8) & 0xF) << 1)) >>> 0;
    default: return null;   // xxx: the hardware's output is undefined
  }
}

// ALU.v, flags included: they come from the adder whatever the op, and
// only a subtraction makes them mean anything.
export function aluCompute(a: number, b: number, ctl: number): AluOutput {
  const subLike = ctl === 0b0001 || ctl === 0b0100 || ctl === 0b0110;
  const sum = a + (subLike ? (~b >>> 0) : b) + (subLike ? 1 : 0);
  const s = sum >>> 0;
  const C = sum > 0xFFFFFFFF ? 1 : 0;
  const N = s >>> 31;
  const V = ((a >>> 31) !== (b >>> 31)) && ((b >>> 31) === N) ? 1 : 0;
  const flags = { eq: s === 0 ? 1 : 0, lt: N ^ V, ltu: C ? 0 : 1 };
  const sh = b & 31;
  let r: number | null;
  switch (ctl) {
    case 0b0000: case 0b0001: r = s; break;
    case 0b1000: r = a ^ b; break;
    case 0b1100: r = a | b; break;
    case 0b1110: r = a & b; break;
    case 0b0010: r = a << sh; break;
    case 0b1010: r = a >>> sh; break;
    case 0b1011: r = (a | 0) >> sh; break;
    case 0b0100: r = N ^ V; break;
    case 0b0110: r = C ? 0 : 1; break;
    default: r = null;
  }
  return { result: r === null ? null : r >>> 0, flags };
}

// PC_Logic.v
export function pcLogic(pcs: string, f3: number, flags: AluFlags): string {
  if (pcs === '00') return '00';
  if (pcs === '10') return '01';
  if (pcs === '11') return '11';
  const cond = ({ 0b000: flags.eq, 0b001: 1 - flags.eq, 0b100: flags.lt,
                 0b101: 1 - flags.lt, 0b110: flags.ltu, 0b111: 1 - flags.ltu } as Record<number, number>)[f3];
  return '0' + (cond ? '1' : '0');
}
