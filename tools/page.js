// Builds the page from src/: the markup in src/index.html, the styles in
// src/styles (in the order of order.json) and the scripts in src/ts (in the
// order of tsconfig.json's "files").
//
// A script is either an ES module (it has an import or export) or a classic
// script. The classic scripts share one global scope: they are joined in
// order and esbuild only strips the types and, optionally, minifies, keeping
// top-level names, which the markup's inline handlers and the tests call. The
// modules are bundled ahead of them, and their exports are put on window, so
// the classic scripts and the handlers reach them by name. A module can use
// the classic scripts' globals only once they have run, so not while it is
// being loaded.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildSync, transformSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const read = f => fs.readFileSync(f, 'utf8');

function buildPage({ minify = true } = {}) {
  const files = JSON.parse(read(path.join(ROOT, 'tsconfig.json'))).files;
  const isModule = f => /^(import\s+(\{|\*|type\s|[\w$]+\s*(,|from))|export\s+(const|let|var|function|async|class|interface|type|enum|default|\{|\*))/m.test(read(path.join(ROOT, f)));
  const modules = files.filter(isModule);
  const classic = files.filter(f => !isModule(f));
  let js = '';
  if (modules.length) {
    const entry = modules.map((f, i) => 'import * as m' + i + ' from ' + JSON.stringify(path.join(ROOT, f)) + ';').join('\n') +
      '\nObject.assign(globalThis, ' + modules.map((f, i) => 'm' + i).join(', ') + ');\n';
    js = buildSync({
      stdin: { contents: entry, resolveDir: path.join(SRC, 'ts'), loader: 'ts', sourcefile: 'modules.ts' },
      bundle: true, format: 'iife', minify, legalComments: 'none', write: false
    }).outputFiles[0].text;
  }
  js += transformSync(classic.map(f => read(path.join(ROOT, f))).join('\n'), { loader: 'ts', minify, legalComments: 'none' }).code;
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
