// What is on window besides the modules' exports: the CodeMirror 6 bundle
// (ui/cm6-loader.ts loads it), the desktop app's bridge (desktop/app/src/
// rvnative.js), the hooks the test suites set before the page loads, and
// the editor objects the page leaves there for them.

// The CodeMirror 6 bundle (riscv_simulator_tests/cm6_entry.js): every export of
// the packages it is built from, at the versions package.json pins, on one object.
type CM6Bundle = typeof import('@codemirror/state') & typeof import('@codemirror/view') &
  typeof import('@codemirror/language') & typeof import('@codemirror/commands') &
  typeof import('@codemirror/search') & typeof import('@codemirror/autocomplete') &
  { tags: typeof import('@lezer/highlight').tags };
declare var CM6: CM6Bundle;

// The desktop app's bridge (desktop/app/src/rvnative.js). A run the page stopped
// comes back as { cancelled: true }.
interface RvNativeRun { out: string[]; err: string[]; files: Record<string, Uint8Array>; code?: number | string; cancelled?: boolean }
interface RvNativeBuild { ok?: boolean; key?: string; log?: string; compiler?: string | null; cached?: boolean; cancelled?: boolean; ms?: { verilate: number; cxx: number } }
interface RvNative {
  icarus: boolean; icarusVersion: string | null; platform: string;
  verilator: boolean; verilatorVersion: string | null;
  rememberedFolder: string | null;
  hdlRun(id: number, tool: string, files: Record<string, string | Uint8Array>, args: string[],
         opts: { merge: boolean; keep: string | null }): Promise<RvNativeRun>;
  hdlKill(id: number): Promise<void>;
  vlBuild(id: number, files: Record<string, string>, opts: object): Promise<RvNativeBuild>;
  vlRun(id: number, key: unknown, files: Record<string, string | Uint8Array>, args: string[],
        opts: { merge: boolean; keep: string }): Promise<RvNativeRun>;
  onVlProgress(cb: (id: number, evt: { phase: string; total?: number; received?: number; done?: number }) => void): void;
  vlLive(id: number, key: unknown, files: Record<string, string | Uint8Array>, args: string[],
         opts: { keep: string }): Promise<{ cancelled?: boolean; code?: number | string; files: Record<string, Uint8Array> }>;
  vlLiveSend(id: number, line: string): Promise<void>;
  vlLiveRead(id: number, name: string, max: number): Promise<{ size: number; data?: Uint8Array } | null>;
  onVlLiveData(cb: (id: number, text: string) => void): void;
  pickFolder(): Promise<string | null>;
  readFolder(dir: string): Promise<{ path: string; src: string }[]>;
  forgetFolder(): Promise<void>;
}

// The parts of the File System Access API's directory handle the page uses.
interface DirHandle {
  name: string; kind: 'directory';
  entries(): AsyncIterable<[string, DirHandle | { kind: 'file'; getFile(): Promise<File> }]>;
  queryPermission(opts: { mode: 'read' }): Promise<string>;
  requestPermission(opts: { mode: 'read' }): Promise<string>;
}

// What Compiler Explorer's compile API returns, as far as the page reads it.
interface GodboltAsmLine { text: string; source?: { line?: number; column?: number } | null }
interface GodboltResponse {
  code?: number; asm?: GodboltAsmLine[];
  stderr?: { text: string }[]; buildResult?: { stderr?: { text: string }[] };
}

interface Window {
  CM6?: CM6Bundle;
  rvNative?: RvNative;
  __CM6_DISABLE_CDN?: boolean;
  // A test's stand-in for Compiler Explorer: a response, or a function of the source.
  __mockGodboltResponse?: GodboltResponse | ((source: string) => GodboltResponse);
  // The File System Access API, in Chromium.
  showDirectoryPicker?: (opts?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<DirHandle>;
  cmEditor?: import('@codemirror/view').EditorView;
  languageCompartment?: import('@codemirror/state').Compartment;
}
