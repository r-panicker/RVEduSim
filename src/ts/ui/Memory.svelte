<script lang="ts">
  // The Memory panel, built by updateMemoryView() in memory-register-views.ts:
  // a region's words, one per row, as bytes or as whole words. Editing is in
  // that module too. The address and row-count boxes are read by
  // updateMemoryView() and set by memGo(), so the component leaves their
  // values alone.
  import { viewRev } from './views.svelte';
  import {
    memModel, memGo, setMemViewMode, setMemDecSigned, updateMemoryView, startMemWordCellEdit, startMemByteEdit,
    startMemWordEdit, handleMemByteEditKey, commitMemByteEdit, focusMemByte, type MemLabel,
  } from './memory-register-views';
  import SignToggle from './SignToggle.svelte';
  import type { Snippet } from 'svelte';

  const m = $derived.by(() => { viewRev.memory; return memModel; });
  const colTitle = "Drag to resize this column · double-click to reset the panel's columns";
  const REGIONS = [
    { id: 'code', name: 'Text', title: 'Program / text segment' },
    { id: 'data', name: 'Data', title: 'Data / static segment (writes land here)' },
    { id: 'stack', name: 'Stack', title: 'Stack region near the stack pointer' },
    { id: 'mmio', name: 'MMIO', title: 'Memory-mapped I/O region' },
  ];
</script>

<!-- The names in a word, anchored directly above it so they share its
     column in both views. -->
{#snippet labelled(label: MemLabel | null, inner: Snippet)}
  {#if label}<span class="mem-row-label-anchor"><span class="mem-row-label" class:mmio-row-label={label.mmio}
    title={label.title}>{label.text}</span>{@render inner()}</span>{:else}{@render inner()}{/if}
{/snippet}

<div class="mem-toolbar">
  <div class="mem-tool-group">
    <label class="mem-tool-label" for="memAddr">Addr</label>
    <input type="text" id="memAddr" value="0x400000" onchange={updateMemoryView}
      onkeydown={e => { if (e.key === 'Enter') updateMemoryView(); }}>
  </div>
  <div class="mem-subtabs" role="group" aria-label="Memory region">
    {#each REGIONS as g (g.id)}
      <button class="mem-subtab-btn" class:active={m.segment === g.id} id="memTabBtn-{g.id}" onclick={() => memGo(g.id)}
        title={g.title}>{g.name}</button>
    {/each}
  </div>
  <button class="mem-refresh-btn" onclick={updateMemoryView} title="Refresh memory view">&#x21bb;</button>
  <div class="mem-tool-group">
    <label class="mem-tool-label" for="memRows">Rows</label>
    <input type="number" id="memRows" value="64" min="1" max="128" onchange={updateMemoryView}>
  </div>
  <div class="mem-view-toggle" role="group" aria-label="Display mode">
    <button type="button" id="memViewModeBytes" class="mem-view-mode-btn" class:active={!m.wordMode}
      title="Show separate editable bytes (groups of 4 bytes = one 32-bit little-endian word)" onclick={() => setMemViewMode('bytes')}>Byte</button>
    <button type="button" id="memViewModeWord" class="mem-view-mode-btn" class:active={m.wordMode}
      title="Show one whole 32-bit little-endian word per 4-byte group" onclick={() => setMemViewMode('word')}>Word</button>
  </div>
  <div class="mem-legend">
    <span id="memLegendText" class="mem-legend-mode"><span class="mem-legend-endian">{m.wordMode
      ? 'Full word (LSB to the right)' : 'Little endian (LSB to the left)'}</span></span>
    <span class="mem-legend-sep" id="memLegendSep" hidden={!m.editable}>&nbsp;·&nbsp;</span>
    <span id="memLegendEditable">{#if m.editable}<span class="mem-legend-editable">{m.editable}</span>{/if}</span>
  </div>
</div>
<div class="mem-col-header" id="memColHeader">
  <span class="mem-col-h" data-mem-col="addr">Addr<span class="col-resizer" data-panel="memory" data-col="addr" title={colTitle}></span></span>
  <span class="mem-col-h" data-mem-col="hex">Content (Hex)<span class="col-resizer" data-panel="memory" data-col="hex" title={colTitle}></span></span>
  <!-- Byte view shows ASCII; word view shows decimal, signed or not. -->
  <span class="mem-col-h" data-mem-col="ascii"><span id="memContentColLabel">{m.wordMode ? 'Content (DEC)' : 'Content (ASCII)'}</span><SignToggle
    wrapId="memDecSignToggleWrap" id="memDecSignToggle" hidden={!m.wordMode} checked={m.signed} onchange={setMemDecSigned} /></span>
</div>
<div class="mem-view" id="memView">
  {#each m.rows as r (r.key)}
    <div data-row={r.start}><span class="addr" data-col="addr">{r.addr}</span><span class="mem-hex-block">
      {#if r.word}
        {@const w = r.word}
        {#snippet wordCell()}<span class="val word-cell" class:changed={w.changed} class:readonly-code={!w.editable}
          data-addr={w.addr} data-size="4" title={w.title}
          onclick={w.editable ? (e => startMemWordCellEdit(e, w.addr)) : null}>{w.hex}</span>{/snippet}
        {@render labelled(r.label, wordCell)}
      {:else if r.bytes}
        {@const bytes = r.bytes}
        {#snippet byteCells()}<span class="mem-row-bytes">{#each bytes as b (b.addr)}{#if b.editable}<span class="val"
          class:changed={b.changed} contenteditable="true" spellcheck="false" data-addr={b.addr} data-size="1" data-old={b.hex}
          onfocus={e => startMemByteEdit(e.currentTarget)} ondblclick={e => startMemWordEdit(e, b.addr)}
          onkeydown={e => handleMemByteEditKey(e, e.currentTarget)} onblur={e => commitMemByteEdit(e.currentTarget)}
          title={b.title}>{b.hex}</span>{:else}<span class="val readonly-code" class:changed={b.changed} data-addr={b.addr}
          data-size="1" style="cursor:default;opacity:0.88;" title={b.title}>{b.hex}</span>{/if}{/each}</span>{/snippet}
        {@render labelled(r.label, byteCells)}
      {/if}
    </span><span class="mem-ascii-block">
      {#if r.word}
        <span class="val-dec" class:changed={r.word.changed} class:readonly-code={!r.word.editable} title={r.word.decTitle}
          onclick={r.word.editable ? (e => startMemWordCellEdit(e, r.word!.addr)) : null}>{r.word.dec}</span>
      {:else if r.bytes}
        <span class="mem-ascii-group">{#each r.bytes as b (b.addr)}<span class="ascii" class:changed={b.changed} title={b.asciiTitle}
          onclick={b.editable ? (() => focusMemByte(b.addr)) : null}>{b.ch}</span>{/each}</span>
      {/if}
    </span></div>
  {/each}
</div>
