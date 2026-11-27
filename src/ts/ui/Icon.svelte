<script lang="ts" module>
  // The toolbar's icons: 16×16, drawn in the text colour with a 1.6 stroke,
  // so they take the button's colour and dim with it when it is disabled.
  // Each is a list of paths; `fill` marks the solid ones.
  const ICONS: Record<string, { d: string[]; fill?: boolean }> = {
    open: { d: ['M1.8 4.2h4.4l1.5 1.6h6.5v7.4H1.8z'] },
    save: { d: ['M2.5 2.5h8.8l2.2 2.2v8.8h-11z', 'M5 2.5v3.3h5.5V2.5', 'M4.8 13.5V9.3h6.4v4.2'] },
    undo: { d: ['M5.8 3.5 2.8 6.5l3 3', 'M2.8 6.5h6.7a3.3 3.3 0 0 1 0 6.6H7'] },
    redo: { d: ['M10.2 3.5l3 3-3 3', 'M13.2 6.5H6.5a3.3 3.3 0 0 0 0 6.6H9'] },
    find: { d: ['M7 2.6a4.4 4.4 0 1 1 0 8.8 4.4 4.4 0 0 1 0-8.8z', 'M10.3 10.3l3.4 3.4'] },
    settings: { d: ['M2.2 4.5h6.6', 'M12.3 4.5h1.5', 'M2.2 11.5h2.5', 'M8.2 11.5h5.6',
      'M10.55 2.8a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4z', 'M6.45 9.8a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4z'] },
    build: { d: ['M5.5 4 2 8l3.5 4', 'M10.5 4 14 8l-3.5 4', 'M9.2 3 6.8 13'] },
    run: { d: ['M4.5 2.8v10.4L13 8z'], fill: true },
    pause: { d: ['M4 3h3v10H4z', 'M9 3h3v10H9z'], fill: true },
    step: { d: ['M3 3v10l7-5z', 'M11.2 3h1.8v10h-1.8z'], fill: true },
    back: { d: ['M13 3v10L6 8z', 'M3 3h1.8v10H3z'], fill: true },
    reset: { d: ['M2.6 2.8v3.7h3.7', 'M2.9 6.3a5.3 5.3 0 1 1 .5 4.6'] },
    datapath: { d: ['M1.8 5.5h3.6v5H1.8z', 'M10.6 2.2h3.6v4h-3.6z', 'M10.6 9.8h3.6v4h-3.6z', 'M5.4 8h2.6', 'M8 4.2v7.6', 'M8 4.2h2.6', 'M8 11.8h2.6'] },
    wave: { d: ['M1.2 10.5h2.6v-5h3.6v6h3.2v-5h4.2'] },
    download: { d: ['M8 2.2v8', 'M4.6 7.2 8 10.6l3.4-3.4', 'M2.4 13.6h11.2'] },
    info: { d: ['M8 1.9a6.1 6.1 0 1 1 0 12.2A6.1 6.1 0 0 1 8 1.9z', 'M8 7.2v4', 'M8 4.9v.2'] },
  };
</script>

<script lang="ts">
  let { name }: { name: string } = $props();
  const icon = $derived(ICONS[name]);
</script>

<svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
  {#each icon.d as d}
    <path {d} fill={icon.fill ? 'currentColor' : 'none'} stroke={icon.fill ? 'none' : 'currentColor'}
      stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  {/each}
</svg>

<style>
  .icon { flex: 0 0 auto; display: block; }
</style>
