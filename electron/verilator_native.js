'use strict';
// Verilator for the desktop app. A build turns the page's sources into a
// native model with verilator_bin and a C++20 compiler, and is cached on
// disk by content, so the same sources build once. A run is then like a vvp
// run: a temporary directory, plusargs, output and kept files back.
//
// The compiler is the user's own when one works (CXX, g++, clang++; on
// macOS only once the Xcode command line tools are installed, since probing
// clang++ without them opens the installer). Otherwise a pinned Zig release
// is downloaded once into the cache, checked against its SHA-256, and
// "zig c++" is used. Each step is reported through progress() so the page
// can say what a long first build is doing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { spawn, execFile } = require('child_process');
const { runProcess, EXE } = require('./hdl_native');

const TOP = 'cg3207_hdl_tb';
// Measured on the RV/ RTL against Verilator's own default, -Os: the
// simulation runs about 1.85 times as fast without the trace, 1.37 with
// it, for about 0.9 s more per build.
const OPT = process.env.RVSIM_VL_OPT || '-O3';
const KEEP_MODELS = 8;

// Compiled into every model; see its header. The testbench only calls it
// with +LIVE.
const LIVE_CPP = "// Live runs. With +LIVE the testbench calls cg3207_live_poll() at every\n// rising edge. Commands from the app arrive on stdin, one per line:\n//   in <code> <value>   an input change (1 DIP, 2 PB, 3 ACCEL_Data,\n//                       4 ACCEL_DReady, 5 UART byte | gap << 8), or 8 to\n//                       stop the waveform\n//   hz <frequency>      pace the simulation to this clock; 0 for flat out\n//   vcd <0|1>           flush the waveform to disk every 250 ms\n//   stop                end the run at the next cycle\n// +HZ=<frequency> and +LIVEVCD set the first two from the start.\n// Code 6 asks the testbench to stop, 7 to flush the waveform. Before cycle\n// \"from\" the run is replaying what was recorded already, so nothing is\n// paced or applied until then.\n#include \"Vcg3207_hdl_tb__Dpi.h\"\n#include \"Vcg3207_hdl_tb__Syms.h\"\n#include \"verilated.h\"\n#include <algorithm>\n#include <chrono>\n#include <cstdlib>\n#include <cstdio>\n#include <deque>\n#include <mutex>\n#include <sstream>\n#include <string>\n#include <thread>\n#include <utility>\n#ifdef _WIN32\n#include <io.h>\n#define cg3207_read _read\n#else\n#include <unistd.h>\n#define cg3207_read read\n#endif\n\nnamespace {\nusing Clock = std::chrono::steady_clock;\nstd::mutex mu;\nstd::deque<std::pair<int, int>> pending;\ndouble hz = 0;\nbool hzChanged = true;\nbool stopRequested = false;\nbool liveVcd = false;\nbool started = false;\nClock::time_point t0, lastFlush, lastVcdFlush;\nlong long c0 = 0;\n\n// Reads with read(2) rather than std::cin: a thread blocked inside stdio\n// holds stdin's lock, and exit() flushing every stream would wait on it\n// for ever once the testbench calls $finish.\nbool nextLine(std::string& line) {\n  static std::string buf;\n  for (;;) {\n    const std::string::size_type nl = buf.find('\\n');\n    if (nl != std::string::npos) {\n      line = buf.substr(0, nl);\n      buf.erase(0, nl + 1);\n      return true;\n    }\n    char chunk[256];\n    const int n = static_cast<int>(cg3207_read(0, chunk, sizeof chunk));\n    if (n <= 0) return false;\n    buf.append(chunk, n);\n  }\n}\n\nvoid reader() {\n  std::string line;\n  while (nextLine(line)) {\n    std::istringstream in(line);\n    std::string cmd;\n    in >> cmd;\n    std::lock_guard<std::mutex> g(mu);\n    if (cmd == \"in\") {\n      int code = 0;\n      long long v = 0;\n      in >> code >> v;\n      pending.emplace_back(code, static_cast<int>(static_cast<unsigned long long>(v) & 0xffffffffULL));\n    } else if (cmd == \"hz\") {\n      in >> hz;\n      hzChanged = true;\n    } else if (cmd == \"vcd\") {\n      int on = 0;\n      in >> on;\n      liveVcd = on != 0;\n    } else if (cmd == \"stop\") {\n      stopRequested = true;\n    }\n  }\n  std::lock_guard<std::mutex> g(mu);\n  stopRequested = true;  // the app has gone\n}\n}  // namespace\n\nint cg3207_live_poll(int cycle, int from, int* code, int* value) {\n  if (!started) {\n    started = true;\n    const std::string h = Verilated::commandArgsPlusMatch(\"HZ=\");\n    if (h.size() > 4) hz = std::atof(h.c_str() + 4);\n    liveVcd = !std::string(Verilated::commandArgsPlusMatch(\"LIVEVCD\")).empty();\n    std::thread(reader).detach();\n  }\n  if (cycle < from) return 0;\n  std::unique_lock<std::mutex> g(mu);\n  const Clock::time_point now0 = Clock::now();\n  if (hzChanged) {\n    hzChanged = false;\n    t0 = lastFlush = lastVcdFlush = now0;\n    c0 = cycle;\n  }\n  if (stopRequested) {\n    stopRequested = false;\n    *code = 6;\n    *value = 0;\n    return 1;\n  }\n  if (!pending.empty()) {\n    *code = pending.front().first;\n    *value = pending.front().second;\n    pending.pop_front();\n    return 1;\n  }\n  const double h = hz;\n  const bool lv = liveVcd;\n  g.unlock();\n  Clock::time_point now = now0;\n  if (h > 0) {\n    const Clock::time_point target = t0 + std::chrono::duration_cast<Clock::duration>(\n      std::chrono::duration<double>(static_cast<double>(cycle - c0) / h));\n    while (now < target) {\n      std::fflush(stdout);\n      const auto wait = std::min<Clock::duration>(target - now, std::chrono::milliseconds(10));\n      std::this_thread::sleep_for(wait);\n      now = Clock::now();\n      std::lock_guard<std::mutex> g2(mu);\n      if (stopRequested || !pending.empty() || hzChanged) return 0;  // taken on the next edge\n    }\n  }\n  // @@C says how far the run has got, which with no architectural trace\n  // and no peripheral activity nothing else would.\n  if (now - lastFlush > std::chrono::milliseconds(30)) {\n    lastFlush = now;\n    std::printf(\"@@C %d\\n\", cycle);\n    std::fflush(stdout);\n  }\n  if (lv && now - lastVcdFlush > std::chrono::milliseconds(250)) {\n    lastVcdFlush = now;\n    *code = 7;\n    *value = 0;\n    return 1;\n  }\n  return 0;\n}\n\n// $dumpflush and $dumpoff compile to nothing in Verilator, so the testbench\n// asks for them here: the dumper $dumpfile opened is flushed (1), or closed\n// as $finish would close it (0). Both are members of the model's generated\n// symbol table, which is one reason the app carries its own Verilator.\nvoid cg3207_vcd(int op) {\n  const VerilatedScope* s = static_cast<const VerilatedScope*>(svGetScope());\n  if (!s) return;\n  Vcg3207_hdl_tb__Syms* syms = static_cast<Vcg3207_hdl_tb__Syms*>(s->symsp());\n  if (op == 0) {\n    if (syms->__Vm_dumping) syms->_traceDumpClose();\n    return;\n  }\n  const VerilatedLockGuard lock{syms->__Vm_dumperMutex};\n  if (syms->__Vm_dumperp) syms->__Vm_dumperp->flush();\n}\n";

