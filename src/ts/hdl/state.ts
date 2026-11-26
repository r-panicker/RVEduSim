// HDL mode's state: the settings, the loaded sources, the recording being
// stepped through, what has been built for it, and what is running. Each
// group is one object that every part of HDL mode reads and writes.
//
// The recording and the build products are typed where their modules are;
// until those are modules too they are held as `any`.

// Cycles a run records, per simulator: long enough to use the inputs while
// it runs (about 11 s natively with Icarus). A post-synthesis run is
// recorded in one go, and the netlist simulates several times slower, so it
// has a shorter one.
export const HDL_CYCLES_DEFAULT = { icarus: 200000, synth: 50000, verilator: 20000000 };

export const hdlConfig = {
  simulator: 'icarus' as 'icarus' | 'verilator',
  cycleBudget: HDL_CYCLES_DEFAULT.icarus,   // Cycles per Run / Resume
  traceEnabled: true,      // record the architectural trace (needed to step)
  dumpVcd: true,           // record a waveform
  waveTop: false,          // only the testbench's and the Wrapper's own signals
  liveWave: 'live' as 'pause' | 'live',   // when a live run's waveform is built
  compareEnabled: false,   // cross-check against the JS functional model
  synthEnabled: false,     // synthesise with Yosys and simulate the netlist
};

export interface HdlSource { name: string; src: string }

export const hdlSources = {
  files: [] as HdlSource[],
  // { kind: 'native' | 'handle' | 'snapshot', name, path, handle, ... }
  folder: null as any,
  folderReading: null as Promise<unknown> | null,
};

export interface TimedInput { cycle: number; code: number; value: number }
export interface TimedByte { cycle: number; byte: number }

export const hdlRec = {
  trace: null as any,              // the recording: { steps, pre, final, next, ... }
  idx: 0,                          // position in it, in instructions completed
  stim: [] as TimedInput[],        // input changes on the timeline
  rx: [] as TimedByte[],           // UART bytes on the timeline
  base: { dip: 0, pb: 0, accel: 0, adrdy: true },   // inputs at cycle 0
  regKnown: new Uint8Array(32),    // has the hardware written this register yet?
  seekMark: null as any,           // { trace, idx, acks } as the last seek left them
  // A second input moved while the first is still re-simulating must not
  // be dropped, or the recording would stop matching the switches.
  pendingResim: false,
  // Inputs already put on the timeline in the middle of a run.
  stimmedInRun: new Set<unknown>(),
  epoch: 0,                        // bumped whenever the recording is discarded
};

export const hdlBuild = {
  vvpCache: null as any,           // { key, vvp, regBank }: compiled once per source set
  memCache: null as any,           // { key, mem }: the memory images last built
  dmemBytes: 1 << 14,              // the DMEM window, read back from the Wrapper
  lastVcd: null as any,            // the waveform: VCD text (Verilator) or a VCD doc (Icarus)
  lastRtlOut: null as string | null,   // output of the latest behavioural run
};

export const hdlCheckpoints = {
  set: null as any,                // { key, every, at: Map<cycle, { txt, mem }> }
  off: null as any,                // { key, why }: sources whose checkpoints are off
  vlOff: null as any,              // the compiled design whose Verilator checkpoints are off
};

export const hdlActivity = {
  running: false,
  jobSeq: 0,                       // id of the engine's next job
  live: null as any,               // a live Verilator run
  chunked: null as any,            // { stop } during an Icarus run in chunks
  paced: null as any,              // { cyc, applied }: a run without the trace at Real time
  play: null as any,               // { to, trace, wall, cyc0, done, timer }: playback at Real time
};
