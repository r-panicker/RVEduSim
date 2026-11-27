<script lang="ts">
  // The Registers panel: x0..x31, built by updateRegisters() in panels.ts.
  // A value cell is edited in place on a click (memory-register-views.ts),
  // or in a popup on a double click.
  import { viewRev } from './views.svelte';
  import { REPLAYED_STATE_TITLE, regModel, setRegDecSigned } from './panels';
  import { commitRegEdit, handleRegEditKey, popRegEditModal, startRegEdit } from './memory-register-views';
  import SignToggle from './SignToggle.svelte';

  const m = $derived.by(() => { viewRev.registers; return regModel; });
  const colTitle = "Drag to resize this column · double-click to reset the panel's columns";
  const editTitle = 'Single-click: edit inline | Double-click: open edit window';
</script>

<div id="hdlRegNotice" class="hdl-reg-notice" style:display={m.regMissing ? null : 'none'}>
  {#if m.regMissing}
    <b>Register values are not available for this design.</b> No 32 x 32-bit register array could be found in the
    uploaded sources, so nothing here is read from your hardware. Everything else - the PC, the instruction stream,
    memory and the peripherals - comes from the fixed Wrapper and is unaffected. Name the array under
    <b>⚙ Settings → HDL</b>, in the <b>Register file</b> field (for example <code>dut.RV1.RegFile1.RegBank</code>)
    to bring this view back.
  {/if}
</div>
<table class="reg-table" id="regTable">
  <colgroup><col><col><col><col></colgroup>
  <thead>
    <tr>
      <th id="regId" class="col-left col-id">#<span class="col-resizer" data-panel="registers" data-col="id" title={colTitle}></span></th>
      <th id="regName" class="col-left col-name">ABI Name<span class="col-resizer" data-panel="registers" data-col="name" title={colTitle}></span></th>
      <th id="regHex" class="col-left col-val">Content (Hex)<span class="col-resizer" data-panel="registers" data-col="hex" title={colTitle}></span></th>
      <th id="regDec" class="col-left col-val">Content (Dec)<SignToggle checked={m.signed} onchange={setRegDecSigned} /></th>
    </tr>
  </thead>
  {#key m.editGen}
    <tbody id="regBody">
      {#each m.rows as r (r.i)}
        <tr><td class="reg-name col-id">x{r.i}</td><td class="reg-name col-name">{r.name}</td>
          {#if m.readOnly}
            <td class="reg-val readonly-code col-val" class:reg-changed={r.changed} class:reg-unknown={r.unknown} title={REPLAYED_STATE_TITLE}>{r.hex}</td>
            <td class="reg-val readonly-code col-val" class:reg-changed={r.changed} class:reg-unknown={r.unknown} title={REPLAYED_STATE_TITLE}>{r.dec}</td>
          {:else}
            {#each [{ type: 'hex', text: r.hex, val: r.hex }, { type: 'dec', text: r.dec, val: r.dec.padStart(11, ' ') }] as c (c.type)}
              <td class="reg-val reg-editable col-val" class:reg-changed={r.changed} data-idx={r.i} data-val={c.val} data-type={c.type}
                onclick={e => startRegEdit(e.currentTarget)} ondblclick={e => popRegEditModal(e, e.currentTarget)}
                onblur={e => commitRegEdit(e.currentTarget)} onkeydown={e => handleRegEditKey(e, e.currentTarget)}
                title={editTitle}>{c.text}</td>
            {/each}
          {/if}
        </tr>
      {/each}
    </tbody>
  {/key}
</table>
