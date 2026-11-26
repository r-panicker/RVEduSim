// Godbolt output for the built-in C examples, captured once so the suites do
// not need the network.
//
// Every example but `dip_led` / `dip_led_c` lives in examples/asm/ and
// examples/c/ and is fetched at runtime (see examples_fetch.js for the
// test-side fetch shim), so this cache is keyed by filename and matched by
// reading those same files off disk.
//
// DIP_to_LED.c's entry lives in its own file, godbolt_cache_dip_led.json,
// separate from the others in godbolt_cache.json — it is the one C
// example that is baked into the page rather than fetched, so its cache
// entry is not tied to the same "one file per fetched example" set the rest
// belong to. Both are merged into one lookup table below; nothing outside
// this file needs to know they are two files on disk.
//
// Install it before compiling C in a jsdom window:
//
//   const { installGodboltCache } = require('./godbolt_cache');
//   installGodboltCache(win);
//
// It hooks `window.__mockGodboltResponse`, which the page consults when the
// live API is unreachable, and matches on the exact source text against
// examples/c/*.c, so an edited program misses.
//
// To refresh an entry after changing a C example, POST examples/c/<file>.c to
//   https://godbolt.org/api/compiler/rv32-cclang2010/compile
// and store the response JSON under that filename — in godbolt_cache.json,
// or in godbolt_cache_dip_led.json if the file is DIP_to_LED.c.

const fs = require('fs');
const path = require('path');

const C_EXAMPLES_DIR = path.resolve(__dirname, '..', 'examples', 'c');
const CACHE = {
  ...require('./godbolt_cache.json'),
  ...require('./godbolt_cache_dip_led.json'),
};

function installGodboltCache(win) {
  win.__mockGodboltResponse = (source) => {
    const wanted = String(source == null ? '' : source).trim();
    let files;
    try { files = fs.readdirSync(C_EXAMPLES_DIR).filter(f => f.endsWith('.c')); }
    catch (e) { return null; }
    for (const file of files) {
      const content = fs.readFileSync(path.join(C_EXAMPLES_DIR, file), 'utf8').trim();
      if (content === wanted) return CACHE[file] || null;
    }
    return null;
  };
  return win;
}

module.exports = { CACHE, installGodboltCache };
