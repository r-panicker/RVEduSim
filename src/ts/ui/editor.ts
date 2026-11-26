// @ts-nocheck
// The code editor: CodeMirror 6 language modes, theme, gutters, tooltips
// and autocomplete, the editor proxy and history, the console log and
// status bar, and the editor/dock splitter.

import { getCVarAtSourceLine } from '../c/compile';
import { readMem, readMemSigned } from '../machine/memory';
import { initializeState } from '../machine/reset';
import { cpu, program, run, stepHistory } from '../machine/state';
import { PDP_COLOUR } from './datapath';
import { updateDisassembly, updateMachineCode } from './disassembly';
import { editorState } from './editor-state';
import { hideExecMarker, toggleBreakpoint, updateStats } from './execution';
import { updateMemoryView } from './memory-register-views';
import { RISCV_AUTOCOMPLETE_DOCS, clampGridRowWidths, escapeHtml, extractEditorSymbols, getAssemblyLineContext, updateRegisters } from './panels';
import { updateToolbarButtonStates } from './run-control';


export const consoleEl = document.getElementById('console');
export const regBody = document.getElementById('regBody');
export const memView = document.getElementById('memView');
export const disassemblyDisplay = document.getElementById('disassemblyDisplay');
export const statusBar = document.getElementById('statusBar');

// The editor's shared state (language, file name, Find & Replace) is
// editorState in ui/editor-state.ts. EXAMPLE_FILENAMES and EXAMPLE_MENU are
// in ui/examples-language.ts.

// ============================================================
// CODEMIRROR 6 RISC-V INTEGRATION & THEME
// ============================================================

export const RISCV_INSTRUCTIONS_SET = new Set([
  'add','addi','sub','lui','auipc','and','andi','or','ori','xor','xori',
  'sll','slli','srl','srli','sra','srai','slt','slti','sltu','sltiu',
  'beq','bne','blt','bge','bltu','bgeu','jal','jalr','lb','lh','lw','lbu','lhu','sb','sh','sw',
  'fence','ecall','ebreak',
  'mul','mulh','mulhsu','mulhu','div','divu','rem','remu',
  'lr.w','sc.w','amoswap.w','amoadd.w','amoxor.w','amoand.w','amoor.w','amomin.w','amomax.w','amominu.w','amomaxu.w',
  'flw','fsw','fadd.s','fsub.s','fmul.s','fdiv.s','fsqrt.s','fsgnj.s','fsgnjn.s','fsgnjx.s',
  'fmin.s','fmax.s','fcvt.w.s','fcvt.wu.s','fmv.x.w','feq.s','flt.s','fle.s','fclass.s',
  'fcvt.s.w','fcvt.s.wu','fmv.w.x',
  'fld','fsd','fadd.d','fsub.d','fmul.d','fdiv.d','fsqrt.d','fsgnj.d','fsgnjn.d','fsgnjx.d',
  'fmin.d','fmax.d','fcvt.s.d','fcvt.d.s','feq.d','flt.d','fle.d','fclass.d','fcvt.w.d',
  'fcvt.wu.d','fcvt.d.w','fcvt.d.wu',
  'csrrw','csrrs','csrrc','csrrwi','csrrsi','csrrci','mret','sret','uret','wfi','sfence.vma',
  'li','la','lla','lga','mv','not','neg','negw','sext.w','nop','j','jr','ret','call','tail',
  'beqz','bnez','blez','bgez','bltz','bgtz','bgt','ble','bgtu','bleu','seqz','snez','sltz','sgtz',
  'fmv.s','fneg.s','fabs.s','fmv.d','fneg.d','fabs.d','pause'
]);

export const RISCV_REGISTERS_SET = new Set([
  'zero','ra','sp','gp','tp','t0','t1','t2','s0','fp','s1','a0','a1','a2','a3','a4','a5','a6','a7',
  's2','s3','s4','s5','s6','s7','s8','s9','s10','s11','t3','t4','t5','t6',
  'ft0','ft1','ft2','ft3','ft4','ft5','ft6','ft7','fs0','fs1','fa0','fa1','fa2','fa3','fa4','fa5',
  'fa6','fa7','fs2','fs3','fs4','fs5','fs6','fs7','fs8','fs9','fs10','fs11','ft8','ft9','ft10','ft11'
]);


export const RISCV_CSRS_SET = new Set([
  'mstatus','mie','mtvec','mepc','mcause','mtval','mip','misa','mvendorid','marchid','mimpid','mhartid',
  'mcycle','minstret','cycle','time','instret','fflags','frm','fcsr'
]);

