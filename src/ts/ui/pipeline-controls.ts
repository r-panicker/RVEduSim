// The microarchitecture setting and the pipeline's settings: the hazard
// unit's switches and the branch predictor, in Settings and on the
// datapath strip, which show them from the pipeline state. The pipeline
// itself is machine/pipeline.ts.

import { pipeline } from '../machine/pipeline';
import { run } from '../machine/state';
import { dpOnModeChange, dpOnStateChange } from './datapath';
import { log } from './editor';
import { openSettingsModal } from './execution';
import { resetAll } from './run-control';
import { byId } from './dom';
import { redraw } from './views.svelte';

// Switching microarchitecture starts the program again: a pipeline
// cannot be conjured from the middle of a single-cycle run, and the
// cycle count so far would belong to the other model.
export const JS_ARCH_LOG: Record<typeof pipeline.arch, string> = {
  single: 'Single-cycle: one cycle per instruction.',
  multi: 'Multi-cycle: cycles per instruction from the table in Settings.',
  pipe: '5-stage pipeline: Step and Back move one clock cycle.'
};
export function setJsArch(name: string) {
  const a: typeof pipeline.arch = name in JS_ARCH_LOG ? name as typeof pipeline.arch : 'single';
  if (a === pipeline.arch) { redrawPipeControls(); return; }
  if (run.running) {
    run.running = false;
    if (run.timerId) { clearTimeout(run.timerId); run.timerId = null; }
  }
  pipeline.arch = a;
  pipeline.on = a === 'pipe';
  resetAll();
  log(JS_ARCH_LOG[a], 'info');
  redrawPipeControls();
  if (typeof dpOnModeChange === 'function') dpOnModeChange();
  if (typeof dpOnStateChange === 'function') dpOnStateChange();
}
export function pipeSetMode(on: boolean) { setJsArch(on ? 'pipe' : 'single'); }

// Settings and the strip's selector both show the microarchitecture.
function redrawPipeControls() {
  redraw('settings');
  redraw('datapath');
}

export function setPipeHazard(key: keyof typeof pipeline.hazards, on: boolean) {
  pipeline.hazards[key] = on;
  redraw('settings');
  if (typeof dpOnModeChange === 'function') dpOnModeChange();
}

// A different predictor is different hardware: start the program again.
export function setPipePredictor(part: Partial<typeof pipeline.predictor>) {
  Object.assign(pipeline.predictor, part);
  if (pipeline.predictor.bits !== 2) pipeline.predictor.bits = 1;
  if (pipeline.on) {
    if (run.running) { run.running = false; if (run.timerId) { clearTimeout(run.timerId); run.timerId = null; } }
    resetAll();
  }
  redraw('settings');
  if (typeof dpOnModeChange === 'function') dpOnModeChange();
}

// The strip's ⚙: Settings, scrolled to the microarchitecture card.
export function openPipeSettings() {
  openSettingsModal('simulator');
  const card = byId<HTMLSelectElement>('simMicroarch').closest('.sim-card');
  if (!card) return;
  let sc = card.parentElement;
  while (sc && sc.scrollHeight <= sc.clientHeight) sc = sc.parentElement;
  if (sc) sc.scrollTop += card.getBoundingClientRect().top - sc.getBoundingClientRect().top - 8;
}
