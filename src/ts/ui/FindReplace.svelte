<script lang="ts">
  // The editor's find & replace bar, from findView in find-replace.ts. Its
  // two text boxes are read there by id.
  import { viewRev } from './views.svelte';
  import { editorState } from './editor-state';
  import {
    findView, updateFindMatches, handleFindKey, findPrev, findNext, toggleFindCase, closeFindReplace, replaceCurrent,
    replaceAll,
  } from './find-replace';

  const f = $derived.by(() => { viewRev.find; return { ...findView, any: editorState.find.matches.length > 0 }; });
</script>

<div class="find-replace-panel" id="findReplacePanel" style:display={f.open ? 'flex' : 'none'} style="z-index:20;">
  <div class="find-row">
    <input type="text" id="findInput" placeholder="Find in editor (Enter / Shift+Enter)..."
      spellcheck="false" oninput={updateFindMatches} onkeydown={handleFindKey}>
    <span class="find-count" id="findCount">{f.count}</span>
    <button class="find-btn" id="findPrevBtn" onclick={findPrev} disabled={!f.any} class:inactive={!f.any}
      title="Previous match (Shift+Enter)">▲</button>
    <button class="find-btn" id="findNextBtn" onclick={findNext} disabled={!f.any} class:inactive={!f.any} title="Next match (Enter)">▼</button>
    <button class="find-toggle-btn" id="findCaseBtn" class:active={f.caseOn} onclick={toggleFindCase} title="Match case (Alt+C)">Aa</button>
    <button class="find-btn find-close" id="findCloseBtn" onclick={closeFindReplace} title="Close (Esc)">&times;</button>
  </div>
  <div class="find-row" id="replaceRow" style="display:flex;">
    <input type="text" id="replaceInput" placeholder="Replace with..." spellcheck="false"
      onkeydown={e => { if (e.key === 'Enter') replaceCurrent(); }}>
    <button class="find-action-btn" id="findReplaceBtn" onclick={replaceCurrent} disabled={!f.any} class:inactive={!f.any}
      title="Replace current occurrence">Replace</button>
    <button class="find-action-btn" id="findReplaceAllBtn" onclick={replaceAll} disabled={!f.any} class:inactive={!f.any}
      title="Replace all occurrences">All</button>
  </div>
</div>