// RISC-V Custom Stream Parser for CodeMirror 6
export const riscvStreamParser = {
  token(stream, state) {
    if (stream.eatSpace()) return null;

    // Comments, as splitLine() in the assembler recognises them
    if (stream.match(/^(?:[#;]|\/\/).*$/)) {
      return 'comment';
    }
    if (stream.match(/^\/\*.*?\*\//)) {
      return 'comment';
    }

    // Strings
    if (stream.match(/^"([^"\\]|\\.)*"/)) {
      return 'string';
    }
    if (stream.match(/^'([^'\\]|\\.)*'/)) {
      return 'string';
    }

    // Assembler Directives (.text, .data, .word, etc.)
    if (stream.match(/^\.[a-zA-Z_]\w*/)) {
      return 'meta';
    }

    // Relocation macros %hi(...), %lo(...), %pcrel_hi(...), etc.
    if (stream.match(/^%(?:hi|lo|pcrel_hi|pcrel_lo|tprel_hi|tprel_lo|tprel_add|gprel|got_pcrel_hi|call)\b/)) {
      return 'operator';
    }

    // Numbers (Hex, Binary, Decimal)
    if (stream.match(/^0x[0-9a-fA-F]+/i) || stream.match(/^0b[01]+/i) || stream.match(/^-?\b\d+\b/)) {
      return 'number';
    }

    // Labels (identifiers before :)
    if (stream.match(/^[a-zA-Z_.$][\w.$]*(?=\s*:)/)) {
      return 'labelName';
    }

    // Words: Instructions, Registers, CSRs, Identifiers
    const wordMatch = stream.match(/^[a-zA-Z_.$][\w.$]*/);
    if (wordMatch) {
      const word = wordMatch[0].toLowerCase();
      if (RISCV_INSTRUCTIONS_SET.has(word)) {
        return 'keyword';
      }
      if (RISCV_REGISTERS_SET.has(word)) {
        return 'variableName';
      }
      if (RISCV_CSRS_SET.has(word)) {
        return 'propertyName';
      }
      return 'name';
    }

    // Punctuation
    if (stream.eat(/^[,():]/)) {
      return 'punctuation';
    }

    stream.next();
    return null;
  }
};

// ---- CodeMirror 6 extension objects ---------------------------------
// Created lazily by buildEditorExtensions() once window.CM6 is available
// (CDN-loaded with a local fallback; the app boots only when CM6 exists).
// Declared at the top level because initCodeMirrorEditor(), setLanguageMode()
// and the window-exposed helpers reference them.
export let riscvLanguage = null, cLanguage = null, riscvHighlightStyle = null, riscvEditorTheme = null,
    setBreakpointsEffect = null, setExecLineEffect = null, breakpointGutterMarker = null,
    breakpointLineNumberMarker = null, breakpointStateField = null, breakpointGutter = null,
    execLineField = null, signatureHelpField = null, riscvHoverTooltip = null,
    setPipeStagesEffect = null, pipeStagesField = null;

// Helper: format instruction signature with active operand parameter highlighted
export function formatActiveInstructionSignature(formatStr, operandIndex) {
  if (!formatStr) return '';
  const spaceIdx = formatStr.indexOf(' ');
  if (spaceIdx === -1) {
    return `<span style="color:#89b4fa;font-weight:bold;">${escapeHtml(formatStr)}</span>`;
  }
  const mnem = formatStr.slice(0, spaceIdx);
  const operandPart = formatStr.slice(spaceIdx + 1);
  
  const operands = operandPart.split(',');
  const formattedOperands = operands.map((op, idx) => {
    const trimmed = op.trim();
    if (idx === operandIndex) {
      return `<span style="color:#fab387;font-weight:bold;text-decoration:underline;background:rgba(250,179,135,0.2);padding:1px 4px;border-radius:3px;">${escapeHtml(trimmed)}</span>`;
    }
    return `<span style="color:#cdd6f4;">${escapeHtml(trimmed)}</span>`;
  });
  
  return `<span style="color:#89b4fa;font-weight:bold;">${escapeHtml(mnem)}</span> ` + formattedOperands.join(', ');
}

export function buildEditorExtensions() {
  riscvLanguage = CM6.StreamLanguage.define(riscvStreamParser);

// C Language Stream Parser for CodeMirror 6
const C_KEYWORDS_SET = new Set([
  'if', 'else', 'while', 'for', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'goto', 'sizeof', 'typedef', 'struct', 'union', 'enum', 'static', 'extern',
  'const', 'volatile', 'register', 'auto', 'inline', 'restrict', 'asm', '__asm__', '__volatile__'
]);

const C_TYPES_SET = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', 'bool',
  'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'size_t', 'ssize_t', 'intptr_t', 'uintptr_t', 'ptrdiff_t', 'wchar_t'
]);

const cStreamParser = {
  startState() {
    return { inBlockComment: false };
  },
  token(stream, state) {
    if (state.inBlockComment) {
      if (stream.match(/^.*?\*\//)) {
        state.inBlockComment = false;
        return 'comment';
      }
      stream.skipToEnd();
      return 'comment';
    }

    if (stream.eatSpace()) return null;

    // Single line comments
    if (stream.match(/^\/\/.*/)) {
      return 'comment';
    }

    // Block comments
    if (stream.match(/^\/\*/)) {
      if (stream.match(/^.*?\*\//)) {
        return 'comment';
      }
      state.inBlockComment = true;
      stream.skipToEnd();
      return 'comment';
    }

    // Preprocessor directives (#include, #define, #ifdef, etc.)
    if (stream.match(/^#[a-zA-Z_]\w*/)) {
      return 'meta';
    }

    // Strings
    if (stream.match(/^"([^"\\]|\\.)*"/)) {
      return 'string';
    }
    // Characters
    if (stream.match(/^'([^'\\]|\\.)*'/)) {
      return 'string';
    }

    // Numbers (Hex, Binary, Floats, Decimals)
    if (stream.match(/^0x[0-9a-fA-F]+[uUlL]*/i) ||
        stream.match(/^0b[01]+[uUlL]*/i) ||
        stream.match(/^\d+(\.\d+)?([eE][+-]?\d+)?[fFlLuU]*/)) {
      return 'number';
    }

    // Multi-character and single-character operators
    if (stream.match(/^(?:->|<<|>>|<=|>=|==|!=|&&|\|\||\+\+|--|\+=|-=|\*=|(?:\/)=|%=|&=|\|=|\^=|[-+*\/%&|^!~=<>?:])/)) {
      return 'operator';
    }

    // Identifiers, Keywords, Types
    const wordMatch = stream.match(/^[a-zA-Z_]\w*/);
    if (wordMatch) {
      const word = wordMatch[0];
      if (C_KEYWORDS_SET.has(word)) {
        return 'keyword';
      }
      if (C_TYPES_SET.has(word)) {
        return 'typeName';
      }
      if (/^[A-Z_][A-Z0-9_]*$/.test(word)) {
        return 'propertyName';
      }
      return 'variableName';
    }

    // Punctuation
    if (stream.eat(/^[{}\[\](),;.]/)) {
      return 'punctuation';
    }

    stream.next();
    return null;
  }
};

cLanguage = CM6.StreamLanguage.define(cStreamParser);

editorState.language = 'asm';
editorState.languageCompartment = null;

riscvHighlightStyle = CM6.HighlightStyle.define([
  { tag: CM6.tags.keyword, color: '#89b4fa', fontWeight: '600' },          // RV Instructions / C Keywords (Blue)
  { tag: CM6.tags.typeName, color: '#f5c2e7', fontWeight: '600' },         // C Types (Pink)
  { tag: CM6.tags.variableName, color: '#a6e3a1' },                        // Registers / Variables (Green)
  { tag: CM6.tags.meta, color: '#f5c2e7', fontWeight: '600' },             // Directives (Pink)
  { tag: CM6.tags.labelName, color: '#fab387', fontWeight: 'bold' },       // Labels (Peach)
  { tag: CM6.tags.comment, color: '#6c7086', fontStyle: 'italic' },        // Comments (Gray)
  { tag: CM6.tags.number, color: '#f9e2af' },                               // Numbers/Immediates (Yellow)
  { tag: CM6.tags.string, color: '#a6e3a1' },                               // Strings (Green)
  { tag: CM6.tags.punctuation, color: '#cdd6f4' },                          // Punctuation (Lavender/White)
  { tag: CM6.tags.operator, color: '#89dceb', fontWeight: '600' },         // %hi, %lo macros / C operators (Cyan)
  { tag: CM6.tags.propertyName, color: '#cba6f7' }                         // CSRs / Macros (Mauve)
]);

riscvEditorTheme = CM6.EditorView.theme({
  "&": {
    color: "#cdd6f4",
    backgroundColor: "#181825",
    height: "100%",
    fontFamily: "'Consolas', 'Roboto Mono', 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
    fontSize: "13px"
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "inherit",
    lineHeight: "20px"
  },
  ".cm-content": {
    caretColor: "#cba6f7",
    padding: "12px 8px 120px 8px",
    fontFamily: "inherit"
  },
  "&.cm-focused": {
    outline: "none"
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "#cba6f7",
    borderLeftWidth: "2px"
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(203, 166, 247, 0.3) !important"
  },
  ".cm-gutters": {
    backgroundColor: "#181825",
    color: "#6c7086",
    borderRight: "1px solid #313244",
    paddingRight: "2px",
    userSelect: "none"
  },
  ".cm-lineNumbers": {
    minWidth: "36px",
    textAlign: "right"
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 6px 0 2px",
    cursor: "pointer"
  },
  ".cm-lineNumbers .cm-gutterElement:hover": {
    color: "#cdd6f4"
  },
  ".cm-activeLineGutter": {
    backgroundColor: "rgba(137, 180, 250, 0.12)",
    color: "#cdd6f4"
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(137, 180, 250, 0.05)"
  },
  ".cm-execLine": {
    backgroundColor: "rgba(137, 180, 250, 0.18) !important",
    borderLeft: "3px solid #89b4fa"
  },
  ".cm-breakpoint-gutter": {
    width: "16px",
    paddingLeft: "2px",
    cursor: "pointer"
  },
  ".cm-breakpoint-dot": {
    color: "#f38ba8",
    fontSize: "14px",
    lineHeight: "20px",
    display: "inline-block",
    textAlign: "center",
    width: "14px",
    filter: "drop-shadow(0 0 4px rgba(243, 139, 168, 0.7))"
  },
  ".cm-lineNumbers .cm-gutterElement.cm-breakpoint-line-number": {
    color: "#f38ba8 !important",
    fontWeight: "bold !important",
    backgroundColor: "rgba(243, 139, 168, 0.25) !important",
    borderRadius: "4px",
    textShadow: "0 0 6px rgba(243, 139, 168, 0.6)"
  },
  ".cm-tooltip": {
    backgroundColor: "#181825 !important",
    border: "1px solid #45475a !important",
    borderRadius: "6px !important",
    boxShadow: "0 8px 24px rgba(0,0,0,0.5) !important",
    color: "#cdd6f4 !important"
  },
  ".cm-tooltip-autocomplete": {
    backgroundColor: "#181825 !important",
    border: "1px solid #45475a !important",
    borderRadius: "6px !important",
    boxShadow: "0 8px 24px rgba(0,0,0,0.5) !important",
    fontFamily: "inherit !important"
  },
  ".cm-tooltip-autocomplete > ul": {
    maxHeight: "260px !important",
    fontFamily: "inherit !important"
  },
  ".cm-tooltip-autocomplete > ul > li": {
    color: "#cdd6f4 !important",
    padding: "4px 8px !important"
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "rgba(137, 180, 250, 0.2) !important",
    color: "#cba6f7 !important"
  },
  ".cm-tooltip.cm-completionInfo": {
    backgroundColor: "#181825 !important",
    border: "1px solid #45475a !important",
    borderRadius: "6px !important",
    padding: "6px 10px !important",
    maxWidth: "420px !important",
    boxShadow: "0 8px 24px rgba(0,0,0,0.5) !important"
  },
  ".cm-signature-tooltip": {
    backgroundColor: "#181825 !important",
    border: "1px solid #89b4fa !important",
    borderRadius: "6px !important",
    boxShadow: "0 6px 20px rgba(0,0,0,0.6) !important"
  }
}, { dark: true });

// Breakpoint & Execution Line Effects & Fields
setBreakpointsEffect = CM6.StateEffect.define();
setExecLineEffect = CM6.StateEffect.define();

breakpointGutterMarker = new class extends CM6.GutterMarker {
  toDOM() {
    const dot = document.createElement('span');
    dot.className = 'cm-breakpoint-dot';
    dot.innerHTML = '●';
    dot.title = 'Breakpoint';
    return dot;
  }
};

breakpointLineNumberMarker = new class extends CM6.GutterMarker {
  get elementClass() {
    return 'cm-breakpoint-line-number';
  }
};

breakpointStateField = CM6.StateField.define({
  create() {
    return {
      gutter: CM6.RangeSet.empty,
      lineNumbers: CM6.RangeSet.empty
    };
  },
  update(value, tr) {
    let gutter = value.gutter.map(tr.changes);
    let lineNumbers = value.lineNumbers.map(tr.changes);

    for (const e of tr.effects) {
      if (e.is(setBreakpointsEffect)) {
        const gutterBuilder = new CM6.RangeSetBuilder();
        const lnBuilder = new CM6.RangeSetBuilder();

        const sortedLines = [...e.value].sort((a,b) => a - b);
        for (const lineNo of sortedLines) {
          if (lineNo >= 1 && lineNo <= tr.state.doc.lines) {
            const line = tr.state.doc.line(lineNo);
            gutterBuilder.add(line.from, line.from, breakpointGutterMarker);
            lnBuilder.add(line.from, line.from, breakpointLineNumberMarker);
          }
        }
        gutter = gutterBuilder.finish();
        lineNumbers = lnBuilder.finish();
      }
    }
    return { gutter, lineNumbers };
  },
  provide: f => [
    CM6.lineNumberMarkers.from(f, v => v.lineNumbers)
  ]
});

breakpointGutter = [
  breakpointStateField,
  CM6.gutter({
    class: 'cm-breakpoint-gutter',
    markers: v => v.state.field(breakpointStateField).gutter,
    initialSpacer: () => breakpointGutterMarker,
    domEventHandlers: {
      mousedown(view, line, event) {
        const lineNo = view.state.doc.lineAt(line.from).number;
        toggleBreakpoint(lineNo);
        return true;
      }
    }
  })
];

execLineField = CM6.StateField.define({
  create() { return CM6.Decoration.none; },
  update(execLines, tr) {
    execLines = execLines.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setExecLineEffect)) {
        const lineNo = e.value;
        if (lineNo < 1 || lineNo > tr.state.doc.lines) {
          execLines = CM6.Decoration.none;
        } else {
          const line = tr.state.doc.line(lineNo);
          const dec = CM6.Decoration.line({
            attributes: { class: 'cm-execLine' }
          });
          execLines = CM6.Decoration.set([dec.range(line.from)]);
        }
      }
    }
    return execLines;
  },
  provide: f => CM6.EditorView.decorations.from(f)
});

