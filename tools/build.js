// npm run build: the page into dist/, minified (--dev: not minified).
// The engines and examples it loads by relative path are linked in beside it,
// so dist/ can be served as it is; the Pages workflow and the desktop app
// copy the real folders instead.
const fs = require('fs');
const path = require('path');
const { writeDist, ROOT } = require('./page');

const dev = process.argv.includes('--dev');
const { dir, bytes } = writeDist({ minify: !dev });
for (const d of ['vendor', 'examples']) {
  const link = path.join(dir, d);
  if (!fs.existsSync(link)) fs.symlinkSync(path.relative(dir, path.join(ROOT, d)), link, 'junction');
}
console.log('dist/: index.html ' + bytes.html + ' B, app.js ' + bytes.js + ' B, app.css ' + bytes.css + ' B' + (dev ? ' (not minified)' : ''));
