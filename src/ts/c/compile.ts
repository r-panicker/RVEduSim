// Compiling C: Compiler Explorer's output assembled into the program, and
// where each C variable lives while the program runs.

import { DATA_DIRECTIVE_WIDTH, DATA_SECTION_DIRECTIVES, assemble, parseStringLiteral, setSection } from '../asm/assembler';
import { parseImm } from '../asm/operands';
import { cProgram, type CLocalVar } from './state';
import { loadProgram } from '../machine/reset';
import { layout, program, run, type MachineLine } from '../machine/state';
import { updateDisassembly, updateMachineCode } from '../ui/disassembly';
import { editor, log, setStatus } from '../ui/editor';
import { editorState } from '../ui/editor-state';
import { highlightCurrentLine, updateStats } from '../ui/execution';
import { updateMemSubTabs, updateMemoryView } from '../ui/memory-register-views';
import { resetPeriphFoldState } from '../ui/peripherals';
import { updateToolbarButtonStates } from '../ui/run-control';
import { byId } from '../ui/dom';
import { errorMessage } from '../errors';

/* ============================================================
   C variable <-> memory location correspondence (best-effort)

   Not real DWARF - Compiler Explorer's JSON response doesn't hand us a
   parsed line/location table, and parsing the raw DWARF byte stream it
   embeds as .byte/.uleb128 directives is a project of its own. Instead
   this leans on how clang at -O0 always behaves: every local is spilled
   to a fixed s0-relative stack slot, and that slot's instruction carries
   a .loc pointing at the C source line that produced it (already parsed
   into cLineToPcsMap by compileAndAssembleC). So: find each function's C source range by
   a light regex scan (good enough for the simple, single-line-signature
   style every bundled example uses - not a real C parser), match each
   local's declaration (or, if uninitialized, its first assignment) back
   to the instruction that stores it, and read the stack offset off of
   that instruction's own disassembly text. Parameters are found the
   same way, from the a0.. spill sequence right at function entry.
   ============================================================ */

