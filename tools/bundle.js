// The page's script: src/ts/main.ts and everything it imports, Svelte
// components included, bundled by esbuild into one script on stdout
// (--minify to minify it).
//
// It runs as its own process, started by tools/page.js: the Svelte plugin
// needs esbuild's asynchronous API, and page.js is synchronous for its
// callers (the build and every test suite).
const path = require('path');
const { build } = require('esbuild');
const sveltePlugin = require('esbuild-svelte');

const minify = process.argv.includes('--minify');

build({
  entryPoints: [path.resolve(__dirname, '..', 'src', 'ts', 'main.ts')],
  bundle: true, format: 'iife', minify, legalComments: 'none', write: false,
  // Svelte's browser build; its server build renders to strings.
  conditions: ['svelte', 'browser'],
  // The drawings in src/figures, included as markup.
  loader: { '.svg': 'text' },
  // Styles stay in src/styles, so a component's own <style> (if one ever
  // has one) is put into the page by the component rather than a second
  // stylesheet.
  plugins: [sveltePlugin({ compilerOptions: { css: 'injected' } })],
  logLevel: 'error',
}).then(r => {
  process.stdout.write(r.outputFiles[0].text);
}, () => {
  process.exit(1);
});
