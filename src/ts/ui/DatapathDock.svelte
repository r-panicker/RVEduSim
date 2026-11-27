<script lang="ts">
  // The datapath strip: its header, the caption, and the diagrams (from
  // src/figures; the pipelined ones are written by tools/pdp_build.py),
  // with the field encodings over them and the pipeline timeline. The
  // diagrams are animated, and the caption, encodings and timeline drawn,
  // by datapath.ts.
  import single from '../../figures/datapath-single.svg';
  import pipelined from '../../figures/datapath-pipelined.svg';
  import pipelinedBp from '../../figures/datapath-pipelined-bp.svg';
  import { viewRev } from './views.svelte';
  import { dpHeader, dpDockMounted, dpPlaceEncoding, onDpBodyClick } from './datapath';
  import DatapathHeader from './DatapathHeader.svelte';

  const flex = $derived.by(() => { viewRev.datapath; return dpHeader.dockFlex; });
  let body: HTMLElement;
  $effect(() => {
    dpDockMounted();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => dpPlaceEncoding());
    ro.observe(body);
    return () => ro.disconnect();
  });
</script>

<div class="dp-dock" id="dpDock" style:flex={flex}>
  <DatapathHeader />
  <div class="dp-caption" id="dpCaption"></div>
  <div class="dp-body" id="dpBody" bind:this={body} onclick={onDpBodyClick}>
    <div class="dp-enc" id="dpEnc" hidden></div>
    {@html single}{@html pipelined}{@html pipelinedBp}
    <div class="dp-timeline" id="dpTimeline"></div>
  </div>
</div>