export function stripCCommentsAndStrings(line: string | string[]) {
  let out = '';
  let i = 0;
  let inBlockComment = false;
  while (i < line.length) {
    if (inBlockComment) {
      const end = line.indexOf('*/', i);
      if (end === -1) { i = line.length; break; }
      out += ' '.repeat(end + 2 - i);
      i = end + 2;
      inBlockComment = false;
      continue;
    }
    const c = line[i];
    if (c === '/' && line[i + 1] === '/') { out += ' '.repeat(line.length - i); break; }
    if (c === '/' && line[i + 1] === '*') { inBlockComment = true; out += '  '; i += 2; continue; }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < line.length && line[j] !== quote) { if (line[j] === '\\') j++; j++; }
      j = Math.min(j + 1, line.length);
      out += quote + ' '.repeat(j - i - 1);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function buildCVariableLocations(sourceText: string, mc: MachineLine[]) {
  cProgram.functionLocals = new Map();
  if (!sourceText || !mc || !mc.length) return;
  const rawLines = sourceText.split('\n');
  const cleanLines = rawLines.map(stripCCommentsAndStrings);
  const funcs: { name: string; startLine: number; endLine: number; params: string[]; vars: { name: string; declLine: number; kind: 'local' }[] }[] = [];
  const sigRe = /^[ \t]*(?:static\s+|inline\s+)?[A-Za-z_][\w\s\*]*?\b(\w+)\s*\(([^;{}]*)\)\s*\{?\s*$/;
  const NOT_FUNCS = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'else']);
  for (let i = 0; i < cleanLines.length; i++) {
    const line = cleanLines[i];
    if (/;\s*$/.test(line)) continue; // prototype, not a definition
    const m = line.match(sigRe);
    if (!m || NOT_FUNCS.has(m[1])) continue;
    let braceLine = line.includes('{') ? i : -1;
    for (let j = i + 1; braceLine === -1 && j < Math.min(cleanLines.length, i + 3); j++) {
      if (cleanLines[j].includes('{')) braceLine = j;
    }
    if (braceLine === -1) continue;
    let depth = 0, endLine = -1;
    for (let j = braceLine; j < cleanLines.length && endLine === -1; j++) {
      for (const ch of cleanLines[j]) {
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { endLine = j; break; } }
      }
    }
    if (endLine === -1) continue;
    const params: string[] = [];
    const paramsRaw = m[2].trim();
    if (paramsRaw && paramsRaw !== 'void') {
      paramsRaw.split(',').forEach((p) => {
        const pm = p.trim().match(/(\w+)\s*$/);
        if (pm) params.push(pm[1]);
      });
    }
    funcs.push({ name: m[1], startLine: braceLine + 2, endLine: endLine + 1, params, vars: [] });
  }

  const DECL_RE = /\b(?:const\s+|volatile\s+|static\s+|unsigned\s+|signed\s+)*(?:void|char|short|int|long|float|double|_Bool|[A-Za-z_]\w*_t)\b[\s\*]*(\w+)\s*(?:=|;|,|\))/;
  funcs.forEach(fn => {
    const seen = new Set(fn.params);
    for (let ln = fn.startLine; ln <= fn.endLine; ln++) {
      const text = cleanLines[ln - 1];
      if (text === undefined) continue;
      const dm = text.match(DECL_RE);
      if (dm && !seen.has(dm[1])) {
        seen.add(dm[1]);
        fn.vars.push({ name: dm[1], declLine: ln, kind: 'local' });
      }
    }
  });

  // Resolve each function's address range from `labels` (set by assemble()).
  const withAddr = funcs
    .map(fn => ({ fn, addr: (typeof program.labels !== 'undefined' && program.labels[fn.name] !== undefined) ? program.labels[fn.name] >>> 0 : null }))
    .filter((x): x is { fn: typeof x.fn; addr: number } => x.addr !== null)
    .sort((a, b) => a.addr - b.addr);
  const haltAddr = (typeof program.labels !== 'undefined' && program.labels['__halt'] !== undefined) ? program.labels['__halt'] >>> 0 : null;

  withAddr.forEach((entry, idx) => {
    const { fn, addr } = entry;
    const endAddr = (idx + 1 < withAddr.length) ? withAddr[idx + 1].addr : (haltAddr !== null ? haltAddr : 0xFFFFFFFF);

    // Parameters: scan the first ~20 instructions of the function for the
    // a0.. spill sequence (`sw aN, OFF(s0)`), in register order. Also find
    // where s0 itself gets set up - reading s0-relative addresses before
    // that point (regs[8] is still whatever the previous frame left it at)
    // produces addresses that look like garbage.
    const paramOffsets: number[] = [];
    let framePtrAddr: number | null = null;
    const inRange = mc.filter((it) => it.address >= addr && it.address < endAddr).slice(0, 20);
    inRange.forEach((it) => {
      if (framePtrAddr === null && /^\s*addi\s+s0\s*,\s*sp\s*,/.test(it.text || '')) {
        framePtrAddr = it.address;
      }
      const pm = /^\s*sw\s+a(\d+)\s*,\s*(-?\d+)\(s0\)/.exec(it.text || '');
      if (pm) {
        const argIdx = parseInt(pm[1], 10);
        if (paramOffsets[argIdx] === undefined) paramOffsets[argIdx] = parseInt(pm[2], 10);
      }
    });

    const vars: CLocalVar[] = [];
    fn.params.forEach((pname, i) => {
      if (paramOffsets[i] !== undefined) vars.push({ name: pname, offset: paramOffsets[i], kind: 'param' });
    });

    const findStoreOffset = (cLine: number) => {
      const pcs = cProgram.lineToPcs.get(cLine);
      if (!pcs) return null;
      for (const p of pcs) {
        const item = mc.find((it) => it.address === p);
        if (!item || !item.text) continue;
        const sm = /\bs[bhw]\s+[^,]+,\s*(-?\d+)\((s0|sp)\)/.exec(item.text || '');
        if (sm) return parseInt(sm[1], 10);
      }
      return null;
    };

    fn.vars.forEach(v => {
      let off = findStoreOffset(v.declLine);
      if (off === null) {
        // No initializer on the declaration line itself - fall back to
        // this variable's first assignment further down in the function.
        const assignRe = new RegExp('\\b' + v.name + '\\s*=[^=]');
        for (let ln = v.declLine + 1; ln <= fn.endLine && off === null; ln++) {
          const text = cleanLines[ln - 1];
          if (text !== undefined && assignRe.test(text)) off = findStoreOffset(ln);
        }
      }
      if (off !== null) vars.push({ name: v.name, offset: off, kind: v.kind });
    });

    if (vars.length) {
      cProgram.functionLocals.set(fn.name, {
        startAddr: addr, endAddr, startLine: fn.startLine - 1, endLine: fn.endLine,
        framePtrAddr: framePtrAddr !== null ? framePtrAddr : addr, vars
      });
    }
  });
}

