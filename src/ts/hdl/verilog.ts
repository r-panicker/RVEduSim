// Reading Verilog sources as text, and the small formats the HDL engine
// writes for the simulator.

import { hdlSources, type HdlSource } from './state';

// Blank out comments and string literals so a keyword inside either is
// never mistaken for code, while keeping every byte offset intact so
// line numbers stay true.
export function hdlStripNoise(src: string): string {
  let out = src.split('');
  let i = 0, n = src.length;
  const blank = (a: number, b: number) => { for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const two = src.substr(i, 2);
    if (two === '//') { const e = src.indexOf('\n', i); blank(i, e < 0 ? n : e); i = e < 0 ? n : e; }
    else if (two === '/*') { const e = src.indexOf('*/', i + 2); blank(i, e < 0 ? n : e + 2); i = e < 0 ? n : e + 2; }
    else if (src[i] === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"' && src[j] !== '\n') j += (src[j] === '\\' ? 2 : 1);
      blank(i, j + 1); i = j + 1;
    } else i++;
  }
  return out.join('');
}

// The text of `module name` up to its endmodule, or null if no source has it.
export function hdlModuleBody(src: string | null | undefined, name: string): string | null {
  const re = new RegExp('\\bmodule\\s+' + name + '\\b', 'g');
  const text = src || '';
  const m = re.exec(text);
  if (!m) return null;
  const end = text.indexOf('endmodule', m.index);
  return text.slice(m.index, end < 0 ? text.length : end);
}

// Which uploaded file declares `module Wrapper`? Everything hinges on
// it being present, since the generated testbench instantiates it.
export function hdlFindWrapper(files: HdlSource[] = hdlSources.files): HdlSource | null {
  return files.find(f => /^\s*module\s+Wrapper\b/m.test(f.src)) || null;
}

export function hdlHex32(v: number): string { return (v >>> 0).toString(16).padStart(8, '0'); }

// FNV-1a, for cache keys.
export function hdlHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}
