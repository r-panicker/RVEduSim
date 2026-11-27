<script lang="ts">
  // The encoding column beside the datapath drawing, from dpPanel.enc in
  // datapath.ts: one instruction's fields, bit by bit, with the Decoder's
  // table single-cycle; the five stages' fields and the branch predictor's
  // table pipelined.
  import { viewRev } from './views.svelte';
  import { dpPanel, type DpEncField } from './datapath';

  const enc = $derived.by(() => { viewRev.dpPanel; return dpPanel.enc; });
  const bitsOf = (f: DpEncField) => Array.from({ length: f.hi - f.lo + 1 }, (_, j) => f.hi - j);
  const bin = (instr: number, f: DpEncField) => bitsOf(f).map(i => (instr >>> i) & 1).join('');
</script>

{#snippet grid(instr: number, fields: DpEncField[], pipe: boolean)}
  <div class="dp-enc-grid" class:pdp-enc-grid={pipe}>
    {#each fields as f (f.hi)}
      <span class="dp-enc-name dp-enc-{f.kind}" style="grid-column: span {f.hi - f.lo + 1}" title={f.name}>{f.name}</span>
    {/each}
    {#each fields as f (f.hi)}
      {#each bitsOf(f) as i (i)}
        <span class="dp-enc-bit dp-enc-{f.kind}" class:dp-enc-first={i === f.hi} class:dp-enc-lsb={i === 0} title="bit {i}">{(instr >>> i) & 1}</span>
      {/each}
    {/each}
    {#if !pipe}
      {#each fields as f (f.hi)}
        <span class="dp-enc-ends" style="grid-column: span {f.hi - f.lo + 1}"><span>{f.hi}</span><span>{f.hi === f.lo ? '' : f.lo}</span></span>
      {/each}
    {/if}
  </div>
{/snippet}

<div class="dp-enc" id="dpEnc" hidden={!enc}>
  {#if enc && !enc.pipe}
    <div class="dp-enc-title"><b>{enc.format}</b> <code>{enc.text}</code></div>
    {@render grid(enc.instr, enc.fields, false)}
    <table class="dp-enc-table"><tbody>
      {#each enc.fields as f (f.hi)}
        <tr><td class="dp-enc-range">{f.hi}:{f.lo}</td><td class="dp-enc-bin">{bin(enc.instr, f)}</td>
          <td class="dp-enc-{f.kind}">{f.name}</td><td>{f.meaning}</td></tr>
      {/each}
    </tbody></table>
    {#if enc.imm}
      <div class="dp-enc-imm">Extend (ImmSrc {enc.imm.src}) gathers the imm bits: <code>{enc.imm.hex}</code> = {enc.imm.dec}</div>
    {/if}
    <table class="dp-ctl-table">
      <thead><tr><th>Op</th><th>Instr</th><th>PCS</th><th>Memto<br>Reg</th><th>Reg<br>Write</th><th>Mem<br>Write</th><th>ALU<br>SrcA</th>
        <th>ALU<br>SrcB</th><th>ImmSrc</th><th>ALUControl</th></tr></thead>
      <tbody>
        {#each enc.control as r (r.op)}
          <tr class:dp-ctl-on={r.on}><td>{r.op}</td><td class="dp-ctl-name">{r.name}</td>{#each r.cells as c, i (i)}<td>{c}</td>{/each}<td>{r.imm}</td>
            <td>{#each r.alu as line, i (i)}{#if i}<br>{/if}{line}{/each}</td></tr>
        {/each}
      </tbody>
    </table>
    <div class="dp-ctl-note"># ALUControl[0] = (funct3 == 0x5) ? imm[10] : 1'b0</div>
  {:else if enc && enc.pipe}
    {#each enc.stages as st (st.stage)}
      <div class="pdp-enc-row">
        <div class="pdp-enc-head"><b style:color={st.colour}>{st.stage}</b>{' '}{#if st.text !== null}<code>{st.text}</code>{:else}<i>bubble</i>{/if}</div>
        {#if st.text !== null}{@render grid(st.instr, st.fields, true)}{/if}
      </div>
    {/each}
    {#if enc.bht}
      <div class="pdp-enc-row pdp-bht">
        <div class="pdp-enc-head"><b>BHT</b> {enc.bht.entries} × {enc.bht.bits}-bit, index PC[{enc.bht.k}:2]{enc.bht.inUse ? ', entries in use' : ''}</div>
        <table class="dp-ctl-table">
          <thead><tr><th></th><th>Index</th><th>PrTaken</th><th>PrBTA</th></tr></thead>
          <tbody>
            {#each enc.bht.rows as r (r.index)}
              <tr class:dp-ctl-on={r.f || r.e}><td>{#if r.f}<b style="color:#209fb5">F</b>{/if}{#if r.e}<b style="color:#fe640b">E</b>{/if}</td>
                <td>{r.index}</td><td>{r.pr}</td><td>{r.bta}</td></tr>
            {/each}
          </tbody>
        </table>
        <div class="dp-ctl-note">Mispredict = (PrTakenE ⊕ TakenE) + TakenE · (PrBTAE ≠ PCNextE)</div>
      </div>
    {/if}
  {/if}
</div>
