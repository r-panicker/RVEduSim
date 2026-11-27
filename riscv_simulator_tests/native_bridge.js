/*
 * The desktop app's engine (desktop/native, Rust) for the test suites, with
 * the interface they used to load from the app's Node modules: createRunner
 * for Icarus, createVerilator, readFolder and the find* helpers. Each runner
 * talks to its own rvnative-bridge process over JSON lines (see
 * desktop/native/src/bin/bridge.rs), so the suites drive the code the app runs.
 *
 * The bridge is built with cargo when this module loads (a no-op once it is
 * up to date); RVSIM_BRIDGE names a prebuilt one instead.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.platform === 'win32' ? '.exe' : '';
const OS = { darwin: 'mac', win32: 'win' }[process.platform] || process.platform;
const TARGET = OS + '-' + process.arch;

function bridgePath() {
  if (process.env.RVSIM_BRIDGE) return process.env.RVSIM_BRIDGE;
  const bin = path.join(ROOT, 'desktop', 'target', 'release', 'rvnative-bridge' + EXE);
  const r = spawnSync('cargo', ['build', '--release', '--quiet', '-p', 'rvnative'], { cwd: path.join(ROOT, 'desktop'), stdio: 'inherit' });
  if (r.error && !fs.existsSync(bin)) throw new Error('rvnative-bridge is not built and cargo is not available: ' + r.error.message);
  if (r.status && !fs.existsSync(bin)) throw new Error('building rvnative-bridge failed');
  return bin;
}
let BIN = null;

const toWire = files => {
  const o = {};
  for (const k in files) o[k] = typeof files[k] === 'string' ? files[k] : { b64: Buffer.from(files[k]).toString('base64') };
  return o;
};
// A kept file comes as the path of a copy, which is read and removed.
const bytes = v => {
  const b = fs.readFileSync(v.path);
  fs.rmSync(v.path, { force: true });
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
};
const fromRun = r => {
  if (!r || r.cancelled) return r;
  const files = {};
  for (const k in r.files || {}) files[k] = bytes(r.files[k]);
  return Object.assign({}, r, { files });
};

// One bridge process: call(cmd, args) resolves its reply; on(job, kind, fn)
// receives its events for one job until off().
function connect(argv) {
  BIN = BIN || bridgePath();
  const child = spawn(BIN, argv, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const pending = new Map(), listeners = new Map();
  let seq = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let m;
    try { m = JSON.parse(line); } catch (e) { return; }
    if (m.event) {
      const fn = listeners.get(m.event + ':' + m.job);
      if (fn) fn(m.data);
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if ('error' in m) p.reject(new Error(m.error)); else p.resolve(m.result);
  });
  child.on('exit', () => { for (const p of pending.values()) p.reject(new Error('rvnative-bridge exited')); pending.clear(); });
  child.unref();
  child.stdin.on('error', () => {});
  const call = (cmd, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
  });
  return {
    call,
    on: (job, kind, fn) => listeners.set(kind + ':' + job, fn),
    off: (job, kind) => listeners.delete(kind + ':' + job),
    close: () => { try { child.stdin.end(); } catch (e) {} },
  };
}

function findBinDir(candidates) {
  for (const d of candidates) if (d && fs.existsSync(path.join(d, 'vvp' + EXE)) && fs.existsSync(path.join(d, 'ivl' + EXE))) return d;
  return null;
}

function findVerilator(candidates) {
  for (const d of candidates) {
    if (d && fs.existsSync(path.join(d, 'bin', 'verilator_bin' + EXE)) && fs.existsSync(path.join(d, 'include', 'verilated.cpp'))) return d;
  }
  return null;
}

// Where a local build of each toolchain is.
const icarusDirs = () => [process.env.HDL_NATIVE_DIR, path.join(ROOT, 'desktop', 'iverilog', TARGET)];
const verilatorDirs = () => [process.env.HDL_VERILATOR_DIR, path.join(ROOT, 'desktop', 'verilator', TARGET)];

function createRunner(binDir) {
  const b = connect(['--icarus', binDir]);
  return {
    run: async (id, tool, files, args, opts) => fromRun(await b.call('hdlRun', { id, tool, files: toWire(files), args, opts: opts || {} })),
    kill: id => { b.call('hdlKill', { id }).catch(() => {}); },
    killAll: () => b.close(),
  };
}

function createVerilator({ root, cacheDir }) {
  const b = connect(['--verilator', root, '--cache', cacheDir]);
  return {
    async build(id, files, opts, progress) {
      if (progress) b.on(id, 'progress', progress);
      try { return await b.call('vlBuild', { id, files, opts: opts || {} }); } finally { b.off(id, 'progress'); }
    },
    run: async (id, key, files, args, opts) => fromRun(await b.call('vlRun', { id, key, files: toWire(files), args, opts: opts || {} })),
    async runLive(id, key, files, args, opts, onData) {
      b.on(id, 'live', onData);
      try { return fromRun(await b.call('vlLive', { id, key, files: toWire(files), args, opts: opts || {} })); } finally { b.off(id, 'live'); }
    },
    liveSend: (id, line) => b.call('vlLiveSend', { id, line: String(line) }),
    async liveRead(id, name, max) {
      const r = await b.call('vlLiveRead', { id, name, max: max || 0 });
      return r && r.data ? { size: r.size, data: bytes(r.data) } : r;
    },
    kill: id => { b.call('hdlKill', { id }).catch(() => {}); },
    killAll: () => b.close(),
    info: () => b.call('info', {}),
  };
}

let folderBridge = null;
function readFolder(dir, kind) {
  folderBridge = folderBridge || connect([]);
  return folderBridge.call('readFolder', { dir, kind: kind || 'hdl' });
}

module.exports = { createRunner, createVerilator, readFolder, findBinDir, findVerilator, icarusDirs, verilatorDirs };
