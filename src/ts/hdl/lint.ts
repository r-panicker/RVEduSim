// @ts-nocheck
// ================================================================
// Synthesis lint
// ================================================================
// Flags constructs that behave one way in simulation and another - or not
// at all - after synthesis. Everything reported carries a file and a line,
// and nothing here blocks a run.

import { hdlLog } from './engine';
import { hdlSources } from './state';
import { hdlStripNoise } from './verilog';


export const HDL_LINT_OK_TASKS = /^\$(readmemh|readmemb|signed|unsigned|clog2|bits|size|left|right|high|low|increment|dimensions|fatal|error|warning|info)\b/;

// Split a module body into its `always` blocks, with the line each starts
// on. Brace/`begin`-`end` matching is enough - these are flat RTL blocks.
export function hdlAlwaysBlocks(src) {
  const blocks = [];
  const re = /\balways\b\s*(@\s*\(([^)]*)\)|@\s*\*|@\*)?/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index;
    let i = re.lastIndex, depth = 0, seen = false;
    // Walk begin/end pairs; a block with no `begin` is a single statement.
    const tok = /\b(begin|end|case|casex|casez|endcase|fork|join)\b|;/g;
    tok.lastIndex = i;
    let t, endIdx = src.length;
    while ((t = tok.exec(src)) !== null) {
      const w = t[1];
      if (w === 'begin' || w === 'fork') { depth++; seen = true; }
      else if (w === 'end' || w === 'join') { depth--; if (seen && depth <= 0) { endIdx = t.index + w.length; break; } }
      else if (w === 'case' || w === 'casex' || w === 'casez') depth++;
      else if (w === 'endcase') depth--;
      else if (!w && !seen) { endIdx = t.index + 1; break; }   // bare `;`
    }
    blocks.push({
      start: start,
      line: src.slice(0, start).split('\n').length,
      sens: (m[2] || (m[0].includes('*') ? '*' : '')).trim(),
      body: src.slice(re.lastIndex, endIdx),
    });
    re.lastIndex = endIdx;
  }
  return blocks;
}

// One uploaded file -> a list of {line, level, msg}.
export function hdlLintFile(name, rawSrc) {
  const src = hdlStripNoise(rawSrc);
  const found = [];
  const lineOf = idx => src.slice(0, idx).split('\n').length;
  const add = (line, level, msg) => found.push({ file: name, line: line, level: level, msg: msg });

  // Delays are discarded by synthesis. A `#` is only a delay when a
  // number follows it: `#(` is a parameter list or override.
  let m, re = /(^|[^\w$])#\s*\d/g;
  while ((m = re.exec(src)) !== null) {
    add(lineOf(m.index), 'err', 'delay `#` — ignored by synthesis, so the hardware will not match this simulation');
  }

  // Simulation-only system tasks. $readmemh is not one: Vivado uses it
  // for memory initialisation.
  re = /\$[a-zA-Z_]\w*/g;
  while ((m = re.exec(src)) !== null) {
    if (HDL_LINT_OK_TASKS.test(m[0])) continue;
    add(lineOf(m.index), 'warn', m[0] + ' — simulation-only, ignored by synthesis');
  }

  // Types with no hardware equivalent.
  re = /\b(real|realtime|time|event)\s+[A-Za-z_]\w*\s*[;,=]/g;
  while ((m = re.exec(src)) !== null) {
    add(lineOf(m.index), 'err', '`' + m[1] + '` is not synthesisable');
  }

  // Loops synthesis cannot unroll.
  re = /\b(forever|while)\b/g;
  while ((m = re.exec(src)) !== null) {
    add(lineOf(m.index), 'err', '`' + m[1] + '` — synthesis needs a statically bounded loop');
  }

  // casex lets an X match anything, which cannot happen in hardware.
  re = /\bcasex\b/g;
  while ((m = re.exec(src)) !== null) {
    add(lineOf(m.index), 'warn', '`casex` — X-matching does not exist in hardware; prefer `casez`');
  }

  // Per-always-block checks.
  for (const b of hdlAlwaysBlocks(src)) {
    const clocked = /\b(posedge|negedge)\b/.test(b.sens);
    const body = b.body;
    if (clocked) {
      // A blocking assignment in a clocked block races every other block
      // reading that signal on the same edge. Loop headers are exempt:
      // `for (i = 0; i < N; i = i + 1)` has to be blocking.
      const noLoops = body.replace(/\bfor\s*\([^)]*\)/g, m0 => m0.replace(/[^\n]/g, ' '));
      const bm = /(^|\n)[^\n;]*?[A-Za-z_]\w*(\s*\[[^\]]*\])?\s*=(?!=)/.exec(noLoops);
      if (bm && !/<=/.test(bm[0])) {
        add(b.line + noLoops.slice(0, bm.index).split('\n').length - 1, 'warn',
            'blocking `=` in a clocked block — use `<=` for sequential logic');
      }
    } else if (b.sens && b.sens !== '*') {
      // An explicit sensitivity list on combinational logic is the classic
      // simulation/synthesis mismatch: synthesis reads it as `@*` anyway.
      if (/\bor\b|,/.test(b.sens)) {
        add(b.line, 'warn',
            'combinational `always @(' + b.sens.replace(/\s+/g, ' ').slice(0, 40) +
            ')` — synthesis treats this as `@*`; write `@*` so simulation agrees');
      }
    }
  }

  // An `initial` is fine for a power-up value or a $readmemh, but not
  // for anything that needs time to pass.
  re = /\binitial\b/g;
  while ((m = re.exec(src)) !== null) {
    const chunk = src.slice(m.index, m.index + 600);
    if (/#\s*[\d(]/.test(chunk.split(/\bend\b/)[0] || '')) {
      add(lineOf(m.index), 'err', '`initial` with a delay — simulation-only');
    }
  }

  return found;
}

// Lint every uploaded source except anything that looks like a testbench.
export function hdlSynthLint() {
  const out = [];
  for (const f of hdlSources.files) {
    if (/(^|[_\-])tb\.v$|_tb\.|testbench/i.test(f.name)) continue;
    out.push.apply(out, hdlLintFile(f.name, f.src));
  }
  // One report per line.
  const seen = new Set();
  return out.filter(x => {
    const k = x.file + ':' + x.line + ':' + x.msg;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// Report to the console. Called when sources are loaded, so the feedback
// arrives before the first run rather than after it.
export function hdlReportLint(quietWhenClean) {
  if (!hdlSources.files.length) return 0;
  const hits = hdlSynthLint();
  if (!hits.length) {
    if (!quietWhenClean) {
      hdlLog('Synthesis lint: nothing to flag in ' + hdlSources.files.length + ' file(s).', 'sys');
    }
    return 0;
  }
  const errs = hits.filter(h => h.level === 'err').length;
  hdlLog('Synthesis lint: ' + hits.length + ' note(s)' +
    (errs ? ', ' + errs + ' that will not synthesise' : '') + '.', errs ? 'warn' : 'sys');
  for (const h of hits.slice(0, 40)) {
    hdlLog('  ' + h.file + ':' + h.line + '  ' + h.msg, h.level === 'err' ? 'err' : 'warn');
  }
  if (hits.length > 40) hdlLog('  … and ' + (hits.length - 40) + ' more.', 'warn');
  return hits.length;
}