export function getCurrentCFunction(pcVal: number) {
  for (const [name, info] of cProgram.functionLocals) {
    if (pcVal >= info.startAddr && pcVal < info.endAddr) return { name, ...info };
  }
  return null;
}

export function getCVarAtSourceLine(cLine: number, varName: string) {
  for (const [, info] of cProgram.functionLocals) {
    if (cLine < info.startLine || cLine > info.endLine) continue;
    const v = info.vars.find(x => x.name === varName);
    if (v) return { ...v, framePtrAddr: info.framePtrAddr };
  }
  return null;
}

export function highlightFirstCLine(mc: MachineLine[]) {
  let firstCLine = -1;
  if (program.labels && program.labels['main'] !== undefined) {
    const mainAddr = program.labels['main'];
    if (cProgram.pcToLine.has(mainAddr)) {
      firstCLine = cProgram.pcToLine.get(mainAddr) ?? -1;
    }
  }
  if (firstCLine === -1) {
    for (const item of mc) {
      if (item.cLine && item.cLine >= 1) {
        firstCLine = item.cLine;
        break;
      }
    }
  }
  run.currentLine = firstCLine;
  highlightCurrentLine();
}

export function warnAboutLibgccHelpers(asm: GodboltAsmLine[] | undefined, optLevel: string) {
  const names = new Set<string>();
  for (const item of (asm || [])) {
    const t = (item && item.text) || '';
    let m: RegExpExecArray | null;
    LIBGCC_HELPER_RE.lastIndex = 0;
    while ((m = LIBGCC_HELPER_RE.exec(t)) !== null) names.add(m[0]);
  }
  if (!names.size) return;
  const list = Array.from(names).sort().join(', ');
  const mBox = byId<HTMLInputElement>('godboltUseM');
  const mOn = mBox ? mBox.checked : false;
  if (mOn) return;   // the helpers would only appear without M, but be safe
  log(`\u26a0\ufe0f This program multiplies or divides, but "Include M extension" is off, ` +
      `so the compiler emitted calls to the libgcc helper(s) ${list} instead of a ` +
      `mul/div instruction. Those helpers are library code that is not part of this ` +
      `program, so assembly will fail on them.`, 'warn');
  log(`   Two ways out: tick "Include M extension" in Settings \u2192 Compiler, or raise the ` +
      `optimisation level. At ${optLevel} the compiler keeps the multiply as a call; from ` +
      `-O1 upwards it will often replace a multiply or divide by a constant with shifts ` +
      `and adds, and the helper call disappears. That is why the same program can ` +
      `assemble at -Os and fail at -O0.`, 'warn');
  setStatus(`\u26a0\ufe0f Multiply/divide without the M extension \u2014 ${list} cannot be resolved`, 'warn');
}

