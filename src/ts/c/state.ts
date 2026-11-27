// The C program last compiled, and how its lines map to the assembly the
// compiler produced.

// A variable's offset is from the frame pointer (s0).
export interface CLocalVar { name: string; offset: number; kind: 'param' | 'local' }
// A function's code range, its C lines, and its stack variables. The
// frame pointer (s0) is set up at framePtrAddr; before that the offsets do
// not point at the variables yet.
export interface CFunctionLocals {
  startAddr: number; endAddr: number; startLine: number; endLine: number;
  framePtrAddr: number;
  vars: CLocalVar[];
}

export const cProgram = {
  source: null as string | null,              // the C source compiled
  generatedAsm: '',                           // the assembly Godbolt returned, as assembled
  pcToLine: new Map<number, number>(),        // instruction address -> C line
  lineToPcs: new Map<number, number[]>(),     // C line -> its instructions' addresses
  lineToFirstPc: new Map<number, number>(),   // C line -> its first instruction
  functionLocals: new Map<string, CFunctionLocals>(),   // each function's stack variables
};

// The Compiler tab's settings: what Godbolt is asked to build with.
export const COMPILERS: [id: string, label: string][] = [
  ['rv32-cclang2010', 'RISC-V Clang 20.1.0 (Stable)'],
  ['rv32-cclang', 'RISC-V Clang (Trunk)'],
  ['rv32-cgcc1420', 'RISC-V GCC 14.2.0 (Stable)'],
  ['rv32-cgcctrunk', 'RISC-V GCC (Trunk)'],
];
export const OPT_LEVELS: [flag: string, label: string][] = [
  ['-O0', '-O0 (Debug — Precise 1:1 C Source Line Mappings)'],
  ['-O1', '-O1 (Basic Optimization)'],
  ['-O2', '-O2 (Speed Optimization)'],
  ['-Os', '-Os (Size Optimization)'],
  ['-O3', '-O3 (Aggressive Optimization)'],
];
export const COMPILER_DEFAULT = { compiler: 'rv32-cclang2010', opt: '-O0', archFlags: '-march=rv32i -mabi=ilp32', useM: false };
export const compilerConfig = { ...COMPILER_DEFAULT };

