// HDL mode: the memory images the Wrapper's $readmemh loads, and the
// search for the register file the testbench traces.

import { hdlLog } from './engine';
import { hdlDiscardTrace } from './run';
import { hdlSourcesChanged } from './sources';
import { hdlConfig, hdlSources } from './state';
import { hdlFindWrapper, hdlModuleBody } from './verilog';
import { getMemByte } from '../machine/memory';
import { layout, program, type MachineLine, type PlacedLine } from '../machine/state';
import { setStatus } from '../ui/editor';
import { DEFAULT_DEPTH_BITS } from '../ui/example-sources';

// ================================================================
// Memory images for the Wrapper's $readmemh
// ================================================================
// The Wrapper sizes IROM/DMEM from its own localparams, so read them
// back out of the uploaded file rather than assuming the defaults —
// a student who enlarged IROM_DEPTH_BITS for a bigger program should
// get a correspondingly larger image.
export function hdlDepthBits(wrapperSrc: string, name: string, fallback: number) {
  const m = new RegExp('localparam\\s+' + name + '\\s*=\\s*(\\d+)').exec(wrapperSrc || '');
  const v = m ? parseInt(m[1], 10) : NaN;
  return Number.isFinite(v) && v > 2 && v <= 24 ? v : fallback;
}

// Build a $readmemh image: one 8-digit little-endian word per line,
// taken straight from the assembled memory image so that gaps inside
// the segment keep their addresses (a plain item dump would pack them
// and silently shift everything after the gap).
export function hdlBuildMemImage(baseAddr: number, depthBits: number, lastUsedAddr: number) {
  const words = Math.pow(2, depthBits - 2);
  const lines: string[] = [];
  // Only emit up to the last word the program actually uses, mirroring
  // what RARS dumps. Trailing words stay uninitialised (X), exactly as
  // they would in Vivado.
  let lastWord = -1;
  for (let w = 0; w < words; w++) {
    const a = baseAddr + w * 4;
    if (a <= lastUsedAddr) lastWord = w;
  }
  for (let w = 0; w <= lastWord; w++) {
    const a = baseAddr + w * 4;
    const val = ((getMemByte(a)) | (getMemByte(a + 1) << 8) |
                 (getMemByte(a + 2) << 16) | (getMemByte(a + 3) << 24)) >>> 0;
    lines.push(val.toString(16).padStart(8, '0'));
  }
  return lines.join('\n') + '\n';
}

export function hdlMemFiles(wrapperSrc: string) {
  const iromBits = hdlDepthBits(wrapperSrc, 'IROM_DEPTH_BITS', 9);
  const dmemBits = hdlDepthBits(wrapperSrc, 'DMEM_DEPTH_BITS', 14);
  const placed = (i: MachineLine): i is PlacedLine => !i.error && !!i.bytes;
  const codeItems = program.machineCode.filter(placed).filter(i => i.address < layout.dataBase);
  const dataItems = program.machineCode.filter(placed).filter(i => i.address >= layout.dataBase);
  const lastCode = codeItems.reduce((m, i) => Math.max(m, i.address + i.bytes.length - 1), layout.baseAddress - 1);
  const lastData = dataItems.reduce((m, i) => Math.max(m, i.address + i.bytes.length - 1), layout.dataBase - 1);
  return {
    files: {
      'AA_IROM.mem': hdlBuildMemImage(layout.baseAddress, iromBits, lastCode),
      'AA_DMEM.mem': hdlBuildMemImage(layout.dataBase, dmemBits, lastData)
    },
    iromBits, dmemBits,
    codeWords: Math.max(0, Math.ceil((lastCode - layout.baseAddress + 1) / 4)),
    dataWords: Math.max(0, Math.ceil((lastData - layout.dataBase + 1) / 4)),
    iromCapacity: Math.pow(2, iromBits - 2),
    dmemCapacity: Math.pow(2, dmemBits - 2)
  };
}

// The two depths the current program needs, as IROM_DEPTH_BITS and
// DMEM_DEPTH_BITS would express them. Taken from the Linker segment sizes,
// which an example sets from its row in examples/index.txt.
export function hdlRequiredDepths() {
  const bitsFor = (bytes: number) => {
    let b = 2;
    while (Math.pow(2, b) < bytes) b++;
    return Math.max(b, DEFAULT_DEPTH_BITS);
  };
  return { irom: bitsFor(layout.codeSize >>> 0), dmem: bitsFor(layout.dataSize >>> 0) };
}

