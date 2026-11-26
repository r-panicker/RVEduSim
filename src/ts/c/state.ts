// The C program last compiled, and how its lines map to the assembly the
// compiler produced.

export interface CLocalVar { name: string; offset: number; [key: string]: unknown }
export interface CFunctionLocals {
  startAddr: number; endAddr: number; startLine: number; endLine: number;
  vars: CLocalVar[];
  [key: string]: unknown;
}

export const cProgram = {
  source: null as string | null,              // the C source compiled
  generatedAsm: '',                           // the assembly Godbolt returned, as assembled
  pcToLine: new Map<number, number>(),        // instruction address -> C line
  lineToPcs: new Map<number, number[]>(),     // C line -> its instructions' addresses
  lineToFirstPc: new Map<number, number>(),   // C line -> its first instruction
  functionLocals: new Map<string, CFunctionLocals>(),   // each function's stack variables
};
