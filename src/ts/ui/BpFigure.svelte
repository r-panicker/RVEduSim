<script lang="ts">
  // What is inside the Branch Predictor, opened from the block in the
  // pipelined datapath with prediction on. The drawing is
  // src/figures/branch-predictor.svg, written by tools/pdp_build.py.
  import figure from '../../figures/branch-predictor.svg';
  import { viewRev } from './views.svelte';
  import { bpFigureOpen, closeBpFigure } from './execution';

  const open = $derived.by(() => { viewRev.bpFigure; return bpFigureOpen; });
</script>

<div class="cycles-overlay" class:open id="bpFigOverlay" onclick={e => { if (e.target === e.currentTarget) closeBpFigure(); }}>
  <div class="cycles-panel bp-fig-modal">
    <div class="c-head">
      <span>Branch Predictor</span>
      <button onclick={closeBpFigure} title="Close">&times;</button>
    </div>
    <div class="c-body bp-fig-body">{@html figure}</div>
  </div>
</div>
