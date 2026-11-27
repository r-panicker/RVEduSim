// Every setting, kept in localStorage so that the next visit (or the next
// start of the desktop app) begins where this one left off. The settings
// live in their state objects and a few controls; a snapshot of all of
// them is written whenever one may have changed, and read back once at
// boot, before the first program is assembled.
//
// The page layout (panels, docks, the waveform's signals) is saved by the
// modules that own it under their own rvsim.* keys. Reset All clears all
// of those keys too.

import { hdlCyclesFor } from '../hdl/engine';
import { hdlConfig } from '../hdl/state';
import { pipeline } from '../machine/pipeline';
import { clock, layout, run, uart } from '../machine/state';
import { uartCharCycles } from '../machine/clock';
import { setUartSendMode } from '../machine/uart';
import { syncClockControls } from './clock-controls';
import { byId } from './dom';
import { exampleSources } from './example-sources';
import { pipeSyncControls } from './pipeline-controls';

export const SETTINGS_KEY = 'rvsim.settings.v1';
const STORAGE_PREFIX = 'rvsim.';

type Json = Record<string, unknown>;

// Controls whose value is the setting itself.
const COMPILER_FIELDS = ['godboltCompilerSelect', 'godboltOptSelect', 'godboltArchFlags'];
const HDL_FIELDS = ['hdlGeneration', 'hdlRegPath'];

function fieldValues(ids: string[]) {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const el = byId<HTMLInputElement | HTMLSelectElement>(id);
    if (el) out[id] = el.value;
  }
  return out;
}

export function settingsSnapshot() {
  const useM = byId<HTMLInputElement>('godboltUseM');
  return {
    compiler: { ...fieldValues(COMPILER_FIELDS), useM: useM ? useM.checked : false },
    layout: { ...layout },
    js: {
      arch: pipeline.arch, hazards: { ...pipeline.hazards }, predictor: { ...pipeline.predictor },
      cycles: { ...run.cycleConfig }, statementStepping: run.statementStepping, maxInstructions: run.maxInstructions,
    },
    clock: { divBits: clock.divBits, pace: clock.pace },
    examples: { webUrl: exampleSources.webUrl },
    uart: { sendMode: uart.sendMode, charInstr: uart.charInstr, typedInstr: uart.typedInstr },
    hdl: {
      trace: hdlConfig.traceEnabled, vcd: hdlConfig.dumpVcd, waveTop: hdlConfig.waveTop, liveWave: hdlConfig.liveWave,
      compare: hdlConfig.compareEnabled, synth: hdlConfig.synthEnabled, cycles: { ...hdlCyclesFor },
      ...fieldValues(HDL_FIELDS),
    },
  };
}

let restored = false;
let pending: ReturnType<typeof setTimeout> | null = null;

export function saveSettings() {
  // Nothing is written before the saved settings have been read back, or
  // the defaults the page starts with would replace them.
  if (!restored) return;
  if (pending) { clearTimeout(pending); pending = null; }
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsSnapshot())); } catch (e) { /* no storage */ }
}

// Many controls change settings; one listener notices all of them.
// Deferred, so the control's own handler has updated the state first.
function saveSoon() {
  if (pending) clearTimeout(pending);
  pending = setTimeout(saveSettings, 0);
}

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

// Copies the fields of `from` that `into` has, of the same type.
function assignKnown(into: Json, from: unknown, ok: (k: string, v: unknown) => boolean = () => true) {
  if (!isObj(from)) return;
  for (const k of Object.keys(into)) {
    const v = from[k];
    if (v !== undefined && typeof v === typeof into[k] && ok(k, v)) into[k] = v;
  }
}

function setFields(values: unknown) {
  if (!isObj(values)) return;
  for (const [id, v] of Object.entries(values)) {
    const el = byId<HTMLInputElement | HTMLSelectElement>(id);
    if (!el || typeof v !== 'string') continue;
    // A select keeps its value only if it still offers it.
    if (el instanceof HTMLSelectElement && ![...el.options].some(o => o.value === v)) continue;
    el.value = v;
  }
}

