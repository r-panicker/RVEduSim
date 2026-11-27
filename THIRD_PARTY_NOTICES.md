# Third-party components

These components are distributed with, or downloaded by, the simulator. Each keeps its own
licence.

| Component | Where | Licence | Source |
|---|---|---|---|
| CodeMirror 6 and Lezer | `vendor/codemirror/cm6_bundle.min.js` (built from `riscv_simulator_tests/cm6_entry.js`) | MIT | <https://codemirror.net> |
| Svelte 5 runtime | compiled into the page's `app.js` | MIT | <https://svelte.dev> |
| Icarus Verilog, WebAssembly build | `vendor/verisim/` | GPL-2.0-or-later | <https://github.com/steveicarus/iverilog>; build from <https://github.com/senolgulgonul/verisim> |
| Yosys, WebAssembly build (YoWASP `@yowasp/yosys` 0.68.1207) | `vendor/yosys/` | ISC, with the licences of the tools it bundles | <https://github.com/YosysHQ/yosys>, <https://yowasp.org> |
| Icarus Verilog, native | desktop app, built from source by `desktop/scripts/build-iverilog.sh` | GPL-2.0-or-later | <https://github.com/steveicarus/iverilog> |
| Verilator | desktop app, built from source by `desktop/scripts/build-verilator.sh` | LGPL-3.0-only or Artistic-2.0 | <https://github.com/verilator/verilator> |
| Tauri and the Rust crates it uses | desktop app | MIT or Apache-2.0, mostly | <https://tauri.app> |
| WebKitGTK, GTK and the libraries they use | the Linux AppImage | LGPL-2.1-or-later and others | <https://webkitgtk.org>, <https://www.gtk.org> |
| Zig | downloaded by the desktop app when the computer has no C++ compiler | MIT | <https://ziglang.org> |

Icarus Verilog runs as separate programs; the desktop app ships its `COPYING` beside the
binaries. C programs are compiled by the Compiler Explorer service
(<https://godbolt.org>), which the page calls over the network.
