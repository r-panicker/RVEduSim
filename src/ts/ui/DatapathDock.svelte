<script lang="ts">
  // The datapath strip: its header, the caption, and the diagrams (from
  // src/figures; the pipelined ones are written by tools/pdp_build.py),
  // with the field encodings beside them and the pipeline timeline. The
  // diagrams are animated by datapath.ts, which also keeps the caption,
  // encodings and timeline in dpPanel.
  import single from '../../figures/datapath-single.svg';
  import pipelined from '../../figures/datapath-pipelined.svg';
  import pipelinedBp from '../../figures/datapath-pipelined-bp.svg';
  import { viewRev } from './views.svelte';
  import { dpHeader, dpPanel, dpDockMounted, dpPlaceEncoding, onDpBodyClick } from './datapath';
  import DatapathHeader from './DatapathHeader.svelte';
  import DpEncoding from './DpEncoding.svelte';
  import DpTimeline from './DpTimeline.svelte';

  const flex = $derived.by(() => { viewRev.datapath; return dpHeader.dockFlex; });
  // Authored in datapath.ts, with markup for the signal names and values.
  const caption = $derived.by(() => { viewRev.dpPanel; return dpPanel.caption; });
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
  <div class="dp-caption" id="dpCaption">{@html caption}</div>
  <div class="dp-body" id="dpBody" bind:this={body} onclick={onDpBodyClick}>
    <DpEncoding />
    {@html single}{@html pipelined}{@html pipelinedBp}
    <DpTimeline />
  </div>
</div>
