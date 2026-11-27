// What the header, the toolbar and its status line show (Toolbar.svelte).
// Several modules own a part of it: run-control.ts the buttons' states,
// hdl/shared-ui.ts HDL mode's overrides of them, datapath.ts the Datapath/
// Waveform button, hdl/sources.ts the Verilog chip, editor.ts the status
// message and execution.ts the metrics. Each sets its part and redraws.

import { redraw } from './views.svelte';

export type ToolButton = { on: boolean; title: string };
// A piece of the metrics line: text, or a span styled by its kind.
export type StatSeg = { k: 'text' | 'lag' | 'tag' | 'pc'; s: string };
// The Example menu: a section per source (examples-language.ts).
export type ExampleMenuItem = { value: string; label: string; title: string; disabled?: boolean };
export type ExampleMenuGroup = { label: string; items: ExampleMenuItem[] };

export const toolbar = {
  lang: 'asm' as 'asm' | 'c',
  engine: 'js' as 'js' | 'hdl',
  // A simulation in progress: switching engines would run both at once.
  engLocked: false,
  hdlChip: { show: false, long: 'no Verilog', short: 'no Verilog', warn: false, title: '' },
  examples: [] as ExampleMenuGroup[],
  // The example loaded, or 'user_file' for a file opened from disk, which
  // is then shown as the selected entry of the menu.
  exampleKey: 'dip_led',
  userFile: null as string | null,
  assemble: { on: true, title: 'Assemble / Compile and load program into memory (Ctrl+Enter)', label: 'Assemble' },
  undo: { on: true, title: 'Undo last edit (Ctrl+Z)' } as ToolButton,
  redo: { on: true, title: 'Redo last undone edit (Ctrl+Y)' } as ToolButton,
  // `dim` greys the button out; null leaves its look to the stylesheet.
  run: { on: true, title: 'Run the assembled program (F5)', label: 'Run', dim: null as boolean | null },
  step: { on: true, title: 'Step (F8)' } as ToolButton,
  back: { on: true, title: 'Back step (Shift+F8)' } as ToolButton,
  reset: { on: true, title: 'Reset execution state' } as ToolButton,
  viz: { hdl: false, on: true, shown: false, title: '' },
  // Which downloads have something to save.
  downloads: {} as Record<string, boolean>,
  status: { text: 'Ready' as string | null, colour: null as string | null },
  // The metrics line in two halves, each a list of parts; null before the
  // first update.
  stats: null as { lead: StatSeg[][]; tail: StatSeg[][]; title: string } | null,
};

export function redrawToolbar() {
  redraw('toolbar');
}
