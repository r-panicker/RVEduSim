// The release tag the Toolchain workflow publishes the native Icarus Verilog
// and Verilator under, and the desktop workflow fetches them from: a hash of
// the two build scripts, which pin the versions. Line ends are made plain so
// that every runner computes the same tag.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const h = crypto.createHash('sha256');
for (const f of ['build-iverilog.sh', 'build-verilator.sh'])
  h.update(fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\r\n/g, '\n'));
console.log('toolchain-' + h.digest('hex').slice(0, 12));
