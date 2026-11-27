<script lang="ts">
  // The ± / U switch in a Dec column's header: checked shows signed decimals.
  let { checked, onchange, id = undefined, wrapId = undefined, hidden = false }: {
    checked: boolean; onchange: (signed: boolean) => void; id?: string; wrapId?: string; hidden?: boolean;
  } = $props();
</script>

<label class="sign-toggle" id={wrapId} title="Signed / unsigned decimal display" {hidden}><span class="sign-toggle-lbl">±</span><input
  type="checkbox" {id} {checked} onchange={e => onchange(e.currentTarget.checked)}><span class="sign-toggle-track"><span
  class="sign-toggle-thumb"></span></span><span class="sign-toggle-lbl">U</span></label>
