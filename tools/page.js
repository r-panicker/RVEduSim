// Builds the page from src/: the markup in src/index.html, the styles in
// src/styles (in the order of order.json) and the scripts in src/ts.
//
// The scripts are ES modules, entered at src/ts/main.ts, and classic scripts,
// listed in src/ts/classic.json. esbuild bundles the modules first; main.ts
// puts their exports on window. The classic scripts follow, joined in order
// as one script sharing one global scope, with the types stripped and,
// minified, their top-level names kept, since the markup's inline handlers
// and the tests call them by name. A module can use a classic script's
// globals only once the page has loaded, not while it is being loaded.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildSync, transformSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const read = f => fs.readFileSync(f, 'utf8');

function buildPage({ minify = true } = {}) {
  const TS = path.join(SRC, 'ts');
  let js = buildSync({
    entryPoints: [path.join(TS, 'main.ts')], bundle: true, format: 'iife', minify, legalComments: 'none', write: false
  }).outputFiles[0].text;
  const classic = JSON.parse(read(path.join(TS, 'classic.json')));
  js += transformSync(classic.map(f => read(path.join(TS, f))).join('\n'), { loader: 'ts', minify, legalComments: 'none' }).code;
  const order = JSON.parse(read(path.join(SRC, 'styles', 'order.json')));
  const cssSrc = order.map(f => read(path.join(SRC, 'styles', f))).join('\n');
  const css = minify ? transformSync(cssSrc, { loader: 'css', minify: true }).code : cssSrc;
  const html = read(path.join(SRC, 'index.html'));
  return { html, js, css };
}

// The page as one file, with its styles and script inline, for jsdom.
function inlinePage(opts) {
  const { html, js, css } = buildPage(Object.assign({ minify: false }, opts));
  return html
    .replace('<link rel="stylesheet" href="app.css">', () => '<style>\n' + css + '</style>')
    .replace('<script src="app.js"></script>', () => '<script>\n' + js + '</script>');
}

// dist/: the page, with app.js and app.css named by a hash of their content
// in the links so that a browser never runs a cached copy of an older build.
function writeDist({ minify = true, dir = path.join(ROOT, 'dist') } = {}) {
  const { html, js, css } = buildPage({ minify });
  const v = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'app.js'), js);
  fs.writeFileSync(path.join(dir, 'app.css'), css);
  fs.writeFileSync(path.join(dir, 'index.html'), html
    .replace('href="app.css"', 'href="app.css?v=' + v(css) + '"')
    .replace('src="app.js"', 'src="app.js?v=' + v(js) + '"'));
  return { dir, bytes: { html: html.length, js: js.length, css: css.length } };
}

module.exports = { buildPage, inlinePage, writeDist, ROOT };
