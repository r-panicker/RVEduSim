// Fetching, decoding and executing one instruction: RV32I, M, F and D, A
// and the RV64 word forms, and the RARS ecall services.

import { sext } from '../asm/operands';
import { dregs, fpBits, getS, getSBits, setS, setSBits } from './fpregs';
import { host } from './host';
import { getMemByte, readMem, readMemSigned, setMemByte, writeMem } from './memory';
import { cpu, memory, run } from './state';

export function fetchInstruction(addr: number) {
  return readMem(addr, 4);
}

export function decodeAndExecute(instr32: number, addr: number) {
  const opcode = instr32 & 0x7F;
  const rd = (instr32 >> 7) & 0x1F;
  const funct3 = (instr32 >> 12) & 0x7;
  const rs1 = (instr32 >> 15) & 0x1F;
  const rs2 = (instr32 >> 20) & 0x1F;
  const funct7 = (instr32 >> 25) & 0x7F;

  // Decode immediates
  const immI = sext(instr32 >> 20, 12);
  const immS = sext(((instr32 >> 25) << 5) | ((instr32 >> 7) & 0x1F), 12);
  const immB = sext(
    ((instr32 >> 31) << 12) |
    (((instr32 >> 25) & 0x3F) << 5) |
    (((instr32 >> 8) & 0xF) << 1) |
    ((instr32 >> 7) & 1) << 11, 13);
  const immU = instr32 & 0xFFFFF000;
  const immJ = sext(
    ((instr32 >> 31) << 20) |
    (((instr32 >> 21) & 0x3FF) << 1) |
    (((instr32 >> 20) & 1) << 11) |
    ((instr32 >> 12) & 0xFF) << 12, 21);

  let nextPC = addr + 4;

  switch (opcode) {
    case 0b0110111: // LUI
      cpu.regs[rd] = immU;
      break;
    case 0b0010111: // AUIPC
      cpu.regs[rd] = addr + immU;
      break;
    case 0b1101111: // JAL
      if (rd !== 0) cpu.regs[rd] = addr + 4;
      nextPC = addr + immJ;
      break;
    case 0b1100111: // JALR
      const jalrTarget = (cpu.regs[rs1] + immI) & ~1;
      if (rd !== 0) cpu.regs[rd] = addr + 4;
      nextPC = jalrTarget;
      break;
    case 0b1100011: // BRANCH
      let taken = false;
      switch (funct3) {
        case 0b000: taken = cpu.regs[rs1] === cpu.regs[rs2]; break; // BEQ
        case 0b001: taken = cpu.regs[rs1] !== cpu.regs[rs2]; break; // BNE
        case 0b100: taken = cpu.regs[rs1] < cpu.regs[rs2]; break; // BLT
        case 0b101: taken = cpu.regs[rs1] >= cpu.regs[rs2]; break; // BGE
        case 0b110: taken = unsigned(cpu.regs[rs1]) < unsigned(cpu.regs[rs2]); break; // BLTU
        case 0b111: taken = unsigned(cpu.regs[rs1]) >= unsigned(cpu.regs[rs2]); break; // BGEU
      }
      if (taken) nextPC = addr + immB;
      break;
    case 0b0000011: // LOAD
      let loadAddr = (cpu.regs[rs1] >>> 0) + immI;
      if (rd !== 0) {
        switch (funct3) {
          case 0b000: cpu.regs[rd] = readMemSigned(loadAddr, 1); break; // LB
          case 0b001: cpu.regs[rd] = readMemSigned(loadAddr, 2); break; // LH
          case 0b010: cpu.regs[rd] = readMemSigned(loadAddr, 4); break; // LW
          case 0b100: cpu.regs[rd] = readMem(loadAddr, 1); break; // LBU
          case 0b101: cpu.regs[rd] = readMem(loadAddr, 2); break; // LHU
        }
      }
      break;
    case 0b0100011: // STORE
      {
        let storeAddr = (cpu.regs[rs1] >>> 0) + immS;
        switch (funct3) {
          case 0b000: writeMem(storeAddr, cpu.regs[rs2] & 0xFF, 1); break; // SB
          case 0b001: writeMem(storeAddr, cpu.regs[rs2] & 0xFFFF, 2); break; // SH
          case 0b010: writeMem(storeAddr, cpu.regs[rs2], 4); break; // SW
        }
      }
      break;
    case 0b0011011: // OP-IMM-32 (addiw, slliw, srliw, sraiw)
      if (rd !== 0) {
        let shamtW = rs2 & 0x1F;
        switch (funct3) {
          case 0b000: cpu.regs[rd] = (cpu.regs[rs1] + immI) | 0; break; // ADDIW
          case 0b001: cpu.regs[rd] = (cpu.regs[rs1] << shamtW) | 0; break; // SLLIW
          case 0b101:
            if ((funct7 >> 5) & 1) cpu.regs[rd] = (cpu.regs[rs1] >> shamtW) | 0; // SRAIW
            else cpu.regs[rd] = (unsigned(cpu.regs[rs1]) >>> shamtW) | 0; // SRLIW
            break;
        }
      }
      break;
    case 0b0111011: // OP-32 (addw, subw, sllw, srlw, sraw)
      if (rd !== 0) {
        let shamtW = cpu.regs[rs2] & 0x1F;
        switch (funct3) {
          case 0b000:
            if (funct7 & 0x20) cpu.regs[rd] = (cpu.regs[rs1] - cpu.regs[rs2]) | 0; // SUBW
            else cpu.regs[rd] = (cpu.regs[rs1] + cpu.regs[rs2]) | 0; // ADDW
            break;
          case 0b001: cpu.regs[rd] = (cpu.regs[rs1] << shamtW) | 0; break; // SLLW
          case 0b101:
            if (funct7 & 0x20) cpu.regs[rd] = (cpu.regs[rs1] >> shamtW) | 0; // SRAW
            else cpu.regs[rd] = (unsigned(cpu.regs[rs1]) >>> shamtW) | 0; // SRLW
            break;
        }
      }
      break;
    case 0b1000011: // FMADD
    case 0b1000111: // FMSUB
    case 0b1001011: // FNMSUB
    case 0b1001111: // FNMADD
      {
        // Fused in the spec; here the product of two singles is exact in
        // a double, so .s is effectively fused, and .d rounds twice.
        const rs3 = (instr32 >> 27) & 0x1F;
        const funct2 = (instr32 >> 25) & 0x3;
        const neg = opcode === 0b1001011 || opcode === 0b1001111;   // fnm*
        const sub = opcode === 0b1000111 || opcode === 0b1001111;   // f*sub, fnmadd
        const fma = (a: number, b: number, c: number) => (neg ? -(a * b) : a * b) + (sub ? -c : c);
        if (funct2 === 0) setS(rd, fma(getS(rs1), getS(rs2), getS(rs3)));
        else if (funct2 === 1) dregs[rd] = fma(dregs[rs1], dregs[rs2], dregs[rs3]);
      }
      break;
    case 0b0010011: // ALU IMMEDIATE
      if (rd !== 0) {
        let shamt = rs2 & 0x1F;
        switch (funct3) {
          case 0b000: cpu.regs[rd] = cpu.regs[rs1] + immI; break; // ADDI
          case 0b010: cpu.regs[rd] = cpu.regs[rs1] < immI ? 1 : 0; break; // SLTI
          case 0b011: cpu.regs[rd] = unsigned(cpu.regs[rs1]) < unsigned(immI) ? 1 : 0; break; // SLTIU
          case 0b100: cpu.regs[rd] = cpu.regs[rs1] ^ immI; break; // XORI
          case 0b110: cpu.regs[rd] = cpu.regs[rs1] | immI; break; // ORI
          case 0b111: cpu.regs[rd] = cpu.regs[rs1] & immI; break; // ANDI
          case 0b001: cpu.regs[rd] = cpu.regs[rs1] << shamt; break; // SLLI
          case 0b101:
            if ((funct7 >> 5) & 1) cpu.regs[rd] = cpu.regs[rs1] >> shamt; // SRAI
            else cpu.regs[rd] = unsigned(cpu.regs[rs1]) >>> shamt; // SRLI
            break;
        }
      }
      break;
    case 0b0110011: // ALU REGISTER
      if (rd !== 0) {
        if (funct7 === 0b0000001) {
          switch (funct3) {
            case 0b000: cpu.regs[rd] = Math.imul(cpu.regs[rs1], cpu.regs[rs2]); break; // MUL
            case 0b001: // MULH
              cpu.regs[rd] = mulh(cpu.regs[rs1], cpu.regs[rs2]); break;
            case 0b010: // MULHSU
              cpu.regs[rd] = mulhsu(cpu.regs[rs1], cpu.regs[rs2]); break;
            case 0b011: // MULHU
              cpu.regs[rd] = mulhu(unsigned(cpu.regs[rs1]), unsigned(cpu.regs[rs2])); break;
            case 0b100: // DIV
              if (cpu.regs[rs2] === 0) cpu.regs[rd] = -1;
              else cpu.regs[rd] = Math.trunc(cpu.regs[rs1] / cpu.regs[rs2]);
              break;
            case 0b101: // DIVU
              if (cpu.regs[rs2] === 0) cpu.regs[rd] = -1;
              else cpu.regs[rd] = Math.trunc(unsigned(cpu.regs[rs1]) / unsigned(cpu.regs[rs2]));
              break;
            case 0b110: // REM
              if (cpu.regs[rs2] === 0) cpu.regs[rd] = cpu.regs[rs1];
              else cpu.regs[rd] = cpu.regs[rs1] % cpu.regs[rs2];
              break;
            case 0b111: // REMU
              if (cpu.regs[rs2] === 0) cpu.regs[rd] = unsigned(cpu.regs[rs1]);
              else cpu.regs[rd] = unsigned(cpu.regs[rs1]) % unsigned(cpu.regs[rs2]);
              break;
          }
        } else {
          switch (funct3) {
            case 0b000:
              if (funct7 & 0x20) cpu.regs[rd] = cpu.regs[rs1] - cpu.regs[rs2]; // SUB
              else cpu.regs[rd] = cpu.regs[rs1] + cpu.regs[rs2]; // ADD
              break;
            case 0b001: cpu.regs[rd] = cpu.regs[rs1] << (cpu.regs[rs2] & 0x1F); break; // SLL
            case 0b010: cpu.regs[rd] = cpu.regs[rs1] < cpu.regs[rs2] ? 1 : 0; break; // SLT
            case 0b011: cpu.regs[rd] = unsigned(cpu.regs[rs1]) < unsigned(cpu.regs[rs2]) ? 1 : 0; break; // SLTU
            case 0b100: cpu.regs[rd] = cpu.regs[rs1] ^ cpu.regs[rs2]; break; // XOR
            case 0b101:
              if (funct7 & 0x20) cpu.regs[rd] = cpu.regs[rs1] >> (cpu.regs[rs2] & 0x1F); // SRA
              else cpu.regs[rd] = unsigned(cpu.regs[rs1]) >>> (cpu.regs[rs2] & 0x1F); // SRL
              break;
            case 0b110: cpu.regs[rd] = cpu.regs[rs1] | cpu.regs[rs2]; break; // OR
            case 0b111: cpu.regs[rd] = cpu.regs[rs1] & cpu.regs[rs2]; break; // AND
          }
        }
      }
      break;
    case 0b0000111: // LOAD FP
      {
        const fAddr = cpu.regs[rs1] + immI;
        if (funct3 === 0b010) setSBits(rd, readMem(fAddr, 4));           // FLW
        else if (funct3 === 0b011) {                                      // FLD
          fpBits[2 * rd] = readMem(fAddr, 4);
          fpBits[2 * rd + 1] = readMem(fAddr + 4, 4);
        }
      }
      break;
    case 0b0100111: // STORE FP
      {
        // The bits as they are, boxed or not: stores do not check.
        const fAddr = cpu.regs[rs1] + immS;
        if (funct3 === 0b010) writeMem(fAddr, fpBits[2 * rs2], 4);       // FSW
        else if (funct3 === 0b011) {                                      // FSD
          writeMem(fAddr, fpBits[2 * rs2], 4);
          writeMem(fAddr + 4, fpBits[2 * rs2 + 1], 4);
        }
      }
      break;
    case 0b1010011: // FP OPERATIONS
      executeFP(instr32, rd, funct3, rs1, rs2, funct7);
      break;
    case 0b0101111: // ATOMIC
      executeAtomic(instr32, rd, funct3, rs1, rs2, funct7);
      break;
    case 0b1110011: // SYSTEM
      if (funct3 === 0b000) {
        if (immI === 0) handleECall(); // ECALL
        else if (immI === 1) handleEBreak(); // EBREAK
      }
      break;
    default:
      // Unknown instruction - just advance PC
      break;
  }

  cpu.regs[0] = 0;

  // Track last written register for UI highlighting
  if (rd !== 0 && opcode !== 0b0100011 && opcode !== 0b0100111 && opcode !== 0b1100011) {
    cpu.lastExecutedRd = rd;
  }

  return nextPC;
}

