'use strict';
// The page's only way to the machine: run a bundled Icarus stage, build and
// run a Verilator model, and read an HDL folder the user picked. See main.js.
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('app:info');

contextBridge.exposeInMainWorld('rvNative', {
  icarus: info.icarus,
  icarusVersion: info.icarusVersion,
  platform: info.platform,
  hdlRun: (id, tool, files, args, opts) => ipcRenderer.invoke('hdl:run', id, tool, files, args, opts),
  hdlKill: id => ipcRenderer.invoke('hdl:kill', id),
  verilator: info.verilator,
  verilatorVersion: info.verilatorVersion,
  vlBuild: (id, files, opts) => ipcRenderer.invoke('vl:build', id, files, opts),
  vlRun: (id, key, files, args, opts) => ipcRenderer.invoke('vl:run', id, key, files, args, opts),
  onVlProgress: cb => ipcRenderer.on('vl:progress', (e, id, evt) => cb(id, evt)),
  vlLive: (id, key, files, args, opts) => ipcRenderer.invoke('vl:live', id, key, files, args, opts),
  vlLiveSend: (id, line) => ipcRenderer.invoke('vl:live-send', id, line),
  vlLiveRead: (id, name, max) => ipcRenderer.invoke('vl:live-read', id, name, max),
  onVlLiveData: cb => ipcRenderer.on('vl:live-data', (e, id, text) => cb(id, text)),
  rememberedFolder: info.folder,
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  readFolder: dir => ipcRenderer.invoke('folder:read', dir),
  forgetFolder: () => ipcRenderer.invoke('folder:forget')
});