// The Wrapper that ships with the prebuilt processor is ours, so its two
// depths are set to whatever the selected program needs. A Wrapper the
// student loaded is theirs, and is only ever checked, never rewritten.
export function hdlSyncReferenceWrapperDepths() {
  const w = hdlFindWrapper();
  if (!w || !w.isPrebuilt) return false;
  const need = hdlRequiredDepths();
  const before = w.src;
  w.src = w.src
    .replace(/(localparam\s+IROM_DEPTH_BITS\s*=\s*)\d+/, '$1' + need.irom)
    .replace(/(localparam\s+DMEM_DEPTH_BITS\s*=\s*)\d+/, '$1' + need.dmem);
  if (w.src === before) return false;
  hdlDiscardTrace();
  hdlLog('Set the prebuilt Wrapper to IROM_DEPTH_BITS ' + need.irom +
    ', DMEM_DEPTH_BITS ' + need.dmem + ' for this program. Set the same two ' +
    'localparams in your own Wrapper.', 'sys');
  setStatus('Prebuilt Wrapper sized for this program: IROM ' + need.irom +
    ', DMEM ' + need.dmem, 'info');
  hdlSourcesChanged();
  return true;
}

// ================================================================
// Register-file discovery
// ================================================================
// The architectural register bank lives in student-modifiable code, so
// its hierarchical path has to be found rather than assumed. Only the
// ARRAY is ever named - the trace detects writes by comparing against a
// shadow copy, so renaming the register file's ports cannot break it.
export function hdlAllSources() {
  return hdlSources.files.map(f => f.src).join('\n');
}

// A 32-entry array of 32-bit regs is what every RISC-V register file
// has to contain, whatever it is called.
export const HDL_REGBANK_RE =
  /\breg\s*(?:\[\s*31\s*:\s*0\s*\]\s*)?([A-Za-z_]\w*)\s*\[\s*(?:0\s*:\s*31|31\s*:\s*0)\s*\]/;

export const HDL_NOT_AN_INSTANCE = new Set([
  'if', 'else', 'for', 'while', 'repeat', 'case', 'casex', 'casez', 'begin',
  'end', 'always', 'initial', 'assign', 'module', 'endmodule', 'function',
  'task', 'wire', 'reg', 'input', 'output', 'inout', 'integer', 'real',
  'parameter', 'localparam', 'generate', 'endgenerate', 'posedge', 'negedge',
  'defparam', 'genvar', 'return', 'signed', 'unsigned', 'logic'
]);

export function hdlDiscoverRegBank() {
  const all = hdlAllSources();
  const wrapper = hdlFindWrapper();
  if (!wrapper) return null;

  // The Wrapper is fixed, so its instance of the core is a reliable
  // anchor - but read the instance name rather than assuming "RV1".
  const wrapBody = hdlModuleBody(wrapper.src, 'Wrapper') || wrapper.src;
  const coreM = /^[^\S\n]*RV\s*(?:#\s*\([\s\S]*?\)\s*)?([A-Za-z_]\w*)\s*\(/m.exec(wrapBody);
  if (!coreM) return null;
  const corePath = 'dut.' + coreM[1];

  const coreBody = hdlModuleBody(all, 'RV');
  if (!coreBody) return null;

  // Declared directly in the core?
  const direct = HDL_REGBANK_RE.exec(coreBody);
  if (direct) return corePath + '.' + direct[1];

  // Otherwise look inside each module the core instantiates.
  const instRe = /^[^\S\n]*([A-Za-z_]\w*)\s*(?:#\s*\([\s\S]*?\)\s*)?([A-Za-z_]\w*)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = instRe.exec(coreBody)) !== null) {
    const modName = m[1], instName = m[2];
    if (HDL_NOT_AN_INSTANCE.has(modName) || HDL_NOT_AN_INSTANCE.has(instName)) continue;
    const body = hdlModuleBody(all, modName);
    if (!body) continue;
    const hit = HDL_REGBANK_RE.exec(body);
    if (hit) return corePath + '.' + instName + '.' + hit[1];
  }
  return null;
}

// What the testbench should actually use: an explicit override from the
// panel wins, otherwise whatever discovery found.
export function hdlRegBankPath() {
  const manual = hdlConfig.regPath.trim();
  if (manual) return manual;
  return hdlDiscoverRegBank();
}
