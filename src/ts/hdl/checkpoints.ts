// @ts-nocheck
// ================================================================
// Checkpoints
// ================================================================
// vvp cannot save its own state ($save is not implemented in Icarus), so
// a second top-level module does it: every so many cycles it writes
// every reg and memory of the design, and the testbench's own, to files,
// and +CKLOAD starts a run from one of them instead of from reset. An
// input change then replays from the checkpoint before it, and extending
// the recording carries on from the last one.
//
// The state is found by reading the sources, so a design could hold some
// the reading misses. A run from a checkpoint therefore first replays a
// stretch the old recording already covers and must reproduce it
// exactly; if it does not, the run is repeated from reset and checkpoints
// stay off for those sources.

import { HDL_VCD_WINDOW, hdlLog } from './engine';
import { hdlCheckpoints, hdlSources, type HdlTrace, type HdlTimeline } from './state';
import { hdlTraceParser } from './trace';
import { hdlStripNoise } from './verilog';
export const HDL_CK_EVERY = 1024;    // cycles between checkpoints, to start with
export const HDL_CK_KEEP = 40;       // past this many the spacing doubles
export const HDL_CK_VERIFY = 16;     // fewest cycles of the old recording a replay must reproduce

// Verilator runs fast enough to need checkpoints only far apart, and only
// near the end of the recording: Resume starts there, an input change
// while paused is usually made there, and the waveform built on Pause
// covers the last HDL_VCD_WINDOW cycles. A recording keeps the two
// newest (t.vlCks, newest first). A replay from one is checked against the
// recording as an Icarus replay is, and one that does not reproduce it
// turns Verilator's checkpoints off for those sources.
export const HDL_VL_CK_EVERY = 200000;

// The testbench's own state, beside the design's.
export function hdlCkTbState(rb: null, dbuf: boolean) {
  return {
    scalars: ['DIP', 'PB', 'UART_RX', 'UART_RX_valid', 'ACCEL_Data', 'ACCEL_DReady', 'RESET',
              'cyc', 'stim_i', 'rx_i', 'pc_prev', 'led_prev', 'ss_prev']
      .concat(dbuf ? ['OLED_Swap_d'] : []),
    arrays: rb ? ['rf_shadow'] : []
  };
}

export const HDL_CK_CYC_LINE = hdlCkTbState(null, false).scalars.indexOf('cyc');

export function hdlVlCkPick(t: { joinKey: any; vlCks: any[]; }, key: string, limit: number) {
  if (!t || t.joinKey !== key || !t.vlCks) return null;
  return t.vlCks.find((c) => c.k > 0 && c.k <= limit) || null;
}
export function hdlVlCkFailed(k: string, key: any) {
  hdlCheckpoints.vlOff = key;
  hdlLog('A replay from the checkpoint at cycle ' + k + ' did not match the recording, so this ' +
    'design holds state the checkpoints do not save, or an initial block in it assigns with <= ' +
    '(which Verilator reports as MULTIDRIVEN), which lands after the checkpoint is restored. Checkpoints ' +
    'are off for these sources; this run, and every later one, starts from reset.', 'warn');
}
export function hdlVlCkMerge(kept: string | any[], found: { [x: string]: { mem: any; }; }) {
  const list = kept.slice();
  for (const k in found) if (found[k].txt) list.push({ k: +k, txt: found[k].txt, mem: found[k].mem });
  list.sort((a: { k: number; }, b: { k: number; }) => b.k - a.k);
  return list.filter((c: { k: any; }, i: number) => i === 0 || c.k !== list[i - 1].k).slice(0, 2);
}

