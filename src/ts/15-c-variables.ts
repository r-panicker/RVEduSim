// @ts-nocheck
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
let cFunctionLocals = new Map(); // name -> {startAddr, endAddr, startLine, endLine, vars:[{name,offset,kind,declLine}]}

function stripCCommentsAndStrings(line) {
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

function buildCVariableLocations(sourceText, mc) {
  cFunctionLocals = new Map();
  if (!sourceText || !mc || !mc.length) return;
  const rawLines = sourceText.split('\n');
  const cleanLines = rawLines.map(stripCCommentsAndStrings);
  const funcs = [];
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
    const params = [];
    const paramsRaw = m[2].trim();
    if (paramsRaw && paramsRaw !== 'void') {
      paramsRaw.split(',').forEach(p => {
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
    .filter(x => x.addr !== null)
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
    const paramOffsets = [];
    let framePtrAddr = null;
    const inRange = mc.filter(it => it.address >= addr && it.address < endAddr).slice(0, 20);
    inRange.forEach(it => {
      if (framePtrAddr === null && /^\s*addi\s+s0\s*,\s*sp\s*,/.test(it.text || '')) {
        framePtrAddr = it.address;
      }
      const pm = /^\s*sw\s+a(\d+)\s*,\s*(-?\d+)\(s0\)/.exec(it.text || '');
      if (pm) {
        const argIdx = parseInt(pm[1], 10);
        if (paramOffsets[argIdx] === undefined) paramOffsets[argIdx] = parseInt(pm[2], 10);
      }
    });

    const vars = [];
    fn.params.forEach((pname, i) => {
      if (paramOffsets[i] !== undefined) vars.push({ name: pname, offset: paramOffsets[i], kind: 'param' });
    });

    const findStoreOffset = (cLine) => {
      const pcs = cLineToPcsMap.get(cLine);
      if (!pcs) return null;
      for (const p of pcs) {
        const item = mc.find(it => it.address === p);
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
      cFunctionLocals.set(fn.name, {
        startAddr: addr, endAddr, startLine: fn.startLine - 1, endLine: fn.endLine,
        framePtrAddr: framePtrAddr !== null ? framePtrAddr : addr, vars
      });
    }
  });
}

function getCurrentCFunction(pcVal) {
  for (const [name, info] of cFunctionLocals) {
    if (pcVal >= info.startAddr && pcVal < info.endAddr) return { name, ...info };
  }
  return null;
}

function getCVarAtSourceLine(cLine, varName) {
  for (const [, info] of cFunctionLocals) {
    if (cLine < info.startLine || cLine > info.endLine) continue;
    const v = info.vars.find(x => x.name === varName);
    if (v) return { ...v, framePtrAddr: info.framePtrAddr };
  }
  return null;
}

function highlightFirstCLine(mc) {
  let firstCLine = -1;
  if (program.labels && program.labels['main'] !== undefined) {
    const mainAddr = program.labels['main'];
    if (pcToCLineMap.has(mainAddr)) {
      firstCLine = pcToCLineMap.get(mainAddr);
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

// Which libgcc arithmetic helpers the compiled output calls, if any.
const LIBGCC_HELPER_RE = /\b__(?:mul|div|udiv|mod|umod|muldi|divdi|udivdi|moddi|umoddi)[a-z0-9]*\b/g;

function warnAboutLibgccHelpers(asm, optLevel) {
  const names = new Set();
  for (const item of (asm || [])) {
    const t = (item && item.text) || '';
    let m;
    LIBGCC_HELPER_RE.lastIndex = 0;
    while ((m = LIBGCC_HELPER_RE.exec(t)) !== null) names.add(m[0]);
  }
  if (!names.size) return;
  const list = Array.from(names).sort().join(', ');
  const mBox = document.getElementById('godboltUseM');
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

async function compileAndAssembleC(cSourceText) {
  const source = (typeof cSourceText === 'string') ? cSourceText : (editor ? editor.value : '');
  if (!source.trim()) {
    log('No C code to compile.', 'error');
    setStatus('Error: No C code in editor', 'error');
    return null;
  }

  const compilerSelect = document.getElementById('godboltCompilerSelect');
  const optSelect = document.getElementById('godboltOptSelect');
  const archInput = document.getElementById('godboltArchFlags');

  const compilerId = compilerSelect ? compilerSelect.value : 'rv32-cclang2010';
  const optLevel = optSelect ? optSelect.value : '-O0';
  const archFlags = archInput ? archInput.value : '-march=rv32im -mabi=ilp32';

  setStatus(`Compiling C with Godbolt (${compilerId}, ${optLevel})...`, 'info');
  log(`Compiling C code via Godbolt Compiler Explorer (${compilerId}, ${optLevel}, ${archFlags})...`, 'info');

  let godboltData = null;

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
        godboltData = await resp.json();
      } else if (resp) {
        log(`Godbolt HTTP ${resp.status} status.`, 'warn');
      }
    } catch (err) {
      log(`Godbolt connection notice: ${err.name === 'AbortError' ? 'timeout' : err.message}`, 'info');
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
  const startup = [
    { text: '.text', source: null },
    { text: '.globl _start', source: null },
    { text: '_start:', source: null },
    { text: `    li sp, 0x${(effectiveStack >>> 0).toString(16)}`, source: null },
    { text: '    la ra, __halt', source: null },
    { text: '    j main', source: null }
  ];

  const haltTrap = [
    { text: '.text', source: null },
    { text: '__halt:', source: null },
    { text: '    j __halt', source: null }
  ];

  const combinedItems = [...startup, ...godboltData.asm, ...haltTrap];
  const asmText = combinedItems.map(item => item.text).join('\n');
  lastGeneratedAsm = asmText;

  const mc = assemble(asmText, layout.baseAddress);
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
  pcToCLineMap = new Map();
  cLineToPcsMap = new Map();
  cLineToFirstPcMap = new Map();
  program.machineCode = mc;

  for (let k = 0; k < mc.length; k++) {
    const item = mc[k];
    const asmLineIdx = item.line - 1;
    if (asmLineIdx >= 0 && asmLineIdx < combinedItems.length) {
      const gItem = combinedItems[asmLineIdx];
      if (gItem && gItem.source && typeof gItem.source.line === 'number') {
        const cLine = gItem.source.line;
        item.cLine = cLine;
        item.cCol = gItem.source.column || 1;
        pcToCLineMap.set(item.address, cLine);
        if (!cLineToPcsMap.has(cLine)) {
          cLineToPcsMap.set(cLine, []);
          cLineToFirstPcMap.set(cLine, item.address);
        }
        cLineToPcsMap.get(cLine).push(item.address);
      }
    }
  }

  lastAssembledCode = source;
  lastCompiledCSource = source;
  buildCVariableLocations(source, mc);

  loadProgram(mc);
  updateMachineCode();
  updateDisassembly();
  updateMemoryView();
  updateMemSubTabs();
  updateStats();
  highlightFirstCLine(mc);

  program.assembled = true;
  programFinished = false;
  resetPeriphFoldState();
  const nInstr = countInstructions(mc);
  log(`Compiled and loaded ${nInstr} RV32 instructions from C source.`, 'success');
  setStatus(`Compiled & Assembled (${nInstr} instructions). Ready to step/run.`, 'success');
  if (typeof updateToolbarButtonStates === 'function') updateToolbarButtonStates();

  return mc;
}

// Only the text segment. Counting every assembled item would count the
// image example's 130 rows of pixel data as instructions too.
function countInstructions(mc) {
  return (mc || []).filter(i => !i.error && i.bytes && i.address < layout.dataBase).length;
}

function assembleOnly() {
  clearLog();
  if (editorLanguageMode === 'c') {
    return compileAndAssembleC();
  }
  const mc = prepareAssembly();
  if (!mc) {
    program.assembled = false;
    if (typeof updateToolbarButtonStates === 'function') updateToolbarButtonStates();
    return;
  }
  lastAssembledCode = editor.value;
  const nInstr = countInstructions(mc);
  log(`Assembly successful. ${nInstr} instructions.`, 'success');
  loadProgram(mc);
  updateMachineCode();
  updateDisassembly();
  updateMemoryView();
  updateMemSubTabs();
  updateStats();
  highlightFirstLine(mc);
  program.assembled = true;
  programFinished = false;
  resetPeriphFoldState();
  if (program.codeOverflowWords > 0) {
    setStatus(`Assembled ${nInstr} instructions — ${program.codeOverflowWords} too many ` +
      `for the Code segment. See the console.`, 'warn');
  } else {
    setStatus(`Assembled ${nInstr} instructions. Ready to run.`, 'success');
  }
  if (typeof updateToolbarButtonStates === 'function') updateToolbarButtonStates();
  return mc;
}

function stepOnce() {
  if (!program.assembled) {
    setStatus('Please assemble the program first (⚙ Assemble)', 'warn');
    log('Please assemble the program first.', 'warn');
    updateToolbarButtonStates();
    return;
  }
  if (run.running) return;
  if (programFinished) {
    setStatus('Program execution finished. Reset (⟲) or Assemble to step again.', 'info');
    updateToolbarButtonStates();
    return;
  }

  stepHistory.journalEnabled = true;
  stepHistory.writeLog = [];
  stepHistory.pixelLog = [];
  const prePeriph = capturePeriphState();
  const preRegs = Int32Array.from(cpu.regs);
  const preFp = fpBits.slice();
  const preReservation = lrReservation;
  const prePc = cpu.pc;
  const cycBefore = cpu.totalCycles;
  const instrBefore = cpu.instructionCount;
  const startSourceLine = sourceLineForPc(cpu.pc);
  let line = startSourceLine;   // of the last instruction executed
  let fault = null;
  const prePipe = pipeMode ? pipeSnapshot() : null;
  let pipeSig = null;
  try {
    if (pipeMode) {
      pipeSig = run.statementStepping ? pipeStatementStep() : pipeStep();
    } else if (run.statementStepping && startSourceLine > 0) {
      let stepsTaken = 0;
      while (!programFinished && stepsTaken < 10000) {
        line = sourceLineForPc(cpu.pc);
        executeOne();
        stepsTaken++;
        const nextLine = sourceLineForPc(cpu.pc);
        if (nextLine !== startSourceLine || programFinished || run.breakpoints.has(nextLine)) {
          break;
        }
      }
    } else {
      executeOne();
    }
  } catch (e) {
    fault = e;
  }
  stepHistory.journalEnabled = false;
  const instructionsExecuted = cpu.instructionCount - instrBefore;
  // Recorded for a step that faulted too: whatever it wrote before it
  // threw is still applied, and Back is how to take it out again.
  stepHistory.entries.push({
    pc: prePc, regs: preRegs, fp: preFp, reservation: preReservation,
    writes: stepHistory.writeLog.slice(), pixels: stepHistory.pixelLog.slice(), periph: prePeriph,
    cycles: cpu.totalCycles - cycBefore, instr: instructionsExecuted, line: line, pipe: prePipe
  });
  if (stepHistory.entries.length > stepHistory.cap) stepHistory.entries.shift();
  if (fault) {
    log(`Error at PC 0x${prePc.toString(16)}: ${fault.message}`, 'error');
    updateRegisters(); updateMemoryView(); updateMachineCode(); updateDisassembly(); updateStats();
    updateToolbarButtonStates();
    return;
  }
  // Debugger convention: highlight the instruction that is about to execute (the new PC),
  // not the one that just ran.
  run.currentLine = sourceLineForPc(cpu.pc);
  highlightCurrentLine();
  updateRegisters(); updateMemoryView(); updateMachineCode(); updateDisassembly(); updateStats();
  if (pipeMode) {
    const ev = pipeEvents(pipeSig);
    if (pipeDone()) {
      programFinished = true;
      run.currentLine = -1;
      highlightCurrentLine();
      log(`Program completed after ${cpu.totalCycles} cycles, ${cpu.instructionCount} instructions.`, 'success');
      setStatus('Program finished', 'success');
    } else if (run.statementStepping && cpu.totalCycles - cycBefore > 1) {
      setStatus(`Statement step over line ${pipeStmtLine}: ${cpu.totalCycles - cycBefore} cycles, now at cycle ${cpu.totalCycles}`);
    } else {
      setStatus(`Cycle ${cpu.totalCycles}` + (ev ? ': ' + ev : ''));
    }
    log(run.statementStepping && cpu.totalCycles - cycBefore > 1
      ? `Cycles ${cycBefore + 1}-${cpu.totalCycles}: statement at line ${pipeStmtLine} retired (${instructionsExecuted} instructions)`
      : `Cycle ${cpu.totalCycles}` + (ev ? ': ' + ev : ''), 'info');
  } else if (run.statementStepping && instructionsExecuted > 1) {
    setStatus(`Statement step over line ${startSourceLine} — ${instructionsExecuted} instruction` +
      `${instructionsExecuted === 1 ? '' : 's'}, now at line ${run.currentLine > 0 ? run.currentLine : '?'}`);
    log(`Executed statement at line ${startSourceLine} (${instructionsExecuted} instructions, next PC: 0x${cpu.pc.toString(16)}, Line: ${run.currentLine})`, 'info');
  } else {
    setStatus(`Stepped to line ${run.currentLine > 0 ? run.currentLine : '?'}`);
    log(`0x${prePc.toString(16)}: executed (next: 0x${cpu.pc.toString(16)})`, 'info');
  }
  updateToolbarButtonStates();
}

function stepBack() {
  if (run.running) return;
  if (!program.assembled) {
    log('Please assemble the program first before stepping.', 'warn');
    updateToolbarButtonStates();
    return;
  }
  if (stepHistory.entries.length === 0) {
    log('Nothing to step back to.', 'warn');
    updateToolbarButtonStates();
    return;
  }
  const st = stepHistory.entries.pop();
  for (let i = st.writes.length - 1; i >= 0; i--) {
    const w = st.writes[i];
    setMemByte(w.addr, w.old);
  }
  restoreOledPages(st.pixels);
  restorePeriphState(st.periph);
  cpu.regs.set(st.regs);
  fpBits.set(st.fp);
  lrReservation = st.reservation;
  cpu.pc = st.pc;
  if (st.pipe) { pipeRestore(st.pipe); programFinished = false; }
  run.currentLine = st.line;
  cpu.totalCycles = Math.max(0, cpu.totalCycles - st.cycles);
  cpu.instructionCount = Math.max(0, cpu.instructionCount - st.instr);
  cpu.lastChangedReg = -1;
  highlightCurrentLine();
  updateRegisters(); updateMemoryView(); updateMachineCode(); updateDisassembly(); updateStats();
  updatePeripherals(); updateOledCanvas();
  if (st.pipe) {
    setStatus(`Back to cycle ${cpu.totalCycles}`);
    log(`Back to cycle ${cpu.totalCycles}`, 'info');
  } else {
    setStatus(`Stepped back to line ${run.currentLine > 0 ? run.currentLine : '?'}`);
    log(`Back to 0x${st.pc.toString(16)}`, 'info');
  }
  updateToolbarButtonStates();
}

let runTimerId = null;
let programFinished = false;

function updateToolbarButtonStates() {
  refreshDownloadMenu();
  const source = editor.value;   // the whole document, so read it once
  const isCodeModifiedOrUnassembled = (lastAssembledCode === null || source !== lastAssembledCode || !program.assembled);

  // 1. Assemble button: enabled ONLY when a program is loaded or modified, disabled once assembled
  const assembleBtn = document.getElementById('btnAssemble');
  if (assembleBtn) {
    const hasCode = source.trim().length > 0;
    const canAssemble = hasCode && isCodeModifiedOrUnassembled;
    assembleBtn.disabled = !canAssemble;
    assembleBtn.classList.toggle('inactive', !canAssemble);
    if (editorLanguageMode === 'c') {
      assembleBtn.innerHTML = '⚙ Compile';
      if (!hasCode) {
        assembleBtn.title = 'No C code in editor';
      } else if (canAssemble) {
        assembleBtn.title = 'Compile with Godbolt Compiler Explorer & load into memory (Ctrl+Enter)';
      } else {
        assembleBtn.title = 'Program is already compiled and up to date';
      }
    } else {
      assembleBtn.innerHTML = '⚙ Assemble';
      if (!hasCode) {
        assembleBtn.title = 'No assembly code in editor';
      } else if (canAssemble) {
        assembleBtn.title = 'Assemble and load program into memory (Ctrl+Enter)';
      } else {
        assembleBtn.title = 'Program is already assembled and up to date';
      }
    }
  }

  // 2. Undo / Redo buttons
  const undoBtn = document.getElementById('btnUndo');
  const redoBtn = document.getElementById('btnRedo');
  if (undoBtn) {
    const canUndo = !!(editorHistory && editorHistory.currentIndex > 0);
    undoBtn.disabled = !canUndo;
    undoBtn.classList.toggle('inactive', !canUndo);
    undoBtn.title = canUndo ? 'Undo last edit (Ctrl+Z)' : 'Nothing to undo';
  }
  if (redoBtn) {
    const canRedo = !!(editorHistory && editorHistory.currentIndex < editorHistory.history.length - 1);
    redoBtn.disabled = !canRedo;
    redoBtn.classList.toggle('inactive', !canRedo);
    redoBtn.title = canRedo ? 'Redo last undone edit (Ctrl+Y)' : 'Nothing to redo';
  }

  // 3. Run / Pause button (Standard button styling, not distinct primary color)
  const runBtn = document.getElementById('runPauseBtn');
  if (runBtn) {
    runBtn.classList.remove('primary');
    runBtn.classList.remove('danger');

    if (run.running) {
      runBtn.innerHTML = '⏸ Pause';
      runBtn.title = 'Pause program execution (F5)';
      runBtn.disabled = false;
      runBtn.classList.remove('inactive');
      runBtn.style.opacity = '1';
      runBtn.style.cursor = 'pointer';
    } else {
      if (!program.assembled) {
        runBtn.innerHTML = '▶ Run';
        runBtn.title = 'Please assemble the program first (⚙ Assemble or Ctrl+Enter) before running';
        runBtn.disabled = true;
        runBtn.classList.add('inactive');
        runBtn.style.opacity = '0.45';
        runBtn.style.cursor = 'not-allowed';
      } else if (programFinished) {
        runBtn.innerHTML = '▶ Run';
        runBtn.title = 'Run program from start (F5)';
        runBtn.disabled = false;
        runBtn.classList.remove('inactive');
        runBtn.style.opacity = '1';
        runBtn.style.cursor = 'pointer';
      } else if (cpu.pc !== layout.baseAddress || cpu.instructionCount > 0) {
        runBtn.innerHTML = '▶ Resume';
        runBtn.title = `Resume execution from line ${run.currentLine > 0 ? run.currentLine : 'current PC'} (F5)`;
        runBtn.disabled = false;
        runBtn.classList.remove('inactive');
        runBtn.style.opacity = '1';
        runBtn.style.cursor = 'pointer';
      } else {
        runBtn.innerHTML = '▶ Run';
        runBtn.title = 'Run assembled program (F5)';
        runBtn.disabled = false;
        runBtn.classList.remove('inactive');
        runBtn.style.opacity = '1';
        runBtn.style.cursor = 'pointer';
      }
    }
  }

  // 4. Step forward button
  const stepBtn = document.getElementById('btnStep');
  if (stepBtn) {
    const canStep = (program.assembled && !run.running && !programFinished);
    stepBtn.disabled = !canStep;
    stepBtn.classList.toggle('inactive', !canStep);
    if (!program.assembled) {
      stepBtn.title = 'Please assemble the program first (⚙ Assemble or Ctrl+Enter) to step (F8)';
    } else if (run.running) {
      stepBtn.title = 'Cannot step while program is running (pause first)';
    } else if (programFinished) {
      stepBtn.title = 'Program execution finished. Reset (⟲) or Assemble to step again.';
    } else {
      stepBtn.title = 'Single step forward (F8)';
    }
  }

  // 5. Step back button
  const backBtn = document.getElementById('btnBack');
  if (backBtn) {
    const canBack = (program.assembled && !run.running && stepHistory.entries && stepHistory.entries.length > 0);
    backBtn.disabled = !canBack;
    backBtn.classList.toggle('inactive', !canBack);
    if (!program.assembled) {
      backBtn.title = 'Please assemble the program first before stepping (Shift+F8)';
    } else if (run.running) {
      backBtn.title = 'Cannot step back while program is running';
    } else if (!stepHistory.entries || stepHistory.entries.length === 0) {
      backBtn.title = 'No previous execution history to step back to';
    } else {
      backBtn.title = `Step back 1 instruction (${stepHistory.entries.length} step${stepHistory.entries.length > 1 ? 's' : ''} available) (Shift+F8)`;
    }
  }

  // 6. Reset button: active only after starting to Run or Step, or if state is dirty
  const resetBtn = document.getElementById('btnReset');
  if (resetBtn) {
    const isDirty = (cpu.instructionCount > 0 || (stepHistory.entries && stepHistory.entries.length > 0) || run.running || programFinished || cpu.pc !== layout.baseAddress || (typeof board.leds !== 'undefined' && board.leds !== 0) || (typeof board.sevseg !== 'undefined' && parseInt(board.sevseg, 16) !== 0) || (typeof uart.txText !== 'undefined' && uart.txText !== '') || (typeof uart.pending !== 'undefined' && (uart.pending.length > 0 || uart.rxFull)));
    resetBtn.disabled = !isDirty;
    resetBtn.classList.toggle('inactive', !isDirty);
    resetBtn.title = isDirty ? 'Reset CPU state, registers, memory, and peripherals to initial conditions' : 'Reset becomes active once execution begins (Run or Step)';
  }

  // 7. Find & Replace action buttons
  const findPrevBtn = document.getElementById('findPrevBtn');
  const findNextBtn = document.getElementById('findNextBtn');
  const replaceBtn = document.getElementById('findReplaceBtn');
  const replaceAllBtn = document.getElementById('findReplaceAllBtn');
  const hasMatches = (typeof findMatches !== 'undefined' && findMatches.length > 0);
  if (findPrevBtn) { findPrevBtn.disabled = !hasMatches; findPrevBtn.classList.toggle('inactive', !hasMatches); }
  if (findNextBtn) { findNextBtn.disabled = !hasMatches; findNextBtn.classList.toggle('inactive', !hasMatches); }
  if (replaceBtn) { replaceBtn.disabled = !hasMatches; replaceBtn.classList.toggle('inactive', !hasMatches); }
  if (replaceAllBtn) { replaceAllBtn.disabled = !hasMatches; replaceAllBtn.classList.toggle('inactive', !hasMatches); }

  // 8. UART Clear button
  const uartClearBtn = document.getElementById('uartClearBtn');
  if (uartClearBtn) {
    const hasUartText = !!(typeof uart.txText !== 'undefined' && uart.txText.length > 0);
    uartClearBtn.disabled = !hasUartText;
    uartClearBtn.classList.toggle('inactive', !hasUartText);
    uartClearBtn.title = hasUartText ? 'Clear Terminal display output' : 'Terminal output is already empty';
  }

  if (typeof updateFloatSteps === 'function') updateFloatSteps();
}

function updateRunButtonState() {
  updateToolbarButtonStates();
}

function runProgram() {
  if (!program.assembled) {
    clearLog();
    const mc = assembleOnly();
    if (!mc) return;
    programFinished = false;
  } else if (programFinished) {
    resetAll();
    programFinished = false;
    log(`Running program from start (PC 0x${cpu.pc.toString(16)})...`, 'info');
  } else {
    log(`Resuming execution from PC 0x${cpu.pc.toString(16)} (line ${sourceLineForPc(cpu.pc)})...`, 'info');
  }

  run.running = true;
  updateToolbarButtonStates();
  let count = 0;
  const INFINITE_LOOP_CAP = 100000000;
  const maxRunLimit = (typeof run.maxInstructions === 'number' && run.maxInstructions > 0) ? run.maxInstructions : 100000000;
  const BATCH_SIZE = Math.min(10000, maxRunLimit); // per-tick chunk for UI responsiveness
  // Real time: each tick runs the cycles the clock has owed since the run
  // started. More than a quarter second behind, the debt is dropped and
  // the shortfall shows as a fraction of real time.
  let rt = null;
  clock.rtRatio = 1;
  const initialLine = sourceLineForPc(cpu.pc);
  let resumeLine = (initialLine >= 1 && run.breakpoints.has(initialLine)) ? initialLine : -1;

  function finishRun(stopReason, cycleCount) {
    run.running = false;
    if (runTimerId) { clearTimeout(runTimerId); runTimerId = null; }
    program.assembled = true;
    // Where the run stopped, for the highlight. The branches below override
    // it only when there is no instruction to point at.
    run.currentLine = sourceLineForPc(cpu.pc);

    if (cycleCount >= INFINITE_LOOP_CAP) {
      log('Max cycles reached (possible infinite loop).', 'warn');
      setStatus('Stopped (max cycles)', 'warn');
      programFinished = false;
    } else if (cycleCount >= maxRunLimit) {
      programFinished = false;
      log(`Paused after ${maxRunLimit.toLocaleString()} instructions. Click Run to continue.`, 'info');
      setStatus(`Paused after ${maxRunLimit.toLocaleString()} instructions`, 'info');
    } else if (stopReason === 'exit' || stopReason === 'bounds') {
      run.currentLine = -1;
      programFinished = true;
      log(`Program completed after ${cpu.totalCycles} cycles, ${cpu.instructionCount} instructions.`, 'success');
      setStatus('Program finished', 'success');
    } else if (stopReason === 'breakpoint') {
      programFinished = false;
      if (pipeMode && pipe.E) setStatus(`Stopped at breakpoint (line ${sourceLineForPc(pipe.E.pc)}, in Execute)`, 'warn');
      else setStatus(`Stopped at breakpoint (line ${run.currentLine})`, 'warn');
    } else if (stopReason === 'paused') {
      programFinished = false;
      setStatus('Paused', 'info');
    } else {
      programFinished = false;
    }
    updateRegisters();
    updateMemoryView();
    updateStats();
    highlightCurrentLine();
    updateMachineCode();
    updateDisassembly();
    updateToolbarButtonStates();
  }

  function runBatch() {
    if (!run.running) {
      finishRun('paused', count);
      return;
    }

    let batchCount = 0;
    let stopReason = null;
    const hasBreakpoints = run.breakpoints.size > 0;
    const paced = clock.pace === 'real';
    const tick0 = performance.now(), hz = cpuHz();
    let due = Infinity;
    if (paced) {
      if (!rt) rt = { wall: tick0, cyc: cpu.totalCycles, lastWall: tick0, lastCyc: cpu.totalCycles };
      due = rt.cyc + (tick0 - rt.wall) / 1000 * hz;
    }

    while (run.running && count < INFINITE_LOOP_CAP && count < maxRunLimit &&
           (paced ? cpu.totalCycles < due && ((batchCount & 1023) || performance.now() - tick0 < 30)
                  : batchCount < BATCH_SIZE)) {
      const execAddr = cpu.pc;

      // Pipelined, a count is a cycle, and a breakpoint stops the run
      // once its instruction has entered Execute: from there on nothing
      // can flush it.
      if (pipeMode) {
        try {
          pipeStep();
        } catch (e) {
          log(`Error in cycle ${cpu.totalCycles}: ${e.message}`, 'error');
          stopReason = 'error';
          run.running = false;
          break;
        }
        count++;
        batchCount++;
        if (!run.running || pipeDone()) { stopReason = 'exit'; break; }
        if (hasBreakpoints && pipe.E) {
          const line = sourceLineForPc(pipe.E.pc);
          if (line >= 1 && run.breakpoints.has(line)) {
            log(`Breakpoint hit at line ${line}, now in Execute`, 'warn');
            stopReason = 'breakpoint';
            run.running = false;
            break;
          }
        }
        continue;
      }

      if (hasBreakpoints) {
        const line = sourceLineForPc(execAddr);
        if (line >= 1 && run.breakpoints.has(line)) {
          if (line !== resumeLine) {
            run.currentLine = line;
            log(`Breakpoint hit at line ${line}`, 'warn');
            stopReason = 'breakpoint';
            run.running = false;
            break;
          }
        } else {
          resumeLine = -1;
        }
      }

      try {
        executeOne();
      } catch (e) {
        log(`Error executing at PC 0x${execAddr.toString(16)}: ${e.message}`, 'error');
        stopReason = 'error';
        run.running = false;
        break;
      }

      if (hasBreakpoints && cpu.pc !== execAddr + 4) {
        resumeLine = -1;
      }

      count++;
      batchCount++;

      if (!run.running) { stopReason = 'exit'; break; }
      if ((cpu.pc >>> 0) < (layout.baseAddress >>> 0) || (cpu.pc >>> 0) >= (layout.mmioBase >>> 0)) { stopReason = 'bounds'; break; }
      if (sourceLineForPc(cpu.pc) === -1 && fetchInstruction(cpu.pc) === 0) { stopReason = 'exit'; break; }
    }

    updatePeripherals();

    let wait = 0;
    if (paced) {
      const t = performance.now();
      if (cpu.totalCycles < due - hz / 4) { rt.wall = t; rt.cyc = cpu.totalCycles; }
      // Measured over at least 50 cycles: on a slow clock a shorter window
      // can end between two whole cycles and read as lag.
      if (t - rt.lastWall >= Math.max(500, 50000 / hz)) {
        clock.rtRatio = Math.min(1, (cpu.totalCycles - rt.lastCyc) / ((t - rt.lastWall) / 1000 * hz));
        rt.lastWall = t; rt.lastCyc = cpu.totalCycles;
      }
      if (cpu.totalCycles >= due) wait = Math.max(0, Math.min(100, rt.wall + (cpu.totalCycles + 1 - rt.cyc) / hz * 1000 - t));
      updateStats();
      // A clock slow enough to watch: show each instruction as it runs.
      if (hz <= RT_FOLLOW_HZ) { run.currentLine = sourceLineForPc(cpu.pc); highlightCurrentLine(); updateRegisters(); }
    }

    if (run.running && count < INFINITE_LOOP_CAP && count < maxRunLimit && !stopReason) {
      runTimerId = setTimeout(runBatch, wait);
    } else {
      finishRun(stopReason || (count >= maxRunLimit ? 'paused' : null), count);
    }
  }

  runBatch();
}

function toggleRunPause() {
  // In HDL mode the Run button drives the Verilog engine instead of the
  // JavaScript model. Pause ends a live Verilator run, or a chunked Icarus
  // run after its current chunk, or else playback of the recording.
  if (simEngineMode === 'hdl') {
    if (hdlLive) { hdlLiveStop(); return; }
    if (hdlChunkedStop()) return;
    if (hdlStopPlay()) {
      setStatus('HDL playback paused at cycle ' + cpu.totalCycles + ' - Run carries on', 'info');
      return;
    }
    if (!program.assembled) {
      setStatus('Please assemble the program first — the Wrapper loads it via $readmemh', 'warn');
      return;
    }
    runHdlSimulation();
    return;
  }
  if (run.running) {
    run.running = false;
    if (runTimerId) { clearTimeout(runTimerId); runTimerId = null; }
    // Cancelling the pending batch means the run loop never reaches its own
    // exit path, so the highlight is moved to the paused instruction here.
    run.currentLine = sourceLineForPc(cpu.pc);
    setStatus('Paused', 'info');
    log('Execution paused by user.', 'info');
    updateRegisters();
    updateMemoryView();
    updateStats();
    highlightCurrentLine();
    updateMachineCode();
    updateDisassembly();
    updateToolbarButtonStates();
  } else {
    if (!program.assembled) {
      setStatus('Please assemble the program first (⚙ Assemble or Ctrl+Enter)', 'warn');
      log('Please assemble the program first before running.', 'warn');
      updateToolbarButtonStates();
      return;
    }
    runProgram();
  }
}

function togglePause() {
  toggleRunPause();
}

function resetAll() {
  run.running = false;
  if (runTimerId) { clearTimeout(runTimerId); runTimerId = null; }

  const wasAssembled = program.assembled && program.machineCode && program.machineCode.length > 0 && (lastAssembledCode !== null && editor.value === lastAssembledCode);
  resetState();
  clearLog();
  programFinished = false;
  run.currentLine = -1;

  if (wasAssembled) {
    loadProgram(program.machineCode);
    highlightFirstLine(program.machineCode);
    program.assembled = true;
    setStatus('Reset to start of program. Ready to run or step.');
    log('Simulator reset to start of program. Ready to run or step.', 'info');
  } else {
    program.assembled = false;
    highlightCurrentLine();
    setStatus('Reset');
    let mc = [];
    try { if (editor.value.trim()) mc = assemble(editor.value); } catch (e) { }
    highlightFirstLine(mc);
  }
  updateRegisters();
  updateMemoryView();
  updateStats();
  updateMachineCode();
  updateDisassembly();
  updateToolbarButtonStates();
}

function resetState() {
  run.running = false;
  if (runTimerId) { clearTimeout(runTimerId); runTimerId = null; }
  initializeState();
  stepHistory.entries = [];
  stepHistory.writeLog = [];
  stepHistory.pixelLog = [];
  // Reset all peripheral state
  board.leds = 0;
  clockLedLit = true;
  board.sevseg = '00000000';
  board.dip = 0;
  board.buttons = 0;
  // Reset UART Terminal display & RX queue
  uart.txText = '';
  uart.txBytes = [];
  uart.pending = [];
  uart.rxFull = false;
  uart.rxByte = 0;
  uart.rxDropped = 0;
  uart.rxDroppedTotal = 0;
  const btnEl = document.getElementById('uartSendBtn');
  if (btnEl) {
    btnEl.innerText = 'Send';
    btnEl.style.background = '';
  }
  const statusEl = document.getElementById('uartAutoSendStatus');
  if (statusEl) statusEl.innerText = '';
  oled.col = 0;
  oled.row = 0;
  oled.ctrl = 0;
  oled.advCol = false;
  oled.advRow = false;
  clearOledDisplay();
  accel.x = 0;
  accel.y = 0;
  accel.z = 64;
  accel.temp = 25;
  accel.dready = 1;
  const xS = document.getElementById('accelXSlider');
  const yS = document.getElementById('accelYSlider');
  const zS = document.getElementById('accelZSlider');
  const tS = document.getElementById('accelTempSlider');
  if (xS) xS.value = 0;
  if (yS) yS.value = 0;
  if (zS) zS.value = 64;
  if (tS) tS.value = 25;
  updatePeripherals();
  updateRegisters();
  updateMemoryView();
  updateDisassembly();
  updateStats();
  hideExecMarker();
}