// Which pipeline stage holds each line's instruction, as letters in a
// gutter of their own. Effect value: [[lineNo, 'F D'], ...].
class PipeStageMarker extends CM6.GutterMarker {
  constructor(text) { super(); this.text = text; }
  eq(other) { return other.text === this.text; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-pipe-stage';
    for (const L of this.text.split(' ')) {
      const b = document.createElement('b');
      b.textContent = L;
      b.style.color = PDP_COLOUR[L];
      el.appendChild(b);
    }
    return el;
  }
}
setPipeStagesEffect = CM6.StateEffect.define();
pipeStagesField = CM6.StateField.define({
  create() { return CM6.RangeSet.empty; },
  update(marks, tr) {
    marks = marks.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setPipeStagesEffect)) continue;
      const b = new CM6.RangeSetBuilder();
      for (const [lineNo, text] of e.value) {
        if (lineNo < 1 || lineNo > tr.state.doc.lines) continue;
        const line = tr.state.doc.line(lineNo);
        b.add(line.from, line.from, new PipeStageMarker(text));
      }
      marks = b.finish();
    }
    return marks;
  }
});

// Live Signature Helper Tooltip (shows active instruction format while typing operands)
function getSignatureTooltip(state) {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  
  const line = state.doc.lineAt(sel.head);
  const textBefore = line.text.slice(0, sel.head - line.from);
  
  if (textBefore.includes('#') || textBefore.includes(';')) return null;
  
  const lineCtx = getAssemblyLineContext(textBefore);
  if (lineCtx.context !== 'OPERAND' || !lineCtx.activeMnemonic) return null;
  
  const activeInst = (typeof RISCV_AUTOCOMPLETE_DOCS !== 'undefined') ? RISCV_AUTOCOMPLETE_DOCS.find(
    d => (d.type === 'inst' || d.type === 'pseudo' || d.type === 'directive') && d.name.toLowerCase() === lineCtx.activeMnemonic
  ) : null;
  if (!activeInst) return null;
  
  return {
    pos: sel.head,
    above: true,
    arrow: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-signature-tooltip';
      dom.style.cssText = 'padding:6px 10px;font-size:12px;background:#181825;color:#cdd6f4;border:1px solid #89b4fa;border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,0.5);line-height:1.4;pointer-events:none;z-index:999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
      
      const sigHtml = formatActiveInstructionSignature(activeInst.format, lineCtx.operandIndex);
      dom.innerHTML = `
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
              <span style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(137,180,250,0.2);color:#89b4fa;font-weight:bold;">PARAM ${lineCtx.operandIndex + 1}</span>
              <code style="font-family:monospace;font-size:12px;">${sigHtml}</code>
            </div>
            <div style="font-size:11px;color:#a6adc8;">${escapeHtml(activeInst.desc)}</div>
          `;
      return { dom };
    }
  };
}

