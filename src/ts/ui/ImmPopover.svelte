<script lang="ts">
  // An immediate's other readings, beside it in the Disassembly panel, from
  // immPopoverView in disassembly.ts. Placed once it has been drawn, since
  // its size decides where it fits.
  import { viewRev } from './views.svelte';
  import { immPopoverView } from './disassembly';

  const p = $derived.by(() => { viewRev.immPopover; return immPopoverView; });
  let el: HTMLElement;

  // Below the immediate, or above it when there is no room, and kept on
  // screen at phone width, where the panel is nearly as wide as the viewport.
  $effect(() => {
    const a = p.anchor;
    if (!a) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = a.left;
    let top = a.bottom + 6;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 6);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  });
</script>

<div id="immPopover" bind:this={el} hidden={!p.anchor}>
  {#each p.readings as [key, value], i (i)}
    <div class="imm-row"><span class="imm-key">{key}</span> <span class="imm-val">{value}</span></div>
  {/each}
</div>
