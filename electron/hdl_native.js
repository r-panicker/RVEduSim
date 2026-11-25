'use strict';
// Runs one Icarus stage natively, the way the page runs it under WASM. The
// page writes its files into the root of an Emscripten file system and names
// them '/name'; here they go into a fresh temporary directory that is the
// tool's working directory, and '/name' becomes 'name'.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const EXE = process.platform === 'win32' ? '.exe' : '';

function createRunner(binDir) {
  const jobs = new Map();

  function localArg(a) {
    const m = /^(-[A-Za-z])?\/([^/]+)$/.exec(a);
    return m ? (m[1] || '') + m[2] : a;
  }

  // ivl.conf names the directory its code generator (vvp.tgt) and the VPI
  // modules live in, and where to write the .vvp. The module paths end up
  // quoted in the .vvp, so they use forward slashes, which Windows accepts,
  // rather than backslashes vvp would read as escapes.
  function localConf(text) {
    return text.split('\n').map(l => {
      if (/^basedir:/.test(l)) return 'basedir:' + binDir;
      const mod = /^module:([^/\\]+)$/.exec(l);
      if (mod) return 'module:' + path.join(binDir, mod[1]).replace(/\\/g, '/');
      const m = /^out:\/([^/]+)$/.exec(l);
      return m ? 'out:' + m[1] : l;
    }).join('\n');
  }

  async function run(id, tool, files, args, opts) {
    if (!['ivlpp', 'ivl', 'vvp'].includes(tool)) throw new Error('unknown tool ' + tool);
    const local = {};
    for (const name in files) local[name] = tool === 'ivl' && name === 'ivl.conf' ? localConf(String(files[name])) : files[name];
    let argv = args.map(localArg);
    if (tool === 'vvp') argv = ['-M', binDir].concat(argv);
    return runProcess(jobs, id, path.join(binDir, tool + EXE), argv, local, opts);
  }

  function kill(id) {
    const child = jobs.get(id);
    if (child) child.kill('SIGKILL');
  }

  function killAll() { for (const id of jobs.keys()) kill(id); }

  return { run, kill, killAll };
}

// Every Verilog source under dir, as { path, src } with '/'-separated
// paths relative to it. The page decides which of them to load.
// The page leaves out Vivado's output folders by path; these are not worth walking.
const SKIP_DIR = /^\.|^node_modules$/;
const HDL_FILE = /\.(v|sv|vh|svh)$/i;
const MAX_FILES = 500;

async function readFolder(dir) {
  const out = [];
  async function walk(d, rel) {
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch (e) { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) await walk(path.join(d, e.name), r); }
      else if (e.isFile() && HDL_FILE.test(e.name)) {
        out.push({ path: r, src: await fs.promises.readFile(path.join(d, e.name), 'utf8') });
      }
    }
  }
  await walk(dir, '');
  return out;
}

// Runs exe with argv in a fresh temporary directory holding files, and
// returns its output lines and the files matching opts.keep. The process is
// registered in jobs under id so that it can be killed.
async function runProcess(jobs, id, exe, argv, files, opts) {
  opts = opts || {};
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rvsim-'));
  try {
    for (const name in files) {
      if (name !== path.basename(name)) throw new Error('bad file name ' + name);
      const data = files[name];
      await fs.promises.writeFile(path.join(dir, name), typeof data === 'string' ? data : Buffer.from(data));
    }
    // stdout and stderr share one file so that, merged, their lines stay
    // in the order the tool wrote them.
    const outPath = path.join(dir, '.stdout'), errPath = path.join(dir, '.stderr');
    const outFd = fs.openSync(outPath, 'w');
    const errFd = opts.merge ? outFd : fs.openSync(errPath, 'w');
    const code = await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(exe, argv, { cwd: dir, stdio: ['ignore', outFd, errFd], windowsHide: true, env: opts.env });
      } catch (e) { reject(e); return; }
      jobs.set(id, child);
      child.on('error', reject);
      child.on('close', (c, sig) => resolve(sig ? sig : c));
    }).finally(() => {
      jobs.delete(id);
      fs.closeSync(outFd);
      if (errFd !== outFd) fs.closeSync(errFd);
    });
    // A rejection would lose its fields crossing IPC, so a cancelled run
    // says so in its result.
    if (code === 'SIGKILL' || code === 'SIGTERM') return { cancelled: true };
    const lines = p => {
      const t = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
      const a = t.split(/\r?\n/);
      if (a.length && a[a.length - 1] === '') a.pop();
      return a;
    };
    const out = lines(outPath), err = opts.merge ? [] : lines(errPath);
    const got = {};
    if (opts.keep) {
      const re = new RegExp(opts.keep);
      for (const name of await fs.promises.readdir(dir)) {
        if (re.test(name)) got[name] = new Uint8Array(await fs.promises.readFile(path.join(dir, name)));
      }
    }
    return { out, err, files: got, code };
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// The directory holding this platform's build, or null when there is none.
function findBinDir(candidates) {
  for (const d of candidates) {
    if (d && fs.existsSync(path.join(d, 'vvp' + EXE)) && fs.existsSync(path.join(d, 'ivl' + EXE))) return d;
  }
  return null;
}

module.exports = { createRunner, findBinDir, readFolder, runProcess, EXE };