// A run from a checkpoint at k prints from k (+TRACEFROM) and is joined
// on at `from`; what it printed before that goes aside, to be checked
// against the recording. Records are routed by their own cycle, which can
// trail the order they are printed in by one.
export function hdlJoinSplit(from: number) {
  let partial = '', past = false, seen = 0;
  const route = (parts: string[]) => {
    const main = [], over = [];
    for (const l of parts) {
      const c = hdlRecCycle(l);
      if (c !== null && c > seen) seen = c;
      if (c === null) (past ? main : over).push(l);
      else if (c >= from || l.startsWith('@@C')) { if (c >= from) past = true; main.push(l); }
      else over.push(l);
    }
    const j = (a: any[]) => a.length ? a.join('\n') + '\n' : '';
    return { main: j(main), over: j(over), seen };
  };
  return {
    feed(text: string) {
      const parts = (partial + text).split('\n');
      partial = parts.pop();
      return route(parts);
    },
    end() { const p = partial ? [partial] : []; partial = ''; return route(p); },
    // The unfinished line it holds, which belongs after everything routed.
    take() { const p = partial; partial = ''; return p; }
  };
}

// The records of a recording from cycle lo up to hi, each with its own
// cycle, in an order that does not depend on how they were grouped into
// steps. UART acknowledgements carry no cycle once parsed, and are left out.
export function hdlRecordList(t: HdlTrace, lo: number, hi: number) {
  const out: string[] = [];
  const add = (r: any[]) => { if (r[1] >= lo && r[1] < hi) out.push(JSON.stringify(r)); };
  // @@C is printed by the wall clock (Verilator) or on request (+PCLOG),
  // so a replay need not repeat it.
  const per = (list: any) => { for (const [k, f] of list) if (k !== 'C') add([k, parseInt(f[0], 10)].concat(f.slice(1))); };
  per(t.pre);
  const steps = t.steps;
  let a = 0, b = steps.length;
  while (a < b) { const m = (a + b) >> 1; if (steps[m].cyc < lo) a = m + 1; else b = m; }
  for (let i = Math.max(0, a - 1); i < steps.length && steps[i].cyc < hi; i++) {
    const s = steps[i];
    add(['I', s.cyc, s.pc, s.instr]);
    for (const w of s.regw) add(['W', w[2], w[0], w[1]]);
    for (const m of s.memw) add(['M', m[3], m[0], m[1], m[2]]);
    per(s.per);
  }
  return out.sort();
}
// Where a check against recording t can start: a recording folded into a
// snapshot no longer holds what came before it.
export function hdlCheckFrom(t: { base: { cyc: number; }; }, k: number) { return Math.max(k, t.base ? t.base.cyc + 2 : 0); }
export function hdlJoinCheck(oldRecs: string | any[] | null, overText: string, lo: number, hi: number) {
  if (/^@@K/m.test(overText)) return false;
  const p = hdlTraceParser();
  p.feed(overText);
  const got = hdlRecordList(p.finish(), lo, hi);
  return got.length === oldRecs.length && got.every((r, i) => r === oldRecs[i]);
}

// The restore happens 1 ns into the run, so its waveform's times move by
// 10k ns, as in hdlVcdJoin.
export function hdlShiftVcd(text: string, k: number) {
  if (!text || !k) return text;
  const ts = /\$timescale\s+(\d+)\s*(s|ms|us|ns|ps|fs)\s+\$end/.exec(text);
  const unit = ts ? +ts[1] * { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9, ps: 1e-12, fs: 1e-15 }[ts[2]] : 1e-9;
  const shift = Math.round(10 * k * 1e-9 / unit);
  const defs = text.indexOf('$enddefinitions');
  if (defs < 0) return text;
  const at = text.indexOf('$end', defs + 15) + 4;
  return text.slice(0, at) + text.slice(at).replace(/^#(\d+)$/gm, (_: any, t: string | number) => '#' + (+t + shift));
}

export function hdlCkModules() {
  const mods = new Map();
  for (const f of hdlSources.files) {
    // Attributes go too, minding that `@(*)` is not one.
    const src = hdlStripNoise(f.src).replace(/\(\*(?!\s*\))[\s\S]*?\*\)/g, ' ');
    const re = /\bmodule\s+([A-Za-z_]\w*)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const end = src.indexOf('endmodule', m.index);
      if (!mods.has(m[1])) mods.set(m[1], src.slice(m.index, end < 0 ? src.length : end));
    }
  }
  return mods;
}