export function unsigned(val: number) {
  return val >>> 0;
}

export function mulh(a: number, b: number) {
  return Number((BigInt(a) * BigInt(b)) >> 32n);
}

export function mulhu(a: number, b: number) {
  return Number((BigInt(a >>> 0) * BigInt(b >>> 0)) >> 32n);
}

export function mulhsu(a: number, b: number) {
  return Number((BigInt(a) * BigInt(b >>> 0)) >> 32n);
}

export function fpRound(v: number, rm: number) {
  switch (rm) {
    case 1: return Math.trunc(v);                               // rtz
    case 2: return Math.floor(v);                               // rdn
    case 3: return Math.ceil(v);                                // rup
    case 4: return Math.sign(v) * Math.round(Math.abs(v));      // rmm
    default: {                                                  // rne, and dyn
      const f = Math.floor(v), d = v - f;
      if (d !== 0.5) return d < 0.5 ? f : f + 1;
      return f % 2 === 0 ? f : f + 1;
    }
  }
}

// FP to integer conversion rounds as rm says and saturates, as the spec
// requires: NaN and anything above the range give the largest value,
// anything below it the smallest. A plain store into the Int32Array would
// wrap instead.
export function fpToInt(v: number, unsignedResult: boolean, rm: number) {
  const t = fpRound(v, rm);
  if (unsignedResult) {
    if (Number.isNaN(t) || t > 0xFFFFFFFF) return -1;
    return t < 0 ? 0 : t;
  }
  if (Number.isNaN(t) || t > 0x7FFFFFFF) return 0x7FFFFFFF;
  return t < -0x80000000 ? -0x80000000 : t;
}