signatureHelpField = CM6.StateField.define({
  create(state) {
    return getSignatureTooltip(state);
  },
  update(tooltip, tr) {
    if (tr.docChanged || tr.selection) {
      return getSignatureTooltip(tr.state);
    }
    return tooltip;
  },
  provide: f => CM6.showTooltip.computeN([f], state => {
    const val = state.field(f);
    return val ? [val] : [];
  })
});

// Hover Tooltip for Instructions, Registers, Directives, and Symbols
riscvHoverTooltip = CM6.hoverTooltip((view, pos, side) => {
  const line = view.state.doc.lineAt(pos);
  const lineText = line.text;
  const col = pos - line.from;

  if (editorState.language === 'c') {
    const cCommentIdx = lineText.indexOf('//');
    if (cCommentIdx !== -1 && col >= cCommentIdx) return null;
    const cMatch = lineText.slice(0, col).match(/(\w+)$/);
    const cWordStart = cMatch ? col - cMatch[1].length : col;
    const cMatchAfter = lineText.slice(col).match(/^(\w+)/);
    const cWordEnd = cMatchAfter ? col + cMatchAfter[1].length : col;
    if (cWordStart === cWordEnd) return null;
    const cWord = lineText.slice(cWordStart, cWordEnd);
    const varInfo = getCVarAtSourceLine(line.number, cWord);
    if (!varInfo) return null;
    return {
      pos: line.from + cWordStart,
      end: line.from + cWordEnd,
      above: true,
      create() {
        const dom = document.createElement('div');
        dom.className = 'cm-hover-tooltip';
        dom.style.cssText = 'padding:6px 10px;font-size:12px;max-width:360px;background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,0.4);line-height:1.45;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
        const offsetTxt = `s0 ${varInfo.offset >= 0 ? '+' : '-'} ${Math.abs(varInfo.offset)}`;
        let addrLine = offsetTxt;
        let valueHtml = '';
        const pcReady = typeof cpu.pc !== 'undefined' && (cpu.pc >>> 0) > varInfo.framePtrAddr;
        if (typeof program.assembled !== 'undefined' && program.assembled && typeof cpu.regs !== 'undefined' && pcReady) {
          const s0 = cpu.regs[8] >>> 0;
          const addr = (s0 + varInfo.offset) >>> 0;
          const uval = readMem(addr, 4, true) >>> 0;
          const sval = readMemSigned(addr, 4, true);
          addrLine += ` = 0x${addr.toString(16).padStart(8, '0')}`;
          valueHtml = `<div style="font-size:11px;color:#a6adc8;border-top:1px solid #313244;padding-top:3px;margin-top:3px;">Hex 0x${uval.toString(16).padStart(8, '0')} &nbsp;·&nbsp; Dec (signed) ${sval} &nbsp;·&nbsp; Dec (unsigned) ${uval}</div>`;
        } else if (typeof program.assembled !== 'undefined' && program.assembled && !pcReady) {
          valueHtml = `<div style="font-size:11px;color:#a6adc8;border-top:1px solid #313244;padding-top:3px;margin-top:3px;">s0 not set up yet at the current PC</div>`;
        }
        dom.innerHTML = `
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                <span style="font-size:10px;padding:1px 5px;border-radius:3px;font-weight:bold;text-transform:uppercase;background:#313244;color:#89b4fa;">${varInfo.kind}</span>
                <span style="font-weight:bold;color:#fab387;font-family:monospace;font-size:13px;">${escapeHtml(varInfo.name)}</span>
              </div>
              <div style="color:#cdd6f4;margin-bottom:3px;font-family:monospace;">${addrLine}</div>
              ${valueHtml}
            `;
        return { dom };
      }
    };
  }

  const commentIdx = lineText.indexOf('#');
  if (commentIdx !== -1 && col >= commentIdx) return null;
  
  const match = lineText.slice(0, col).match(/([.\w]+)$/);
  const wordStart = match ? col - match[1].length : col;
  const matchAfter = lineText.slice(col).match(/^([.\w]+)/);
  const wordEnd = matchAfter ? col + matchAfter[1].length : col;
  
  if (wordStart === wordEnd) return null;
  const word = lineText.slice(wordStart, wordEnd);
  const wordLower = word.toLowerCase();
  
  const userSymbols = extractEditorSymbols(view.state.doc.toString());
  const allCandidates = [...userSymbols, ...(typeof RISCV_AUTOCOMPLETE_DOCS !== 'undefined' ? RISCV_AUTOCOMPLETE_DOCS : [])];
  const docItem = allCandidates.find(d => d.name.toLowerCase() === wordLower);
  if (!docItem) return null;
  
  return {
    pos: line.from + wordStart,
    end: line.from + wordEnd,
    above: true,
    create(view) {
      const dom = document.createElement('div');
      dom.className = 'cm-hover-tooltip';
      dom.style.cssText = 'padding:6px 10px;font-size:12px;max-width:360px;background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,0.4);line-height:1.45;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
      
      const badgeLabel = docItem.type === 'directive' ? 'dir' : docItem.type === 'register' ? 'reg' : docItem.type;
      
      dom.innerHTML = `
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
              <span style="font-size:10px;padding:1px 5px;border-radius:3px;font-weight:bold;text-transform:uppercase;background:#313244;color:#89b4fa;">${badgeLabel}</span>
              <span style="font-weight:bold;color:#fab387;font-family:monospace;font-size:13px;">${escapeHtml(docItem.format || docItem.name)}</span>
            </div>
            <div style="color:#cdd6f4;margin-bottom:3px;">${escapeHtml(docItem.desc || '')}</div>
            ${docItem.meta ? `<div style="font-size:11px;color:#a6adc8;border-top:1px solid #313244;padding-top:3px;margin-top:3px;">${escapeHtml(docItem.meta)}</div>` : ''}
          `;
      return { dom };
    }
  };
});

} // end buildEditorExtensions()