// Index just past the parenthesised group that opens at s[i].
export function hdlCkSkipGroup(s: string | any[], i: number) {
  let depth = 0;
  for (; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i + 1;
  }
  return s.length;
}

// Split on the commas that are not inside brackets, braces or parentheses.
export function hdlCkSplit(s: string | any[]) {
  const parts = [];
  let depth = 0, from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push(s.slice(from, i)); from = i + 1; }
  }
  parts.push(s.slice(from));
  return parts;
}

// The names a declaration declares, after its keyword: `[7:0] a, b [0:3] = ...`.
export function hdlCkDeclarators(text: string) {
  let t = text.replace(/^\s*(signed|unsigned)\b/, '');
  for (let m; (m = /^\s*\[[^\]]*\]/.exec(t)) !== null;) t = t.slice(m[0].length);
  t = t.replace(/^\s*(signed|unsigned)\b/, '');
  return hdlCkSplit(t).map(d => {
    const m = /^\s*(\\\S+|[A-Za-z_][\w$]*)\s*((?:\[[^\]]*\]\s*)*)/.exec(d);
    return m ? { name: m[1], dims: (m[2].match(/\[/g) || []).length } : null;
  }).filter(Boolean);
}

// One module's regs and the instances it contains.
export function hdlCkScan(body: string | string[], mods: Map<any, any>) {
  // A generate block that declares nothing and instantiates none of the
  // design's modules (a parameter check, say) holds no state; any other
  // would put regs at names this scan cannot work out.
  let stateful = false;
  body = body.replace(/\bgenerate\b([\s\S]*?)\bendgenerate\b/g, (all: any, inner: string) => {
    if (/\b(reg|logic|integer)\b/.test(inner) ||
        [...mods.keys()].some(n => new RegExp('\\b' + n + '\\b').test(inner))) stateful = true;
    return ' ';
  });
  if (stateful) return { off: 'keeps state in a generate block' };
  if (/\bgenvar\b/.test(body)) return { off: 'uses a generate loop' };
  body = body.replace(/\bfunction\b[\s\S]*?\bendfunction\b/g, ' ')
             .replace(/\btask\b[\s\S]*?\bendtask\b/g, ' ');
  const regs = [], insts = [];
  // The port list, where an ANSI `output reg` is declared.
  let i = (/^module\s+[A-Za-z_]\w*\s*/.exec(body) || [''])[0].length;
  if (body[i] === '#') i = hdlCkSkipGroup(body, body.indexOf('(', i));
  while (/\s/.test(body[i] || '')) i++;
  if (body[i] === '(') {
    const end = hdlCkSkipGroup(body, i);
    let isReg = false;
    for (const item of hdlCkSplit(body.slice(i + 1, end - 1))) {
      let t = item.trim();
      const dir = /^(input|output|inout)\b\s*/.exec(t);
      if (dir) {
        const kind = /^(?:wire\s+|var\s+)?(reg|logic|integer)\b/.exec(t.slice(dir[0].length));
        isReg = dir[1] === 'output' && !!kind;
        t = kind ? t.slice(dir[0].length + kind.index + kind[0].length) : t.slice(dir[0].length);
      }
      if (isReg) regs.push(...hdlCkDeclarators(t));
    }
    i = end;
  }
  i = body.indexOf(';', i) + 1;
  // The body, at module level: declarations and instances. Procedural
  // code is skipped by depth, so a `reg` local to a named block is not
  // taken for one of the module's.
  const re = /\\\S+|[A-Za-z_][\w$]*/g;
  re.lastIndex = i;
  let depth = 0, m;
  while ((m = re.exec(body)) !== null) {
    const w = m[0];
    if (/^(begin|fork|case|casex|casez)$/.test(w)) { depth++; continue; }
    if (/^(end|join|join_any|join_none|endcase)$/.test(w)) { depth = Math.max(0, depth - 1); continue; }
    if (depth) continue;
    if (w === 'reg' || w === 'logic' || w === 'integer') {
      const semi = body.indexOf(';', re.lastIndex);
      regs.push(...hdlCkDeclarators(body.slice(re.lastIndex, semi < 0 ? body.length : semi)));
      re.lastIndex = semi < 0 ? body.length : semi + 1;
      continue;
    }
    if (!mods.has(w)) continue;
    let q = re.lastIndex;
    while (/\s/.test(body[q] || '')) q++;
    if (body[q] === '#') q = hdlCkSkipGroup(body, body.indexOf('(', q));
    const nm = /^\s*(\\\S+|[A-Za-z_][\w$]*)\s*/.exec(body.slice(q));
    if (!nm) continue;
    q += nm[0].length;
    if (body[q] === '[') return { off: 'has an array of instances' };
    if (body[q] !== '(') continue;
    insts.push({ mod: w, name: nm[1] });
    re.lastIndex = q;
  }
  return { regs, insts };
}

