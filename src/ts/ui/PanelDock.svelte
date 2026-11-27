<script lang="ts">
  // The right-hand column: the strip of panel chips and the dock, from
  // dockView in panels.ts. Every panel and splitter is a direct child of the
  // stack, in dock order, so a relayout moves nothing into or out of a
  // panel: in the 2×2 grid the stack wraps, the row splitter breaking the
  // line.
  import { viewRev } from './views.svelte';
  import {
    PANEL_DEFS, PANEL_FIND, dockView, onPanelChip, togglePanelFind, onSplitterDown, onSplitterMove,
    onSplitterUp, onSplitterReset,
  } from './panels';
  import Panel from './Panel.svelte';

  // Read afresh on every redraw: the panel states are set in place.
  const d = $derived.by(() => { viewRev.dock; return { ...dockView }; });
</script>

<div class="tab-bar"
  title="Click to show or hide a panel. Panels are independent — stack several in this column, or detach any to a floating window with its ⧉ button.">
  {#each PANEL_DEFS as def (def.name)}
    {@const st = d.shown[def.name] ?? { visible: false, floating: false }}
    <button id="panelChip-{def.name}" type="button" style:display={(d.chipShown[def.name] ?? !def.mobileOnly) ? null : 'none'}
      class:active={d.mobile ? d.mobileTab === def.name : st.visible}
      class:floating={!d.mobile && st.visible && st.floating}
      onclick={() => onPanelChip(def.name)}><span class="tab-chip-dot"></span>{def.label}</button>
  {/each}
</div>
<button class="mobile-find-btn" id="mobileFindBtn" type="button" title="Filter rows"
  hidden={!(d.mobile && d.mobileTab && PANEL_FIND.has(d.mobileTab))} onclick={() => togglePanelFind(d.mobileTab ?? '')}>🔍</button>
<div class="panel-stack" class:dock-grid={d.grid} class:is-empty={d.empty} id="panelStack">
  {#each d.items as it (it.key)}
    {#if it.kind === 'panel'}
      <Panel p={it} focused={d.focusedFloat === it.name} />
    {:else}
      <div class={it.kind === 'hsplit' ? 'panel-hsplitter' : 'panel-vsplitter'} title="Drag to resize · double-click to even out"
        onpointerdown={e => onSplitterDown(e, it)} onpointermove={onSplitterMove} onpointerup={onSplitterUp}
        onpointercancel={onSplitterUp} ondblclick={() => onSplitterReset(it)}></div>
    {/if}
  {/each}
  <div class="panel-stack-empty">
    <span class="panel-stack-empty-icon">▤</span>
    <span>All panels are hidden — use the buttons above to show the various panels.</span>
  </div>
</div>