const ZIG_VERSION = '0.17.1';
const ZIG = {
  'linux-x64':  { file: 'zig-x86_64-linux-0.17.1.tar.xz',   sha: '3581863e3cbcfd0fce0efc682ce7e9e93da96668a977791d356a26d2a7e9b17a' },
  'win32-x64':  { file: 'zig-x86_64-windows-0.17.1.zip',    sha: 'b03f477a1943673e02aca0f570e8030dffd536ce1f45cbc4d3326ec31159562e' },
  'darwin-arm64': { file: 'zig-aarch64-macos-0.17.1.tar.xz', sha: '75f1bc7a1e9852f17ec9a0c1895f767c4ec56d46bc8a834920eece1d0359dd8d' },
  'darwin-x64': { file: 'zig-x86_64-macos-0.17.1.tar.xz',   sha: '9af07b20319fbd0c92ee46ad23e81d6a782b1aaea2cfb8dcbff35f1d2c7ddbb7' }
}[process.platform + '-' + process.arch];
// RVSIM_ZIG_URL replaces the base URL, for testing without the network.
const ZIG_BASE = process.env.RVSIM_ZIG_URL || 'https://ziglang.org/download/' + ZIG_VERSION + '/';

// Downloads url to dest, reporting progress, following redirects, and
// checking the SHA-256. signal aborts it.
function download(url, dest, sha, progress, signal, hops) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https:') ? https.get : http.get;
    const req = get(url, { signal, headers: { 'User-Agent': 'rvedusim' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (hops || 0) < 5) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).href, dest, sha, progress, signal, (hops || 0) + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); return; }
      const total = +res.headers['content-length'] || 0;
      const h = crypto.createHash('sha256');
      const out = fs.createWriteStream(dest);
      let got = 0, last = 0;
      res.on('data', d => {
        h.update(d);
        got += d.length;
        if (got - last > (1 << 20) || got === total) { last = got; progress({ phase: 'compiler-download', received: got, total }); }
      });
      res.on('error', reject);
      res.pipe(out);
      out.on('finish', () => {
        if (h.digest('hex') !== sha) { fs.rmSync(dest, { force: true }); reject(new Error('The download did not match its checksum.')); }
        else resolve();
      });
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

