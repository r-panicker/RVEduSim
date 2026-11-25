/*
 * The HDL suites simulate a processor's RTL and edit some of its modules
 * (ALU.v, ProgramCounter.v, RegFile.v, ...) to test how the page reacts.
 * They take it from the folder named by RVSIM_CORE_DIR, or from ../RV beside
 * this folder when there is one. The folder holds RV.v, its modules and
 * Wrapper.v, laid out as the Nexys 4 template project lays them out.
 *
 * coreDir(suite) returns that folder, or ends the suite as skipped.
 * findCoreDir() returns it, or null.
 * coreOrPrebuilt() returns { dir, prebuilt }: that folder, or without one
 * examples/hdl, which holds the Wrapper and a prebuilt gate-level core.
 * RVSIM_PREBUILT=1 picks examples/hdl even when there is RTL.
 */
const fs = require('fs');
const path = require('path');

function findCoreDir() {
  const dir = process.env.RVSIM_CORE_DIR
    ? path.resolve(process.env.RVSIM_CORE_DIR)
    : path.resolve(__dirname, '..', 'RV');
  return fs.existsSync(path.join(dir, 'RV.v')) && fs.existsSync(path.join(dir, 'Wrapper.v')) ? dir : null;
}

function coreDir(suite) {
  const dir = findCoreDir();
  if (dir) return dir;
  console.log(suite + ': skipped. It simulates a processor\'s RTL: set RVSIM_CORE_DIR to a folder ' +
    'holding RV.v, its modules (ALU.v, Decoder.v, Extend.v, MCycle.v, PC_Logic.v, ProgramCounter.v, ' +
    'RegFile.v, Shifter.v) and Wrapper.v.');
  process.exit(0);
}

function coreOrPrebuilt() {
  const dir = process.env.RVSIM_PREBUILT ? null : findCoreDir();
  return dir ? { dir, prebuilt: false } : { dir: path.resolve(__dirname, '..', 'examples', 'hdl'), prebuilt: true };
}

module.exports = { coreDir, findCoreDir, coreOrPrebuilt };
