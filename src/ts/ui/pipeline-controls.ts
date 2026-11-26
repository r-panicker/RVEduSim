// The microarchitecture setting and the pipeline's settings: the hazard
// unit's switches and the branch predictor, in Settings and on the
// datapath strip. The pipeline itself is machine/pipeline.ts.

import { pipeline } from '../machine/pipeline';
import { run } from '../machine/state';
import { dpOnModeChange, dpOnStateChange } from './datapath';
import { log } from './editor';
import { openSettingsModal } from './execution';
import { resetAll } from './run-control';
import { byId } from './dom';

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
  if (a === pipeline.arch) { pipeSyncControls(); return; }
  if (run.running) {
    run.running = false;
    if (run.timerId) { clearTimeout(run.timerId); run.timerId = null; }
  }
  pipeline.arch = a;
  pipeline.on = a === 'pipe';
  resetAll();
  log(JS_ARCH_LOG[a], 'info');
  pipeSyncControls();
  if (typeof dpOnModeChange === 'function') dpOnModeChange();
  if (typeof dpOnStateChange === 'function') dpOnStateChange();
}
export function pipeSetMode(on: boolean) { setJsArch(on ? 'pipe' : 'single'); }

export function pipeInitControls() {
  const arch = byId<HTMLSelectElement>('simMicroarch');
  if (arch) arch.onchange = () => setJsArch(arch.value);
  document.querySelectorAll<HTMLInputElement>('[data-haz]').forEach(el => {
    el.onchange = () => {
      pipeline.hazards[el.dataset.haz as keyof typeof pipeline.hazards] = el.checked;
      if (typeof dpOnModeChange === 'function') dpOnModeChange();
    };
  });
  // A different predictor is different hardware: start the program again.
  const bp = (id: string, apply: (el: HTMLInputElement) => void) => {
    const el = byId<HTMLInputElement>(id);
    if (!el) return;
    el.onchange = () => {
      apply(el);
      if (pipeline.on) {
        if (run.running) { run.running = false; if (run.timerId) { clearTimeout(run.timerId); run.timerId = null; } }
        resetAll();
      }
      pipeSyncControls();
      if (typeof dpOnModeChange === 'function') dpOnModeChange();
    };
  };
  bp('pipeBpOn', (el) => { pipeline.predictor.on = el.checked; });
  bp('pipeBpBits', (el) => { pipeline.predictor.bits = +el.value === 2 ? 2 : 1; });
  bp('pipeBpEntries', (el) => { pipeline.predictor.entries = +el.value; });
  pipeSyncControls();
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

export function pipeSyncControls() {
  const arch = byId<HTMLSelectElement>('simMicroarch');
  if (arch) arch.value = pipeline.arch;
  const stripArch = byId<HTMLSelectElement>('dpArch');
  if (stripArch) stripArch.value = pipeline.on ? 'pipe' : 'single';
  document.querySelectorAll<HTMLInputElement>('[data-haz]').forEach(el => {
    el.checked = !!pipeline.hazards[el.dataset.haz as keyof typeof pipeline.hazards];
  });
  const bpOn = byId<HTMLInputElement>('pipeBpOn');
  if (bpOn) bpOn.checked = pipeline.predictor.on;
  ([['pipeBpBits', pipeline.predictor.bits], ['pipeBpEntries', pipeline.predictor.entries]] as const).forEach(([id, v]) => {
    const el = byId<HTMLSelectElement>(id);
    if (el) { el.value = String(v); el.disabled = !pipeline.predictor.on; }
  });
  const flushLbl = document.querySelector('[data-haz="flush"]');
  if (flushLbl && flushLbl.nextSibling) flushLbl.nextSibling.textContent = pipeline.predictor.on ? ' Flush on misprediction' : ' Flush on taken branch';
  const box = byId('pipeHazBox');
  // Only the chosen model's settings are shown.
  if (box) box.style.display = pipeline.on ? '' : 'none';
  const table = byId('cyclesTableBox');
  if (table) table.style.display = pipeline.arch === 'multi' ? '' : 'none';
}
