<script lang="ts">
  // The header and the toolbar, from `toolbar` in toolbar-state.ts. Two
  // rows: the program (language, engine, example, files, editing, Settings)
  // and running it (Assemble, the run controls, the views, the status). It
  // is laid out by the width of the editor's column, not the window's, so
  // dragging the splitter reflows it too. A group is never split: as room
  // runs out the status takes a line of its own, then the secondary buttons
  // give up their words for their icons, and on a phone the controls stack
  // into four lines with the run controls right above the status.
  import { viewRev } from './views.svelte';
  import { toolbar, type StatSeg } from './toolbar-state';
  import { setLanguageMode, loadExample, EXAMPLE_SOURCES_VALUE } from './examples-language';
  import { setSimEngineMode } from './engine-mode';
  import { openSettingsModal, openCreditsModal, saveFile, handleDownloadPick } from './execution';
  import { loadFile } from './file-io';
  import { editorHistory } from './editor';
  import { openFindReplace } from './find-replace';
  import { assembleOnly, resetAll, stepBack, stepOnce, toggleRunPause } from './run-control';
  import { toggleVisualisation } from './datapath';
  import Icon from './Icon.svelte';

  // A shallow copy, so that the parts each module sets in place are read
  // afresh on every redraw.
  const t = $derived.by(() => { viewRev.toolbar; return { ...toolbar }; });
  // The next thing to press stands out: Assemble while the source has not
  // been assembled as it stands, Run once it has.
  const nextIsAssemble = $derived(t.assemble.on);
  const SEP = ' |  ';
  const DOWNLOADS = [['irom', 'AA_IROM.mem'], ['dmem', 'AA_DMEM.mem'], ['tb', 'Testbench (.v)'], ['vcd', 'Waveform (.vcd)']];
  let fileLoader: HTMLInputElement;
</script>