export async function compileAndAssembleC(cSourceText?: string) {
  const source = (typeof cSourceText === 'string') ? cSourceText : (editor ? editor.value : '');
  if (!source.trim()) {
    log('No C code to compile.', 'error');
    setStatus('Error: No C code in editor', 'error');
    return null;
  }

  const compilerSelect = byId<HTMLSelectElement>('godboltCompilerSelect');
  const optSelect = byId<HTMLSelectElement>('godboltOptSelect');
  const archInput = byId<HTMLInputElement>('godboltArchFlags');

  const compilerId = compilerSelect ? compilerSelect.value : 'rv32-cclang2010';
  const optLevel = optSelect ? optSelect.value : '-O0';
  const archFlags = archInput ? archInput.value : '-march=rv32im -mabi=ilp32';

  setStatus(`Compiling C with Godbolt (${compilerId}, ${optLevel})...`, 'info');
  log(`Compiling C code via Godbolt Compiler Explorer (${compilerId}, ${optLevel}, ${archFlags})...`, 'info');

  let godboltData: GodboltResponse | null = null;

  // 1. Try Live Godbolt API request
  if (typeof fetch === 'function') {
    try {
      const body = {
        source: source,
        options: {
          userArguments: `${archFlags} ${optLevel} -fno-pic -fno-pie`,
          filters: {
            binary: false,
            commentOnly: true,
            demangle: true,
            directives: false,
            labels: true,
            libraryCode: false,
            trim: false
          }
        }
      };

      const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), 12000) : null;

      const resp = await fetch(`https://godbolt.org/api/compiler/${compilerId}/compile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      });
      if (timeoutId) clearTimeout(timeoutId);

      if (resp && resp.ok) {
        godboltData = await resp.json() as GodboltResponse;
      } else if (resp) {
        log(`Godbolt HTTP ${resp.status} status.`, 'warn');
      }
    } catch (err) {
      log(`Godbolt connection notice: ${(err as Error).name === 'AbortError' ? 'timeout' : errorMessage(err)}`, 'info');
    }
  }

  // 2. Fall back to a response injected by the test harness, so the
  // suites can exercise C mode without reaching the network. jsdom has no
  // fetch, so this is the only path they ever take. It may be a single
  // response, or a function of the source for a harness that compiles
  // more than one program in the same window.
  if (!godboltData || !godboltData.asm) {
    const injected = (typeof window !== 'undefined') ? window.__mockGodboltResponse : null;
    if (typeof injected === 'function') godboltData = injected(source);
    else if (injected) godboltData = injected;
  }

  if (!godboltData || !godboltData.asm) {
    const errMsg = 'C compilation needs the network: the Godbolt Compiler Explorer API was not reachable. Check your internet connection and try again, or switch to Assembly mode, which compiles entirely in the browser.';
    log(errMsg, 'error');
    setStatus('C compilation failed — Godbolt unreachable. See the console.', 'error');
    program.assembled = false;
    if (typeof updateToolbarButtonStates === 'function') updateToolbarButtonStates();
    return null;
  }

  // Check if compiler reported errors
  if (godboltData.code !== 0 && (!godboltData.asm || godboltData.asm.length === 0)) {
    let errText = '';
    if (godboltData.stderr && Array.isArray(godboltData.stderr)) {
      errText = godboltData.stderr.map(e => e.text).join('\n');
    } else if (godboltData.buildResult && godboltData.buildResult.stderr) {
      errText = godboltData.buildResult.stderr.map(e => e.text).join('\n');
    }
    log(`C Compilation Errors:\n${errText || 'Non-zero exit code from compiler'}`, 'error');
    setStatus('C Compilation Failed — see console log', 'error');
    program.assembled = false;
    if (typeof updateToolbarButtonStates === 'function') updateToolbarButtonStates();
    return null;
  }

  // With the M extension off there is no mul/div instruction, so the
  // compiler calls a libgcc helper instead - a function that is not part
  // of this program and never will be. Say so here, while the setting
  // that caused it is still the obvious thing to change, rather than
  // leaving it to surface as an unresolved symbol during assembly.
  warnAboutLibgccHelpers(godboltData.asm, optLevel);

  // Calculate effective stack pointer: if data symbols or arrays extend beyond layout.stackBase,
  // dynamically elevate stack pointer so the stack frame never collides with global/static data.
  let estimatedDataBytes = 0;
  let currentSection = 'text';
  for (const item of (godboltData.asm || [])) {
    const t = (item.text || '').trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;
    const toks = t.split(/\s+/);
    const first = toks[0];
    const mn = first.toLowerCase();
    if (mn === '.text') { currentSection = 'text'; continue; }
    if (DATA_SECTION_DIRECTIVES.has(mn)) { currentSection = 'data'; continue; }
    if (mn === '.section') { currentSection = setSection(toks[1]) || 'ignore'; continue; }
    if (currentSection === 'data') {
      if (mn === '.zero' || mn === '.space') {
        const n = parseImm(toks[1]);
        if (n > 0) estimatedDataBytes += n;
      } else if (DATA_DIRECTIVE_WIDTH[mn]) {
        const count = t.slice(first.length).split(',').filter(s => s.trim().length > 0).length;
        estimatedDataBytes += count * DATA_DIRECTIVE_WIDTH[mn];
      } else if (mn === '.ascii' || mn === '.asciz' || mn === '.asciiz' || mn === '.string') {
        const qIdx = t.search(/["']/);
        const strContent = (qIdx >= 0) ? t.slice(qIdx) : '';
        estimatedDataBytes += parseStringLiteral(strContent).length + (mn === '.ascii' ? 0 : 1);
      }
    }
  }

  let effectiveStack = layout.stackBase >>> 0;
  const dataEnd = (layout.dataBase + estimatedDataBytes) >>> 0;
  if (dataEnd > effectiveStack || estimatedDataBytes > layout.dataSize) {
    effectiveStack = Math.max(effectiveStack, ((dataEnd + 0x2000 + 0xFFF) & ~0xFFF) >>> 0);
    log(`⚠️ Data is ${estimatedDataBytes} bytes, over the ${layout.dataSize}-byte Data segment. ` +
        `The startup stack pointer was moved to 0x${effectiveStack.toString(16)} so the stack ` +
        `clears it. On hardware the segment size is fixed — raise "Data (.data) size" in ` +
        `Settings → Linker, and DMEM_DEPTH_BITS in Wrapper, to match.`, 'warn');
    setStatus(`Data section is ${estimatedDataBytes} bytes — stack moved to ` +
      `0x${effectiveStack.toString(16)}. See the console.`, 'warn');
  }

  // Prepend CRT0 baremetal startup shim: sets sp = effectiveStack, jumps to main().
  // main() is never expected to return (every example is `while (1) { ... }`), so
  // this jumps rather than calls - no return address is set up in the usual sense.
  // ra is still seeded with __halt's address first, so an accidental `ret` out of
  // main lands on the trap below instead of whatever ra's reset value points at.
  // The trap itself is appended after ALL of the compiled program (not before it,
  // as a plain `call` fallback would sit) so PC running off the end of the real
  // program - for any reason - lands on a defined infinite loop instead of running
  // into unmapped memory beyond the assembled code.
  const startup: GodboltAsmLine[] = [
    { text: '.text', source: null },
    { text: '.globl _start', source: null },
    { text: '_start:', source: null },
    { text: `    li sp, 0x${(effectiveStack >>> 0).toString(16)}`, source: null },
    { text: '    la ra, __halt', source: null },
    { text: '    j main', source: null }
  ];

  const haltTrap: GodboltAsmLine[] = [
    { text: '.text', source: null },
    { text: '__halt:', source: null },
    { text: '    j __halt', source: null }
  ];

  const combinedItems = [...startup, ...godboltData.asm, ...haltTrap];
  const asmText = combinedItems.map(item => item.text).join('\n');
  cProgram.generatedAsm = asmText;

  const mc = assemble(asmText, layout.baseAddress, { language: editorState.language, report: log });
  if (!mc) {
    log('Failed to assemble Godbolt emitted assembly.', 'error');
    setStatus('Assembly Error', 'error');
    program.assembled = false;
    if (typeof updateToolbarButtonStates === 'function') updateToolbarButtonStates();
    return null;
  }

  let hasError = false;
  for (const item of mc) {
    if (item.error) {
      log(`Line ${item.line}: ${item.error}`, 'error');
      hasError = true;
    }
  }
  if (hasError) {
    setStatus('Assembly error in generated code', 'error');
    program.assembled = false;
    if (typeof updateToolbarButtonStates === 'function') updateToolbarButtonStates();
    return null;
  }

  // Build PC -> C Line mapping
  cProgram.pcToLine = new Map();
  cProgram.lineToPcs = new Map();
  cProgram.lineToFirstPc = new Map();
  program.machineCode = mc;

  for (let k = 0; k < mc.length; k++) {
    const item = mc[k];
    const asmLineIdx = item.line - 1;
    if (asmLineIdx >= 0 && asmLineIdx < combinedItems.length) {
      const gItem = combinedItems[asmLineIdx];
      if (gItem && gItem.source && typeof gItem.source.line === 'number') {
        const cLine = gItem.source.line;
        item.cLine = cLine;
        cProgram.pcToLine.set(item.address, cLine);
        let pcs = cProgram.lineToPcs.get(cLine);
        if (!pcs) {
          cProgram.lineToPcs.set(cLine, pcs = []);
          cProgram.lineToFirstPc.set(cLine, item.address);
        }
        pcs.push(item.address);
      }
    }
  }

  editorState.lastAssembledCode = source;
  cProgram.source = source;
  buildCVariableLocations(source, mc);

  loadProgram(mc);
  updateMachineCode();
  updateDisassembly();
  updateMemoryView();
  updateMemSubTabs();
  updateStats();
  highlightFirstCLine(mc);

  program.assembled = true;
  run.finished = false;
  resetPeriphFoldState();
  const nInstr = countInstructions(mc);
  log(`Compiled and loaded ${nInstr} RV32 instructions from C source.`, 'success');
  setStatus(`Compiled & Assembled (${nInstr} instructions). Ready to step/run.`, 'success');
  if (typeof updateToolbarButtonStates === 'function') updateToolbarButtonStates();

  return mc;
}

// Only the text segment. Counting every assembled item would count the
// image example's 130 rows of pixel data as instructions too.
export function countInstructions(mc: MachineLine[]) {
  return (mc || []).filter((i) => !i.error && i.bytes && i.address < layout.dataBase).length;
}

// Which libgcc arithmetic helpers the compiled output calls, if any.
export const LIBGCC_HELPER_RE = /\b__(?:mul|div|udiv|mod|umod|muldi|divdi|udivdi|moddi|umoddi)[a-z0-9]*\b/g;
