// The page's own sizes, which the user drags (App.svelte): the dock's width,
// set by the main splitter and by the 2×2 grid, and the console's height.
// null leaves a size to the stylesheet. Also the page's modes, which
// App.svelte sets on <body> as classes for the stylesheet.

import { redraw } from './views.svelte';

export const pageLayout = { dockW: null as number | null, consoleH: null as number | null };

export function setDockWidth(px: number | null) {
  if (pageLayout.dockW === px) return;
  pageLayout.dockW = px;
  redraw('page');
}

export function setConsoleH(px: number | null) {
  if (pageLayout.consoleH === px) return;
  pageLayout.consoleH = px;
  redraw('page');
}

// hdl: HDL mode. waveOpen, dpOpen: the waveform or datapath strip shown at
// the bottom of the page; waveInPanel, dpInPanel: each is a panel tab
// instead, on a phone. dpMax: the datapath strip fills the window. dpPipe,
// dpBp: the pipelined diagram, with the branch predictor. dpTimeline: the
// strip shows the timeline. floatDp: the floating step controls stand in
// for the strip's own.
export const pageMode = {
  hdl: false, waveOpen: false, waveInPanel: false, dpOpen: false, dpMax: false, dpInPanel: false,
  dpPipe: false, dpBp: false, dpTimeline: false, floatDp: false,
};
export const PAGE_MODE_CLASS: Record<keyof typeof pageMode, string> = {
  hdl: 'hdl-mode', waveOpen: 'wave-open', waveInPanel: 'wave-in-panel', dpOpen: 'dp-open', dpMax: 'dp-max',
  dpInPanel: 'dp-in-panel', dpPipe: 'dp-pipe', dpBp: 'dp-bp', dpTimeline: 'dp-view-timeline', floatDp: 'float-dp',
};

export function setPageMode(part: Partial<typeof pageMode>) {
  const keys = Object.keys(part) as (keyof typeof pageMode)[];
  if (keys.every(k => pageMode[k] === part[k])) return;
  Object.assign(pageMode, part);
  redraw('page');
}

