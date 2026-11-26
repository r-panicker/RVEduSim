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