// fmin/fmax return the other operand when one is NaN, and the canonical
// NaN only when both are. Math.min/max already order -0 below +0.
export function fpMinMax(a: number, b: number, isMax: boolean) {
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  return isMax ? Math.max(a, b) : Math.min(a, b);
}

// Sign injection works on bit patterns: the magnitude of a, the sign
// chosen from b by funct3 (0 copy, 1 negate, 2 xor).
export function fpSignInject(aSign: number, bSign: number, funct3: number) {
  if (funct3 === 0b000) return bSign;
  if (funct3 === 0b001) return bSign ^ 1;
  return aSign ^ bSign;
}

// funct3 is the rounding mode for the arithmetic and the conversions and
// selects the operation for the rest. Arithmetic always rounds to nearest
// even, which is what JS does; the conversions to integer honour it.
export function executeFP(instr32: number, rd: number, funct3: number, rs1: number, rs2: number, funct7: number) {
  // fmt is funct7's low bit, except fcvt.s.d, whose fmt names the result.
  const isDouble = (funct7 & 1) === 1 || funct7 === 0b0100000;

  if (isDouble) {
    const a = dregs[rs1], b = dregs[rs2];
    switch (funct7) {
      case 0b0000001: dregs[rd] = a + b; break;                            // FADD.D
      case 0b0000101: dregs[rd] = a - b; break;                            // FSUB.D
      case 0b0001001: dregs[rd] = a * b; break;                            // FMUL.D
      case 0b0001101: dregs[rd] = a / b; break;                            // FDIV.D
      case 0b0101101: if (rs2 === 0) dregs[rd] = Math.sqrt(a); break;      // FSQRT.D
      case 0b0010101: if (funct3 <= 1) dregs[rd] = fpMinMax(a, b, funct3 === 1); break; // FMIN.D / FMAX.D
      case 0b1100001: if (rs2 <= 1) cpu.regs[rd] = fpToInt(a, rs2 === 1, funct3); break;    // FCVT.W[U].D
      case 0b1101001: if (rs2 <= 1) dregs[rd] = rs2 === 1 ? unsigned(cpu.regs[rs1]) : cpu.regs[rs1]; break; // FCVT.D.W[U]
      case 0b0100000: if (rs2 === 1) setS(rd, a); break;                   // FCVT.S.D
      case 0b0100001: if (rs2 === 0) dregs[rd] = getS(rs1); break;         // FCVT.D.S
      case 0b0010001:                                                      // FSGNJ[N|X].D
        if (funct3 <= 2) {
          const hi = fpBits[2 * rs1 + 1];
          const sign = fpSignInject(hi >>> 31, fpBits[2 * rs2 + 1] >>> 31, funct3);
          fpBits[2 * rd] = fpBits[2 * rs1];
          fpBits[2 * rd + 1] = ((hi & 0x7FFFFFFF) | (sign << 31)) >>> 0;
        }
        break;
      case 0b1010001:
        if (funct3 === 0b010) cpu.regs[rd] = a === b ? 1 : 0;                  // FEQ.D
        else if (funct3 === 0b001) cpu.regs[rd] = a < b ? 1 : 0;               // FLT.D
        else if (funct3 === 0b000) cpu.regs[rd] = a <= b ? 1 : 0;              // FLE.D
        break;
      case 0b1110001: if (funct3 === 0b001) cpu.regs[rd] = fclass(a, true); break; // FCLASS.D
    }
  } else {
    const a = getS(rs1), b = getS(rs2);
    switch (funct7) {
      case 0b0000000: setS(rd, a + b); break;                              // FADD.S
      case 0b0000100: setS(rd, a - b); break;                              // FSUB.S
      case 0b0001000: setS(rd, a * b); break;                              // FMUL.S
      case 0b0001100: setS(rd, a / b); break;                              // FDIV.S
      case 0b0101100: if (rs2 === 0) setS(rd, Math.sqrt(a)); break;        // FSQRT.S
      case 0b0010100: if (funct3 <= 1) setS(rd, fpMinMax(a, b, funct3 === 1)); break; // FMIN.S / FMAX.S
      case 0b1100000: if (rs2 <= 1) cpu.regs[rd] = fpToInt(a, rs2 === 1, funct3); break;  // FCVT.W[U].S
      case 0b1110000: // FMV.X.W moves the low word as it is; FCLASS.S shares funct7
        if (funct3 === 0b000) cpu.regs[rd] = fpBits[2 * rs1] | 0;
        else if (funct3 === 0b001) cpu.regs[rd] = fclass(a, false);
        break;
      case 0b1101000: if (rs2 <= 1) setS(rd, rs2 === 1 ? unsigned(cpu.regs[rs1]) : cpu.regs[rs1]); break; // FCVT.S.W[U]
      case 0b1111000: if (funct3 === 0b000) setSBits(rd, cpu.regs[rs1]); break; // FMV.W.X
      case 0b0010000:                                                      // FSGNJ[N|X].S
        if (funct3 <= 2) {
          const x = getSBits(rs1);
          const sign = fpSignInject(x >>> 31, getSBits(rs2) >>> 31, funct3);
          setSBits(rd, (x & 0x7FFFFFFF) | (sign << 31));
        }
        break;
      case 0b1010000:
        if (funct3 === 0b010) cpu.regs[rd] = a === b ? 1 : 0;                  // FEQ.S
        else if (funct3 === 0b001) cpu.regs[rd] = a < b ? 1 : 0;               // FLT.S
        else if (funct3 === 0b000) cpu.regs[rd] = a <= b ? 1 : 0;              // FLE.S
        break;
    }
  }
}