// Whether a memory is ever assigned: its name, then one or more index
// groups (which can nest, as in DMEM[ALUResult[9:2]][7:0]), then = or <=.
export function hdlCkWritten(body: string | any[], id: string | any[]) {
  for (let at = body.indexOf(id); at >= 0; at = body.indexOf(id, at + 1)) {
    if (/[\w$.]/.test(body[at - 1] || '') || /[\w$]/.test(body[at + id.length] || '')) continue;
    let q = at + id.length, groups = 0;
    for (;;) {
      while (/\s/.test(body[q] || '')) q++;
      if (body[q] !== '[') break;
      let depth = 0;
      for (; q < body.length; q++) {
        if (body[q] === '[') depth++;
        else if (body[q] === ']' && --depth === 0) { q++; break; }
      }
      groups++;
    }
    if (groups && (body.startsWith('<=', q) || (body[q] === '=' && body[q + 1] !== '='))) return true;
  }
  return false;
}

// The regs that can carry a value from one cycle to the next: those
// assigned in an always block that is not combinational (@*,
// always_comb), or in a task. The rest are worked out again from these.
export function hdlCkHeld(body: string) {
  const held = new Set();
  const re = /\b(always_ff|always_latch|always_comb|always|task)\b/g;
  const stop = /\b(always_ff|always_latch|always_comb|always|initial|assign|task|function|endmodule)\b/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const i = re.lastIndex;
    if (m[1] === 'always_comb' || (m[1] === 'always' && /^\s*@\s*(\*|\(\s*\*\s*\))/.test(body.slice(i, i + 40)))) continue;
    stop.lastIndex = i;
    const e = stop.exec(body);
    const end = e ? e.index : body.length;
    const text = body.slice(i, end);
    for (const a of text.matchAll(/([A-Za-z_][\w$]*)\s*(?:\[[^\]]*\]\s*)*(?:<=|=(?!=))/g)) held.add(a[1]);
    for (const a of text.matchAll(/\{([^{}]*)\}\s*(?:<=|=(?!=))/g))
      for (const id of a[1].match(/[A-Za-z_][\w$]*/g) || []) held.add(id);
    re.lastIndex = end;
  }
  return held;
}

// Every reg in the design under the Wrapper, by hierarchical name. A
// memory that nothing writes is left out: its contents come from
// $readmemh in every run, so saving it would only cost time. With
// heldOnly (Verilator), so are the regs hdlCkHeld finds combinational:
// naming a signal from another module keeps Verilator from optimising
// it, which costs a long run more than the checkpoints save.
export function hdlCkState(heldOnly: boolean) {
  const mods = hdlCkModules();
  if (!mods.has('Wrapper')) return { off: 'there is no Wrapper' };
  const scalars: string[] = [], arrays: string[] = [];
  const name = (path: string, id: string | string[]) => path + '.' + id + (id[0] === '\\' ? ' ' : '');
  const walk = (mod: string, path: string, depth: number) => {
    if (depth > 64) throw new Error('its hierarchy is too deep');
    const body = mods.get(mod);
    const s = hdlCkScan(body, mods);
    if (s.off) throw new Error('module ' + mod + ' ' + s.off);
    const held = heldOnly ? hdlCkHeld(body) : null;
    const seen = new Set();
    for (const r of s.regs) {
      if (seen.has(r.name)) continue;
      seen.add(r.name);
      if (r.dims > 1) throw new Error('module ' + mod + ' has a multi-dimensional array');
      if (!r.dims) { if (!held || held.has(r.name)) scalars.push(name(path, r.name)); continue; }
      if (hdlCkWritten(body, r.name)) arrays.push(name(path, r.name));
    }
    for (const c of s.insts) walk(c.mod, name(path, c.name), depth + 1);
  };
  try {
    walk('Wrapper', 'cg3207_hdl_tb.dut', 0);
  } catch (e) {
    return { off: e.message };
  }
  return { scalars, arrays };
}

