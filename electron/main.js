'use strict';
// The desktop app: riscv_simulator.html in a window, served from disk over
// app:// (a file:// page cannot fetch its own .wasm), with Icarus Verilog
// run natively through the bridge in preload.js.
const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { createRunner, findBinDir, readFolder } = require('./hdl_native');
const { createVerilator, findVerilator } = require('./verilator_native');

const OS = { darwin: 'mac', win32: 'win' }[process.platform] || process.platform;
const WEB_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '..');
const IVL_DIR = findBinDir([
  app.isPackaged ? path.join(process.resourcesPath, 'iverilog') : null,
  path.join(__dirname, 'iverilog', OS + '-' + process.arch)
]);
const runner = IVL_DIR ? createRunner(IVL_DIR) : null;
const VL_DIR = findVerilator([
  app.isPackaged ? path.join(process.resourcesPath, 'verilator') : null,
  path.join(__dirname, 'verilator', OS + '-' + process.arch)
]);
let verilator = null;
function getVerilator() {
  if (!verilator && VL_DIR) {
    verilator = createVerilator({ root: VL_DIR, cacheDir: path.join(app.getPath('userData'), 'verilator') });
  }
  return verilator;
}

// A separate profile, for running an instance that does not share settings
// with the installed app (the tests do this).
if (process.env.RVSIM_USER_DATA) app.setPath('userData', process.env.RVSIM_USER_DATA);

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

// ---- HDL source folders -----------------------------------------------
// The page may read only folders the user chose here. The last one is kept
// so the app reopens with it.
const SETTINGS = path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) { return {}; }
}
function saveSettings(s) {
  try { fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2)); } catch (e) {}
}
const settings = loadSettings();
const allowedFolders = new Set(settings.folder ? [settings.folder] : []);

ipcMain.on('app:info', e => {
  let version = null;
  if (IVL_DIR) { try { version = fs.readFileSync(path.join(IVL_DIR, 'VERSION'), 'utf8').trim(); } catch (err) {} }
  let vlVersion = null;
  if (VL_DIR) { try { vlVersion = fs.readFileSync(path.join(VL_DIR, 'VERSION'), 'utf8').trim().split(' ')[0]; } catch (err) {} }
  e.returnValue = { icarus: !!runner, icarusVersion: version, verilator: !!VL_DIR, verilatorVersion: vlVersion,
    folder: settings.folder || null, platform: process.platform };
});

ipcMain.handle('hdl:run', (e, id, tool, files, args, opts) => {
  if (!runner) throw new Error('This build has no native Icarus Verilog.');
  return runner.run(id, tool, files, args, opts);
});
ipcMain.handle('hdl:kill', (e, id) => {
  if (runner) runner.kill(id);
  if (verilator) verilator.kill(id);
});
ipcMain.handle('vl:build', (e, id, files, opts) => {
  if (!getVerilator()) throw new Error('This build has no Verilator.');
  return getVerilator().build(id, files, opts, evt => {
    if (!e.sender.isDestroyed()) e.sender.send('vl:progress', id, evt);
  });
});
// A live run's output is passed on every 50 ms rather than chunk by chunk.
ipcMain.handle('vl:live', async (e, id, key, files, args, opts) => {
  if (!getVerilator()) throw new Error('This build has no Verilator.');
  let buf = '';
  const flush = () => {
    if (buf && !e.sender.isDestroyed()) e.sender.send('vl:live-data', id, buf);
    buf = '';
  };
  const timer = setInterval(flush, 50);
  try {
    return await getVerilator().runLive(id, key, files, args, opts, d => { buf += d; });
  } finally {
    clearInterval(timer);
    flush();
  }
});
ipcMain.handle('vl:live-send', (e, id, line) => { if (verilator) verilator.liveSend(id, line); });
ipcMain.handle('vl:live-read', (e, id, name, max) => verilator ? verilator.liveRead(id, name, max) : null);
ipcMain.handle('vl:run', (e, id, key, files, args, opts) => {
  if (!getVerilator()) throw new Error('This build has no Verilator.');
  return getVerilator().run(id, key, files, args, opts);
});

ipcMain.handle('folder:pick', async e => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: settings.folder || undefined });
  if (r.canceled || !r.filePaths.length) return null;
  const dir = r.filePaths[0];
  allowedFolders.add(dir);
  settings.folder = dir;
  saveSettings(settings);
  return dir;
});
ipcMain.handle('folder:read', (e, dir) => {
  if (!allowedFolders.has(dir)) throw new Error('That folder was not chosen in this app.');
  return readFolder(dir);
});
ipcMain.handle('folder:forget', () => {
  delete settings.folder;
  saveSettings(settings);
});

// ---- window -------------------------------------------------------------
function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 920, backgroundColor: '#1e1e2e',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  const external = url => /^https?:|^mailto:/.test(url) && shell.openExternal(url);
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) { e.preventDefault(); external(url); }
  });
  win.loadURL('app://rvsim/riscv_simulator.html');
}

app.whenReady().then(() => {
  protocol.handle('app', req => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
    const file = path.resolve(WEB_ROOT, rel);
    if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
  // Without a menu the macOS Edit shortcuts (copy, paste, undo) stop working;
  // elsewhere a menu bar is only a row of screen.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => {
  if (runner) runner.killAll();
  if (verilator) verilator.killAll();
  if (process.platform !== 'darwin') app.quit();
});
