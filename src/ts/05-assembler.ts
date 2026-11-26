// @ts-nocheck
// The two-pass assembler, operand-count checks and the instruction
// encoder, plus the helpers that render the Native instruction column.
function resolveAddrRef(s, allowForward = false) {
  if (program.labels[s] !== undefined) return program.labels[s];
  if (program.symbolTable[s] !== undefined) return program.symbolTable[s];
  const low = s.toLowerCase();
  if (program.labels[low] !== undefined) return program.labels[low];
  if (program.symbolTable[low] !== undefined) return program.symbolTable[low];

  // Handle symbol offset arithmetic like symbol+96 or symbol-16
  const arithMatch = s.match(/^([a-zA-Z0-9_.$]+)\s*([+-])\s*([0-9a-fxX]+)$/);
  if (arithMatch) {
    const baseSym = arithMatch[1];
    const op = arithMatch[2];
    const offset = parseImm(arithMatch[3]);
    const baseVal = resolveAddrRef(baseSym, allowForward);
    if (!isNaN(baseVal) && !isNaN(offset)) {
      return op === '+' ? baseVal + offset : baseVal - offset;
    }
  }

  const n = parseImm(s, allowForward);
  if (!isNaN(n)) return n;
  if (allowForward) return 0;
  if (/^__(mul|div|udiv|mod|umod|muldi|divdi|udivdi|moddi|umoddi)[a-z0-9]*$/.test(s)) {
    throw new Error(`'${s}' is a libgcc helper the compiler emits for ` +
      `multiply/divide when the M extension is off, and it is library code ` +
      `that is not part of this program. Tick "Include M extension" in ` +
      `Settings → Compiler and compile again; or raise the optimisation ` +
      `level, since from -O1 upwards the compiler often replaces a multiply ` +
      `or divide by a constant with shifts and adds and the call disappears; ` +
      `or avoid * / % in your C.`);
  }
  throw new Error(`Unknown symbol '${s}'`);
}
function instructionSlots(mnemonic, args) {
  // A load or store that names a symbol, rather than offset(reg),
  // expands to auipc + the access.
  if (LOAD_MNEMONICS.includes(mnemonic) || STORE_MNEMONICS.includes(mnemonic)) {
    if (args.length === 3) return 2;
    if (args.length === 2) {
      if (!args[1].includes('(')) return 2;
      const mem = parseMemOp(args[1], true);
      if (!mem || (mem.reg === 0 && (mem.offset > 2047 || mem.offset < -2048))) return 2;
    }
  }
  if (INSTRUCTIONS[mnemonic]) return 1;
  switch (mnemonic) {
    case 'la': case 'lla': case 'lga': case 'call': case 'tail': return 2;
    case 'li': {
      if (args.length < 2) return 1;   // arity is reported during emit
      // A symbol not defined yet is a label further down, so an address.
      try { return PSEUDO_INSTRUCTIONS.li(args[0], args[1]).length; } catch (e) { return 2; }
    }
  }
  if (PSEUDO_INSTRUCTIONS[mnemonic]) {
    if (typeof PSEUDO_INSTRUCTIONS[mnemonic] === 'function') {
      try { return PSEUDO_INSTRUCTIONS[mnemonic](...args).length; } catch (e) { return 1; }
    }
    return PSEUDO_INSTRUCTIONS[mnemonic].length;
  }
  return 0;
}
function expandPseudoLines(mnemonic, args) {
  const p = PSEUDO_INSTRUCTIONS[mnemonic];
  if (typeof p === 'function') return p(...args);
  return p.map(t => t.replace(/%\d+/g, (m) => { const idx = parseInt(m.substring(1), 10); return args[idx] || ''; }));
}

// The Native instruction column is a disassembly, so it names registers the
// way the encoding does - x0 to x31. ABI names are a source-level
// convenience and stay in the Original source column beside it, which is
// also what makes the two columns worth reading against each other.
function toHwRegName(tok) {
  const t = String(tok == null ? '' : tok).trim().toLowerCase();
  if (/^x(\d|[12]\d|3[01])$/.test(t)) return t;
  if (REG_NAMES[t] !== undefined) return REG_NAMES[t];
  return null;
}

function hwRegOperand(a) {
  const t = String(a == null ? '' : a).trim();
  const direct = toHwRegName(t);
  if (direct) return direct;
  // offset(base) - rewrite the base register, leave the offset alone.
  const m = t.match(/^(.*)\(\s*([A-Za-z_]\w*)\s*\)$/);
  if (m) {
    const base = toHwRegName(m[2]);
    if (base) return m[1].trim() + '(' + base + ')';
  }
  return t;
}

// The same string, plus where the immediate operand sits inside it. The
// column still shows the operand as it was written; the span is only so
// that the other readings of the same field can be offered on hover.
const SHIFT_IMM_OPS = new Set(['slli', 'srli', 'srai']);
const IMM_TYPES = new Set(['I', 'S', 'B', 'U', 'J']);