// The checkpoint module: a separate top level, so it stays out of the
// waveform and out of the testbench the Download menu saves. Binary,
// because hex cannot say which bits of a digit are x or z.
export function hdlBuildCkModule(state: { off: any; scalars?: undefined; arrays?: undefined; } | { scalars: any[]; arrays: any[]; off?: undefined; }, rb: string | null, dbuf: boolean, vl: boolean) {
  const T = 'cg3207_hdl_tb.';
  const tb = hdlCkTbState(rb, dbuf);
  const sc = tb.scalars.map(n => T + n).concat(state.scalars);
  const ar = tb.arrays.map(n => T + n).concat(state.arrays);
  if (vl) return hdlBuildVlCkModule(sc, ar);
  return `\`timescale 1ns / 1ps
// Checkpoints for the simulator's replays. Every +CKEVERY cycles, and at
// cycle +CKAT, at the falling edge, every reg is written to ck_<cycle>.txt
// and every written memory to ck_<cycle>_m<i>.mem. +CKLOAD=<cycle> restores ck_load.txt and
// ck_load_m<i>.mem 1 ns into the run, before the first rising edge, so the
// run carries on from that cycle; @@K reports a file that did not read back.
module cg3207_hdl_ck;
  integer every = 0, at = -1, from = -1, fd, n;
  reg [8*48-1:0] name;
  initial begin
    if ($value$plusargs("CKEVERY=%d", every)) begin end
    if ($value$plusargs("CKAT=%d", at)) begin end
    if ($value$plusargs("CKLOAD=%d", from)) begin
      #1;
      n = 0;
      fd = $fopen("ck_load.txt", "r");
      if (fd) begin
${sc.map(p => `        n = n + $fscanf(fd, "%b\\n", ${p});`).join('\n')}
        $fclose(fd);
      end
${ar.map((p, i) => `      $readmemb("ck_load_m${i}.mem", ${p});`).join('\n')}
      if (n != ${sc.length}) begin
        $display("@@K %0d", n);
        $finish;
      end
    end
  end
  always @(negedge ${T}CLK)
    if (!${T}RESET && ${T}cyc != from &&
        ((every > 0 && ${T}cyc % every == 0) || ${T}cyc == at)) begin
      #1;
      $sformat(name, "ck_%0d.txt", ${T}cyc);
      fd = $fopen(name, "w");
${sc.map(p => `      $fwrite(fd, "%b\\n", ${p});`).join('\n')}
      $fclose(fd);
${ar.map((p, i) => `      $sformat(name, "ck_%0d_m${i}.mem", ${T}cyc);\n      $writememb(name, ${p});`).join('\n')}
    end
endmodule
`;
}

