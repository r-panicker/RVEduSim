<script lang="ts">
  // Settings: the Compiler, Linker and Simulation tabs. Which tab shows,
  // whether it is open and which engine's settings the Simulation tab shows
  // are settingsModel in execution.ts. The controls' values are set and read
  // by the modules that own each setting, by id, so the component leaves them
  // alone; the cycles table and the HDL file list are filled in the same way.
  import { viewRev } from './views.svelte';
  import {
    settingsModel, closeSettingsModal, switchSettingsTab, applyAndCloseSettings, resetCurrentSettingsTab,
    updateLinkerStackPreview,
  } from './execution';
  import { syncGodboltArchFlags } from './examples-language';
  import { resetEverything } from './settings-store';
  import { exampleSources, examplesFolderPicked, forgetExamplesFolder, pickExamplesFolder, setExamplesWebUrl,
    type ExampleSourceState } from './example-sources';
  import { setStatus } from './editor';
  import {
    setHdlCompare, setHdlCycles, setHdlDetail, setHdlDumpVcd, setHdlLiveWave, setHdlRegPath, setHdlSimulator,
    setHdlSynth, setHdlTrace, setHdlWaveTop,
  } from './waveform';
  import { hdlClearFiles, hdlLoadPrebuiltProcessor, hdlPickFolder } from '../hdl/sources';

  const m = $derived.by(() => { viewRev.settings; return settingsModel; });
  const ex = $derived.by(() => {
    viewRev.settings;
    return { webUrl: exampleSources.webUrl, web: exampleSources.web, folder: exampleSources.folder && { ...exampleSources.folder },
             local: exampleSources.local, desktop: !!window.rvNative };
  });
  const sourceStatus = (s: ExampleSourceState) => s.status === 'loading' ? 'reading…'
    : s.status === 'error' ? 'unavailable: ' + s.error
    : s.status === 'ok' ? s.entries.length + ' example' + (s.entries.length === 1 ? '' : 's') : '';

  // Reset All reloads the page, so it takes a second click to confirm.
  let resetArmed = $state(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  function onResetAll() {
    if (resetArmed) { resetEverything(); return; }
    resetArmed = true;
    setStatus('Click Reset All again to reset every setting and the layout. The page reloads, so save your program first.', 'warn');
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { resetArmed = false; }, 4000);
  }
</script>

