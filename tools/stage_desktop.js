#!/usr/bin/env node
// Assembles desktop/web, the page the desktop app carries: dist/ (npm run
// build), CodeMirror from vendor/, and examples/. Icarus's WASM build is left
// out, since the app runs Icarus natively, and so is Yosys: the app loads it
// from the CDN on first use, as the browser does (see vendor/README.md).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const WEB = path.join(ROOT, 'desktop', 'web');

for (const f of ['index.html', 'app.js', 'app.css']) {
  if (!fs.existsSync(path.join(DIST, f))) { console.error('dist/' + f + ' is missing: run npm run build first'); process.exit(1); }
}
fs.rmSync(WEB, { recursive: true, force: true });
fs.mkdirSync(WEB, { recursive: true });
for (const f of ['index.html', 'app.js', 'app.css']) fs.copyFileSync(path.join(DIST, f), path.join(WEB, f));
fs.mkdirSync(path.join(WEB, 'vendor', 'codemirror'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'vendor', 'codemirror', 'cm6_bundle.min.js'), path.join(WEB, 'vendor', 'codemirror', 'cm6_bundle.min.js'));
fs.cpSync(path.join(ROOT, 'examples'), path.join(WEB, 'examples'), { recursive: true, dereference: true });
let bytes = 0;
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else bytes += fs.statSync(p).size; } })(WEB);
console.log('desktop/web: ' + (bytes / 1e6).toFixed(1) + ' MB');