// Verilator's: the testbench instantiates it (hdlVerilate), since
// Verilator builds one top level, and a metacomment keeps it out of the
// waveform. Neither block waits: a delay would make it a process that
// Verilator schedules at run time, which slows the whole model by a
// fifth, as does writing the design's regs from a block that runs on a
// clock edge. So the restore is an initial block, which Verilator runs
// after the design's own (a design whose initial blocks assign with <=,
// which Verilator reports as MULTIDRIVEN, overrides it, and the check of
// the replay turns checkpoints off), and the save runs when a flag set
// at the falling edge rises. It writes to two files in turn, so that a
// run leaves its two newest.
export function hdlBuildVlCkModule(sc: any[], ar: any[]) {
  const T = 'cg3207_hdl_tb.';
  return `\`timescale 1ns / 1ps
/* verilator tracing_off */
// Checkpoints for the simulator's replays. Every +CKEVERY cycles, after the
// falling edge, every reg is written to ck_s<n>.txt, n taking 0 and 1 in
// turn, and every written memory to ck_s<n>_m<i>.mem. +CKLOAD=<cycle>
// restores ck_load.txt and ck_load_m<i>.mem at time 0, before the first
// rising edge, so the run carries on from that cycle; @@K reports a file
// that did not read back.
module cg3207_hdl_ck;
  integer every = 0, from = -1, slot = 0, fd, n;
  reg [8*48-1:0] name;
  reg save = 1'b0;
  initial begin
    if ($value$plusargs("CKEVERY=%d", every)) begin end
    if ($value$plusargs("CKLOAD=%d", from)) begin
      n = 0;
      fd = $fopen("ck_load.txt", "r");
      if (fd) begin
${sc.map((p) => `        n = n + $fscanf(fd, "%b\\n", ${p});`).join('\n')}
        $fclose(fd);
      end
${ar.map((p: any, i: any) => `      $readmemb("ck_load_m${i}.mem", ${p});`).join('\n')}
      if (n != ${sc.length}) begin
        $display("@@K %0d", n);
        $finish;
      end
    end
  end
  always @(negedge ${T}CLK)
    save <= !${T}RESET && every > 0 && ${T}cyc != from && ${T}cyc % every == 0 && ${T}cyc < ${T}max_cycles;
  always @(posedge save) begin
    slot = (${T}cyc / every) % 2;
    $sformat(name, "ck_s%0d.txt", slot);
    fd = $fopen(name, "w");
${sc.map((p) => `    $fwrite(fd, "%b\\n", ${p});`).join('\n')}
    $fclose(fd);
${ar.map((p: any, i: any) => `    $sformat(name, "ck_s%0d_m${i}.mem", slot);\n    $writememb(name, ${p});`).join('\n')}
  end
endmodule
`;
}

// The first cycle at which two input timelines differ, or Infinity. A
// checkpoint taken before it holds for both.
export function hdlTimelineDiff(a: HdlTimeline, b: HdlTimeline) {
  let diff = Infinity;
  const walk = (x: string | any[], y: string | any[], same: { (p: any, q: any): boolean; (p: any, q: any): boolean; (arg0: any, arg1: any): any; }) => {
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (i < x.length && i < y.length && same(x[i], y[i])) continue;
      diff = Math.min(diff, i < x.length ? x[i].cycle : Infinity, i < y.length ? y[i].cycle : Infinity);
      return;
    }
  };
  const byCycle = (l: { cycle: number; }[]) => l.slice().sort((p: { cycle: number; }, q: { cycle: number; }) => p.cycle - q.cycle);
  walk(byCycle(a.stim), byCycle(b.stim), (p: { cycle: any; code: any; value: any; }, q: { cycle: any; code: any; value: any; }) => p.cycle === q.cycle && p.code === q.code && p.value === q.value);
  walk(a.rx, b.rx, (p: { cycle: any; byte: any; }, q: { cycle: any; byte: any; }) => p.cycle === q.cycle && p.byte === q.byte);
  return diff;
}

// The cycle a record belongs to; @@N and @@F, which close a run, come
// after every cycle of it.
export function hdlRecCycle(line: string) {
  const m = /^@@([A-Z]) (\d+)/.exec(line);
  return m ? (m[1] === 'N' || m[1] === 'F' ? Infinity : +m[2]) : null;
}

// A dump as text. vvp on Windows writes it with CRLF line ends; the
// readers here match timestamps as whole lines, so they are made plain.
export function hdlVcdFromBytes(bytes: any, dec?: TextDecoder | undefined) {
  const s = (dec || new TextDecoder()).decode(bytes);
  return s.indexOf('\r') < 0 ? s : s.replace(/\r\n/g, '\n');
}

