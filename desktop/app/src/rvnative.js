// window.rvNative in the desktop app: the interface the page probes for to
// run HDL natively and read Verilog folders, over Tauri's IPC to the Rust
// engine (desktop/native). The browser page has no rvNative and uses its
// WASM engines instead. window.__RVNATIVE_INFO__ is set just before this
// script by the app.
(() => {
  const info = window.__RVNATIVE_INFO__ || {};
  const core = () => window.__TAURI__.core;
  const invoke = (cmd, args) => core().invoke(cmd, args);

  const toB64 = u8 => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  // Files to send: text as it is, bytes (a compiled .vvp) as base64.
  const wire = files => {
    const o = {};
    for (const k in files) o[k] = typeof files[k] === 'string' ? files[k] : { b64: toB64(files[k]) };
    return o;
  };
  // A run's result arrives as one binary frame: the length of a JSON header,
  // the header, then the kept files' bytes in the order it lists them.
  const unframe = buf => {
    const b = new Uint8Array(buf);
    const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true);
    const head = JSON.parse(new TextDecoder().decode(b.subarray(4, 4 + n)));
    const files = {};
    let at = 4 + n;
    for (const [name, len] of head.files || []) { files[name] = b.subarray(at, at + len); at += len; }
    head.files = files;
    return head;
  };
  const channel = fn => { const ch = new (core().Channel)(); ch.onmessage = fn; return ch; };

  const progressCbs = [], liveCbs = [];
  let sendChain = Promise.resolve();
  window.rvNative = {
    icarus: !!info.icarus, icarusVersion: info.icarusVersion || null, platform: info.platform,
    verilator: !!info.verilator, verilatorVersion: info.verilatorVersion || null,
    rememberedFolder: info.folder || null,
    rememberedExamplesFolders: info.examplesFolders || [],
    hdlRun: async (id, tool, files, args, opts) => unframe(await invoke('hdl_run', { id, tool, files: wire(files), args, opts })),
    hdlKill: id => invoke('hdl_kill', { id }),
    vlBuild: (id, files, opts) => invoke('vl_build', { id, files, opts, onProgress: channel(e => progressCbs.forEach(cb => cb(id, e))) }),
    vlRun: async (id, key, files, args, opts) => unframe(await invoke('vl_run', { id, key, files: wire(files), args, opts })),
    onVlProgress: cb => { progressCbs.push(cb); },
    vlLive: async (id, key, files, args, opts) =>
      unframe(await invoke('vl_live', { id, key, files: wire(files), args, opts, onData: channel(t => liveCbs.forEach(cb => cb(id, t))) })),
    // Each command waits for the one before: two UART bytes must reach the
    // model in the order they were typed, and separate IPC calls need not
    // arrive in the order they were made.
    vlLiveSend: (id, line) => (sendChain = sendChain.then(() => invoke('vl_live_send', { id, line: String(line) })).catch(() => {})),
    vlLiveRead: async (id, name, max) => {
      const r = unframe(await invoke('vl_live_read', { id, name, max: max || 0 }));
      if (r.none) return null;
      return r.files.data ? { size: r.size, data: r.files.data } : { size: r.size };
    },
    onVlLiveData: cb => { liveCbs.push(cb); },
    // kind: 'hdl' (the default) or 'examples'. HDL mode remembers one
    // folder, the examples a list; forgetFolder takes the example folder to drop.
    pickFolder: kind => invoke('folder_pick', { kind: kind || null }),
    readFolder: (dir, kind) => invoke('folder_read', { dir, kind: kind || null }),
    forgetFolder: (kind, dir) => invoke('folder_forget', { kind: kind || null, dir: dir || null }),
  };

  // Links to the web open in the browser rather than in the app's window.
  const external = url => /^(https?:|mailto:)/.test(url) && !url.startsWith(location.origin);
  document.addEventListener('click', e => {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (a && external(a.href)) { e.preventDefault(); invoke('open_external', { url: a.href }); }
  }, true);
  window.open = url => { if (url && external(String(url))) invoke('open_external', { url: String(url) }); return null; };
})();