<div class="cycles-overlay" class:open={m.open} id="settingsOverlay" onclick={(event) => { if(event.target===event.currentTarget)closeSettingsModal(); }}>
  <div class="cycles-panel settings-modal">
    <div class="c-head" style="margin-bottom:0;border-bottom:1px solid #313244;">
      <span style="font-size:14px;font-weight:700;color:#cdd6f4;">⚙ Settings &amp; Configuration</span>
      <button onclick={() => closeSettingsModal()} title="Close">&times;</button>
    </div>
    <!-- Settings Tab Navigation Bar -->
    <div class="settings-tab-bar">
      <button class="settings-tab-btn" class:active={m.tab === 'compiler'} id="settingsTabBtn-compiler" onclick={() => { switchSettingsTab('compiler'); }}>⚡ Compiler</button>
      <button class="settings-tab-btn" class:active={m.tab === 'linker'} id="settingsTabBtn-linker" onclick={() => { switchSettingsTab('linker'); }}>🗺 Linker</button>
      <button class="settings-tab-btn" class:active={m.tab === 'simulator'} id="settingsTabBtn-simulator" onclick={() => { switchSettingsTab('simulator'); }}>⏱ Simulation</button>
      <button class="settings-tab-btn" class:active={m.tab === 'examples'} id="settingsTabBtn-examples" onclick={() => { switchSettingsTab('examples'); }}>📚 Examples</button>
    </div>
    <!-- Tab 1: Compiler -->
    <div class="settings-tab-content" class:active={m.tab === 'compiler'} id="settingsContent-compiler">
      <div style="display:flex;flex-direction:column;gap:12px;font-size:12.5px;">
        <div>
          <label style="font-weight:600;display:block;margin-bottom:4px;color:#cba6f7;">RISC-V 32-bit Compiler:</label>
          <select id="godboltCompilerSelect" style="width:100%;--sel-h:30px;">
            <option value="rv32-cclang2010" selected>RISC-V Clang 20.1.0 (Stable)</option>
            <option value="rv32-cclang">RISC-V Clang (Trunk)</option>
            <option value="rv32-cgcc1420">RISC-V GCC 14.2.0 (Stable)</option>
            <option value="rv32-cgcctrunk">RISC-V GCC (Trunk)</option>
          </select>
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:4px;color:#cba6f7;">Optimization Level:</label>
          <select id="godboltOptSelect" style="width:100%;--sel-h:30px;">
            <option value="-O0" selected>-O0 (Debug — Precise 1:1 C Source Line Mappings)</option>
            <option value="-O1">-O1 (Basic Optimization)</option>
            <option value="-O2">-O2 (Speed Optimization)</option>
            <option value="-Os">-Os (Size Optimization)</option>
            <option value="-O3">-O3 (Aggressive Optimization)</option>
          </select>
          <span style="display:block;margin-top:6px;font-size:11.5px;color:#a6adc8;line-height:1.45;">
            This changes how much code the compiler emits, often by several
            times over. <b>-O0</b> keeps every C statement separate and
            <b>-O3</b> unrolls and inlines, so both are usually the largest;
            <b>-Os</b> is the smallest.
          </span>
          <details class="hdl-note" style="margin-top:6px;">
            <summary>Making sure it still fits the hardware</summary>
            <div class="hdl-hint">
              The program has to fit the instruction memory the processor
              actually has. In this simulator that limit is <b>Code (.text)
              size</b> in Settings → Linker; on the FPGA it is set by
              <code>IROM_DEPTH_BITS</code> in <code>Wrapper</code>, and the two
              have to agree. The status bar reports the size after every
              assemble, and says by how many words the program overruns if it
              does. Raising the optimisation level, or raising both limits
              together, are the two ways out — raising only the linker
              setting will build here and then silently truncate on hardware.
            </div>
          </details>
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:4px;color:#cba6f7;">Architecture &amp; ABI Flags:</label>
          <input type="text" id="godboltArchFlags" value="-march=rv32i -mabi=ilp32" style="width:100%;padding:5px 8px;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:4px;box-sizing:border-box;font-family:monospace;">
          <label style="display:flex;align-items:center;gap:8px;font-weight:600;color:#cba6f7;cursor:pointer;margin-top:6px;font-size:12.5px;">
            <input type="checkbox" id="godboltUseM" onchange={() => syncGodboltArchFlags()} style="accent-color:#cba6f7;width:15px;height:15px;cursor:pointer;">
            Include M extension (RV32I + M — mul/div)
          </label>
        </div>
        <div style="font-size:11px;color:#9399b2;line-height:1.4;background:#11111b;padding:8px;border-radius:4px;border:1px solid #313244;">
          💡 <strong>Note:</strong> C source code is compiled online via Compiler Explorer (Godbolt) REST API
        </div>
      </div>
    </div>
    <!-- Tab 2: Linker -->
    <div class="settings-tab-content" class:active={m.tab === 'linker'} id="settingsContent-linker">
      <div class="cycle-hint" style="margin-bottom:10px;">Base addresses and segment sizes (hex). Stack top (sp) defaults to Data Base + Data Size, but can be customized. Applying reloads the program with the new layout.</div>
      <div style="font-size:11.5px;color:#fab387;background:rgba(250, 179, 135, 0.10);border:1px solid rgba(250, 179, 135, 0.35);padding:8px 10px;border-radius:5px;margin-bottom:12px;line-height:1.45;">
        ⚠️ The segment sizes should not exceed the memory size provisioned in hardware.
      </div>
      <div id="memSegmentsConfigBody">
        <div class="cycle-field"><label for="ms-code">Code (.text) base</label><input id="ms-code" type="text" value="0x400000" oninput={() => updateLinkerStackPreview()}></div>
        <div class="cycle-field"><label for="ms-codesize">Code (.text) size</label><input id="ms-codesize" type="text" value="0x200" oninput={() => updateLinkerStackPreview()}></div>
        <div class="cycle-field"><label for="ms-data">Data (.data) base</label><input id="ms-data" type="text" value="0x10010000" oninput={() => updateLinkerStackPreview()}></div>
        <div class="cycle-field"><label for="ms-datasize">Data (.data) size</label><input id="ms-datasize" type="text" value="0x200" oninput={() => updateLinkerStackPreview()}></div>
        <div class="cycle-field"><label for="ms-stack">Stack top (sp)</label><input id="ms-stack" type="text" value="0x10010200" title="Initial stack pointer address (defaults to Data Base + Data Size; user overridable)"></div>
        <div class="cycle-field"><label for="ms-mmio">MMIO base</label><input id="ms-mmio" type="text" value="0xFFFF0000"></div>
      </div>
    </div>
    <!-- Tab 3: Simulation. What reaches both engines, then the active
         engine's own settings; the other engine's are hidden. -->
    <div class="settings-tab-content" class:active={m.tab === 'simulator'} id="settingsContent-simulator">

      <div class="sim-group" id="simGroupBoth">
        <div class="sim-group-hdr"><span class="sim-group-title">Both engines</span></div>
        <div class="sim-card" id="simStatementStepCard">
          <label style="display:flex;align-items:center;gap:8px;font-weight:600;color:#cba6f7;cursor:pointer;font-size:13px;">
            <input type="checkbox" id="simStatementStep" style="accent-color:#cba6f7;width:16px;height:16px;cursor:pointer;">
            Statement Stepping (Fast Mode)
          </label>
          <span style="font-size:11.5px;color:#a6adc8;line-height:1.4;">
            Step and Back move a whole C statement or pseudo-op expansion at a time, not one machine instruction.
          </span>
        </div>
        <div class="sim-card">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-weight:600;color:#cba6f7;font-size:13px;"
              title="The CPU clock on the board: the top-level module divides 100 MHz by 2^CLK_DIV_BITS. The same setting for both engines.">Clock</span>
            <span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#a6adc8;">
              CLK_DIV_BITS
              <input type="number" data-clk="div" min="0" max="26" step="1" value="5" class="pipe-select" style="width:52px;"
                title="As in the top-level module: 0 is 100 MHz, 1 is 50 MHz, 5 is 3.13 MHz, 26 is about 1.5 Hz">
              <span data-clk="hz" style="min-width:62px;color:#cdd6f4;">3.13 MHz</span>
              <select data-clk="pace" class="pipe-select"
                title="Max speed runs as fast as the browser can. Real time runs at the clock above, so delay loops take as long as on the board; if the browser cannot keep up, the toolbar shows the fraction of real time it reaches. In HDL mode a run is recorded first and then played back at the clock.">
                <option value="max">Max speed</option>
                <option value="real">Real time</option>
              </select>
            </span>
          </div>
        </div>
      </div>

      <div class="sim-group" id="simGroupJs" hidden={m.hdl}>
        <div class="sim-group-hdr"><span class="sim-group-title">JavaScript model</span></div>
        <div class="sim-card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <label for="simMicroarch" style="font-weight:600;color:#cba6f7;font-size:13px;">Microarchitecture</label>
            <select id="simMicroarch" class="pipe-select" title="Switching resets the program">
              <option value="single">Single-cycle</option>
              <option value="multi">Multi-cycle</option>
              <option value="pipe">5-stage pipeline</option>
            </select>
          </div>
          <div class="pipe-haz" id="pipeHazBox">
            <label title="ForwardAE / ForwardBE: ALUResultM or ResultW into Execute"><input type="checkbox" data-haz="fwdE"> Forward M, W to E</label>
            <label title="Forward1D / Forward2D: ResultW into the register file's outputs"><input type="checkbox" data-haz="fwdD"> Forward W to D</label>
            <label title="ForwardM: a load's data in W into a store's WriteDataM"><input type="checkbox" data-haz="fwdM"> Mem-mem copy</label>
            <label title="FlushD and FlushE when PCSrcE is set"><input type="checkbox" data-haz="flush"> Flush on taken branch</label>
            <label title="lwStall: hold F and D and put a bubble in E when Decode reads the register a load in E is about to write"><input type="checkbox" data-haz="lwStall"> Load-use stall</label>
            <label title="A BHT read in Fetch predicts whether each instruction is taken, and its target; a misprediction found in Execute flushes and redirects. Changing it resets the program"><input type="checkbox" id="pipeBpOn"> Branch prediction</label>
            <label title="1-bit: the last outcome. 2-bit: a saturating counter, so one surprise does not flip it">
              <select id="pipeBpBits" class="pipe-select"><option value="1">1-bit</option><option value="2">2-bit</option></select></label>
            <label title="BHT entries, indexed by PC[k+1:2] and untagged, so instructions whose PCs share those bits share an entry">
              <select id="pipeBpEntries" class="pipe-select"><option>4</option><option>8</option><option>16</option><option>32</option><option>64</option><option>128</option><option>256</option></select> entries</label>
          </div>
          <div id="cyclesTableBox">
            <div class="c-body" id="cyclesConfigBody" style="padding:0;"></div>
          </div>
        </div>
        <div class="sim-card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <label for="simMaxInstrPerRun" style="font-weight:600;color:#cba6f7;font-size:13px;">
              Max Instructions Per Run
            </label>
            <input id="simMaxInstrPerRun" type="number" min="1" max="2000000000" step="1000000" value="100000000"
              style="width:110px;padding:4px 8px;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:4px;font-family:inherit;font-size:12px;text-align:right;">
          </div>
          <span style="font-size:11.5px;color:#a6adc8;line-height:1.4;">
            Maximum number of instructions executed per run before pausing. Default: <strong>100,000,000</strong>.
          </span>
        </div>
      </div>

      <!-- The Verilog engine's setup, done once per session. -->
      <div id="simGroupHdl" hidden={!m.hdl}>
      <div class="cycle-hint" style="margin-bottom:12px;">
        Your Verilog is compiled on this computer and never uploaded. Files you drop
        here last for this session; a folder is remembered.
      </div>

      <div class="sim-group">
        <div class="sim-group-hdr"><span class="sim-group-title">Processor sources</span>
          <span class="sim-group-note" id="hdlSourcesNote"></span></div>
        <div class="hdl-drop" id="hdlDropZone">
          Drop your <b>.v</b> files here, or
          <label class="hdl-btn" style="display:inline-block;padding:2px 8px;">
            browse…
            <input type="file" id="hdlFileInput" multiple accept=".v,.sv,.vh,.svh" style="display:none;">
          </label>
          <button type="button" class="hdl-btn" id="hdlFolderBtn" style="display:none;padding:2px 8px;"
            onclick={() => hdlPickFolder()}>folder…</button>
          <input type="file" id="hdlFolderInput" webkitdirectory multiple style="display:none;">
          <br>Include <b>Wrapper</b>, <b>RV</b> and every submodule.
          <br><span style="color:#6c7086;">You can also drop them anywhere on the page, or open them with 📂 Open.</span>
        </div>
        <div class="hdl-file-list" id="hdlFileList"></div>
        <div class="hdl-warn" id="hdlWrapperWarn" style:display={m.wrappers ? 'block' : 'none'}>
          {#if m.wrappers && m.wrappers.length > 1}
            {m.wrappers.length} of the loaded files declare <code>module Wrapper</code>: {m.wrappers.join(', ')}.
            The generated testbench instantiates <code>Wrapper</code> by name, so remove all but one (×).
          {:else}
            None of the loaded files declares <code>module Wrapper</code>. The generated
            testbench instantiates <code>Wrapper</code> by name, so add the file that declares it.
          {/if}
        </div>
        <div class="hdl-row" style="margin-top:8px;">
          <button type="button" class="hdl-btn" id="hdlPrebuiltBtn" onclick={() => hdlLoadPrebuiltProcessor()}
            title="Replace the loaded sources with a working RV32I+M processor and the fixed Wrapper, so HDL mode has something to run before yours does. Pre-synthesised into one flattened module, so there is nothing in it to read.">Prebuilt processor</button>
          <button type="button" class="hdl-btn" onclick={() => hdlClearFiles()}>Clear files</button>
        </div>
      </div>

      <div class="sim-group" id="hdlGroupBoth">
        <div class="sim-group-hdr"><span class="sim-group-title">Simulation</span></div>

        <div class="sim-card">
          <div id="hdlSimulatorRow" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
            <label for="hdlSimulator" style="font-weight:600;color:#cba6f7;font-size:13px;">Simulator</label>
            <select id="hdlSimulator" onchange={(event) => { setHdlSimulator(event.currentTarget.value); }}
              style="--sel-h:28px;">
              <option value="icarus">Icarus Verilog</option>
              <option value="verilator">Verilator</option>
            </select>
          </div>
        </div>

        <div class="sim-card">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
            <label for="hdlCycles" style="font-weight:600;color:#cba6f7;font-size:13px;">Cycles per Run / Resume</label>
            <input type="number" id="hdlCycles" value="200000" min="1" max="2000000"
              onchange={(event) => { setHdlCycles(event.currentTarget.value); }}
              style="width:110px;padding:4px 8px;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:4px;font-family:inherit;font-size:12px;text-align:right;">
          </div>
          <span style="font-size:11.5px;color:#a6adc8;line-height:1.4;">
            Clock cycles a fresh Run records, and how many more each Resume adds.
          </span>
        </div>



      </div>

      <div class="sim-group">
        <div class="sim-group-hdr" style="display:flex;justify-content:space-between;align-items:center;gap:10px;"><span class="sim-group-title">Recording &amp; output</span>
          <span style="display:inline-flex;align-items:center;gap:6px;"
            title="Sets the options below that cost run time. Full records everything, and with Verilator the waveform follows a run while it goes; Balanced keeps only the Wrapper's signals in the waveform, built on Pause; Fastest records no waveform and no architectural trace, so Step, Back, breakpoints and the Registers panel do not work, and turns the cross-check and post-synthesis simulation off. Change any option below and this reads Custom.">
            <label for="hdlDetail" style="font-size:12px;color:#a6adc8;">Detail</label>
            <select id="hdlDetail" onchange={(event) => { setHdlDetail(event.currentTarget.value); }} style="--sel-h:28px;">
              <option value="full">Full</option>
              <option value="balanced">Balanced</option>
              <option value="fastest">Fastest</option>
              <option value="custom" hidden disabled>Custom</option>
            </select>
          </span></div>
        <div class="sim-card">
          <label style="display:flex;align-items:center;gap:8px;font-weight:600;color:#cba6f7;cursor:pointer;font-size:13px;">
            <input type="checkbox" id="hdlTrace" checked onchange={(event) => { setHdlTrace(event.currentTarget.checked); }}
              style="accent-color:#cba6f7;width:16px;height:16px;cursor:pointer;">
            Record the architectural trace
          </label>
          <span style="font-size:11.5px;color:#a6adc8;line-height:1.4;">
            Needed for Step, Back, breakpoints and the Registers panel. About 30% of the run time.
          </span>
        </div>

        <div class="sim-card">
          <label style="display:flex;align-items:center;gap:8px;font-weight:600;color:#cba6f7;cursor:pointer;font-size:13px;">
            <input type="checkbox" id="hdlVcd" checked onchange={(event) => { setHdlDumpVcd(event.currentTarget.checked); }}
              style="accent-color:#cba6f7;width:16px;height:16px;cursor:pointer;">
            Record a waveform
          </label>
          <span style="font-size:11.5px;color:#a6adc8;line-height:1.4;">
            For the waveform view and the VCD download. About 30% of the run time.
          </span>
          <div id="hdlWaveScopeRow" style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:10px;"
            title="Wrapper only records the testbench's and the Wrapper's own signals (CLK, PC, Instr, the peripherals and the x0..x31 registers), not those inside RV, and takes about a quarter less time. To see a signal inside RV, choose All and Reset.">
            <label for="hdlWaveTop" style="font-weight:600;color:#cba6f7;font-size:13px;">Signals</label>
            <select id="hdlWaveTop" onchange={(event) => { setHdlWaveTop(event.currentTarget.value === 'top'); }} style="--sel-h:28px;">
              <option value="all">All</option>
              <option value="top">Wrapper only, about 25% faster</option>
            </select>
          </div>
          <div id="hdlLiveWaveRow" style="display:none;display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:10px;"
            title="With Verilator a run is live. While running re-reads the waveform twice a second, which slows a fast run down and is worth it with Real time at a slow clock. Either way it covers at most the last 50,000 cycles.">
            <label for="hdlLiveWave" style="font-weight:600;color:#cba6f7;font-size:13px;">Built</label>
            <select id="hdlLiveWave" onchange={(event) => { setHdlLiveWave(event.currentTarget.value); }} style="--sel-h:28px;">
              <option value="pause">On Pause</option>
              <option value="live">While running, slower</option>
            </select>
          </div>
        </div>

        <div class="sim-card">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
            <label for="hdlGeneration" style="font-weight:600;color:#cba6f7;font-size:13px;">Verilog standard</label>
            <select id="hdlGeneration"
              style="--sel-h:28px;">
              <option value="2005">Verilog-2005</option>
              <option value="2001">Verilog-2001</option>
              <option value="1995">Verilog-1995</option>
              <option value="2005-sv">SystemVerilog</option>
            </select>
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-weight:600;color:#cba6f7;cursor:pointer;font-size:13px;margin-top:10px;">
            <input type="checkbox" id="hdlCompare" onchange={(event) => { setHdlCompare(event.currentTarget.checked); }}
              style="accent-color:#cba6f7;width:16px;height:16px;cursor:pointer;">
            Cross-check against the JS model
          </label>
          <span style="font-size:11.5px;color:#a6adc8;line-height:1.4;">
            Reports the first instruction where your hardware and the functional model
            disagree. Costs a second execution.
          </span>
        </div>

        <div class="sim-card" id="hdlSynthCard">
          <label style="display:flex;align-items:center;gap:8px;font-weight:600;color:#cba6f7;cursor:pointer;font-size:13px;"
            title="The netlist has no checkpoints to continue from, and is checked against one RTL run of the same length from reset, so a Run with this on is simulated in one go: it cannot be paused (Reset stops it), and an input changed meanwhile takes effect where it ends. Cycles per Run is 50,000 by default while it is on.">
            <input type="checkbox" id="hdlSynth" onchange={(event) => { setHdlSynth(event.currentTarget.checked); }}
              style="accent-color:#cba6f7;width:16px;height:16px;cursor:pointer;">
            Post-synthesis functional simulation
          </label>
          <span style="font-size:11.5px;color:#a6adc8;line-height:1.4;">
            Synthesises your core with Yosys and checks the netlist against your RTL.
            Slow: 20–35 s each time the Verilog changes, then a second, slower run.
            A Run is simulated in one go and cannot be paused.
          </span>
          <details class="hdl-note">
            <summary>What this does, and the one-off download</summary>
            <div class="hdl-hint">
              Every run is simulated twice: once as you wrote it, and once as the
              gate-level netlist Yosys produces. The two are compared and the first point
              where they differ is reported — which is what an inferred latch, an
              incomplete sensitivity list or a race between blocking assignments looks
              like. The panels keep showing the RTL run, so stepping and the register view
              are unaffected; register writes are not compared, because synthesis leaves
              no register array to read.
              <br><br>
              Ticking this downloads the synthesiser the first time you use it (about
              <b>13 MB</b>). Nothing is fetched until you tick it, and your browser caches
              it for a year, so later sessions start immediately. Synthesis takes 20–35
              seconds and is redone only when your Verilog changes.
            </div>
          </details>
        </div>
      </div>

      <div class="sim-group">
        <div class="sim-group-hdr"><span class="sim-group-title">Register file</span>
          <span class="sim-group-note">detected automatically</span></div>
        <div class="sim-card">
          <input type="text" id="hdlRegPath" spellcheck="false" onchange={() => setHdlRegPath()}
            style="width:100%;padding:5px 8px;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:4px;box-sizing:border-box;font-family:monospace;font-size:12px;"
            title="Hierarchical path to your 32-entry register array. Detected automatically; override it only if detection fails.">
          <span style="font-size:11.5px;color:#a6adc8;line-height:1.4;" id="hdlRegPathHint">load your sources to detect the register file</span>
        </div>
      </div>

      <details class="hdl-note">
        <summary>How HDL mode works</summary>
        <div class="hdl-hint">
          The assembled program reaches your Wrapper as <code>AA_IROM.mem</code> and
          <code>AA_DMEM.mem</code> through its own <code>$readmemh</code> — assemble first, then run.
          Run records the whole simulation; <b>Step</b> and <b>Back</b> then move through that
          recording, so stepping is instant and works in both directions. <b>Run</b> becomes
          <b>Resume</b> once there is a recording — it continues to the next breakpoint, and
          records another <i>Cycles</i> worth when it reaches the end. <b>Reset</b> is how you
          start the hardware over.
          Changing a DIP switch, a button, the accelerometer or the UART input while paused is
          timestamped at the current cycle and the run replayed — everything before that point
          comes out identical, so you keep your place, and the very next instruction already
          sees the new value.
        </div>
      </details>
      </div>
    </div>
    <!-- Tab 4: where the Example menu's programs come from (example-sources.ts). -->
    <div class="settings-tab-content" class:active={m.tab === 'examples'} id="settingsContent-examples">
      <div class="sim-card ex-card">
        <div class="ex-head"><label for="examplesWebUrl">Web folder</label><span class="ex-status" id="examplesWebStatus">{sourceStatus(ex.web)}</span></div>
        <div class="ex-row">
          <input id="examplesWebUrl" type="text" spellcheck="false" value={ex.webUrl}
            placeholder={'Default: ' + (ex.desktop ? 'the RVEduSim site' : "this site's examples")}
            title="A GitHub folder (github.com/owner/repo/tree/branch/folder), or any https folder laid out like examples/: index.txt, asm/ and c/"
            onchange={e => setExamplesWebUrl(e.currentTarget.value)}>
          <button type="button" class="hdl-btn" disabled={!ex.webUrl} onclick={() => setExamplesWebUrl('')}
            title="Use the default examples again">Default</button>
        </div>
      </div>
      <div class="sim-card ex-card">
        <div class="ex-head"><span>Folder on this computer</span><span class="ex-status" id="examplesLocalStatus">{ex.folder ? sourceStatus(ex.local) : ''}</span></div>
        <div class="ex-row">
          <button type="button" class="hdl-btn" id="examplesFolderBtn" onclick={() => pickExamplesFolder()}
            title={ex.folder && ex.folder.pending ? 'Read the folder again. The browser asks for permission first.'
              : 'Its .asm, .s and .c files, or the ones its index.txt lists, are added to the Example menu'}
            >{ex.folder ? (ex.folder.pending ? '↻ ' : '') + ex.folder.name : 'folder…'}</button>
          {#if ex.folder}<button type="button" class="hdl-file-x" title="Forget this folder" onclick={() => forgetExamplesFolder()}>&times;</button>{/if}
          <input type="file" id="examplesFolderInput" webkitdirectory multiple style="display:none;"
            onchange={e => { const el = e.currentTarget; examplesFolderPicked(el.files ?? []).then(() => { el.value = ''; }); }}>
        </div>
      </div>
    </div>
    <!-- Footer -->
    <div class="c-foot" style="margin-top:0;border-top:1px solid #313244;padding:12px 20px;">
      <div style="display:flex;gap:8px;">
        <button onclick={() => resetCurrentSettingsTab()} title="This tab's settings back to the defaults">Reset Defaults</button>
        <button onclick={onResetAll} class:armed={resetArmed}
          title="Every setting on every tab, and the page layout (panels, docks, waveform signals), back to the defaults. The page reloads.">{resetArmed ? 'Confirm reset' : 'Reset All'}</button>
      </div>
      <button class="primary" onclick={() => applyAndCloseSettings()}>Apply &amp; Close</button>
    </div>
  </div>
</div>
