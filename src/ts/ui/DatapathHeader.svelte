<script lang="ts">
  // The datapath strip's header: the instruction and phase being drawn,
  // and the strip's controls, from dpHeader in datapath.ts. The caption and
  // the diagram below it are drawn there too.
  import { viewRev } from './views.svelte';
  import { dpHeader, dpNext, dpPlay, dpPrev, dpSetSpeed, dpSetView, toggleDpDock, toggleDpMax } from './datapath';
  import { openPipeSettings, pipeSetMode } from './pipeline-controls';

  const h = $derived.by(() => { viewRev.datapath; return dpHeader; });
</script>

<div class="wave-hdr dp-hdr" id="dpHdr">
  <span class="wave-hdr-title dp-hdr-title">Datapath</span>
  <span class="dp-instr" id="dpInstr">{#if h.instr}<span class="dp-instr-addr">{h.instr.addr + "  "}</span>{h.instr.text}{/if}</span>
  <span class="dp-phase" id="dpPhase">{#if h.phase}{h.phase.n} {#if !h.phase.stage}{h.phase.title}{:else if h.phase.title !== h.phase.stage}<span
    class="dp-stage-name" style:color={h.phase.colour}>{h.phase.stage + ' · '}</span>{h.phase.title}{:else}<span
    style:color={h.phase.colour}>{h.phase.stage}</span>{/if}{/if}</span>
  <span class="wave-hdr-actions dp-hdr-actions">
    <select class="dp-speed" id="dpArch" value={h.pipe ? 'pipe' : 'single'} onchange={e => { const el = e.currentTarget; pipeSetMode(el.value === 'pipe'); el.value = h.pipe ? 'pipe' : 'single'; }}
      title="Microarchitecture. Switching resets the program">
      <option value="single">Single-cycle</option>
      <option value="pipe">Pipelined</option>
    </select>
    <button class="panel-hdr-btn dp-pipe-only" type="button" id="dpPipeCfgBtn" onclick={openPipeSettings} title="Pipeline settings: hazard unit and branch prediction">⚙</button>
    <span class="dp-seg dp-pipe-only" role="group" aria-label="View">
      <button type="button" id="dpViewDiagram" class:active={h.view === 'diagram'} onclick={() => dpSetView('diagram')} title="The datapath diagram">Diagram</button>
      <button type="button" id="dpViewTimeline" class:active={h.view === 'timeline'} onclick={() => dpSetView('timeline')} title="Which stage each instruction was in, cycle by cycle">Timeline</button>
    </span>
    <button class="panel-hdr-btn" type="button" id="dpPrevBtn" onclick={dpPrev} disabled={!h.prev.on} title={h.prev.title}>◀</button>
    <button class="panel-hdr-btn" type="button" id="dpNextBtn" onclick={dpNext} disabled={!h.next.on} title={h.next.title}>▶</button>
    <button class="panel-hdr-btn" type="button" id="dpPlayBtn" onclick={dpPlay} disabled={!h.play.on} title={h.play.title}>{h.play.label}</button>
    <select class="dp-speed" id="dpSpeed" onchange={e => dpSetSpeed(e.currentTarget.value)} title="Animation speed">
      <option value="0.5">½×</option>
      <option value="1" selected>1×</option>
      <option value="2">2×</option>
    </select>
    <button class="panel-hdr-btn dp-max-btn" type="button" onclick={toggleDpMax} title="Give the diagram the whole window below the toolbar"></button>
    <button class="panel-hdr-btn dp-fold-btn" type="button" onclick={toggleDpDock} title="Hide the datapath"></button>
  </span>
</div>