export function hdlVcdId(l: string | string[]) { return /^[bBrR]/.test(l) ? l.slice(l.indexOf(' ') + 1) : l.slice(1); }

export function hdlVcdFold(s: string, end: number, vals: Map<any, any>, fixed: { delete: (arg0: any) => void; } | null) {
  for (let i = 0; i < end;) {
    let j = s.indexOf('\n', i);
    if (j < 0 || j > end) j = end;
    const l = s.slice(i, j).trim();
    if (l && l[0] !== '$' && l[0] !== '#') {
      const id = hdlVcdId(l);
      vals.set(id, l);
      if (fixed) fixed.delete(id);
    }
    i = j + 1;
  }
}

// Where the first timestamp after `t` starts, searching forward or back.
export function hdlVcdAfter(s: string | any[], t: number) {
  const re = /^#(\d+)$/gm;
  let m;
  while ((m = re.exec(s)) !== null) if (+m[1] > t) return m.index;
  return s.length;
}
export function hdlVcdCut(s: string | string[], t: number) {
  let keep = s.length;
  for (let p = s.length; p > 0;) {
    const i = s.lastIndexOf('\n#', p - 1), at = i + 1;
    const nl = s.indexOf('\n', at + 1);
    const v = s.slice(at + 1, nl < 0 ? s.length : nl);
    if (s[at] === '#' && /^\d+$/.test(v)) { if (+v > t) keep = at; else break; }
    if (i < 0) break;
    p = i;
  }
  return keep;
}
export function hdlVcdLast(s: string) {
  const i = s.lastIndexOf('\n#');
  const m = i < 0 ? null : /^#(\d+)$/m.exec(s.slice(i + 1, s.indexOf('\n', i + 1) < 0 ? s.length : s.indexOf('\n', i + 1)));
  return m ? +m[1] : 0;
}

