<script lang="ts">
  // The page. The editor's column (toolbar, editor, console) and the dock
  // side by side, the waveform and datapath strips across the bottom (in
  // their panel tabs on a phone instead), and the dialogs. CodeMirror is
  // created in #cmEditorContainer at boot (find-replace.ts).
  import { viewRev } from './views.svelte';
  import { dockView } from './panels';
  import { pageLayout } from './page-layout';
  import { onMainSplitterDown, onMainSplitterMove, onMainSplitterUp } from './editor';
  import { onConsoleResizeStart, setConsoleHeight, CONSOLE_H_DEFAULT } from './engine-mode';
  import { onWaveResizeStart, onWaveResizeReset } from './waveform';
  import { onDpResizeStart, onDpResizeReset } from './datapath';
  import Settings from './Settings.svelte';
  import FloatSteps from './FloatSteps.svelte';
  import BpFigure from './BpFigure.svelte';
  import Credits from './Credits.svelte';
  import ImmPopover from './ImmPopover.svelte';
  import Toolbar from './Toolbar.svelte';
  import FindReplace from './FindReplace.svelte';
  import Console from './Console.svelte';
  import PanelDock from './PanelDock.svelte';
  import Waveform from './Waveform.svelte';
  import DatapathDock from './DatapathDock.svelte';

  const mobile = $derived.by(() => { viewRev.dock; return dockView.mobile; });
  const dockW = $derived.by(() => { viewRev.page; return pageLayout.dockW; });
</script>

<div class="container">
  <Settings />
  <FloatSteps />
  <BpFigure />
  <Credits />
  <ImmPopover />
  <div class="main">
    <div class="left-panel">
      <Toolbar />
      <div class="editor-wrapper">
        <div class="code-area" id="editorArea">
          <FindReplace />
          <div id="cmEditorContainer" style="flex:1;height:100%;min-height:0;overflow:hidden;position:relative;"></div>
        </div>
      </div>
      <div class="console-resizer" id="consoleResizer" title="Drag to resize the console · double-click to reset"
        onpointerdown={onConsoleResizeStart} ondblclick={() => setConsoleHeight(CONSOLE_H_DEFAULT, true)}></div>
      <Console />
    </div>
    <div class="splitter" id="mainSplitter" title="Drag to resize" onpointerdown={onMainSplitterDown}
      onpointermove={onMainSplitterMove} onpointerup={onMainSplitterUp} onpointercancel={onMainSplitterUp}></div>
    <div class="right-panel" style:width={dockW === null ? null : dockW + 'px'}>
      <PanelDock />
    </div>
  </div>

  {#if !mobile}
    <!-- The waveform strip spans the full window width rather than sitting
         with the side panels: how many cycles fit across is what limits a
         waveform. -->
    <div class="wave-resizer" id="waveResizer" title="Drag to resize · double-click to reset"
      onpointerdown={onWaveResizeStart} ondblclick={onWaveResizeReset}></div>
    <Waveform />
    <!-- The datapath strip: the single-cycle microarchitecture, animated for
         the instruction at the PC, or the pipelined one, a cycle at a time. -->
    <div class="wave-resizer dp-resizer" id="dpResizer" title="Drag to resize · double-click to reset"
      onpointerdown={onDpResizeStart} ondblclick={onDpResizeReset}></div>
    <DatapathDock />
  {/if}
</div>
