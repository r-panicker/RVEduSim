<script lang="ts">
  // The Disassembly panel: the machine-code table built by updateDisassembly()
  // in disassembly.ts, and its display options.
  import { viewRev } from './views.svelte';
  import { disasmModel, handleDisasmShowToggle, setDisasmViewMode, type DisasmSeg } from './disassembly';

  const m = $derived.by(() => { viewRev.disassembly; return disasmModel; });
  const colTitle = "Drag to resize this column · double-click to reset the panel's columns";
</script>

{#snippet segs(list: DisasmSeg[])}{#each list as g}{#if g.k === 'text'}{g.s}{:else if g.k === 'label'}<span
  class="disasm-target-label">{g.s}</span>{:else if g.k === 'imm'}<span class="disasm-imm" tabindex="0" aria-label={g.tip}
  data-imm={g.data}>{g.s}</span>{:else if g.k === 'cvar'}<span class="disasm-cvar-tag" title={g.title}>{g.s}</span>{:else}<span
  class="disasm-stage" style:color={g.colour}>{g.s}</span>{/if}{/each}{/snippet}

<div class="disasm-toolbar">
  <div class="disasm-show-group">
    <label><input type="checkbox" id="showHex" checked onchange={e => handleDisasmShowToggle(e.currentTarget)}> Hex</label>
    <label><input type="checkbox" id="showBinary" onchange={e => handleDisasmShowToggle(e.currentTarget)}> Binary</label>
  </div>
  <div class="mem-view-toggle" role="group" aria-label="Machine code display mode">
    <button type="button" id="disasmViewModeBytes" class="mem-view-mode-btn" class:active={m.view === 'bytes'}
      title="Show separate hex bytes of the machine code (groups of 4 bytes = one 32-bit word). In binary mode the 8 binary digits of each byte stay together; bytes are separated by spaces." onclick={() => setDisasmViewMode('bytes')}>Byte</button>
    <button type="button" id="disasmViewModeWord" class="mem-view-mode-btn" class:active={m.view === 'word'}
      title="Show one whole 32-bit little-endian hex word per 4-byte group (in binary mode its 8-bit bytes are separated by underscores)" onclick={() => setDisasmViewMode('word')}>Word</button>
  </div>
  <!-- Byte mode lists the bytes in memory order, low byte first; word mode
       shows one little-endian 32-bit word. -->
  <span class="disasm-order-hint" id="disasmOrderHint">{m.view === 'word' ? 'LSB to the right' : 'LSB to the left'}</span>
</div>
<div id="disassemblyDisplay">
  <!-- The <colgroup> is what sizes the columns; applyPanelColLayout() sets
       each <col>'s width. -->
  <table class="code-list">
    <colgroup><col><col><col><col></colgroup>
    <thead><tr>
      <th>Addr<span class="col-resizer" data-panel="disassembly" data-col="addr" title={colTitle}></span></th>
      <th>Machine code<span class="col-resizer" data-panel="disassembly" data-col="mc" title={colTitle}></span></th>
      <th>Native instruction<span class="col-resizer" data-panel="disassembly" data-col="native" title={colTitle}></span></th>
      <th>Original source</th>
    </tr></thead>
    <tbody>
      {#each m.rows as r (r.key)}
        {#if r.kind === 'label'}
          <tr class="disasm-label-row">
            <td colspan="4" class="disasm-label-cell">
              <span class="disasm-label-badge"><span class="disasm-label-name">{r.name}:</span></span>
            </td>
          </tr>
        {:else}
          <tr class:current-native={r.current}>
            <td class="addr" data-col="addr">{r.addr}</td>
            <td class="bytes" data-col="bytes">{#each r.bytes as line, i}{#if i}<br>{/if}{line}{/each}</td>
            <td class="native" class:native-expanded={r.pseudo} data-col="native">{@render segs(r.native)}</td>
            <td class="source" class:pseudo={r.pseudo} data-col="source">{@render segs(r.source)}{#if r.cLine}<span
              class="disasm-cline-tag" title={r.cLine.title}>{r.cLine.s}</span>{/if}</td>
          </tr>
        {/if}
      {/each}
    </tbody>
  </table>
</div>
