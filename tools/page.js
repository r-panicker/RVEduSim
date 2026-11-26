// Builds the page from src/: the markup in src/index.html, the styles in
// src/styles (in the order of order.json) and the scripts in src/ts.
//
// The scripts are ES modules, bundled by esbuild from src/ts/main.ts into
// one script; minified, the names inside it are shortened, and main.ts puts
// every module's exports on window under their own names.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildSync, transformSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const read = f => fs.readFileSync(f, 'utf8');

function buildPage({ minify = true } = {}) {
  const TS = path.join(SRC, 'ts');
  const js = buildSync({
    entryPoints: [path.join(TS, 'main.ts')], bundle: true, format: 'iife', minify, legalComments: 'none', write: false
  }).outputFiles[0].text;
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
