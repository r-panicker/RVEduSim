// What tells a Svelte panel to redraw. The state the panels show (machine/
// state.ts, hdl/state.ts, ui/editor-state.ts) is plain objects, read and
// written on every simulated instruction, so it is not made reactive; each
// component re-reads it instead whenever its view's revision changes.

import { flushSync, untrack } from 'svelte';

export const viewRev = $state({
  peripherals: 0,
  disassembly: 0,
  locals: 0,
  registers: 0,
  memory: 0,
  settings: 0,
  credits: 0,
  toolbar: 0,
  waveform: 0,
  datapath: 0,
  find: 0,
  floatSteps: 0,
  dock: 0,
  console: 0,
  page: 0,
  bpFigure: 0,
});

export type ViewName = keyof typeof viewRev;

// Redraws the view before returning, so that a caller (and a test) reading
// its elements next sees them up to date. Called from within Svelte's own
// update (a component's effect, as when a strip is mounted), it only marks
// the view: flushing there would re-enter the update, which goes on to
// draw it anyway.
export function redraw(view: ViewName) {
  // Untracked, or an effect that redraws would depend on what it changes.
  untrack(() => { viewRev[view]++; });
  if (!$effect.tracking()) flushSync();
}
