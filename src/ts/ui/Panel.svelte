<script lang="ts">
  // One panel of the dock: its header (title; filter, detach and hide), its
  // row filter, and its body. Where it sits and how big it is come from the
  // dock (PanelDock.svelte); its contents are the panel's own component.
  import {
    PANEL_FIND_PLACEHOLDER, panelFindCount, panelFindOpen, panelFindText, closePanelFind, setPanelFind, togglePanelFind,
    togglePanelFloat, setPanelVisible, onFloatDragStart, onFloatDragMove, onFloatDragEnd, noteFloatResized, type DockPanel,
  } from './panels';
  import { viewRev } from './views.svelte';
  import Registers from './Registers.svelte';
  import Memory from './Memory.svelte';
  import Peripherals from './Peripherals.svelte';
  import Disassembly from './Disassembly.svelte';
  import Locals from './Locals.svelte';
  import Waveform from './Waveform.svelte';
  import DatapathDock from './DatapathDock.svelte';

  let { p, focused }: { p: DockPanel; focused: boolean } = $props();
  let el: HTMLElement;
  // The row filter, re-read whenever the dock redraws.
  const f = $derived.by(() => {
    viewRev.dock;
    return { open: !!panelFindOpen[p.name], text: panelFindText[p.name] ?? '', count: panelFindCount[p.name] ?? '' };
  });

  // The browser's resize handle sizes a floating panel; the dock keeps
  // the size it was given.
  $effect(() => {
    if (p.mode !== 'floating' || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => noteFloatResized(p.name, el.offsetWidth, el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  });
</script>

<div class="tab-content" id="tab-{p.name}" bind:this={el} data-row={p.row || null}
  class:panel-docked={p.mode === 'docked'} class:panel-floating={p.mode === 'floating'}
  class:panel-mobile-active={p.mode === 'mobile'} class:focused={focused && p.mode === 'floating'}
  style:flex={p.flex} style:height={p.rect ? p.rect.h + 'px' : p.height}
  style:left={p.rect && p.rect.x + 'px'} style:top={p.rect && p.rect.y + 'px'} style:width={p.rect && p.rect.w + 'px'}>
  <div class="panel-hdr" onpointerdown={e => onFloatDragStart(e, p.name)} onpointermove={onFloatDragMove}
    onpointerup={onFloatDragEnd} onpointercancel={onFloatDragEnd}>
    <span class="panel-hdr-title">{p.label}</span>
    <span class="panel-hdr-actions">
      {#if p.findable}
        <button class="panel-hdr-btn" class:active={!!f.text} type="button" data-panel-act="find" title="Filter rows"
          onclick={e => { e.stopPropagation(); togglePanelFind(p.name); }}>🔍</button>
      {/if}
      <button class="panel-hdr-btn" type="button" data-panel-act="float"
        title={p.mode === 'floating' ? 'Dock back into the side panel' : 'Detach to a floating window'}
        onclick={e => { e.stopPropagation(); togglePanelFloat(p.name); }}>{p.mode === 'floating' ? '▣' : '⧉'}</button>
      <button class="panel-hdr-btn" type="button" data-panel-act="hide" title="Hide this panel"
        onclick={e => { e.stopPropagation(); setPanelVisible(p.name, false); }}>✕</button>
    </span>
  </div>
  {#if p.findable}
    <div class="panel-find" id="panelFind-{p.name}" hidden={!f.open}>
      <input type="text" spellcheck="false" placeholder={PANEL_FIND_PLACEHOLDER[p.name]} value={f.text}
        oninput={e => setPanelFind(p.name, e.currentTarget.value)}
        onkeydown={e => { if (e.key === 'Escape') { e.stopPropagation(); closePanelFind(p.name); } }}>
      <span class="panel-find-count">{f.count}</span>
      <button class="find-btn find-close" type="button" title="Clear (Esc)" onclick={() => closePanelFind(p.name)}>&times;</button>
    </div>
  {/if}
  <div class="panel-body">
    {#if p.name === 'registers'}<Registers />
    {:else if p.name === 'memory'}<Memory />
    {:else if p.name === 'peripherals'}<Peripherals />
    {:else if p.name === 'disassembly'}<Disassembly />
    {:else if p.name === 'locals'}<Locals />
    <!-- On a phone the waveform and datapath strips are panel tabs. -->
    {:else if p.name === 'waveform' && p.mode.startsWith('mobile')}<Waveform />
    {:else if p.name === 'datapath' && p.mode.startsWith('mobile')}<DatapathDock />
    {/if}
  </div>
</div>
