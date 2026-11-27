<script lang="ts">
  // A small centred popup with one text field, for typing a register's or a
  // memory word's new value. Enter commits; Escape, leaving the field or a
  // click elsewhere closes it. Opened by openEditPopup() in edit-popup.ts.
  let { id, inputId, label, value, hint, accent, labelStyle, gap, width, oncommit, onclose }: {
    id: string; inputId: string; label: string; value: string; hint: string; accent: string;
    labelStyle: string; gap: number; width: number;
    oncommit: (text: string) => void; onclose: () => void;
  } = $props();

  let box: HTMLElement;
  $effect(() => {
    const outside = (e: MouseEvent) => { if (!box.contains(e.target as Node | null)) onclose(); };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  });
</script>

<div {id} bind:this={box}
  style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1e1e2e;border:2px solid {accent};border-radius:8px;padding:16px 24px;z-index:10000;display:flex;flex-direction:column;align-items:center;gap:{gap}px;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
  <span style={labelStyle}>{label}</span>
  <input type="text" id={inputId} {value}
    style="background:#181825;color:#f5c2e7;border:1px solid #585b70;border-radius:4px;padding:6px 12px;font-size:16px;font-family:'Consolas',monospace;text-align:center;width:{width}px;outline:none;"
    spellcheck="false" autocomplete="off"
    onkeydown={e => {
      if (e.key === 'Enter') { e.preventDefault(); oncommit(e.currentTarget.value); }
      else if (e.key === 'Escape') { e.preventDefault(); onclose(); }
    }}
    onblur={onclose}>
  <span style="color:#6c7086;font-size:10px;">{hint}</span>
</div>
