<script lang="ts">
  // The pipeline timeline, from dpPanel.tl in datapath.ts, which also
  // decides how many cycles fit across.
  import { viewRev } from './views.svelte';
  import { dpPanel } from './datapath';

  const tl = $derived.by(() => { viewRev.dpPanel; return dpPanel.tl; });
</script>

<div class="dp-timeline" id="dpTimeline">
  {#if tl && tl.empty}
    <p class="pdp-tl-empty">Assemble a program to chart it.</p>
  {:else if tl}
    <table class="pdp-tl">
      <thead><tr><th class="pdp-tl-ins">Instruction</th>
        {#each tl.cols as c, i (i)}
          {#if c.live}<th class="pdp-tl-live" title="The cycle the next Step clocks">next</th>{:else}<th>{c.label}</th>{/if}
        {/each}
      </tr></thead>
      <tbody>
        {#each tl.rows as row, ri (ri)}
          <tr class:pdp-tl-gone={row.gone}>
            <td class="pdp-tl-ins">{#if row.nop}<i class="pdp-tl-nop">bubble (nop)</i>{:else}{#if row.addr}<span
              class="pdp-tl-addr">{row.addr}</span>{' '}{/if}{row.text}{#if row.quashed}{' '}<i class="pdp-tl-nop">→ bubble (nop)</i>{/if}{/if}</td>
            {#each row.cells as cell, ci (ci)}
              {#if cell}<td class={cell.cls} style:--pc={cell.colour} title={cell.tip}>{cell.L}</td>{:else}<td></td>{/if}
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