{#snippet statParts(parts: StatSeg[][])}{#each parts as part, i}{#if i}{SEP}{/if}{#each part as g}{#if g.k === 'text'}{g.s}{:else if g.k === 'lag'}<span
  class="stat-lag" title="The browser cannot keep up with this clock">{g.s}</span>{:else if g.k === 'tag'}<span
  class="stat-tag">{g.s}</span>{:else}<span class="stat-pc">{g.s}</span>{/if}{/each}{/each}{/snippet}

<div class="tb">
  <div class="header">
    <h1><svg viewBox="0 0 32 32" width="20" height="20" class="logo">
        <rect x="6" y="6" width="20" height="20" rx="3.5" fill="#181825" stroke="#89b4fa" stroke-width="1.5" />
        <rect x="11" y="11" width="10" height="10" rx="1.5" fill="#313244" stroke="#cba6f7" stroke-width="1" />
        <path d="M2 11h4M2 16h4M2 21h4 M26 11h4M26 16h4M26 21h4 M11 2v4M16 2v4M21 2v4 M11 26v4M16 26v4M21 26v4"
          stroke="#f9e2af" stroke-width="1.5" stroke-linecap="round" /><text x="16" y="18.5"
          font-family="monospace" font-size="6.5" font-weight="bold" fill="#89b4fa" text-anchor="middle">RV</text>
      </svg><span class="title">RVEduSim</span><span class="subtitle">RISC-V Functional and HDL Simulator</span></h1>
    <button type="button" class="credits" onclick={openCreditsModal} title="Credits"><Icon name="info" /><span>Credits</span></button>
  </div>

  <div class="toolbar" id="mainToolbar">
    <div class="toolbar-row toolbar-row-source">
      <div class="group modes">
        <div class="seg" id="langToggleGroup" title="Toggle between RISC-V Assembly and C Language Mode">
          <button type="button" id="langBtnAsm" class:active={t.lang === 'asm'} onclick={() => setLanguageMode('asm')}>ASM</button>
          <button type="button" id="langBtnC" class:active={t.lang === 'c'} onclick={() => setLanguageMode('c')}>C</button>
        </div>
        <div class="seg" id="engToggleGroup" title="Choose the execution engine: the built-in JavaScript functional model, or your own Verilog processor simulated with Icarus Verilog compiled to WebAssembly">
          <button type="button" id="engBtnJs" class:active={t.engine === 'js'} class:inactive={t.engLocked}
            disabled={t.engLocked} onclick={() => setSimEngineMode('js')}>JS</button>
          <button type="button" id="engBtnHdl" class:active={t.engine === 'hdl'} class:inactive={t.engLocked}
            disabled={t.engLocked} onclick={() => setSimEngineMode('hdl')}>HDL</button>
        </div>
        <!-- Whether the Verilog is loaded; it opens the sources in Settings. -->
        <button type="button" id="hdlFilesChip" class="chip" class:warn={t.hdlChip.warn}
          style:display={t.hdlChip.show ? null : 'none'} title={t.hdlChip.title || null}
          onclick={() => openSettingsModal('simulator')}><span class="chip-long">{t.hdlChip.long}</span><span
          class="chip-short">{t.hdlChip.short}</span></button>
        <label class="example" title="Select an example program"><span class="example-word">Example</span>
          <select id="exampleSelect" value={t.exampleKey} onchange={e => {
            const v = e.currentTarget.value;
            if (v !== EXAMPLE_SOURCES_VALUE) { loadExample(v); return; }
            e.currentTarget.value = t.exampleKey;
            openSettingsModal('examples');
          }}>
            {#key t.lang}
              {#each t.examples as g (g.label)}<optgroup label={g.label}>{#each g.items as it (it.value || it.label)}<option
                value={it.value} title={it.title} disabled={it.disabled}>{it.label}</option>{/each}</optgroup>{/each}
            {/key}
            {#if t.userFile}<option id="tempFileOption" value="user_file">📁 {t.userFile}</option>{/if}
            <option value={EXAMPLE_SOURCES_VALUE} title="Where examples come from: a web folder and a folder on this computer">Example sources…</option>
          </select>
        </label>
      </div>
      <div class="group tools">
        <input type="file" id="fileLoader" bind:this={fileLoader} accept=".asm,.s,.c,.h,.txt,.v,.sv,.vh,.svh" onchange={loadFile}>
        <button type="button" class="btn" id="btnOpen" onclick={() => fileLoader.click()} title="Open RISC-V assembly or C source file"><Icon name="open" /><span class="word">Open</span></button>
        <button type="button" class="btn" id="btnSave" onclick={saveFile} title="Save source code to file"><Icon name="save" /><span class="word">Save</span></button>
        <span class="gap"></span>
        <button type="button" class="btn icon-only" id="btnUndo" onclick={() => editorHistory.undo()} disabled={!t.undo.on} class:inactive={!t.undo.on} title={t.undo.title}><Icon name="undo" /></button>
        <button type="button" class="btn icon-only" id="btnRedo" onclick={() => editorHistory.redo()} disabled={!t.redo.on} class:inactive={!t.redo.on} title={t.redo.title}><Icon name="redo" /></button>
        <button type="button" class="btn icon-only" id="btnFind" onclick={() => openFindReplace(false)} title="Find &amp; Replace in code editor (Ctrl+F / Ctrl+H)"><Icon name="find" /></button>
      </div>
      <button type="button" class="btn settings" id="btnSettings" onclick={() => openSettingsModal()} title="Configure Compiler, Linker segments, and Simulator settings"><Icon name="settings" /><span class="word">Settings</span></button>
    </div>

    <div class="toolbar-row toolbar-row-simulation">
      <div class="group run">
        <button type="button" class="btn" class:next={nextIsAssemble} id="btnAssemble" onclick={assembleOnly} disabled={!t.assemble.on} class:inactive={!t.assemble.on}
          title={t.assemble.title}><Icon name="build" /><span class="word">{t.assemble.label}</span></button>
        <div class="transport">
          <button type="button" class="btn" class:next={!nextIsAssemble && t.run.on} class:pausing={t.run.label === 'Pause'}
            id="runPauseBtn" onclick={toggleRunPause} disabled={!t.run.on} class:inactive={!t.run.on} title={t.run.title}><Icon
            name={t.run.label === 'Pause' ? 'pause' : 'run'} /><span class="word">{t.run.label}</span></button>
          <button type="button" class="btn" id="btnStep" onclick={stepOnce} disabled={!t.step.on} class:inactive={!t.step.on} title={t.step.title}><Icon name="step" /><span class="word">Step</span></button>
          <button type="button" class="btn" id="btnBack" onclick={stepBack} disabled={!t.back.on} class:inactive={!t.back.on} title={t.back.title}><Icon name="back" /><span class="word">Back</span></button>
          <button type="button" class="btn" id="btnReset" onclick={resetAll} disabled={!t.reset.on} class:inactive={!t.reset.on} title={t.reset.title}><Icon name="reset" /><span class="word">Reset</span></button>
        </div>
      </div>
      <div class="group views">
        <button type="button" class="btn" id="btnViz" onclick={toggleVisualisation} disabled={!t.viz.on} class:inactive={!t.viz.on} class:viz-on={t.viz.shown}
          title={t.viz.title || null}><Icon name={t.viz.hdl ? 'wave' : 'datapath'} /><span class="word">{t.viz.hdl ? 'Waveform' : 'Datapath'}</span></button>
        <span class="download">
          <Icon name="download" />
          <select id="downloadSelect" onchange={e => handleDownloadPick(e.currentTarget)}
            title="Save a memory image, the generated testbench or the recorded waveform">
            <option value="" selected>Download</option>
            {#each DOWNLOADS as [value, label] (value)}<option {value} disabled={t.downloads[value] === false}>{label}</option>{/each}
          </select>
        </span>
      </div>
      <div class="toolbar-row-status">
        <span class="status" id="statusBar" style:color={t.status.colour} title={t.status.text}>{t.status.text}</span>
        <span class="stats" id="statsBar" title={t.stats?.title}>{#if t.stats}<span class="stat-half">{@render statParts(t.stats.lead)}</span><span
          class="stat-sep">{SEP}</span><span class="stat-half">{@render statParts(t.stats.tail)}</span>{:else}Cycles: 0 &nbsp;|&nbsp; Instr: 0 &nbsp;|&nbsp; PC: 0x00400000{/if}</span>
      </div>
    </div>
  </div>
</div>

<style>
  /* Catppuccin Mocha, as the rest of the page. */
  .tb {
    --tb-bg: #181825;
    --tb-btn: #232334;
    --tb-btn-hover: #2e2e44;
    --tb-line: #34344a;
    --tb-text: #cdd6f4;
    --tb-sub: #a6adc8;
    --tb-accent: #cba6f7;
    --tb-h: 30px;
    container: tb / inline-size;
    background: var(--tb-bg);
    border-bottom: 1px solid #313244;
  }

  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 12px 3px;
    min-width: 0;
  }
  h1 {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0;
    min-width: 0;
    font-size: 15px;
    font-weight: 650;
    color: var(--tb-accent);
    white-space: nowrap;
  }
  .logo { align-self: center; flex: 0 0 auto; }
  .subtitle {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--tb-sub);
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .credits {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: none;
    border: none;
    padding: 2px 4px;
    color: var(--tb-sub);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    border-radius: 4px;
  }
  .credits:hover { color: var(--tb-text); background: var(--tb-btn); }
  .title { min-width: 0; }

  .toolbar {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 12px 7px;
  }
  .toolbar-row {
    display: flex;
    align-items: center;
    gap: 8px 14px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .group {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .gap { width: 4px; }

  /* Buttons */
  .btn {
    height: var(--tb-h);
    padding: 0 10px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: var(--tb-btn);
    color: var(--tb-text);
    border: 1px solid var(--tb-line);
    border-radius: 7px;
    font: inherit;
    font-size: 12.5px;
    font-weight: 550;
    white-space: nowrap;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .btn:hover { background: var(--tb-btn-hover); border-color: #45475a; }
  .btn.icon-only { width: var(--tb-h); padding: 0; }
  .settings { margin-left: auto; }

  /* The next thing to press. */
  .btn.next {
    background: var(--tb-accent);
    border-color: var(--tb-accent);
    color: #11111b;
    font-weight: 650;
  }
  .btn.next:hover { background: #d9bdf9; }
  .btn.next.pausing { background: #fab387; border-color: #fab387; }
  .btn.viz-on { background: #3b3352; border-color: var(--tb-accent); color: var(--tb-accent); }

  /* Run, Step, Back and Reset as one control. */
  .transport { display: flex; }
  .transport .btn { border-radius: 0; margin-left: -1px; }
  .transport .btn:first-child { border-radius: 7px 0 0 7px; margin-left: 0; }
  .transport .btn:last-child { border-radius: 0 7px 7px 0; }
  .transport .btn.next { position: relative; z-index: 1; }

  /* Two-way switches: the language and the engine. */
  .seg {
    display: inline-flex;
    padding: 2px;
    gap: 2px;
    background: #11111b;
    border: 1px solid var(--tb-line);
    border-radius: 8px;
  }
  .seg button {
    height: calc(var(--tb-h) - 6px);
    padding: 0 10px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: #9399b2;
    font: inherit;
    font-size: 12px;
    font-weight: 650;
    cursor: pointer;
  }
  .seg button:hover:not(.active) { color: var(--tb-text); background: rgba(255, 255, 255, 0.05); }
  .seg button.active { background: #313244; color: var(--tb-accent); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }

  .chip {
    height: calc(var(--tb-h) - 4px);
    padding: 0 9px;
    background: #313244;
    border: 1px solid #45475a;
    border-radius: 999px;
    color: var(--tb-sub);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    white-space: nowrap;
  }
  .chip:hover { background: #45475a; color: var(--tb-text); }
  .chip.warn { border-color: #f9e2af; color: #f9e2af; background: #2a2618; }
  .chip-short { display: none; }

  /* Selects: the example, and Download with its icon inside. */
  .example {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 12px;
    font-weight: 550;
    color: var(--tb-sub);
  }
  select {
    --sel-h: var(--tb-h);
    min-width: 0;
    padding: 0 26px 0 10px;
    background-color: var(--tb-btn);
    background-position: right 10px center;
    color: var(--tb-text);
    border-color: var(--tb-line);
    border-radius: 7px;
    font-size: 12.5px;
    font-weight: 550;
  }
  select:hover { background-color: var(--tb-btn-hover); border-color: #45475a; }
  #exampleSelect { width: 200px; max-width: 100%; }
  .download { position: relative; display: inline-flex; align-items: center; color: var(--tb-text); }
  .download :global(.icon) { position: absolute; left: 9px; pointer-events: none; }
  .download select { padding-left: 30px; }
  #fileLoader { display: none; }

  /* The status message and the metrics share the run row while it has
     room for them. */
  .toolbar-row-status {
    flex: 1 1 320px;
    display: flex;
    align-items: center;
    gap: 4px 12px;
    min-width: 0;
    font-size: 12px;
    line-height: 1.3;
  }
  .status {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #bac2de;
    font-weight: 500;
  }
  .stats { margin-left: auto; white-space: nowrap; color: #a6e3a1; font-weight: 600; }
  /* The PC is the one number you look for while stepping. */
  .stat-pc { color: #89b4fa; font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace; }
  .stat-tag { font-size: 9px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #6c7086; vertical-align: 1px; }
  .stat-lag { color: #fab387; }

  /* Narrower: the status takes a line of its own. */
  @container tb (max-width: 1040px) {
    .toolbar-row-status { flex-basis: 100%; }
  }

  /* Narrower still: secondary buttons keep their icons and tooltips. */
  @container tb (max-width: 820px) {
    .tools .word, .settings .word, .views .word, .example-word { display: none; }
    .tools .btn, .settings, .views .btn { width: var(--tb-h); padding: 0; }
    .download select { width: var(--tb-h); padding: 0; color: transparent; background-image: none; }
    .download :global(.icon) { left: 7px; }
    #exampleSelect { width: 170px; }
  }

  @container tb (max-width: 640px) {
    .subtitle { display: none; }
  }

  /* A phone, or a narrow column: four lines - the mode and example, every
     tool as an icon, the run controls at full width, and the status right
     under them. */
  @container tb (max-width: 560px) {
    .tb { --tb-h: 34px; }
    .header { padding: 6px 10px 2px; }
    .toolbar { padding: 6px 10px 8px; gap: 6px; }
    .toolbar-row { display: contents; }
    .toolbar { flex-direction: row; flex-wrap: wrap; column-gap: 6px; }
    .modes { order: 1; flex: 1 1 100%; }
    .example { flex: 1 1 0; }
    #exampleSelect { width: 100%; }
    .chip-long { display: none; }
    .chip-short { display: inline; }
    .tools { order: 2; }
    .views { order: 3; }
    .settings { order: 4; margin-left: auto; }
    .run { order: 5; flex: 1 1 100%; }
    .transport { flex: 4 1 0; }
    .run .btn { flex: 1 1 0; min-width: 0; padding: 0 4px; gap: 4px; font-size: 12px; }
    #btnAssemble { flex: 1 1 0; }
    .toolbar-row-status { order: 6; flex-basis: 100%; font-size: 11.5px; align-items: flex-start; }
    .status { white-space: normal; }
    .stats { display: flex; flex-direction: column; align-items: flex-end; flex: 0 0 auto; }
    .stats .stat-sep { display: none; }
    .gap { display: none; }
  }

  @container tb (max-width: 420px) {
    .credits span { display: none; }
  }

  /* The narrowest phones: the run controls keep only their icons. */
  @container tb (max-width: 380px) {
    .run .word { display: none; }
  }

  /* A column narrower than any phone (a squeezed desktop split): the title
     gives way first, and a group wraps within itself rather than run off
     the edge. */
  @container tb (max-width: 300px) {
    .title { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .modes, .tools { flex-wrap: wrap; }
    .example { flex-basis: 100%; }
    .toolbar-row-status { flex-direction: column; align-items: stretch; }
    .stats { margin-left: 0; align-items: flex-start; }
  }
</style>
