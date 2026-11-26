// HDL mode's state: the settings, the loaded sources, the recording being
// stepped through, what has been built for it, and what is running. Each
// group is one object that every part of HDL mode reads and writes.

import type { HdlCheckpoint, HdlWave } from './checkpoints';
import type { hdlMemFiles } from './memory-images';
import type { HdlLiveRun } from './live';
import type { HdlBase } from './seek';

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

// isPrebuilt: the shipped reference core, whose Wrapper sizes are adjusted to the program.
// folderPath: where a file loaded from a source folder sits in it.
export interface HdlSource { name: string; src: string; isPrebuilt?: boolean; folderPath?: string }

// A source folder, read through the desktop app's bridge (by path), a File
// System Access handle, or once from <input webkitdirectory> (a snapshot).
// pending: the browser wants the read permission granted again; excluded:
// the files removed from the list, by their path in the folder.
export interface HdlFolder {
  kind: 'native' | 'handle' | 'snapshot'; name: string;
  pending: boolean; excluded: Set<string>;
  path?: string; handle?: DirHandle;
}

export const hdlSources = {
  files: [] as HdlSource[],
  folder: null as HdlFolder | null,
  folderReading: null as Promise<boolean> | null,
};

export interface TimedInput { cycle: number; code: number; value: number }
export interface TimedByte { cycle: number; byte: number }

// A peripheral record as the testbench printed it: the @@ kind letter and
// its fields, the cycle first.
export type PerRecord = [kind: string, fields: string[]];

// One instruction of the recording, and what happened while it ran.
export interface HdlStep {
  cyc: number;                                      // the cycle it was fetched in
  pc: number;
  instr: number;
  regw: [reg: number, value: number, cycle: number][];
  memw: [addr: number, byteEnable: number, data: number, cycle: number][];
  per: PerRecord[];
  acks: number;                                     // UART bytes the hardware took
}

// A recorded run: its instructions, the peripheral records before the first
// one (all of them without the architectural trace), and what the run that
// made it was given and produced.
// A design built for one source set: Icarus's bytecode, or a Verilator
// model in the desktop app; the register file's path; whether Icarus's
// checkpoint module (ck) or Verilator's checkpoints (vlCk) are built in.
export interface HdlCompiled { key: string; vvp: Uint8Array | null; model?: unknown; regBank: string | null; ck: boolean; vlCk?: boolean }
export type HdlMemImages = ReturnType<typeof hdlMemFiles>;

export interface HdlTimeline { stim: TimedInput[]; rx: TimedByte[] }

export interface HdlTrace {
  steps: HdlStep[];
  pre: PerRecord[];
  preAcks: number;
  final: { cyc: number; led: number; ss: string } | null;   // the outputs at the end
  next: number | null;                                     // the PC fetched after the end
  userOutput: string;                                      // the design's own $display lines
  newOutput?: string;                                      // ...from the latest run only
  lastCyc?: number;                                        // the latest cycle a record named
  budget: number;                                          // cycles recorded
  offset?: number;                                         // instructions folded into base (Verilator)
  base?: HdlBase;                                          // the state those instructions left
  timeline?: HdlTimeline;                                  // the inputs it was recorded with
  joinKey?: string;                                        // what a later run must match to join on
  regBank?: string | null;                                 // the register file's path, if found
  vlCks?: HdlCheckpoint[] | null;                          // Verilator's checkpoints, newest first
  vcdScope?: 'top' | 'all' | null;
}

export const hdlRec = {
  trace: null as HdlTrace | null,  // the recording
  idx: 0,                          // position in it, in instructions completed
  stim: [] as TimedInput[],        // input changes on the timeline
  rx: [] as TimedByte[],           // UART bytes on the timeline
  base: { dip: 0, pb: 0, accel: 0, adrdy: true },   // inputs at cycle 0
  regKnown: new Uint8Array(32),    // has the hardware written this register yet?
  // Where the last seek left the page: the recording and index, the UART
  // acknowledgements counted, and how far into the last step's records it applied.
  seekMark: null as { trace: HdlTrace | null; idx: number; acks: number; tail?: number[] | null } | null,
  // A second input moved while the first is still re-simulating must not
  // be dropped, or the recording would stop matching the switches.
  pendingResim: false,
  // Inputs already put on the timeline in the middle of a run.
  stimmedInRun: new Set<number>(),
  epoch: 0,                        // bumped whenever the recording is discarded
};

export const hdlBuild = {
  vvpCache: null as HdlCompiled | null,                      // compiled once per source set
  memCache: null as { key: unknown[]; mem: HdlMemImages } | null,   // the memory images last built
  dmemBytes: 1 << 14,              // the DMEM window, read back from the Wrapper
  lastVcd: null as HdlWave | null, // the waveform: VCD text (Verilator) or a VCD doc (Icarus)
  lastRtlOut: null as string | null,   // output of the latest behavioural run
};

export const hdlCheckpoints = {
  set: null as { key: string; every: number; at: Map<number, { txt: string; mem: string[] }> } | null,
  off: null as { key: string } | null,     // sources whose checkpoints are off
  vlOff: null as string | null,            // the compiled design whose Verilator checkpoints are off
};

export const hdlActivity = {
  running: false,
  jobSeq: 0,                       // id of the engine's next job
  live: null as HdlLiveRun | null, // a live Verilator run
  chunked: null as { stop: boolean } | null,                // during an Icarus run in chunks
  paced: null as { cyc: number; applied: number } | null,   // a run without the trace at Real time
  play: null as HdlPlayback | null,                         // playback at Real time
};

// Playback of a recording at the clock: to the instruction at index to,
// from wall-clock time wall and cycle cyc0; done runs when it gets there.
export interface HdlPlayback {
  to: number; trace: HdlTrace | null; wall: number; cyc0: number;
  done?: () => void; timer: ReturnType<typeof setTimeout> | null;
}

// The recording, where the caller is only reached with one in hand.
export function hdlRecording(): HdlTrace {
  if (!hdlRec.trace) throw new Error('no HDL recording');
  return hdlRec.trace;
}