// One bit per class: -inf, -normal, -subnormal, -0, +0, +subnormal,
// +normal, +inf, signalling NaN, quiet NaN. A NaN is reported quiet, since
// a JS number cannot carry the signalling bit.
export function fclass(f: number, isDouble: boolean) {
  if (Number.isNaN(f)) return 0x200;
  const neg = f < 0 || Object.is(f, -0);
  if (!Number.isFinite(f)) return neg ? 0x001 : 0x080;
  if (f === 0) return neg ? 0x008 : 0x010;
  const minNormal = isDouble ? 2.2250738585072014e-308 : 1.1754943508222875e-38;
  if (Math.abs(f) < minNormal) return neg ? 0x004 : 0x020;
  return neg ? 0x002 : 0x040;
}


export function executeAtomic(instr32: number, rd: number, funct3: number, rs1: number, rs2: number, funct7: number) {
  if (funct3 !== 0b010) return;
  const funct5 = funct7 >>> 2;
  const addr = cpu.regs[rs1] >>> 0;
  if (funct5 === 0b00011) {                        // SC.W
    const ok = cpu.reservation === addr;
    if (ok) writeMem(addr, cpu.regs[rs2], 4);
    cpu.regs[rd] = ok ? 0 : 1;
    cpu.reservation = null;
    return;
  }
  const memVal = readMem(addr, 4) | 0;
  if (funct5 === 0b00010) {                        // LR.W
    cpu.regs[rd] = memVal;
    cpu.reservation = addr;
    return;
  }
  const src = cpu.regs[rs2];
  let result: number;
  switch (funct5) {
    case 0b00001: result = src; break;                                        // AMOSWAP.W
    case 0b00000: result = memVal + src; break;                               // AMOADD.W
    case 0b00100: result = memVal ^ src; break;                               // AMOXOR.W
    case 0b01100: result = memVal & src; break;                               // AMOAND.W
    case 0b01000: result = memVal | src; break;                               // AMOOR.W
    case 0b10000: result = Math.min(memVal, src); break;                      // AMOMIN.W
    case 0b10100: result = Math.max(memVal, src); break;                      // AMOMAX.W
    case 0b11000: result = Math.min(unsigned(memVal), unsigned(src)); break;  // AMOMINU.W
    case 0b11100: result = Math.max(unsigned(memVal), unsigned(src)); break;  // AMOMAXU.W
    default: return;
  }
  cpu.regs[rd] = memVal;
  writeMem(addr, result, 4);
}

