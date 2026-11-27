<script lang="ts">
  // Credits, and the visit count when the page is served from its site.
  import { viewRev } from './views.svelte';
  import { creditsModel, closeCreditsModal, sendFeedback } from './execution';

  const m = $derived.by(() => { viewRev.credits; return creditsModel; });
</script>

<div class="cycles-overlay" class:open={m.open} id="creditsOverlay" onclick={(event) => { if(event.target===event.currentTarget)closeCreditsModal(); }}>
  <div class="cycles-panel credits-modal">
    <div class="c-head">
      <span>Credits</span>
      <button onclick={() => closeCreditsModal()} title="Close">&times;</button>
    </div>
    <div class="c-body">
      <p>Part of <a href="https://nus-cg3207.github.io/" target="_blank" rel="noopener noreferrer">CG3207</a>,
        NUS. Written by <a href="https://blog.nus.edu.sg/rajesh/" target="_blank"
          rel="noopener noreferrer">Rajesh Panicker</a>.</p>
      <p>RVEduSim is open source, at <a href="https://github.com/r-panicker/RVEduSim" target="_blank"
        rel="noopener noreferrer">github.com/r-panicker/RVEduSim</a>. A desktop app for Windows, macOS
        and Linux, with native Icarus Verilog and Verilator, can be downloaded from its
        <a href="https://github.com/r-panicker/RVEduSim/releases/latest" target="_blank"
        rel="noopener noreferrer">Releases</a> page.</p>
      <p>The MMIO layout and <code>ecall</code> system call services follow the conventions of
        <a href="https://github.com/TheThirdOne/rars" target="_blank" rel="noopener noreferrer">RARS</a>,
        the RISC-V Assembler and Runtime Simulator.</p>
      <p>The microarchitecture terminology and some of the general ideas follow Sarah L. Harris and
        David Harris, <i>Digital Design and Computer Architecture: RISC-V Edition</i>. The datapaths
        here are a different design from the book's.</p>
      <p>The code editor is <a href="https://codemirror.net/" target="_blank" rel="noopener noreferrer">CodeMirror
          6</a>, and C is compiled by <a href="https://godbolt.org/" target="_blank"
          rel="noopener noreferrer">Compiler Explorer</a>. HDL mode runs on <a href="https://github.com/steveicarus/iverilog" target="_blank"
          rel="noopener noreferrer">Icarus Verilog</a>, compiled to WebAssembly by
        <a href="https://github.com/senolgulgonul/verisim" target="_blank" rel="noopener noreferrer">verisim</a>.
        The desktop app runs Icarus natively and can use
        <a href="https://www.veripool.org/verilator/" target="_blank" rel="noopener noreferrer">Verilator</a> instead,
        with <a href="https://ziglang.org/" target="_blank" rel="noopener noreferrer">Zig</a> as the C++ compiler
        where none is installed. Post-synthesis simulation runs on <a href="https://github.com/YosysHQ/yosys" target="_blank"
          rel="noopener noreferrer">Yosys</a>, compiled to WebAssembly by
        <a href="https://github.com/YoWASP/yosys" target="_blank" rel="noopener noreferrer">YoWASP</a>.</p>
      <p>Feedback and bug reports are welcome: rajesh&lt;at&gt;nus.edu.sg.</p>
      <p class="visit-count" id="visitCount" hidden={!m.visits}>{m.visits}</p>
    </div>
    <div class="c-foot" style="justify-content:space-between;">
      <button type="button" onclick={() => sendFeedback()} title="Email rajesh&lt;at&gt;nus.edu.sg">✉ Feedback</button>
      <button class="primary" onclick={() => closeCreditsModal()}>Close</button>
    </div>
  </div>
</div>