function sh(cmd, args, opts) {
  return new Promise(resolve => {
    execFile(cmd, args, Object.assign({ maxBuffer: 64 << 20, windowsHide: true }, opts), (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout) + String(stderr) }));
  });
}

function hash(parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' ? p : Buffer.from(p)).update('\0');
  return h.digest('hex').slice(0, 24);
}

// Runs fn over items, at most n at a time; stops at the first failure.
async function pool(items, n, fn) {
  let i = 0, failed = null;
  const worker = async () => {
    while (!failed && i < items.length) {
      const item = items[i++];
      const r = await fn(item);
      if (r) failed = r;
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return failed;
}

function createVerilator({ root, cacheDir }) {
  const bin = path.join(root, 'bin', 'verilator_bin' + EXE);
  const inc = path.join(root, 'include');
  const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  const jobs = new Map();
  const building = new Map();       // id -> child processes of a build, for kill
  const aborts = new Map();         // id -> AbortController of a download
  let compiler = null;              // promise of { cmd, args, id, env } or { error }

  fs.mkdirSync(cacheDir, { recursive: true });

  // ---- the compiler ------------------------------------------------------
  const PROBE = '#include <coroutine>\nstruct T { struct promise_type { T get_return_object() { return {}; }' +
    ' std::suspend_never initial_suspend() { return {}; } std::suspend_never final_suspend() noexcept { return {}; }' +
    ' void return_void() {} void unhandled_exception() {} }; };\nT f() { co_return; }\nint main() { f(); return 0; }\n';

  async function works(cmd, pre, env) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rvsim-cxx-'));
    try {
      fs.writeFileSync(path.join(dir, 'p.cpp'), PROBE);
      for (const extra of [[], ['-fcoroutines']]) {
        const r = await sh(cmd, pre.concat(['-std=c++20'], extra, ['p.cpp', '-o', 'p' + EXE]), { cwd: dir, env });
        if (r.code === 0) {
          const v = await sh(cmd, pre.concat(['--version']), { env });
          return { flags: extra, id: v.out.split('\n')[0].trim() };
        }
      }
      return null;
    } finally {
      fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function systemCompilers() {
    const list = [];
    if (process.env.RVSIM_FORCE_ZIG) return list;
    if (process.env.CXX) list.push(process.env.CXX);
    if (process.platform === 'darwin') {
      if ((await sh('xcode-select', ['-p'])).code === 0) list.push('clang++');
    } else {
      list.push('g++', 'clang++');
    }
    return list;
  }

  async function fetchZig(progress, signal) {
    if (!ZIG) return null;
    const name = ZIG.file.replace(/\.(tar\.xz|zip)$/, '');
    const dest = path.join(cacheDir, name);
    const zig = path.join(dest, 'zig' + EXE);
    if (fs.existsSync(zig)) return zig;
    const archive = path.join(cacheDir, ZIG.file);
    progress({ phase: 'compiler-download', received: 0, total: 0, file: ZIG.file });
    await download(ZIG_BASE + ZIG.file, archive + '.part', ZIG.sha, progress, signal);
    fs.renameSync(archive + '.part', archive);
    progress({ phase: 'compiler-unpack' });
    const tmp = dest + '.part';
    await fs.promises.rm(tmp, { recursive: true, force: true });
    await fs.promises.mkdir(tmp, { recursive: true });
    const r = await sh('tar', ['-xf', archive, '-C', tmp]);
    if (r.code !== 0) throw new Error('Could not unpack ' + ZIG.file + ': ' + r.out);
    await fs.promises.rm(dest, { recursive: true, force: true });
    await fs.promises.rename(path.join(tmp, name), dest);
    await fs.promises.rm(tmp, { recursive: true, force: true });
    await fs.promises.rm(archive, { force: true });
    return zig;
  }

  // The first build that needs a compiler finds one; a failure is not
  // remembered, so going online and building again can fetch Zig.
  function findCompiler(progress, signal) {
    progress = progress || (() => {});
    if (compiler) return compiler;
    compiler = (async () => {
      for (const cmd of await systemCompilers()) {
        const ok = await works(cmd, []);
        if (ok) return { cmd, pre: [], flags: ok.flags, id: ok.id, env: process.env, name: cmd };
      }
      let zig;
      try {
        zig = await fetchZig(progress, signal);
      } catch (e) {
        return { error: 'Verilator needs a C++ compiler. None was found on this computer, and the one the ' +
          'simulator uses instead (Zig ' + ZIG_VERSION + ') could not be downloaded: ' + e.message +
          '. Connect to the internet and build again, or install one: g++ on Linux, the Xcode command ' +
          'line tools on macOS (xcode-select --install).', retry: true };
      }
      if (zig) {
        // Zig keeps its own cache of compiled C and C++ libraries; it lives
        // with ours rather than in the user's home directory. Its first
        // compile builds the C++ library, which takes a while, once.
        progress({ phase: 'compiler-check' });
        const env = Object.assign({}, process.env, { ZIG_GLOBAL_CACHE_DIR: path.join(cacheDir, 'zig-cache') });
        const ok = await works(zig, ['c++'], env);
        if (ok) return { cmd: zig, pre: ['c++'], flags: ok.flags, id: 'zig ' + ok.id, env, name: 'Zig ' + ZIG_VERSION };
      }
      return { error: 'No C++20 compiler was found, and Zig ' + ZIG_VERSION + ' did not work on this computer.' };
    })();
    compiler.then(c => { if (c.retry) compiler = null; });
    return compiler;
  }

  // ---- building ----------------------------------------------------------
  // The variables of the makefiles Verilator writes, which say which runtime
  // files the model needs and the -D flags it is compiled with.
  function readMk(objDir) {
    // Verilator writes them with CRLF line ends on Windows.
    const mk = ['V' + TOP + '.mk', 'V' + TOP + '_classes.mk']
      .map(n => { try { return fs.readFileSync(path.join(objDir, n), 'utf8'); } catch (e) { return ''; } }).join('\n')
      .replace(/\r\n/g, '\n');
    const vars = {};
    for (const m of mk.matchAll(/^([A-Z_]+)\s*[+:]?=\s*((?:.*\\\n)*.*)$/gm)) {
      vars[m[1]] = ((vars[m[1]] || '') + ' ' + m[2].replace(/\\\n/g, ' ')).trim();
    }
    return vars;
  }

  function cxxFlags(cc, vars) {
    const defs = ['-DVERILATOR=1'].concat(Object.keys(vars).filter(k => /^VM_/.test(k) && /^\d+$/.test(vars[k]))
      .map(k => '-D' + k + '=' + vars[k]));
    if (vars.VM_PREFIX_INCLUDE) defs.push('-DVM_PREFIX_INCLUDE=' + vars.VM_PREFIX_INCLUDE);
    return ['-std=c++20'].concat(cc.flags, [OPT, '-I.', '-I' + inc, '-I' + path.join(inc, 'vltstd'),
      '-faligned-new', '-fcf-protection=none', '-w'], defs);
  }

  function track(id, child) {
    if (!building.has(id)) building.set(id, new Set());
    building.get(id).add(child);
    child.on('close', () => { const s = building.get(id); if (s) s.delete(child); });
  }

  function exec(id, cmd, args, cwd, env) {
    return new Promise(resolve => {
      let out = '';
      const child = spawn(cmd, args, { cwd, env, windowsHide: true });
      track(id, child);
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      child.on('error', e => resolve({ code: 1, out: String(e.message) }));
      child.on('close', (c, sig) => resolve({ code: sig ? sig : c, out }));
    });
  }

  // Verilator's own runtime, compiled once per compiler and Verilator.
  async function runtimeObjects(id, cc, vars, objDir, progress) {
    const names = ((vars.VM_GLOBAL_FAST || '') + ' ' + (vars.VM_GLOBAL_SLOW || '')).split(/\s+/).filter(Boolean);
    const flags = cxxFlags(cc, vars);
    const dir = path.join(cacheDir, 'runtime-' + hash([version, cc.id, flags.join(' ')]));
    fs.mkdirSync(dir, { recursive: true });
    const objs = names.map(n => path.join(dir, n + '.o'));
    const todo = names.filter((n, i) => !fs.existsSync(objs[i]));
    let done = 0;
    if (todo.length) progress({ phase: 'runtime', done, total: todo.length });
    const fail = await pool(todo, os.cpus().length, async n => {
      const tmp = path.join(dir, n + '.o.part');
      const r = await exec(id, cc.cmd, cc.pre.concat(flags, ['-c', path.join(inc, n + '.cpp'), '-o', tmp]), objDir, cc.env);
      if (r.code !== 0) return n + '.cpp: ' + r.out;
      fs.renameSync(tmp, path.join(dir, n + '.o'));
      progress({ phase: 'runtime', done: ++done, total: todo.length });
      return null;
    });
    if (fail) throw new Error('Compiling the Verilator runtime failed: ' + fail);
    return objs;
  }

  function pruneModels() {
    const dir = path.join(cacheDir, 'models');
    let entries = [];
    try { entries = fs.readdirSync(dir).map(n => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })); } catch (e) { return; }
    entries.sort((a, b) => b.t - a.t);
    for (const e of entries.slice(KEEP_MODELS)) fs.rmSync(path.join(dir, e.n), { recursive: true, force: true });
  }

  // files: { name: source }, each compiled. opts.headers: { name: source },
  // only there to be included. opts.language: a --default-language value.
  async function build(id, files, opts, progress) {
    opts = opts || {};
    progress = progress || (() => {});
    const abort = new AbortController();
    aborts.set(id, abort);
    let cc;
    try { cc = await findCompiler(progress, abort.signal); } finally { aborts.delete(id); }
    if (abort.signal.aborted) return { cancelled: true };
    if (cc.error) return { ok: false, log: cc.error, compiler: null };
    const names = Object.keys(files).sort();
    const vargs = ['--cc', '--exe', '--main', '--timing', '--trace', '--top-module', TOP,
      '--default-language', opts.language || '1364-2005', '-Wno-fatal', '-Wno-lint', '-Wno-style',
      '-Wno-TIMESCALEMOD', '-Wno-MULTITOP', '--x-assign', 'fast', '--x-initial', 'fast',
      '-O3', '--Mdir', 'obj'];
    // Verilator ignores $dumpvars's depth, and inlining makes --trace-depth
    // count everything under the Wrapper as one level, so what a model can
    // dump is limited by scope, when it is built.
    const extra = {};
    // A scope pattern matches a scope's own signals too, so dut.*.* leaves
    // the Wrapper's signals in and takes out everything instantiated in it.
    if (opts.waveTop) extra['wave_top.vlt'] = '`verilator_config\ntracing_off -scope "' + TOP + '.dut.*.*"\n';
    const headers = opts.headers || {};
    const hnames = Object.keys(headers).sort();
    const key = hash([version, cc.id, vargs.join(' ')].concat(names.map(n => n + '\n' + files[n]),
      hnames.map(n => 'h ' + n + '\n' + headers[n]), Object.keys(extra).map(n => n + extra[n]), [LIVE_CPP]));
    const modelDir = path.join(cacheDir, 'models', key);
    const model = path.join(modelDir, 'V' + TOP + EXE);
    if (fs.existsSync(model)) {
      const now = new Date();
      fs.utimesSync(modelDir, now, now);
      return { ok: true, key, cached: true, log: fs.readFileSync(path.join(modelDir, 'verilator.log'), 'utf8'), compiler: cc.name };
    }
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rvsim-vl-'));
    try {
      for (const [n, src] of names.map(n => [n, files[n]]).concat(hnames.map(n => [n, headers[n]]))) {
        if (n !== path.basename(n)) throw new Error('bad file name ' + n);
        fs.writeFileSync(path.join(dir, n), src);
      }
      const t0 = Date.now();
      for (const n in extra) fs.writeFileSync(path.join(dir, n), extra[n]);
      const v = await exec(id, bin, vargs.concat(Object.keys(extra), names), dir, Object.assign({}, process.env, { VERILATOR_ROOT: root }));
      if (v.code === 'SIGKILL') return { cancelled: true };
      if (v.code !== 0) return { ok: false, log: v.out, compiler: cc.name };
      const t1 = Date.now();
      const objDir = path.join(dir, 'obj');
      fs.writeFileSync(path.join(objDir, 'cg3207_live.cpp'), LIVE_CPP);
      const vars = readMk(objDir);
      const rt = await runtimeObjects(id, cc, vars, objDir, progress);
      const flags = cxxFlags(cc, vars);
      const srcs = fs.readdirSync(objDir).filter(n => n.endsWith('.cpp'));
      let done = 0;
      progress({ phase: 'cxx', done, total: srcs.length });
      const fail = await pool(srcs, os.cpus().length, async n => {
        const r = await exec(id, cc.cmd, cc.pre.concat(flags, ['-c', n, '-o', n.replace(/\.cpp$/, '.o')]), objDir, cc.env);
        if (r.code === 0) progress({ phase: 'cxx', done: ++done, total: srcs.length });
        return r.code === 0 ? null : (r.code === 'SIGKILL' ? 'cancelled' : n + ': ' + r.out);
      });
      if (fail === 'cancelled') return { cancelled: true };
      if (fail) return { ok: false, log: v.out + '\nC++ compilation failed: ' + fail, compiler: cc.name };
      // macOS: Verilator's weak symbols are left for the loader, as its own
      // makefile does.
      progress({ phase: 'link' });
      const libs = process.platform === 'win32' ? []
        : process.platform === 'darwin' ? ['-pthread', '-Wl,-U,__Z15vl_time_stamp64v,-U,__Z13sc_time_stampv,-U,_vlog_startup_routines']
        : ['-pthread'];
      const l = await exec(id, cc.cmd, cc.pre.concat(srcs.map(n => n.replace(/\.cpp$/, '.o')), rt,
        ['-o', 'V' + TOP + EXE], libs), objDir, cc.env);
      if (l.code === 'SIGKILL') return { cancelled: true };
      if (l.code !== 0) return { ok: false, log: v.out + '\nLinking failed: ' + l.out, compiler: cc.name };
      fs.mkdirSync(modelDir, { recursive: true });
      fs.copyFileSync(path.join(objDir, 'V' + TOP + EXE), model);
      fs.chmodSync(model, 0o755);
      fs.writeFileSync(path.join(modelDir, 'verilator.log'), v.out);
      pruneModels();
      return { ok: true, key, cached: false, log: v.out, compiler: cc.name, ms: { verilate: t1 - t0, cxx: Date.now() - t1 } };
    } finally {
      building.delete(id);
      fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function run(id, key, files, args, opts) {
    if (!/^[0-9a-f]+$/.test(key)) throw new Error('bad model key');
    const model = path.join(cacheDir, 'models', key, 'V' + TOP + EXE);
    if (!fs.existsSync(model)) throw new Error('The Verilator model is no longer cached; run again from Reset.');
    return runProcess(jobs, id, model, args, files, opts);
  }

  // A live run: the model keeps stdin open for commands (see LIVE_CPP) and
  // its output is handed to onData as it comes. The files it writes stay
  // readable through liveRead() until it ends.
  const live = new Map();
  const early = new Map();          // id -> commands sent before the process started
  async function runLive(id, key, files, args, opts, onData) {
    opts = opts || {};
    if (!/^[0-9a-f]+$/.test(key)) throw new Error('bad model key');
    const model = path.join(cacheDir, 'models', key, 'V' + TOP + EXE);
    if (!fs.existsSync(model)) throw new Error('The Verilator model is no longer cached; run again from Reset.');
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rvsim-live-'));
    try {
      for (const name in files) {
        if (name !== path.basename(name)) throw new Error('bad file name ' + name);
        const data = files[name];
        await fs.promises.writeFile(path.join(dir, name), typeof data === 'string' ? data : Buffer.from(data));
      }
      const child = spawn(model, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      jobs.set(id, child);
      live.set(id, { child, dir });
      for (const line of early.get(id) || []) child.stdin.write(line + '\n');
      early.delete(id);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.stdin.on('error', () => {});
      const code = await new Promise(resolve => {
        child.on('error', e => resolve('error: ' + e.message));
        child.on('close', (c, sig) => resolve(sig ? sig : c));
      });
      if (code === 'SIGKILL' || code === 'SIGTERM') return { cancelled: true };
      const got = {};
      if (opts.keep) {
        const re = new RegExp(opts.keep);
        for (const name of await fs.promises.readdir(dir)) {
          if (re.test(name)) got[name] = new Uint8Array(await fs.promises.readFile(path.join(dir, name)));
        }
      }
      return { code, files: got };
    } finally {
      jobs.delete(id);
      live.delete(id);
      early.delete(id);
      fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  function liveSend(id, line) {
    const l = live.get(id);
    const text = String(line).replace(/[\r\n]/g, ' ');
    if (!l) { if (!early.has(id)) early.set(id, []); early.get(id).push(text); return; }
    if (l.child.stdin.writable) l.child.stdin.write(text + '\n');
  }

  // { size, data }, data left out when the file is larger than max.
  function liveRead(id, name, max) {
    const l = live.get(id);
    if (!l || name !== path.basename(name)) return null;
    try {
      const p = path.join(l.dir, name);
      const size = fs.statSync(p).size;
      if (max && size > max) return { size };
      return { size, data: new Uint8Array(fs.readFileSync(p)) };
    } catch (e) { return null; }
  }

  function kill(id) {
    const child = jobs.get(id);
    if (child) child.kill('SIGKILL');
    if (aborts.has(id)) aborts.get(id).abort();
    for (const c of building.get(id) || []) c.kill('SIGKILL');
  }

  function killAll() {
    for (const id of jobs.keys()) kill(id);
    for (const id of building.keys()) kill(id);
    for (const id of aborts.keys()) kill(id);
  }

  return { build, run, runLive, liveSend, liveRead, kill, killAll, findCompiler, version };
}

function findVerilator(candidates) {
  for (const d of candidates) {
    if (d && fs.existsSync(path.join(d, 'bin', 'verilator_bin' + EXE)) && fs.existsSync(path.join(d, 'include', 'verilated.cpp'))) return d;
  }
  return null;
}

module.exports = { createVerilator, findVerilator };