export function handleECall() {
  const a7 = cpu.regs[17]; // x17 = a7 service number
  const a0 = cpu.regs[10]; // x10 = a0 argument
  const a1 = cpu.regs[11]; // x11 = a1 argument

  switch (a7) {
    case 1: // print_int (a0)
      host.log(`${a0}`, 'info');
      break;
    case 2: // print_float (fa0)
      host.log(`${getS(10)}`, 'info');
      break;
    case 3: // print_double (fa0)
      host.log(`${dregs[10]}`, 'info');
      break;
    case 4: // print_string (a0 = null-terminated string address)
      {
        let s = '';
        let addr = a0 >>> 0;
        while (getMemByte(addr) !== 0 && s.length < 65536) {
          s += String.fromCharCode(getMemByte(addr));
          addr++;
        }
        host.log(s, 'info');
      }
      break;
    case 5: // read_int -> a0
      {
        let val = 0;
        if (typeof prompt === 'function') {
          const input = host.readInput('RARS Syscall 5 (read_int): Enter integer:');
          val = parseInt(input ?? '', 10) || 0;
        }
        cpu.regs[10] = val | 0;
        host.log(`[Syscall read_int]: ${val}`, 'info');
      }
      break;
    case 6: // read_float -> fa0
      {
        let val = 0.0;
        if (typeof prompt === 'function') {
          const input = host.readInput('RARS Syscall 6 (read_float): Enter float:');
          val = parseFloat(input ?? '') || 0.0;
        }
        setS(10, val);
        host.log(`[Syscall read_float]: ${val}`, 'info');
      }
      break;
    case 7: // read_double -> fa0
      {
        let val = 0.0;
        if (typeof prompt === 'function') {
          const input = host.readInput('RARS Syscall 7 (read_double): Enter double:');
          val = parseFloat(input ?? '') || 0.0;
        }
        dregs[10] = val;
        host.log(`[Syscall read_double]: ${val}`, 'info');
      }
      break;
    case 8: // read_string (a0 = buffer addr, a1 = max length)
      {
        const maxLen = Math.max(0, a1);
        let input = '';
        if (typeof prompt === 'function') {
          input = host.readInput(`RARS Syscall 8 (read_string): Enter string (max ${maxLen} chars):`) || '';
        }
        let addr = a0 >>> 0;
        const copyLen = Math.min(input.length, Math.max(0, maxLen - 1));
        for (let i = 0; i < copyLen; i++) {
          setMemByte(addr + i, input.charCodeAt(i) & 0xFF);
        }
        setMemByte(addr + copyLen, 0); // null terminator
        host.log(`[Syscall read_string]: "${input.substring(0, copyLen)}"`, 'info');
      }
      break;
    case 9: // sbrk (a0 = n bytes) -> a0 = old heap pointer
      {
        const bytes = a0 | 0;
        const oldHeap = memory.heapPointer;
        memory.heapPointer += bytes;
        cpu.regs[10] = oldHeap;
        host.log(`[Syscall sbrk]: allocated ${bytes} bytes at 0x${oldHeap.toString(16)}`, 'info');
      }
      break;
    case 10: // exit
      host.log('Program exited via ecall 10 (Exit).', 'info');
      run.running = false;
      break;
    case 11: // print_char (a0 = ASCII char)
      {
        const ch = String.fromCharCode(a0 & 0xFF);
        host.log(ch, 'info');
      }
      break;
    case 12: // read_char -> a0
      {
        let ch = '\0';
        if (typeof prompt === 'function') {
          const input = host.readInput('RARS Syscall 12 (read_char): Enter character:') || '';
          if (input.length > 0) ch = input[0];
        }
        cpu.regs[10] = ch.charCodeAt(0) & 0xFF;
        host.log(`[Syscall read_char]: '${ch}'`, 'info');
      }
      break;
    case 34: // print_int_hex (a0)
      host.log('0x' + (a0 >>> 0).toString(16).padStart(8, '0').toUpperCase(), 'info');
      break;
    case 35: // print_int_binary (a0)
      host.log('0b' + (a0 >>> 0).toString(2).padStart(32, '0'), 'info');
      break;
    case 36: // print_int_unsigned (a0)
      host.log(`${a0 >>> 0}`, 'info');
      break;
    case 40: // sleep / delay a0 ms
      host.log(`[Syscall sleep]: ${a0} ms`, 'info');
      break;
    case 93: // exit2 (exit with code in a0)
      host.log(`Program exited via ecall 93 (Exit2) with return code ${a0}.`, 'info');
      run.running = false;
      break;
    default:
      host.log(`[ECALL] Syscall #${a7} (a0=0x${(a0 >>> 0).toString(16)})`, 'warn');
  }
}

export function handleEBreak() {
  host.log('[EBREAK] Breakpoint hit', 'warn');
  run.running = false;
}
