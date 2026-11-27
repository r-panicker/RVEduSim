<script lang="ts">
  // The step controls that float over the page on a phone, once the
  // toolbar's Step has scrolled out of view or on the datapath tab: Back and
  // Step, or the datapath strip's ◀ ▶ ▶▶. From floatView in datapath.ts.
  import { viewRev } from './views.svelte';
  import { floatStep, floatView } from './datapath';

  const v = $derived.by(() => { viewRev.floatSteps; return floatView; });
</script>

<div class="float-steps" id="floatSteps" hidden={!v.show} data-mode={v.mode}>
  {#each v.buttons as b, i}
    <button type="button" onclick={() => floatStep(i)} hidden={b.hidden} disabled={!b.on} title={b.title}>{b.label}</button>
  {/each}
</div>