export function restoreSettings() {
  let s: unknown = null;
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { s = null; }
  restored = true;
  document.addEventListener('change', saveSoon, true);
  window.addEventListener('pagehide', saveSettings);
  if (!isObj(s)) return;

  if (isObj(s.compiler)) {
    setFields(s.compiler);
    const useM = byId<HTMLInputElement>('godboltUseM');
    if (useM && typeof s.compiler.useM === 'boolean') useM.checked = s.compiler.useM;
  }
  assignKnown(layout as unknown as Json, s.layout, (_k, v) => num(v, 0, 0xFFFFFFFF));

  if (isObj(s.js)) {
    const js = s.js;
    if (js.arch === 'single' || js.arch === 'multi' || js.arch === 'pipe') {
      pipeline.arch = js.arch;
      pipeline.on = js.arch === 'pipe';
    }
    assignKnown(pipeline.hazards as unknown as Json, js.hazards);
    assignKnown(pipeline.predictor as unknown as Json, js.predictor, (k, v) =>
      k === 'bits' ? v === 1 || v === 2 : k === 'entries' ? num(v, 1, 1 << 16) : true);
    assignKnown(run.cycleConfig as unknown as Json, js.cycles, (_k, v) => num(v, 1, 1000));
    if (typeof js.statementStepping === 'boolean') run.statementStepping = js.statementStepping;
    if (num(js.maxInstructions, 1, Number.MAX_SAFE_INTEGER)) run.maxInstructions = js.maxInstructions as number;
  }
  if (isObj(s.clock)) {
    if (num(s.clock.divBits, 0, 26)) clock.divBits = s.clock.divBits as number;
    if (s.clock.pace === 'max' || s.clock.pace === 'real') clock.pace = s.clock.pace;
    // The UART's character time follows the clock, unless it was set by hand.
    uart.charInstr = uartCharCycles();
  }
  if (isObj(s.examples) && typeof s.examples.webUrl === 'string') exampleSources.webUrl = s.examples.webUrl.trim();
  if (isObj(s.uart)) {
    const u = s.uart;
    if (num(u.charInstr, 1, Number.MAX_SAFE_INTEGER)) uart.charInstr = u.charInstr as number;
    if (num(u.typedInstr, 1, Number.MAX_SAFE_INTEGER)) uart.typedInstr = u.typedInstr as number;
    setUartSendMode(typeof u.sendMode === 'string' ? u.sendMode : uart.sendMode);
  }

  if (isObj(s.hdl)) {
    const h = s.hdl;
    const flag = (v: unknown, fallback: boolean) => typeof v === 'boolean' ? v : fallback;
    hdlConfig.traceEnabled = flag(h.trace, hdlConfig.traceEnabled);
    hdlConfig.dumpVcd = flag(h.vcd, hdlConfig.dumpVcd);
    hdlConfig.waveTop = flag(h.waveTop, hdlConfig.waveTop);
    if (h.liveWave === 'live' || h.liveWave === 'pause') hdlConfig.liveWave = h.liveWave;
    hdlConfig.compareEnabled = flag(h.compare, hdlConfig.compareEnabled);
    hdlConfig.synthEnabled = flag(h.synth, hdlConfig.synthEnabled);
    assignKnown(hdlCyclesFor as unknown as Json, h.cycles, (_k, v) => num(v, 1, Number.MAX_SAFE_INTEGER));
    setFields({ hdlGeneration: h.hdlGeneration, hdlRegPath: h.hdlRegPath });
  }
  pipeSyncControls();
  syncClockControls();
}

// Every setting and the whole layout back to the defaults. The page
// reloads, which is what puts every module's state back as it starts.
// Settings asks for a second click first, in the page: not every desktop
// webview shows window.confirm.
export function resetEverything() {
  restored = false;   // nothing may write the current settings back
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(STORAGE_PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch (e) { /* no storage */ }
  location.reload();
}
