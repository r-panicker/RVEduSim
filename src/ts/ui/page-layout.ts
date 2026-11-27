// The page's own sizes, which the user drags (App.svelte): the dock's width,
// set by the main splitter and by the 2×2 grid, and the console's height.
// null leaves a size to the stylesheet.

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
