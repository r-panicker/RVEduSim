<script lang="ts">
  // The console under the editor: the lines log() has written, kept
  // scrolled to the newest.
  import { viewRev } from './views.svelte';
  import { consoleLines } from './editor';
  import { pageLayout } from './page-layout';

  const c = $derived.by(() => { viewRev.console; viewRev.page; return { lines: consoleLines.slice(), h: pageLayout.consoleH }; });
  let el: HTMLElement;
  $effect(() => { c.lines.length; el.scrollTop = el.scrollHeight; });
</script>

<div class="console" id="console" bind:this={el} style:height={c.h === null ? null : c.h + 'px'}
  style:max-height={c.h === null ? null : c.h + 'px'}>
  {#each c.lines as line}<div class={line.cls}>{line.text}</div>{/each}
</div>