// Autocomplete Source for C Language in CodeMirror 6
export function cAutocomplete(context) {
  const line = context.state.doc.lineAt(context.pos);
  const textBefore = line.text.slice(0, context.pos - line.from);

  if (textBefore.includes('//')) return null;
  const quoteCount = (textBefore.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) return null;

  const word = context.matchBefore(/[\w#]+/);
  if (!word && !context.explicit) return null;

  const wordStr = word ? word.text.toLowerCase() : '';
  const options = [];

  const types = [
    { name: 'int', desc: '32-bit signed integer' },
    { name: 'char', desc: '8-bit character / byte' },
    { name: 'void', desc: 'Empty / return type' },
    { name: 'float', desc: '32-bit IEEE 754 float' },
    { name: 'double', desc: '64-bit IEEE 754 float' },
    { name: 'short', desc: '16-bit integer' },
    { name: 'long', desc: 'Long integer' },
    { name: 'unsigned', desc: 'Unsigned type modifier' },
    { name: 'signed', desc: 'Signed type modifier' },
    { name: 'bool', desc: 'Boolean type' },
    { name: 'int8_t', desc: '8-bit signed int' },
    { name: 'int16_t', desc: '16-bit signed int' },
    { name: 'int32_t', desc: '32-bit signed int' },
    { name: 'uint8_t', desc: '8-bit unsigned int' },
    { name: 'uint16_t', desc: '16-bit unsigned int' },
    { name: 'uint32_t', desc: '32-bit unsigned int' },
    { name: 'size_t', desc: 'Unsigned size type' },
    { name: 'uintptr_t', desc: 'Pointer-sized unsigned int' }
  ];

  const keywords = [
    { name: 'return', desc: 'Return from function' },
    { name: 'if', desc: 'Conditional branch' },
    { name: 'else', desc: 'Else branch' },
    { name: 'for', desc: 'For loop' },
    { name: 'while', desc: 'While loop' },
    { name: 'do', desc: 'Do-while loop' },
    { name: 'switch', desc: 'Switch statement' },
    { name: 'case', desc: 'Switch case' },
    { name: 'default', desc: 'Default case' },
    { name: 'break', desc: 'Break loop/switch' },
    { name: 'continue', desc: 'Continue next iteration' },
    { name: 'struct', desc: 'Structure definition' },
    { name: 'typedef', desc: 'Type alias' },
    { name: 'const', desc: 'Constant qualifier' },
    { name: 'volatile', desc: 'Volatile MMIO qualifier' },
    { name: 'static', desc: 'Static storage duration' },
    { name: 'sizeof', desc: 'Size of type or variable' }
  ];

  const macros = [
    { name: 'LEDS', desc: '(*(volatile unsigned int*)0xFFFF0060) - Nexys 4 LEDs' },
    { name: 'SWITCHES', desc: '(*(volatile unsigned int*)0xFFFF0064) - Nexys 4 DIP Switches' },
    { name: 'BUTTONS', desc: '(*(volatile unsigned int*)0xFFFF0068) - Nexys 4 Push Buttons' },
    { name: 'SEVSEG', desc: '(*(volatile unsigned int*)0xFFFF0080) - Nexys 4 7-Segment Display' },
    { name: 'UART_TX', desc: '(*(volatile unsigned int*)0xFFFF000C) - UART Transmit Register' },
    { name: 'ACCEL_DATA', desc: '(*(volatile unsigned int*)0xFFFF0040) - 3-Axis Accelerometer' },
    { name: '#include', desc: 'Preprocessor include header' },
    { name: '#define', desc: 'Preprocessor define macro' },
    { name: '#ifdef', desc: 'Preprocessor conditional' },
    { name: '#ifndef', desc: 'Preprocessor conditional' },
    { name: '#endif', desc: 'Preprocessor end conditional' }
  ];

  for (const item of [...types, ...keywords, ...macros]) {
    const nameLower = item.name.toLowerCase();
    if (!wordStr || nameLower.startsWith(wordStr) || (wordStr.startsWith('#') && nameLower.startsWith(wordStr))) {
      options.push({
        label: item.name,
        type: item.name.startsWith('#') ? 'namespace' : (types.includes(item) ? 'type' : (keywords.includes(item) ? 'keyword' : 'constant')),
        detail: item.desc,
        boost: (nameLower === wordStr) ? 100 : (nameLower.startsWith(wordStr) ? 50 : 10)
      });
    }
  }

  return {
    from: word ? word.from : context.pos,
    options: options,
    validFor: /^[\w#]*$/
  };
}

// Autocomplete Source for CodeMirror 6 with Active Instruction Format Info
export function riscvAutocomplete(context) {
  if (editorState.language === 'c') {
    return cAutocomplete(context);
  }

  const line = context.state.doc.lineAt(context.pos);
  const textBefore = line.text.slice(0, context.pos - line.from);

  if (textBefore.includes('#') || textBefore.includes(';')) return null;
  const quoteCount = (textBefore.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) return null;

  const word = context.matchBefore(/[.\w]+/);
  const lineCtx = getAssemblyLineContext(textBefore);

  if (!word && !context.explicit) {
    return null;
  }

  const userSymbols = extractEditorSymbols(context.state.doc.toString());
  const allCandidates = [...userSymbols, ...(typeof RISCV_AUTOCOMPLETE_DOCS !== 'undefined' ? RISCV_AUTOCOMPLETE_DOCS : [])];

  const activeInstDoc = (lineCtx.context === 'OPERAND' && lineCtx.activeMnemonic && typeof RISCV_AUTOCOMPLETE_DOCS !== 'undefined') ? 
    RISCV_AUTOCOMPLETE_DOCS.find(d => (d.type === 'inst' || d.type === 'pseudo' || d.type === 'directive') && d.name.toLowerCase() === lineCtx.activeMnemonic) : null;

  const wordStr = word ? word.text.toLowerCase() : '';
  const options = [];
  const seen = new Set();

  for (const item of allCandidates) {
    const nameLower = item.name.toLowerCase();
    if (seen.has(nameLower)) continue;

    // Context filtering
    if (lineCtx.context === 'MNEMONIC') {
      if (item.type === 'register') continue;
    } else if (lineCtx.context === 'OPERAND') {
      if (item.type === 'inst' || item.type === 'pseudo' || item.type === 'directive') continue;
    }

    // Matching & scoring
    let boost = 0;
    if (wordStr) {
      if (nameLower.startsWith(wordStr)) {
        boost = nameLower === wordStr ? 100 : 50;
      } else if (wordStr.length >= 2 && nameLower.includes(wordStr)) {
        boost = 20;
      } else {
        continue;
      }
    }

    if (lineCtx.context === 'OPERAND') {
      const isJumpOrBranch = lineCtx.activeMnemonic && /^(j|jal|jalr|beq|bne|blt|bge|bltu|bgeu|beqz|bnez|blez|bgez|bltz|bgtz|bgt|ble|bgtu|bleu|call|tail|la)$/i.test(lineCtx.activeMnemonic);
      if (isJumpOrBranch && (item.type === 'label' || item.type === 'equ')) {
        boost += 40;
      } else if (item.type === 'register') {
        boost += 30;
      }
    }

    seen.add(nameLower);
    const badgeLabel = item.type === 'directive' ? 'dir' : item.type === 'register' ? 'reg' : item.type;

    options.push({
      label: item.name,
      type: item.type === 'directive' ? 'keyword' : item.type === 'register' ? 'variable' : item.type === 'label' ? 'constant' : 'function',
      detail: item.format || '',
      boost: boost,
      info: () => {
        const dom = document.createElement('div');
        dom.style.cssText = 'max-width:380px;font-size:12px;line-height:1.45;padding:6px 8px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#cdd6f4;background:#181825;border-radius:4px;';
        
        let activeInstBanner = '';
        if (activeInstDoc) {
          const sigHtml = formatActiveInstructionSignature(activeInstDoc.format, lineCtx.operandIndex);
          activeInstBanner = `
                <div style="background:rgba(137,180,250,0.12);border:1px solid rgba(137,180,250,0.3);border-radius:4px;padding:6px 8px;margin-bottom:8px;">
                  <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#89b4fa;font-weight:700;margin-bottom:2px;">
                    Active Instruction Format
                  </div>
                  <div style="font-family:monospace;font-size:12px;margin-bottom:2px;">${sigHtml}</div>
                  <div style="color:#cdd6f4;font-size:11px;">${escapeHtml(activeInstDoc.desc)}</div>
                  ${activeInstDoc.meta ? `<div style="font-size:10px;color:#a6adc8;margin-top:2px;">${escapeHtml(activeInstDoc.meta)}</div>` : ''}
                </div>
              `;
        }

        dom.innerHTML = `
              ${activeInstBanner}
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
                <span style="font-size:10px;padding:1px 5px;border-radius:3px;font-weight:bold;text-transform:uppercase;background:#313244;color:#89b4fa;">${badgeLabel}</span>
                <span style="font-weight:bold;color:#cba6f7;font-family:monospace;font-size:13px;">${escapeHtml(item.format || item.name)}</span>
              </div>
              <div style="color:#cdd6f4;margin-bottom:3px;">${escapeHtml(item.desc || '')}</div>
              ${item.meta ? `<div style="font-size:11px;color:#a6adc8;border-top:1px solid rgba(255,255,255,0.08);padding-top:3px;margin-top:3px;">${escapeHtml(item.meta)}</div>` : ''}
            `;
        return dom;
      }
    });
  }

  return {
    from: word ? word.from : context.pos,
    options: options,
    validFor: /^[.\w]*$/
  };
}

// CodeMirror 6 Compatibility Proxy
export const editor = {
  get value() {
    return editorState.cm ? editorState.cm.state.doc.toString() : '';
  },
  set value(newVal) {
    if (!editorState.cm) return;
    const currentVal = editorState.cm.state.doc.toString();
    if (currentVal !== newVal) {
      editorState.cm.dispatch({
        changes: { from: 0, to: currentVal.length, insert: newVal }
      });
    }
  },
  get selectionStart() {
    return editorState.cm ? editorState.cm.state.selection.main.from : 0;
  },
  set selectionStart(pos) {
    if (!editorState.cm) return;
    const to = editorState.cm.state.selection.main.to;
    const maxPos = editorState.cm.state.doc.length;
    const clampedPos = Math.max(0, Math.min(pos, maxPos));
    editorState.cm.dispatch({
      selection: CM6.EditorSelection.single(clampedPos, Math.max(clampedPos, to))
    });
  },
  get selectionEnd() {
    return editorState.cm ? editorState.cm.state.selection.main.to : 0;
  },
  set selectionEnd(pos) {
    if (!editorState.cm) return;
    const from = editorState.cm.state.selection.main.from;
    const maxPos = editorState.cm.state.doc.length;
    const clampedPos = Math.max(0, Math.min(pos, maxPos));
    editorState.cm.dispatch({
      selection: CM6.EditorSelection.single(Math.min(from, clampedPos), clampedPos)
    });
  },
  get scrollTop() {
    return editorState.cm ? editorState.cm.scrollDOM.scrollTop : 0;
  },
  set scrollTop(v) {
    if (editorState.cm) editorState.cm.scrollDOM.scrollTop = v;
  },
  get scrollLeft() {
    return editorState.cm ? editorState.cm.scrollDOM.scrollLeft : 0;
  },
  set scrollLeft(v) {
    if (editorState.cm) editorState.cm.scrollDOM.scrollLeft = v;
  },
  focus() {
    if (editorState.cm) editorState.cm.focus();
  },
  setSelectionRange(start, end) {
    if (!editorState.cm) return;
    const maxPos = editorState.cm.state.doc.length;
    const s = Math.max(0, Math.min(start, maxPos));
    const e = Math.max(0, Math.min(end, maxPos));
    editorState.cm.dispatch({
      selection: CM6.EditorSelection.single(s, e),
      effects: CM6.EditorView.scrollIntoView(s, { y: 'center' })
    });
  }
};

// Editor History using CodeMirror 6 History
export const editorHistory = {
  get history() {
    const u = editorState.cm ? CM6.undoDepth(editorState.cm.state) : 0;
    const r = editorState.cm ? CM6.redoDepth(editorState.cm.state) : 0;
    return new Array(u + r + 1);
  },
  get currentIndex() {
    return editorState.cm ? CM6.undoDepth(editorState.cm.state) : 0;
  },
  undo() {
    if (editorState.cm && CM6.undo(editorState.cm)) {
      if (typeof updateToolbarButtonStates === 'function') updateToolbarButtonStates();
      return true;
    }
    return false;
  },
  redo() {
    if (editorState.cm && CM6.redo(editorState.cm)) {
      if (typeof updateToolbarButtonStates === 'function') updateToolbarButtonStates();
      return true;
    }
    return false;
  },
  initialState() {
    if (typeof updateToolbarButtonStates === 'function') updateToolbarButtonStates();
  }
};


export function log(msg, type = 'info') {
  const div = document.createElement('div');
  div.className = type;
  div.textContent = msg;
  consoleEl.appendChild(div);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

export function clearLog() {
  consoleEl.innerHTML = '';
}

export function setStatus(msg, type = '') {
  statusBar.textContent = msg;
  statusBar.style.color = type === 'error' ? '#f38ba8' : type === 'success' ? '#a6e3a1' : '#a6adc8';
}

export function resetExecutionForSourceChange() {
  if (editorState.lastAssembledCode !== null && editor.value === editorState.lastAssembledCode) {
    return;
  }
  initializeState();
  stepHistory.entries = [];
  stepHistory.writeLog = [];
  stepHistory.pixelLog = [];
  program.assembled = false;
  run.running = false;
  program.machineCode = [];
  run.currentLine = -1;
  cpu.lastExecutedRd = -1;
  updateRegisters();
  updateMemoryView();
  updateMachineCode();
  updateDisassembly();
  updateStats();
  hideExecMarker();
  if (typeof updateToolbarButtonStates === 'function') updateToolbarButtonStates();
}

export function initSplitter() {
  const splitter = document.getElementById('mainSplitter');
  const rightPanel = document.querySelector('.right-panel');
  if (!splitter || !rightPanel) return;
  let dragging = false;
  // The editor needs a usable width even when the user drags the splitter
  // far to the left. LEFT_MIN guarantees the code editor keeps enough room;
  // the splitter (6px) is accounted for so the dock never pushes the editor
  // out of view / creates blank space on the right.
  const LEFT_MIN = 360;
  const clamp = (w) => Math.max(220, Math.min(w, Math.max(360, (window.innerWidth || 1200) - LEFT_MIN - 6)));

  splitter.addEventListener('pointerdown', (e) => {
    dragging = true;
    splitter.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  splitter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const mainRect = splitter.parentElement.getBoundingClientRect();
    const width = mainRect.right - e.clientX;
    rightPanel.style.width = clamp(width) + 'px';
    rightPanel.style.minWidth = '';
    rightPanel.style.maxWidth = '';
    // The dock just changed width — re-clamp the persisted 2×2 column
    // bases so a paired row never keeps its old wide widths and overflows
    // the narrower dock (blank space on the right / panels shifting left).
    clampGridRowWidths();
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Persist the clamped width (not a stale un-clamped value).
    rightPanel.style.width = clamp(parseFloat(rightPanel.style.width) || 0) + 'px';
    // Final re-clamp after the width is committed.
    clampGridRowWidths();
  };
  splitter.addEventListener('pointerup', stop);
  splitter.addEventListener('pointercancel', stop);
  // If the window is resized after a drag, re-clamp so a very wide dock
  // can never starve the editor or overflow the viewport (blank space).
  window.addEventListener('resize', () => {
    if (rightPanel.style.width) {
      rightPanel.style.width = clamp(parseFloat(rightPanel.style.width) || 0) + 'px';
      clampGridRowWidths();
    }
  });
}

// Run once the page has loaded every module (main.ts), in page order.
export function onEditorLoad() {
  for (let i = 0; i < 32; i++) {
    RISCV_REGISTERS_SET.add('x' + i);
    RISCV_REGISTERS_SET.add('f' + i);
  }
}