function buildNativeInstruction(mnemonic, args) {
  const ops = args.map(hwRegOperand);
  const text = mnemonic + (ops.length ? ' ' + ops.join(', ') : '');
  const none = { text, immFrom: -1, immTo: -1 };
  const instr = INSTRUCTIONS[mnemonic];
  if (!ops.length || !instr || !IMM_TYPES.has(instr.type)) return none;

  const starts = [];
  let at = mnemonic.length + 1;
  for (const op of ops) { starts.push(at); at += op.length + 2; }

  // offset(base) carries the number in front of the bracket; every other
  // format that has one carries it as the last operand.
  for (let i = 0; i < ops.length; i++) {
    const m = /^([^(]+)\(/.exec(ops[i]);
    if (m) return { text, immFrom: starts[i], immTo: starts[i] + m[1].length };
  }
  const last = ops.length - 1;
  if (toHwRegName(ops[last])) return none;
  return { text, immFrom: starts[last], immTo: starts[last] + ops[last].length };
}

// The immediate as the *encoding* holds it, which is not always what the
// source said: a literal written in hex, the same value written in decimal
// and one a pseudo-op computed all land in the same field.
function nativeImmInfo(mnemonic, word, address) {
  const instr = INSTRUCTIONS[mnemonic];
  if (!instr) return null;
  const sext = (v, bits) => (v << (32 - bits)) >> (32 - bits);
  const w = word >>> 0;
  switch (instr.type) {
    case 'U':
      return { kind: 'u20', value: (w >>> 12) & 0xFFFFF, mnemonic };
    case 'J': {
      const raw = (((w >>> 31) & 1) << 20) | (((w >>> 12) & 0xFF) << 12) |
                  (((w >>> 20) & 1) << 11) | (((w >>> 21) & 0x3FF) << 1);
      const off = sext(raw, 21);
      return { kind: 'target', value: (address + off) >>> 0, offset: off, mnemonic };
    }
    case 'B': {
      const raw = (((w >>> 31) & 1) << 12) | (((w >>> 7) & 1) << 11) |
                  (((w >>> 25) & 0x3F) << 5) | (((w >>> 8) & 0xF) << 1);
      const off = sext(raw, 13);
      return { kind: 'target', value: (address + off) >>> 0, offset: off, mnemonic };
    }
    case 'S':
      return { kind: 'sext', value: sext((((w >>> 25) & 0x7F) << 5) | ((w >>> 7) & 0x1F), 12), mnemonic };
    case 'I':
      if (SHIFT_IMM_OPS.has(mnemonic)) return { kind: 'shamt', value: (w >>> 20) & 0x1F, mnemonic };
      return { kind: 'sext', value: sext((w >>> 20) & 0xFFF, 12), mnemonic };
    default:
      return null;
  }
}

// What else this field can legally be read as. Only spellings a RISC-V
// assembler accepts are offered: a 12-bit signed field may be written as
// the signed value or as its full 32-bit two's complement, but never as
// the raw 12 bits read unsigned, and a genuinely unsigned field (a shift
// amount, lui's 20 bits) has no signed reading at all. An empty list
// means the operand as shown is already the whole story.
function nativeImmReadings(info) {
  if (!info) return [];
  const hex = v => '0x' + (v >>> 0).toString(16);
  const addr = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');
  if (info.kind === 'target') {
    const off = info.offset;
    return [['target', addr(info.value)],
            ['offset', (off < 0 ? '−' : '+') + Math.abs(off) + ' bytes from this instruction']];
  }
  if (info.kind === 'u20') {
    const shifted = (info.value << 12) >>> 0;
    return [['decimal', String(info.value)],
            ['hex', hex(info.value)],
            [info.mnemonic === 'auipc' ? 'adds' : 'loads', addr(shifted)]];
  }
  if (info.kind === 'shamt') {
    if (info.value < 10) return [];
    return [['decimal', String(info.value)], ['hex', hex(info.value)]];
  }
  if (info.value < 0) {
    return [['signed', String(info.value)],
            ['hex', hex(info.value)],
            ['unsigned', String(info.value >>> 0)]];
  }
  if (info.value < 10) return [];
  return [['decimal', String(info.value)], ['hex', hex(info.value)]];
}

// GNU as directives that need no code generation in this simulator.
const DIRECTIVE_NOOP = new Set([
  '.globl', '.global', '.type', '.size', '.option', '.macro', '.endm', '.end',
  '.file', '.ident', '.comm', '.lcomm', '.pushsection', '.popsection',
  '.altmacro', '.noaltmacro', '.weak', '.local', '.extern', '.hidden', '.protected',
  '.attribute', '.cfi_sections', '.cfi_startproc', '.cfi_endproc', '.cfi_def_cfa_offset',
  '.cfi_offset', '.cfi_restore', '.cfi_def_cfa_register', '.cfi_def_cfa',
  '.loc', '.addrsig', '.addrsig_sym', '.line', '.custom'
]);

const LOAD_MNEMONICS = ['lb', 'lh', 'lw', 'lbu', 'lhu', 'flw', 'fld'];
const STORE_MNEMONICS = ['sb', 'sh', 'sw', 'fsw', 'fsd'];

// Directives that switch to the data segment on their own, without .section.
const DATA_SECTION_DIRECTIVES = new Set(['.data', '.rodata', '.bss', '.sdata', '.sbss', '.tdata', '.tbss']);

// Width of each data directive. A line holding only values continues the
// directive above it, so both passes size that line from this one table;
// two lists that disagreed would put every later label at an address the
// bytes are not at.
const DATA_DIRECTIVE_WIDTH = {
  '.byte': 1,
  '.half': 2, '.2byte': 2, '.short': 2,
  '.word': 4, '.4byte': 4, '.int': 4, '.long': 4,
  '.dword': 8, '.8byte': 8, '.quad': 8,
};

// Map a section name (possibly quoted / dot-prefixed) to 'text' or 'data'.
function setSection(name) {
  const raw = String(name || '').split(',')[0].replace(/["']/g, '').replace(/^\./, '').trim().toLowerCase();
  if (raw.startsWith('text')) return 'text';
  if (/^(data|rodata|bss|sdata|sbss|tdata|tbss)/.test(raw)) return 'data';
  return null;
}

function assemble(source, startAddr) {
  const base = (startAddr !== undefined) ? startAddr : layout.baseAddress;
  const lines = source.split('\n');
  const output = [];
  program.labels = {};
  program.symbolTable = {};

  const splitLine = (line) => {
    let idx = line.indexOf('#');
    const idx2 = line.indexOf(';');
    if (idx < 0 || (idx2 >= 0 && idx2 < idx)) idx = idx2;
    const idx3 = line.indexOf('//');
    if (idx < 0 || (idx3 >= 0 && idx3 < idx)) idx = idx3;
    return { main: (idx >= 0 ? line.substring(0, idx) : line).trim(), comment: idx >= 0 ? line.substring(idx) : '' };
  };
  const parseArgs = (s) => {
    const toks = s.trim().split(/\s+/);
    return toks.slice(1).join(' ').split(',').map(t => t.trim()).filter(t => t);
  };

  // ---- Pre-pass: collect .equ/.eqv/.set constants (earlier ones usable in later ones) ----
  for (let i = 0; i < lines.length; i++) {
    const { main } = splitLine(lines[i]);
    const m = main.match(/^\.(equ|eqv|set)\s+(\w+)\s*,?\s*(.+)$/i);
    if (m) {
      const val = parseImm(m[3].trim());
      if (!isNaN(val)) program.symbolTable[m[2]] = val;
    }
  }

  // ---- Phase 1: assign addresses & collect labels ----
  let textAddr = base, dataAddr = layout.dataBase, section = 'text';
  let activeDataDirPass1 = null;
  const getAddr = () => section === 'text' ? textAddr : dataAddr;
  const setAddr = (a) => { if (section === 'text') textAddr = a; else dataAddr = a; };
  const bump = (n) => setAddr(getAddr() + n);
  const alignedAddr = (n) => (getAddr() + (n - 1)) & ~(n - 1);
  // .align and .p2align take a power of two, .balign a byte count.
  const alignmentOf = (mn, arg) => {
    const n = parseInt(arg, 10) || 0;
    if (n <= 0) return 0;
    return mn === '.balign' ? n : (1 << n);
  };
  // Same reading in both passes, so a size written in hex or as a
  // constant reserves what it says rather than parseInt's 0.
  const spaceCount = (arg) => {
    const n = parseImm(arg);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  // Labels seen since the last real byte was placed. If the next
  // directive aligns forward (`var1: .word 1`), these move with it, so
  // `var1` names the aligned address rather than wherever the colon fell.
  let pendingLabelNames = [];
  const alignAddrForLabels = (newAddr) => {
    const oldAddr = getAddr();
    if (newAddr === oldAddr) return;
    setAddr(newAddr);
    for (const name of pendingLabelNames) {
      if (program.labels[name] === oldAddr) program.labels[name] = newAddr;
    }
  };

  const sizeLine = (main) => {
    const toks = main.split(/\s+/);
    const mn = toks[0].toLowerCase();
    if (mn === '.text') { section = 'text'; activeDataDirPass1 = null; return; }
    if (DATA_SECTION_DIRECTIVES.has(mn)) {
      section = 'data';
      activeDataDirPass1 = null;
      return;
    }
    if (mn === '.section') {
      const s = setSection(toks[1] || mn);
      section = s || 'ignore';
      activeDataDirPass1 = null;
      return;
    }
    if (section === 'ignore') return;
    switch (mn) {
      case '.equ': case '.eqv': case '.set': break; // constants already collected in the pre-pass
      case '.align': case '.balign': case '.p2align': {
        const a = alignmentOf(mn, toks[1]);
        if (a > 1) alignAddrForLabels(alignedAddr(a));
        break;
      }
      case '.org': {
        // Forward only, as in pass 2, which has no way to emit backwards.
        const o = parseImm(toks.slice(1).join(' '), true);
        if (!isNaN(o) && o >= getAddr()) alignAddrForLabels(o);
        pendingLabelNames = [];
        break;
      }
      case '.word': case '.4byte': case '.int': case '.long':
      case '.half': case '.2byte': case '.short':
      case '.byte':
      case '.dword': case '.8byte': case '.quad': {
        activeDataDirPass1 = mn;
        const vals = toks.slice(1).join('').split(',').filter(Boolean);
        const sz = DATA_DIRECTIVE_WIDTH[mn];
        // Align to the directive's own width before placing it.
        if (sz > 1) alignAddrForLabels(alignedAddr(sz));
        bump(sz * vals.length);
        pendingLabelNames = [];
        break;
      }
      case '.space': case '.zero': {
        bump(spaceCount(toks[1]));
        pendingLabelNames = [];
        break;
      }
      case '.asciiz': case '.asciz': case '.string': {
        const qIdx = main.search(/["']/);
        const s = (qIdx >= 0) ? main.slice(qIdx) : main.replace(/^\s*\.\w+\s*/, '').trim();
        bump(parseStringLiteral(s).length + 1);
        pendingLabelNames = [];
        break;
      }
      case '.ascii': {
        const qIdx = main.search(/["']/);
        const s = (qIdx >= 0) ? main.slice(qIdx) : main.replace(/^\s*\.\w+\s*/, '').trim();
        bump(parseStringLiteral(s).length);
        pendingLabelNames = [];
        break;
      }
      default:
        if (INSTRUCTIONS[mn] || PSEUDO_INSTRUCTIONS[mn]) bump((instructionSlots(mn, parseArgs(main)) || 1) * 4);
        else if (!mn.startsWith('.')) bump(4); // unknown mnemonic: keep labels roughly aligned
        pendingLabelNames = [];
    }
  };

  // Problems found while collecting labels, reported once `push` exists.
  const labelDiagnostics = [];
  // Word/half accesses whose offset is not a multiple of the access size.
  const misalignedAccesses = [];

  for (let i = 0; i < lines.length; i++) {
    let { main } = splitLine(lines[i]);
    if (!main) continue;
    let first = main.split(/\s+/)[0];
    if (section === 'data' && activeDataDirPass1 && !first.endsWith(':') && !first.startsWith('.') && !INSTRUCTIONS[first.toLowerCase()] && !PSEUDO_INSTRUCTIONS[first.toLowerCase()]) {
      main = activeDataDirPass1 + ' ' + main;
      first = activeDataDirPass1;
    }
    if (first.endsWith(':')) {
      const labelName = first.slice(0, -1);
      // A duplicate label would silently win over the first, and a
      // label named after a register can never be reached (`j t0`
      // jumps to whatever x5 holds - parseReg wins).
      if (program.labels[labelName] !== undefined) {
        labelDiagnostics.push({ line: i + 1, text: lines[i],
          message: `Label '${labelName}' is defined more than once. Every reference ` +
            `to it resolves to the last definition, so rename one of them.` });
      } else if (parseReg(labelName) >= 0) {
        labelDiagnostics.push({ line: i + 1, text: lines[i],
          message: `'${labelName}' is a register name, so it cannot be used as a label ` +
            `\u2014 \`j ${labelName}\` reads it as the register, not as this address. ` +
            `Rename the label.` });
      }
      program.labels[labelName] = getAddr();
      pendingLabelNames.push(labelName);
      const rest = main.slice(first.length).trim();
      if (rest) sizeLine(rest);
      continue;
    }
    sizeLine(main);
  }

  // ---- Phase 2: emit encoded bytes ----
  textAddr = base; dataAddr = layout.dataBase; section = 'text';

  const push = (item) => { output.push(item); };
  asmAlignmentSink = misalignedAccesses;

  for (const d of labelDiagnostics) {
    push({ address: base, bytes: null, text: d.text, line: d.line,
           error: d.message, asmLine: d.text });
  }

  const pushInstr = (mnMnemonic, args, address, lineNo, asmText, isPseudo = false) => {
    const encoding = encodeInstruction(mnMnemonic, args, address);
    if (encoding === null) throw new Error('Encoding failed');
    const nat = buildNativeInstruction(mnMnemonic, args);
    const word = ((encoding[3] << 24) | (encoding[2] << 16) | (encoding[1] << 8) | encoding[0]) >>> 0;
    push({ address, bytes: encoding, text: asmText, native: nat.text,
           immFrom: nat.immFrom, immTo: nat.immTo,
           imm: nat.immFrom >= 0 ? nativeImmInfo(mnMnemonic, word, address) : null,
           isPseudo, line: lineNo, asmLine: asmText });
    bump(4);
  };

  // A symbol is reached PC-relatively, the way the toolchain reaches it:
  // `auipc` and then a 12-bit signed offset, with the carry into the upper
  // half when that offset comes out negative. `la` already expands this
  // way, so this is also what makes `lw rd, sym` and
  // `la rd, sym; lw rd, 0(rd)` build the same address.
  const pcRelHiLo = (target, here) => {
    const d = target - here;
    const hi20 = Math.floor((d + 0x800) / 4096) & 0xFFFFF;
    return { hi20, lo: d - (hi20 << 12) };
  };

  const emitPseudo = (mn, args, address, lineNo, asmText) => {
    checkPseudoArity(mn, args);
    if (mn === 'la' || mn === 'lla' || mn === 'lga' || mn === 'call' || mn === 'tail') {
      // figure registers & second instruction depending on pseudo
      let target, rdA, rdJ, rsJ, second;
      if (mn === 'la' || mn === 'lla' || mn === 'lga') {
        // la/lla/lga rd, symbol => auipc rd, %pcrel_hi ; addi rd, rd, %pcrel_lo
        const rd = parseReg(args[0]);
        rdA = rd; rdJ = rd; rsJ = rd;
        target = args[1];
        second = 'addi';
      } else {
        // call : auipc ra, hi ; jalr ra, lo(ra)
        // tail : auipc t1(x6), hi ; jalr x0, lo(x6)
        if (mn === 'call') { rdA = 1; rdJ = 1; rsJ = 1; }
        else { rdA = 6; rdJ = 0; rsJ = 6; }
        target = args[0];
        second = 'jalr';
      }
      if (rdA < 0) throw new Error(badRegOperand(mn, args) || `Invalid register in ${mn}`);
      // Encoded through pushInstr like any other instruction, so the rows
      // carry the same immediate readings, and the auipc operand is the
      // 20-bit field the lw/sw symbol expansions also print.
      const rel = pcRelHiLo(resolveAddrRef(target), address);
      pushInstr('auipc', [`x${rdA}`, String(rel.hi20)], address, lineNo, asmText, true);
      if (second === 'addi') {
        pushInstr('addi', [`x${rdA}`, `x${rdA}`, String(rel.lo)], getAddr(), lineNo, asmText, true);
      } else {
        pushInstr('jalr', [`x${rdJ}`, `x${rsJ}`, String(rel.lo)], getAddr(), lineNo, asmText, true);
      }
      return;
    }
    const lines2 = expandPseudoLines(mn, args);
    for (let k = 0; k < lines2.length; k++) {
      const e = lines2[k];
      const eargs = parseArgs(e);
      const emn = e.split(/\s+/)[0].toLowerCase();
      pushInstr(emn, eargs, getAddr(), lineNo, asmText, true);
    }
  };

  function emitOne(main, lineNo, asmText) {
    const toks = main.split(/\s+/);
    const mn = toks[0].toLowerCase();
    const args = parseArgs(main);
    const padTo = (target) => {
      const pad = target - getAddr();
      if (pad > 0) { push({ address: getAddr(), bytes: new Array(pad).fill(0), text: asmText, line: lineNo, asmLine: main }); bump(pad); }
    };
    try {
      if (INSTRUCTIONS[mn]) {
        // `op reg, symbol, rt`: rt is the scratch register that carries
        // the upper half of the address, for a load and a store alike.
        if (args.length === 3 && (LOAD_MNEMONICS.includes(mn) || STORE_MNEMONICS.includes(mn))) {
          const target = resolveAddrRef(args[1]);
          const rt = args[2];
          const here = getAddr();
          const rel = pcRelHiLo(target, here);
          pushInstr('auipc', [rt, String(rel.hi20)], here, lineNo, asmText, true);
          pushInstr(mn, [args[0], String(rel.lo) + `(${rt})`], getAddr(), lineNo, asmText, true);
          return;
        }

        // `load rd, symbol`: rd itself carries the upper half.
        if (LOAD_MNEMONICS.includes(mn)) {
          if (args.length === 2) {
            const mem = parseMemOp(args[1]);
            if (mem && mem.reg === 0) {
              const addr = mem.offset;
              if (addr > 2047 || addr < -2048) {
                // The address has to be built in a register first. For an
                // integer load that register is rd itself, which the load
                // is about to overwrite anyway - nothing else is touched.
                // A float load has no such register (rd is in the FP file),
                // so the scratch register must be named explicitly.
                if (['flw', 'fld'].includes(mn)) {
                  throw new Error(
                    `${mn} ${args[0]}, ${args[1]} needs a scratch register: write ` +
                    `\`${mn} ${args[0]}, ${args[1]}, t0\`. Building the address of ` +
                    `'${args[1]}' takes an integer register, and ${mn} has none to spare.`);
                }
                const tmpReg = 'x' + parseReg(args[0]);
                const here = getAddr();
                const rel = pcRelHiLo(addr, here);
                pushInstr('auipc', [tmpReg, String(rel.hi20)], here, lineNo, asmText, true);
                pushInstr(mn, [args[0], String(rel.lo) + `(${tmpReg})`], getAddr(), lineNo, asmText, true);
                return;
              }
            }
          }
        }

        // `store rs2, symbol` has no register to spare.
        if (STORE_MNEMONICS.includes(mn)) {
          if (args.length === 2) {
            const mem = parseMemOp(args[1]);
            if (mem && mem.reg === 0) {
              const addr = mem.offset;
              if (addr > 2047 || addr < -2048) {
                // Unlike a load, a store has no register it is free to
                // overwrite: rs2 holds the value being stored. Picking a
                // scratch register here would clobber one of the student's
                // live registers without saying so, so the third operand
                // is required - the same rule GNU as applies.
                throw new Error(
                  `${mn} ${args[0]}, ${args[1]} would need a scratch register to hold ` +
                  `the address of '${args[1]}', and would silently overwrite it. Name ` +
                  `it: \`${mn} ${args[0]}, ${args[1]}, t1\` assembles to ` +
                  `\`auipc t1, %pcrel_hi(${args[1]})\` then \`${mn} ${args[0]}, %pcrel_lo(${args[1]})(t1)\`. ` +
                  `Pick a register you do not need.`);
              }
            }
          }
        }

        pushInstr(mn, args, getAddr(), lineNo, asmText);
      } else if (PSEUDO_INSTRUCTIONS[mn]) {
        emitPseudo(mn, args, getAddr(), lineNo, asmText);
      } else {
        switch (mn) {
          case '.text': section = 'text'; break;
          case '.data': section = 'data'; break;
          case '.section': case '.rodata': case '.bss': {
            const s = setSection(toks[1] || mn);
            if (s) section = s;
            break;
          }
          case '.equ': case '.eqv': case '.set': break; // constant, resolved at pre-pass time
          case '.align': case '.balign': case '.p2align': {
            const a = alignmentOf(mn, toks[1]);
            if (a > 1) padTo(alignedAddr(a));
            break;
          }
          case '.org': {
            const o = parseImm(toks.slice(1).join(' '));
            if (!isNaN(o)) padTo(o);
            break;
          }
          case '.word': case '.4byte': case '.int': case '.long':
          case '.half': case '.2byte': case '.short':
          case '.byte': {
            const sz = DATA_DIRECTIVE_WIDTH[mn];
            // Same alignment as sizeLine() in pass 1, emitted as real
            // padding bytes so the two passes' addresses agree.
            if (sz > 1) padTo(alignedAddr(sz));
            const vals = toks.slice(1).join('').split(',').filter(Boolean);
            const bytesArr = [];
            for (const v of vals) {
              const val = parseImm(v);
              if (isNaN(val)) throw new Error(`Bad numeric value '${v}' in ${mn}`);
              // Accept either the signed or the unsigned range for the
              // width, and reject the rest rather than truncate silently.
              const lo = -(2 ** (sz * 8 - 1));
              const hi = 2 ** (sz * 8) - 1;
              if (val < lo || val > hi) {
                throw new Error(`${val} does not fit in ${mn} (${sz} byte${sz > 1 ? 's' : ''}, ` +
                  `${lo} to ${hi}). It would be truncated to ` +
                  `${(val >>> 0) & (sz === 4 ? 0xFFFFFFFF : (2 ** (sz * 8) - 1))}.`);
              }
              const usz = val >>> 0;
              for (let b = 0; b < sz; b++) bytesArr.push((usz >> (b * 8)) & 0xFF);
            }
            if (bytesArr.length) { push({ address: getAddr(), bytes: bytesArr, text: asmText, line: lineNo, asmLine: main }); bump(bytesArr.length); }
            break;
          }
          case '.dword': case '.8byte': case '.quad': {
            padTo(alignedAddr(8));
            const vals = toks.slice(1).join('').split(',').filter(Boolean);
            const bytesArr = [];
            for (const v of vals) {
              // BigInt keeps all 64 bits of a literal; a symbol is at most 32.
              let big;
              try { big = BigInt(v.replace(/_/g, '')); } catch (e) {
                const n = parseImm(v);
                if (isNaN(n)) throw new Error(`Bad numeric value '${v}' in ${mn}`);
                big = BigInt(n);
              }
              const usz = BigInt.asUintN(64, big);
              for (let b = 0; b < 8; b++) bytesArr.push(Number((usz >> BigInt(b * 8)) & 0xFFn));
            }
            push({ address: getAddr(), bytes: bytesArr, text: asmText, line: lineNo, asmLine: main }); bump(bytesArr.length);
            break;
          }
          case '.space': case '.zero':
            padTo(getAddr() + spaceCount(toks[1]));
            break;
          case '.asciiz': case '.asciz': case '.string': case '.ascii': {
            const qIdx = main.search(/["']/);
            const s = (qIdx >= 0) ? main.slice(qIdx) : main.replace(/^\s*\.\w+\s*/, '').trim();
            const bytes = parseStringLiteral(s);
            if (mn !== '.ascii') bytes.push(0);
            push({ address: getAddr(), bytes: bytes, text: asmText, line: lineNo, asmLine: main }); bump(bytes.length);
            break;
          }
          default: {
            if (DIRECTIVE_NOOP.has(mn)) break;
            push({ address: getAddr(), bytes: null, text: asmText, line: lineNo, error: `Unknown mnemonic or directive '${mn}'`, asmLine: main });
            bump(4);
          }
        }
      }
    } catch (e) {
      push({ address: getAddr(), bytes: null, text: asmText, line: lineNo, error: e.message, asmLine: main });
      bump(4);
    }
  }

  let activeDataDirPass2 = null;
  for (let i = 0; i < lines.length; i++) {
    let { main, comment } = splitLine(lines[i]);
    const lineNo = i + 1;
    const asmText = main + (comment ? ' ' + comment : '');
    if (!main) continue;
    let first = main.split(/\s+/)[0];
    const mnLow = first.toLowerCase();
    if (mnLow === '.text' || mnLow === '.section' || DATA_SECTION_DIRECTIVES.has(mnLow)) {
      if (mnLow === '.text') section = 'text';
      else if (DATA_SECTION_DIRECTIVES.has(mnLow)) section = 'data';
      else {
        const s = setSection(main.split(/\s+/)[1] || mnLow);
        section = s || 'ignore';
      }
      activeDataDirPass2 = null;
      continue;
    }
    if (section === 'ignore') continue;
    if (DATA_DIRECTIVE_WIDTH[mnLow]) {
      activeDataDirPass2 = mnLow;
    } else if (section === 'data' && activeDataDirPass2 && !first.endsWith(':') && !first.startsWith('.') && !INSTRUCTIONS[mnLow] && !PSEUDO_INSTRUCTIONS[mnLow]) {
      main = activeDataDirPass2 + ' ' + main;
      first = activeDataDirPass2;
    }
    if (first.endsWith(':')) {
      const rest = main.slice(first.length).trim();
      if (!rest) continue;
      const rfirst = rest.split(/\s+/)[0].toLowerCase();
      if (DATA_DIRECTIVE_WIDTH[rfirst]) activeDataDirPass2 = rfirst;
      emitOne(rest, lineNo, asmText);
      continue;
    }
    emitOne(main, lineNo, asmText);
  }

  asmAlignmentSink = null;

  // `ecall` works here because the simulator implements the RARS syscall
  // services. A processor on the board does not: it has no trap support
  // and there is no OS or ISR behind it. Say so once per
  // assemble, in assembly mode only - every compiled C program ends with
  // the CRT0 shim's exit ecall, which is ours, not the student's.
  if (editorLanguageMode !== 'c') {
    const ecalls = output.filter(o => o.bytes && /^\s*ecall\b/i.test(
      String(o.native || o.text || '').trim())).length;
    if (ecalls) {
      log(`ℹ️ This program uses ecall (${ecalls} site${ecalls === 1 ? '' : 's'}). ` +
          `The simulator implements the RARS syscall services, but a processor on ` +
          `the board does not: it needs trap support in your processor and an OS or ` +
          `ISR to service the trap, and the Wrapper provides neither. Programs meant ` +
          `for the board should use the MMIO peripherals instead.`, 'info');
    }
  }

  if (misalignedAccesses.length) {
    const seen = new Map();
    for (const a of misalignedAccesses) {
      const k = a.mnemonic + ':' + a.offset;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    const shown = Array.from(seen.keys()).slice(0, 6)
      .map(k => '`' + k.split(':')[0] + ' …, ' + k.split(':')[1] + '(rs1)`').join(', ');
    log(`⚠️ WARNING: ${misalignedAccesses.length} memory access(es) use an offset that ` +
        `is not a multiple of the access size — ${shown}` +
        (seen.size > 6 ? ', …' : '') + `. This only works if the base register makes up ` +
        `the difference. The Wrapper's data memory is word-addressed, so on hardware a ` +
        `misaligned word access reads or writes a different word than it does here.`, 'warn');
  }

  program.codeOverflowWords = 0;
  const totalCodeBytes = Math.max(0, textAddr - base);
  if (totalCodeBytes > layout.codeSize) {
    const overWords = Math.ceil((totalCodeBytes - layout.codeSize) / 4);
    log(`⚠️ Code is ${totalCodeBytes} bytes, ${totalCodeBytes - layout.codeSize} over the ` +
        `${layout.codeSize}-byte Code segment — ${overWords} instruction` +
        `${overWords === 1 ? '' : 's'} that will not be loaded. Raise ` +
        `"Code (.text) size" in Settings → Linker, and IROM_DEPTH_BITS in Wrapper ` +
        `for HDL mode.`, 'warn');
    program.codeOverflowWords = overWords;
  }

  const totalDataBytes = Math.max(0, dataAddr - layout.dataBase);
  if (totalDataBytes > layout.dataSize && editorLanguageMode !== 'c') {
    log(`⚠️ Data is ${totalDataBytes} bytes, ${totalDataBytes - layout.dataSize} over the ` +
        `${layout.dataSize}-byte Data segment. Raise "Data (.data) size" in Settings → Linker, ` +
        `and DMEM_DEPTH_BITS in Wrapper for HDL mode.`, 'warn');
  }

  return output;
}

function parseStringLiteral(s) {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.substring(1, s.length - 1);
  }
  let result = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const octMatch = s.slice(i + 1).match(/^[0-7]{1,3}/);
      if (octMatch) {
        const octVal = parseInt(octMatch[0], 8);
        result.push(octVal & 0xFF);
        i += octMatch[0].length;
        continue;
      }
      const hexMatch = s.slice(i + 1).match(/^x[0-9a-fA-F]{1,2}/i);
      if (hexMatch) {
        const hexVal = parseInt(hexMatch[0].slice(1), 16);
        result.push(hexVal & 0xFF);
        i += hexMatch[0].length;
        continue;
      }
      switch (s[i + 1]) {
        case 'n': result.push(10); break;
        case 't': result.push(9); break;
        case 'r': result.push(13); break;
        case '0': result.push(0); break;
        case 'a': result.push(7); break;
        case 'b': result.push(8); break;
        case 'f': result.push(12); break;
        case 'v': result.push(11); break;
        case '\\': result.push(92); break;
        case '"': result.push(34); break;
        case "'": result.push(39); break;
        default: result.push(s.charCodeAt(i + 1) & 0xFF);
      }
      i++;
    } else {
      result.push(s.charCodeAt(i) & 0xFF);
    }
  }
  return result;
}

// How many operands each instruction takes.
//
// Without this, a missing operand would be quietly filled in with x0 or 0 -
// `add t0, t1` assembling as `add t0, t1, x0` and `slli t0, t1` as a shift
// by zero - and a surplus one dropped on the floor. Both produce a program
// that runs and is wrong, with nothing on screen to say so.
const INSTR_ARITY = {
  // rd, rs1  (one source operand only)
  'fmv.x.w': [2], 'fclass.s': [2], 'fclass.d': [2],
  'fcvt.w.s': [2], 'fcvt.wu.s': [2], 'fcvt.w.d': [2], 'fcvt.wu.d': [2],
  'fcvt.s.w': [2], 'fcvt.s.wu': [2], 'fmv.w.x': [2],
  'fcvt.d.w': [2], 'fcvt.d.wu': [2],
  'fsqrt.s': [2], 'fsqrt.d': [2], 'fcvt.s.d': [2], 'fcvt.d.s': [2],
  'lr.w': [2],
  // no operands at all
  'ecall': [0], 'ebreak': [0], 'fence': [0, 2],
  // rd, offset(rs1)  |  rd, symbol, rt  |  (jalr also: rs)
  'jalr': [1, 2, 3],
  // rd, offset  |  offset
  'jal': [1, 2],
};

// Loads and stores accept `rd, offset(rs1)` or `rd, symbol, rt`.
const MEMORY_ARITY = [2, 3];

function allowedArity(mnemonic, instr) {
  if (INSTR_ARITY[mnemonic]) return INSTR_ARITY[mnemonic];
  if (LOAD_MNEMONICS.includes(mnemonic) || STORE_MNEMONICS.includes(mnemonic)) return MEMORY_ARITY;
  switch (instr.type) {
    case 'R': return [3];
    case 'R4': return [4];
    case 'I': return [3];
    case 'S': return MEMORY_ARITY;
    case 'B': return [3];
    case 'U': return [2];
    case 'J': return [1, 2];
    default: return null;   // unknown shape - do not guess
  }
}

function checkArity(mnemonic, args, instr) {
  const want = allowedArity(mnemonic, instr);
  if (!want) return;
  const got = args.length;
  if (want.includes(got)) return;
  const list = want.length === 1
    ? `${want[0]}`
    : want.slice(0, -1).join(', ') + ' or ' + want[want.length - 1];
  const shape = INSTRUCTION_SHAPES[mnemonic];
  throw new Error(
    `${mnemonic} takes ${list} operand${want.length === 1 && want[0] === 1 ? '' : 's'}, ` +
    `but ${got} ${got === 1 ? 'was' : 'were'} given` +
    (shape ? ` \u2014 write \`${shape}\`` : '') + '.');
}

// The canonical written form, for the message above. Only the shapes a
// student actually types; anything missing simply omits the hint.
const INSTRUCTION_SHAPES = {
  add: 'add rd, rs1, rs2', sub: 'sub rd, rs1, rs2', and: 'and rd, rs1, rs2',
  or: 'or rd, rs1, rs2', xor: 'xor rd, rs1, rs2', sll: 'sll rd, rs1, rs2',
  srl: 'srl rd, rs1, rs2', sra: 'sra rd, rs1, rs2', slt: 'slt rd, rs1, rs2',
  sltu: 'sltu rd, rs1, rs2', mul: 'mul rd, rs1, rs2', div: 'div rd, rs1, rs2',
  rem: 'rem rd, rs1, rs2',
  addi: 'addi rd, rs1, imm', andi: 'andi rd, rs1, imm', ori: 'ori rd, rs1, imm',
  xori: 'xori rd, rs1, imm', slti: 'slti rd, rs1, imm', sltiu: 'sltiu rd, rs1, imm',
  slli: 'slli rd, rs1, shamt', srli: 'srli rd, rs1, shamt', srai: 'srai rd, rs1, shamt',
  lw: 'lw rd, offset(rs1)  or  lw rd, symbol', lh: 'lh rd, offset(rs1)',
  lb: 'lb rd, offset(rs1)', lhu: 'lhu rd, offset(rs1)', lbu: 'lbu rd, offset(rs1)',
  sw: 'sw rs2, offset(rs1)  or  sw rs2, symbol, rt',
  sh: 'sh rs2, offset(rs1)', sb: 'sb rs2, offset(rs1)',
  beq: 'beq rs1, rs2, label', bne: 'bne rs1, rs2, label',
  blt: 'blt rs1, rs2, label', bge: 'bge rs1, rs2, label',
  bltu: 'bltu rs1, rs2, label', bgeu: 'bgeu rs1, rs2, label',
  lui: 'lui rd, imm20', auipc: 'auipc rd, imm20',
  jal: 'jal rd, label  or  jal label', jalr: 'jalr rd, offset(rs1)',
  ecall: 'ecall', ebreak: 'ebreak',
};

// The rm field. dyn reads frm, which is never written here and so stays
// rne; that is also the only mode the arithmetic uses (the conversions to
// integer honour all of them).
const FP_ROUNDING_MODES = { rne: 0, rtz: 1, rdn: 2, rup: 3, rmm: 4, dyn: 7 };

// Which instructions carry rm, and what GNU as encodes when the source
// gives none: dyn, except for the conversions that are always exact.
const FP_RM_DEFAULT = {};
['fadd', 'fsub', 'fmul', 'fdiv', 'fsqrt', 'fmadd', 'fmsub', 'fnmsub', 'fnmadd'].forEach(op => {
  FP_RM_DEFAULT[op + '.s'] = 7;
  FP_RM_DEFAULT[op + '.d'] = 7;
});
['fcvt.w.s', 'fcvt.wu.s', 'fcvt.s.w', 'fcvt.s.wu', 'fcvt.w.d', 'fcvt.wu.d', 'fcvt.s.d']
  .forEach(op => { FP_RM_DEFAULT[op] = 7; });
['fcvt.d.w', 'fcvt.d.wu', 'fcvt.d.s'].forEach(op => { FP_RM_DEFAULT[op] = 0; });

// Set by assemble() so encodeInstruction can report a misaligned offset
// without threading a collector through every call site.
let asmAlignmentSink = null;

// The Wrapper's data memory is word-addressed, so an access whose offset is
// not a multiple of its size reads or writes a different word on hardware
// than it does here. The base register's value is unknown at assembly time,
// so this is a warning, not an error.
const ACCESS_WIDTH = {
  lw: 4, sw: 4, flw: 4, fsw: 4,
  lh: 2, lhu: 2, sh: 2,
  fld: 8, fsd: 8,
};

function noteAlignment(mnemonic, args) {
  const width = ACCESS_WIDTH[mnemonic];
  if (!width || !asmAlignmentSink || args.length < 2) return;
  const operand = String(args[1] || '');
  if (!operand.includes('(')) return;       // symbol form: address is known-aligned
  const mem = parseMemOp(operand, true);
  if (!mem || isNaN(mem.offset)) return;
  if (mem.offset % width === 0) return;
  asmAlignmentSink.push({ mnemonic, offset: mem.offset, width });
}

function encodeInstruction(mnemonic, args, address) {
  const instr = INSTRUCTIONS[mnemonic];
  if (!instr) return null;

  // An FP instruction with an rm field takes an optional rounding mode as
  // its last operand; without one it gets GNU as's default.
  let fpRm = null;
  if (FP_RM_DEFAULT[mnemonic] !== undefined) {
    fpRm = FP_RM_DEFAULT[mnemonic];
    const normal = allowedArity(mnemonic, instr);
    if (normal && args.length === Math.max(...normal) + 1) {
      const name = String(args[args.length - 1]).trim().toLowerCase();
      fpRm = FP_ROUNDING_MODES[name];
      if (fpRm === undefined) {
        throw new Error(`'${args[args.length - 1]}' is not a rounding mode. Write one of ` +
          `${Object.keys(FP_ROUNDING_MODES).join(', ')}.`);
      }
      args = args.slice(0, -1);
    }
  }

  checkArity(mnemonic, args, instr);
  noteAlignment(mnemonic, args);

  let encoding = 0;

  switch (instr.type) {
    case 'R': {
      let rd = 0, rs1 = 0, rs2 = 0;
      const rm = fpRm !== null ? fpRm : instr.funct3;

      if (['feq.s', 'flt.s', 'fle.s', 'feq.d', 'flt.d', 'fle.d'].includes(mnemonic)) {
        rd = parseReg(args[0]);
        rs1 = parseFReg(args[1]);
        rs2 = parseFReg(args[2]);
      } else if (['fcvt.w.s', 'fcvt.wu.s', 'fmv.x.w', 'fclass.s', 'fcvt.w.d', 'fcvt.wu.d', 'fclass.d'].includes(mnemonic)) {
        rd = parseReg(args[0]);
        rs1 = parseFReg(args[1]);
        rs2 = instr.rs2 || 0;
      } else if (['fcvt.s.w', 'fcvt.s.wu', 'fmv.w.x', 'fcvt.d.w', 'fcvt.d.wu'].includes(mnemonic)) {
        rd = parseFReg(args[0]);
        rs1 = parseReg(args[1]);
        rs2 = instr.rs2 || 0;
      } else if (['fsqrt.s', 'fsqrt.d', 'fcvt.s.d', 'fcvt.d.s'].includes(mnemonic)) {
        rd = parseFReg(args[0]);
        rs1 = parseFReg(args[1]);
        rs2 = instr.rs2 || 0;
      } else if (mnemonic.startsWith('f') && ['fadd.s', 'fsub.s', 'fmul.s', 'fdiv.s', 'fsgnj.s', 'fsgnjn.s', 'fsgnjx.s', 'fmin.s', 'fmax.s', 'fadd.d', 'fsub.d', 'fmul.d', 'fdiv.d', 'fsgnj.d', 'fsgnjn.d', 'fsgnjx.d', 'fmin.d', 'fmax.d'].includes(mnemonic)) {
        rd = parseFReg(args[0]);
        rs1 = parseFReg(args[1]);
        rs2 = args.length >= 3 ? parseFReg(args[2]) : 0;
      } else if (['lr.w'].includes(mnemonic)) {
        rd = parseReg(args[0]);
        const m = parseMemOp(args[1]);
        rs1 = m ? m.reg : parseReg(args[1].replace(/[()]/g, ''));
        rs2 = 0;
      } else if (['sc.w'].includes(mnemonic) || mnemonic.startsWith('amo')) {
        rd = parseReg(args[0]);
        rs2 = parseReg(args[1]);
        const m = parseMemOp(args[2]);
        rs1 = m ? m.reg : parseReg(args[2].replace(/[()]/g, ''));
      } else {
        rd = parseReg(args[0]);
        rs1 = parseReg(args[1]);
        rs2 = args.length >= 3 ? parseReg(args[2]) : 0;
      }

      if (rd < 0 || rs1 < 0 || rs2 < 0) throw new Error(badRegOperand(mnemonic, args) || `Invalid register in ${mnemonic}`);

      encoding = (instr.funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (rm << 12) | (rd << 7) | instr.opcode;
      break;
    }

    case 'R4': {
      let rd = parseFReg(args[0]);
      let rs1 = parseFReg(args[1]);
      let rs2 = parseFReg(args[2]);
      let rs3 = parseFReg(args[3]);

      if (rd < 0 || rs1 < 0 || rs2 < 0 || rs3 < 0) throw new Error(badRegOperand(mnemonic, args) || `Invalid register in ${mnemonic}`);

      encoding = (rs3 << 27) | (instr.funct2 << 25) | (rs2 << 20) | (rs1 << 15) | (fpRm << 12) | (rd << 7) | instr.opcode;
      break;
    }

    case 'I': {
      let rd = 0, rs1 = 0, imm = 0;

      if (['lb', 'lh', 'lw', 'lbu', 'lhu', 'flw', 'fld'].includes(mnemonic)) {
        if (args.length >= 2) {
          rd = ['flw', 'fld'].includes(mnemonic) ? parseFReg(args[0]) : parseReg(args[0]);
          const mem = parseMemOp(args[1]);
          if (mem) {
            rs1 = mem.reg;
            imm = mem.offset;
          } else {
            rs1 = parseReg(args[1]);
            imm = args.length >= 3 ? parseImm(args[2]) : 0;
          }
        }
      } else if (['jalr'].includes(mnemonic)) {
        if (args.length === 1) {
          const mem = parseMemOp(args[0]);
          if (mem) {
            rd = 1;
            rs1 = mem.reg;
            imm = mem.offset;
          } else {
            rd = 1;
            rs1 = parseReg(args[0]);
            imm = 0;
          }
        } else if (args.length === 3) {
          // jalr rd, rs1, imm
          rd = parseReg(args[0]);
          rs1 = parseReg(args[1]);
          imm = parseImm(args[2]);
        } else {
          rd = parseReg(args[0]);
          const mem = parseMemOp(args[1]);
          if (mem) {
            rs1 = mem.reg;
            imm = mem.offset;
          } else {
            rs1 = parseReg(args[1]);
          }
        }
      } else if (['ecall', 'ebreak'].includes(mnemonic)) {
        rd = 0; rs1 = 0;
        imm = (mnemonic === 'ecall') ? 0 : 1;
        encoding = (imm << 20) | (0b000 << 12) | (0b00000 << 7) | (0b1110011);
        break;
      } else if (['addi', 'slti', 'sltiu', 'xori', 'ori', 'andi', 'addiw',
        'slli', 'srli', 'srai', 'slliw', 'srliw', 'sraiw'].includes(mnemonic)) {
        rd = parseReg(args[0]);
        rs1 = parseReg(args[1]);
        imm = parseImm(args[2]);
        if (['slli', 'srli', 'srai', 'slliw', 'srliw', 'sraiw'].includes(mnemonic)) {
          // RV32 shifts by 0-31. Masking with 0x1F would silently turn a
          // shift by 32 into a shift by 0, and one by 99 into a shift by 3.
          if (!isNaN(imm) && (imm < 0 || imm > 31)) {
            throw new Error(`${mnemonic} shift amount ${imm} is out of range \u2014 ` +
              `RV32 shifts by 0 to 31, and there is no encoding for more.`);
          }
        }
      } else if (mnemonic === 'fence') {
        // fence pred, succ: sets drawn from i, o, r, w. A bare fence
        // orders everything, as GNU as encodes it.
        const set = (t) => {
          const str = String(t == null ? 'iorw' : t).trim().toLowerCase();
          if (!/^[iorw]+$/.test(str)) throw new Error(`'${t}' is not a fence set - write letters from iorw`);
          return (str.includes('i') ? 8 : 0) | (str.includes('o') ? 4 : 0) |
                 (str.includes('r') ? 2 : 0) | (str.includes('w') ? 1 : 0);
        };
        rd = 0; rs1 = 0;
        imm = (set(args[0]) << 4) | set(args[1]);
      } else {
        rd = 0; rs1 = 0; imm = 0;
      }

      if (rd < 0 || rs1 < 0) throw new Error(badRegOperand(mnemonic, args) || `Invalid register in ${mnemonic}`);
      if (isNaN(imm)) throw new Error(`Invalid immediate '${args[2]}' in ${mnemonic}`);
      if (imm < -2048 || imm > 2047) throw new Error(`Immediate out of range: ${imm}`);

      const imm12 = imm & 0xFFF;

      if (['slli', 'srli', 'srai', 'slliw', 'srliw', 'sraiw'].includes(mnemonic)) {
        const funct7 = instr.funct7 || 0;
        const shamt = imm & 0x1F;
        encoding = (funct7 << 25) | (shamt << 20) | (rs1 << 15) | (instr.funct3 << 12) | (rd << 7) | instr.opcode;
      } else {
        encoding = (imm12 << 20) | (rs1 << 15) | (instr.funct3 << 12) | (rd << 7) | instr.opcode;
      }
      break;
    }

    case 'S': {
      let rs1 = 0, rs2 = 0, imm = 0;

      if (['sb', 'sh', 'sw', 'fsw', 'fsd'].includes(mnemonic)) {
        rs2 = ['fsw', 'fsd'].includes(mnemonic) ? parseFReg(args[0]) : parseReg(args[0]);
        if (args.length >= 2) {
          const mem = parseMemOp(args[1]);
          if (mem) {
            rs1 = mem.reg;
            imm = mem.offset;
          } else {
            rs1 = parseReg(args[1]);
            imm = args.length >= 3 ? parseImm(args[2]) : 0;
          }
        }
      }

      if (rs1 < 0 || rs2 < 0) throw new Error(badRegOperand(mnemonic, args) || `Invalid register in ${mnemonic}`);
      if (imm < -2048 || imm > 2047) throw new Error(`Immediate out of range: ${imm}`);

      const imm11_5 = (imm >> 5) & 0x7F;
      const imm4_0 = imm & 0x1F;
      encoding = (imm11_5 << 25) | (rs2 << 20) | (rs1 << 15) | (instr.funct3 << 12) | (imm4_0 << 7) | instr.opcode;
      break;
    }

    case 'B': {
      let rs1 = 0, rs2 = 0, imm = 0;

      rs1 = parseReg(args[0]);
      rs2 = parseReg(args[1]);

      const targetStr = args[2];
      let targetAddr;
      if (program.labels[targetStr] !== undefined) {
        targetAddr = program.labels[targetStr];
      } else if (program.symbolTable[targetStr] !== undefined) {
        targetAddr = program.symbolTable[targetStr];
      } else {
        const val = parseImm(targetStr);
        if (isNaN(val)) throw new Error(`Unknown label: ${targetStr}`);
        if (targetStr.startsWith('+') || targetStr.startsWith('-') || Math.abs(val) < layout.baseAddress) {
          targetAddr = address + val;
        } else {
          targetAddr = val;
        }
      }

      imm = targetAddr - address;

      if (rs1 < 0 || rs2 < 0) throw new Error(badRegOperand(mnemonic, args) || `Invalid register in ${mnemonic}`);
      if (imm & 1) throw new Error(`Branch target not aligned: ${targetStr}`);
      if (imm < -4096 || imm > 4095) throw new Error(`Branch offset out of range: ${imm}`);

      const bit12 = (imm >> 12) & 1;
      const bit10_5 = (imm >> 5) & 0x3F;
      const bit4_1 = (imm >> 1) & 0xF;
      const bit11 = (imm >> 11) & 1;

      encoding = (bit12 << 31) | (bit10_5 << 25) | (rs2 << 20) | (rs1 << 15) | (instr.funct3 << 12) |
        (bit4_1 << 8) | (bit11 << 7) | instr.opcode;
      break;
    }

    case 'U': {
      let rd = parseReg(args[0]);
      let imm = args.length >= 2 ? parseImm(args[1]) : 0;

      if (rd < 0) throw new Error(badRegOperand(mnemonic, args) || `Invalid register in ${mnemonic}`);
      if (isNaN(imm)) throw new Error(`Invalid immediate '${args[1]}' in ${mnemonic}`);

      // LUI/AUIPC take a 20-bit immediate directly. Masking it would
      // silently drop whatever did not fit, so `lui t0, 0x100000` would
      // load 0.
      if (imm > 0xFFFFF || imm < -0x80000) {
        throw new Error(`${mnemonic} immediate ${imm} does not fit the 20 bits ` +
          `${mnemonic} encodes (0 to 0xFFFFF). ${mnemonic} loads the UPPER 20 bits ` +
          `of a 32-bit value \u2014 for a full 32-bit constant use \`li\`, or ` +
          `\`%hi(symbol)\` for an address.`);
      }
      const uimm = imm & 0xFFFFF;
      encoding = (uimm << 12) | (rd << 7) | instr.opcode;
      break;
    }

    case 'J': {
      // 'jal <label>' is shorthand for 'jal ra, <label>'
      let rd = args.length >= 2 ? parseReg(args[0]) : 1;
      let targetStr = args.length >= 2 ? args[1] : args[0];
      let targetAddr;

      if (program.labels[targetStr] !== undefined) {
        targetAddr = program.labels[targetStr];
      } else if (program.symbolTable[targetStr] !== undefined) {
        targetAddr = program.symbolTable[targetStr];
      } else {
        const val = parseImm(targetStr);
        if (isNaN(val)) throw new Error(`Unknown label: ${targetStr}`);
        if (targetStr.startsWith('+') || targetStr.startsWith('-') || Math.abs(val) < layout.baseAddress) {
          targetAddr = address + val;
        } else {
          targetAddr = val;
        }
      }

      const imm = targetAddr - address;

      if (rd < 0) throw new Error(badRegOperand(mnemonic, args) || `Invalid register in ${mnemonic}`);
      if (imm & 1) throw new Error(`Jump target not aligned: ${targetStr}`);
      if (imm < -1048576 || imm > 1048575) throw new Error(`Jump offset out of range: ${imm}`);

      const bit20 = (imm >> 20) & 1;
      const bit10_1 = (imm >> 1) & 0x3FF;
      const bit11 = (imm >> 11) & 1;
      const bit19_12 = (imm >> 12) & 0xFF;

      encoding = (bit20 << 31) | (bit10_1 << 21) | (bit11 << 20) | (bit19_12 << 12) | (rd << 7) | instr.opcode;
      break;
    }
  }

  return [encoding & 0xFF, (encoding >> 8) & 0xFF, (encoding >> 16) & 0xFF, (encoding >> 24) & 0xFF];
}
