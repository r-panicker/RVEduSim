<script lang="ts">
  // The waveform dock: its header, the signal picker and the signal names,
  // from waveView in waveform.ts. The waves are drawn on the canvas there,
  // and the Cycle box is kept there too, since it follows the simulation
  // only while it is not being typed in.
  import { viewRev } from './views.svelte';
  import {
    waveView, wavePanning, waveOpen, toggleWavePicker, renderWavePicker, waveResetSignals, waveToggleSignal, waveRemoveSignal,
    waveEnableVcdAndRerun, wavePan, waveZoom, waveFit, toggleWaveDock, onWaveCycleKey, onWaveCycleBlur, onWaveWheel,
    onWaveDown, onWaveMove, onWaveUp, onWaveCancel, drawWaveforms, waveApplyDockSize, updateWaveView,
  } from './waveform';
  import { on } from 'svelte/events';

  const w = $derived.by(() => { viewRev.waveform; return { ...waveView, panning: wavePanning }; });
  let dock: HTMLElement;
  let canvas: HTMLCanvasElement;

  // The wheel zooms and pans, so its listener cannot be passive.
  $effect(() => on(canvas, 'wheel', onWaveWheel, { passive: false }));
  // Mounted at the bottom of the page, or in its tab on a phone: either
  // way it takes its size and draws what there is to draw.
  $effect(() => {
    if (document.body.dataset.booted) { waveApplyDockSize(); updateWaveView(); }
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (waveOpen) drawWaveforms(); });
    ro.observe(dock);
    return () => ro.disconnect();
  });
</script>

<div class="wave-dock" id="waveDock" bind:this={dock} class:wave-empty={w.empty} style:flex={w.flex}>

<div class="wave-hdr">
  <span class="wave-hdr-title">Waveforms</span>
  <button class="panel-hdr-btn wave-add-btn" class:active={w.pickerOpen} type="button" id="waveAddBtn" onclick={toggleWavePicker}
    title="Choose which signals to show, from anywhere in the hierarchy">+ Signal</button>
  <span class="wave-hdr-info" id="waveInfo">{w.info}</span>
  <span class="wave-hdr-hint">ctrl+scroll zooms · shift+scroll pans · click a wave to go there</span>
  <span class="wave-hdr-actions">
    <label class="wave-cycle" title="The cycle the simulator is at. Type another and press Enter to go there.">Cycle
      <input type="text" id="waveCycleInput" inputmode="numeric" spellcheck="false" autocomplete="off"
        onkeydown={onWaveCycleKey} onblur={onWaveCycleBlur}></label>
    <button class="panel-hdr-btn" type="button" onclick={() => wavePan(-1)} title="Pan to earlier cycles">‹</button>
    <button class="panel-hdr-btn" type="button" onclick={() => wavePan(1)} title="Pan to later cycles">›</button>
    <button class="panel-hdr-btn" type="button" onclick={() => waveZoom(2)} title="Zoom out (show more cycles)">−</button>
    <button class="panel-hdr-btn" type="button" onclick={() => waveZoom(0.5)} title="Zoom in">+</button>
    <button class="panel-hdr-btn" type="button" onclick={waveFit} title="Fit the whole run">Fit</button>
    <button class="panel-hdr-btn wave-fold-btn" type="button" id="waveFoldBtn" onclick={toggleWaveDock} title={w.foldTitle}></button>
  </span>
</div>
<!-- A flat filtered list rather than an expandable tree: at seven levels
     deep, typing "alu" beats clicking down four scopes, and the full path
     on every row keeps two instances of a module distinguishable. -->
<div class="wave-picker" id="wavePicker" hidden={!w.pickerOpen}>
  <div class="wave-picker-hdr">
    <span>Signals to show</span>
    <button class="panel-hdr-btn" type="button" onclick={waveResetSignals} title="Back to the default set">Reset</button>
    <button class="panel-hdr-btn" type="button" onclick={toggleWavePicker} title="Close this list (Esc)">Done</button>
  </div>
  <input type="text" id="wavePickerFilter" spellcheck="false" placeholder="Filter by name or path, e.g. alu, t0, RV1.Instr"
    oninput={renderWavePicker} onkeydown={e => { if (e.key === 'Escape') toggleWavePicker(); }}>
  <div class="wave-picker-list" id="wavePickerList">
    {#if !w.picker}
      <div class="wave-picker-empty">Run with the VCD dump on to see the signal list.</div>
    {:else if !w.picker.items.length}
      <div class="wave-picker-empty">No signal matches.</div>
    {:else}
      {#each w.picker.items as v (v.path)}
        <div class="wave-picker-item" class:on={v.on} data-path={v.path} onclick={() => waveToggleSignal(v.path)}><span>{v.on ? '✓' : '\u00a0'}</span><span>{v.path}</span><span
          class="wave-picker-w">{v.width}</span></div>
      {/each}
      {#if w.picker.more}<div class="wave-picker-empty">{w.picker.more} more — narrow the filter.</div>{/if}
    {/if}
  </div>
</div>
<div class="wave-notice" id="waveNotice">
  {#if w.notice === 'vcdOff'}
    Waveforms come from the VCD dump, which is off. <button type="button" onclick={waveEnableVcdAndRerun}>Turn it on and re-run</button>
  {:else if w.notice === 'noRun'}
    Run the program to record a waveform.
  {:else if w.notice === 'noSignals'}
    No signals selected. Use <b>+ Signal</b> to pick some, or <button type="button" onclick={waveResetSignals}>go back to the defaults</button>.
  {/if}
</div>
<div class="wave-body" id="waveBody">
  <div class="wave-names" id="waveNames">
    <div class="wave-names-axis">cycle</div>
    {#each w.names as n (n.path)}
      <div class="wave-name" title={n.path}><span>{n.label}</span><button class="wave-name-remove" type="button" data-path={n.path}
        title="Remove this signal" onclick={() => waveRemoveSignal(n.path)}>✕</button></div>
    {/each}
  </div>
  <canvas id="waveCanvas" bind:this={canvas} class:wave-panning={w.panning}
    title="Click to move the simulation to that cycle · wheel to zoom · drag to pan"
    onpointerdown={onWaveDown} onpointermove={onWaveMove} onpointerup={onWaveUp} onpointercancel={onWaveCancel}></canvas>
</div>
</div>
