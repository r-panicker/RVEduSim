<script lang="ts">
  // The Locals panel (C mode): the current function's variables, built by
  // updateLocalsView() in locals.ts.
  import { viewRev } from './views.svelte';
  import { localsModel, setLocalsDecSigned } from './locals';
  import SignToggle from './SignToggle.svelte';

  const m = $derived.by(() => { viewRev.locals; return localsModel; });
  const colTitle = "Drag to resize this column · double-click to reset the panel's columns";
</script>

<div id="localsNotice" class="hdl-reg-notice" style:display={m.notice ? null : 'none'}>
  {#if m.notice?.k === 'notC'}
    Locals is a C-mode feature — switch to <b>C</b> to see variable-to-memory correspondence here.
  {:else if m.notice?.k === 'none'}
    No local C variables were resolved from this program (best-effort — see the panel header for how).
  {:else if m.notice?.k === 'noFn'}
    PC is not currently inside a function this view has a variable table for (e.g. it is in the CRT0 startup shim or the <code>__halt</code> trap).
  {:else if m.notice?.k === 'noVars'}
    <b>{m.notice.fn}</b> has no locals this view could resolve.
  {:else if m.notice?.k === 'entering'}
    Entering <b>{m.notice.fn}</b>() — its locals will show correct addresses once execution reaches {m.notice.addr}, where the frame pointer (<code>s0</code>) is set up.
  {/if}
</div>
<table class="reg-table" id="localsTable">
  <colgroup><col><col><col><col></colgroup>
  <thead>
    <tr>
      <th id="localsName" class="col-left col-name">Variable<span class="col-resizer" data-panel="locals" data-col="name" title={colTitle}></span></th>
      <th id="localsAddr" class="col-left col-id">Address<span class="col-resizer" data-panel="locals" data-col="addr" title={colTitle}></span></th>
      <th id="localsHex" class="col-left col-val">Content (Hex)<span class="col-resizer" data-panel="locals" data-col="hex" title={colTitle}></span></th>
      <th id="localsDec" class="col-left col-val">Content (Dec)<SignToggle id="localsDecSignToggle" checked={m.signed} onchange={setLocalsDecSigned} /></th>
    </tr>
  </thead>
  <tbody id="localsBody">
    {#each m.rows as r}
      <tr><td class="reg-name col-name" title={r.title}>{r.name}</td><td class="reg-name col-id">{r.addr}</td><td
        class="reg-val col-val">{r.hex}</td><td class="reg-val col-val">{r.dec}</td></tr>
    {/each}
  </tbody>
</table>
