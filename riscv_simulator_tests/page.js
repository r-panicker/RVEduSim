// The page as one HTML string, built from src/ (see tools/page.js) with its
// styles and script inline, so that jsdom runs it without fetching anything.
// Built once per process; RVSIM_TEST_MINIFIED=1 tests the minified build.
const { inlinePage } = require('../tools/page');

let cached = null;
exports.html = () => cached || (cached = inlinePage({ minify: process.env.RVSIM_TEST_MINIFIED === '1' }));