// An Icarus waveform as it is kept between runs: the declarations, the
// values at time `at` (0, or the start of the window), and the changes
// after it in pieces, one per run joined on. A join costs the length of
// what it adds rather than of the whole waveform, and the window drops
// the oldest changes by folding them into the starting values.
// `fixed` holds the ids whose starting value is still the one set at
// time 0: what the testbench reads from its plusargs (the cycle budget,
// how many input changes there are) can differ between runs, and the
// newest run's time-0 values are the ones that hold for the whole.
export function hdlVcdDoc(text: string, raw?: boolean | undefined) {
  if (!text || typeof text !== 'string') return text || null;
  const d = text.indexOf('$enddefinitions');
  if (d < 0) return text;
  const defsEnd = text.indexOf('$end', d + 15) + 4;
  const ts = /\$timescale\s+(\d+)\s*(s|ms|us|ns|ps|fs)\s+\$end/.exec(text);
  const unit = ts ? +ts[1] * { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9, ps: 1e-12, fs: 1e-15 }[ts[2]] : 1e-9;
  const fi = defsEnd + hdlVcdAfter(text.slice(defsEnd), -1);
  const first = fi < text.length ? /^#(\d+)/.exec(text.slice(fi, fi + 32)) : null;
  // Everything before the first timestamp stays as it is: Icarus puts the
  // parameters' values there, in a $dumpall.
  const doc = { defs: text.slice(0, fi), unit, at: first ? +first[1] : 0,
                vals: new Map(), fixed: new Set(), parts: [], end: 0 };
  if (first) {
    const from = fi + first[0].length;
    const rest = hdlVcdAfter(text.slice(from), -1);
    hdlVcdFold(text.slice(from, from + rest), rest, doc.vals, null);
    if (doc.at === 0) doc.fixed = new Set(doc.vals.keys());
    if (from + rest < text.length) {
      const body = text.slice(from + rest);
      doc.parts.push({ t: +/^#(\d+)/.exec(body)[1], text: body });
    }
    doc.end = Math.max(doc.at, hdlVcdLast(text));
  }
  return raw ? doc : hdlVcdWindow(doc);
}

export function hdlVcdText(v: { vals: any[]; defs: string; at: string; parts: any[]; }) {
  if (!v || typeof v === 'string') return v || null;
  const init = [...v.vals.values()];
  return v.defs + (/\n$/.test(v.defs) ? '' : '\n') + '#' + v.at + '\n$dumpvars\n' + init.join('\n') + (init.length ? '\n' : '') +
    '$end\n' + v.parts.map((p) => p.text).join('');
}

export function hdlVcdWindow(v: { defs?: any; unit: any; at: any; vals: any; fixed: any; parts: any; end: any; }) {
  const span = Math.round(HDL_VCD_WINDOW * 10e-9 / v.unit);
  if (v.end - v.at <= span * 1.25) return v;
  const to = v.end - span;
  while (v.parts.length) {
    const p = v.parts[0], i = hdlVcdAfter(p.text, to);
    hdlVcdFold(p.text, i, v.vals, v.fixed);
    if (i < p.text.length) { v.parts[0] = { t: +/^#(\d+)/.exec(p.text.slice(i, i + 32))[1], text: p.text.slice(i) }; break; }
    v.parts.shift();
  }
  v.at = to;
  return v;
}

// A run from the checkpoint at cycle k joined onto the waveform: the old
// one up to the checkpoint, then the new one moved to where it belongs.
// The restore happens 1 ns into the new run, against 10 ns per cycle (the
// testbench's `always #5`) plus 1 ns in the old one, so its times move
// by 10k ns.
export function hdlVcdJoin(a: { at: number; vals: Iterable<readonly [unknown, unknown]> | null | undefined; fixed: Iterable<unknown> | null | undefined; parts: string | any[]; defs: any; unit: any; end: number; }, b: any, k: number) {
  const nb = hdlVcdDoc(b, true);
  if (!nb || typeof nb === 'string') return nb;
  const shift = Math.round(10 * k * 1e-9 / nb.unit);
  const moved = nb.parts.map((p: { t: number; text: string; }) => ({ t: p.t + shift, text: p.text.replace(/^#(\d+)$/gm, (_: any, t: string | number) => '#' + (+t + shift)) }));
  a = hdlVcdDoc(a, true);
  // A join before the window's start has nothing left to join onto; the
  // new run alone covers the window.
  if (!a || typeof a === 'string' || shift < a.at) {
    return hdlVcdWindow({ defs: nb.defs, unit: nb.unit, at: nb.at + shift, vals: nb.vals, fixed: nb.fixed,
                          parts: moved, end: nb.end + shift });
  }
  const vals = new Map(a.vals), fixed = new Set(a.fixed);
  for (const id of fixed) if (nb.vals.has(id)) vals.set(id, nb.vals.get(id));
  const parts = a.parts.slice();
  while (parts.length && parts[parts.length - 1].t > shift) parts.pop();
  if (parts.length) {
    const p = parts[parts.length - 1], i = hdlVcdCut(p.text, shift);
    if (i < p.text.length) parts[parts.length - 1] = { t: p.t, text: p.text.slice(0, i) };
  }
  return hdlVcdWindow({ defs: a.defs, unit: a.unit, at: a.at, vals, fixed, parts: parts.concat(moved),
                        end: moved.length ? nb.end + shift : Math.min(a.end, shift) });
}

export function hdlStitchVcd(a: any, b: any, k: any) { return hdlVcdText(hdlVcdJoin(a, b, k)); }

// Keep the newest checkpoints at an even spacing that doubles as the
// recording grows, plus the last one, which is where an extension starts.
export function hdlCkAdd(found: { [x: string]: any; }) {
  for (const k in found) if (found[k].txt) hdlCheckpoints.set.at.set(+k, found[k]);
  while (hdlCheckpoints.set.at.size > HDL_CK_KEEP) {
    hdlCheckpoints.set.every *= 2;
    const last = Math.max(...hdlCheckpoints.set.at.keys());
    for (const k of [...hdlCheckpoints.set.at.keys()]) if (k % hdlCheckpoints.set.every && k !== last) hdlCheckpoints.set.at.delete(k);
  }
}
