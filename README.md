# RVEduSim

**Open it: <https://r-panicker.github.io/RVEduSim/>**

RVEduSim is a RISC-V simulator in a single web page, built around a Digilent Nexys 4 / Nexys 4 DDR /
Nexys A7 board with a Pmod OLED. It runs RV32I(M) assembly, or C compiled through Compiler
Explorer, on a JavaScript model of the processor (single-cycle, multi-cycle or a 5-stage
pipeline), or on your own Verilog processor simulated with Icarus Verilog. LEDs, switches,
buttons, the 7-segment display, UART, OLED and accelerometer are simulated, and Verilog
runs come with a waveform viewer, post-synthesis simulation and a cross-check against the
JavaScript model.

RVEduSim was written for [CG3207](https://nus-cg3207.github.io/), the computer architecture
course at the National University of Singapore. The course site documents the board's
[peripherals](https://nus-cg3207.github.io/rv_resources/peripherals/) and the
[Verilog templates](https://github.com/NUS-CG3207/nus-cg3207.github.io/tree/main/docs/code_templates/Asst_02)
that HDL mode expects, a Wrapper module that connects the processor to the board and the
processor's own modules.

## Running it locally

The page needs to be served over HTTP; opened as a `file://` URL, the browser blocks the
WebAssembly engines that HDL mode uses.

```bash
python3 -m http.server 8000
# then open http://localhost:8000/riscv_simulator.html
```

Any static host works the same way; [.github/workflows/pages.yml](.github/workflows/pages.yml)
publishes this repository to GitHub Pages, with `riscv_simulator.html` as the site's index.
Nothing else is installed: the Verilog engines run in the browser from `vendor/`.

## The desktop app

`electron/` packages the same page as a desktop app with Icarus Verilog and Verilator
built natively, which makes HDL simulation much faster and lets a Verilator run take input
while it runs. [electron/README.md](electron/README.md) explains how to build and run it;
[.github/workflows/desktop.yml](.github/workflows/desktop.yml) builds installers for
Linux, Windows and macOS.

## Documentation

- [riscv_simulator.md](riscv_simulator.md): the user guide.
- [riscv_simulator_specs.md](riscv_simulator_specs.md): how the simulator works, for
  anyone extending it.
- [vendor/README.md](vendor/README.md): where the bundled engines come from.

## Layout

| Path | What it is |
|---|---|
| `riscv_simulator.html` | The whole simulator |
| `examples/` | Example programs in assembly and C, listed in `examples/index.txt`; `examples/hdl/` holds the board's Wrapper and a prebuilt gate-level reference core |
| `vendor/` | CodeMirror, Icarus Verilog (WebAssembly) and Yosys (WebAssembly) |
| `electron/` | The desktop app |
| `riscv_simulator_tests/` | The test suites |

## Tests

```bash
cd riscv_simulator_tests
npm install
npm test
```

The suites are plain Node scripts that load the page in jsdom; each can also be run on its
own (`node test_pipeline.js`). The ones that simulate a processor's RTL
(`test_hdl_mode.js`, `test_waveform.js`, `test_m_extension.js`, `test_hdl_native.js`,
`test_verilator.js`, `test_hdl_folder_browser.js`, `oneoff_oled_modes.js`) skip
themselves unless `RVSIM_CORE_DIR` names a folder holding `RV.v`, its modules and
`Wrapper.v` (see `core_dir.js`). `test_hdl_native.js`, `test_verilator.js` and
`test_electron_app.js` also need the desktop app's native builds.

## Licence

MIT, for everything in this repository except the third-party components listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), which keep their own licences.
