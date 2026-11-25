# `electron/` — the desktop app

`riscv_simulator.html` in an Electron window, with Icarus Verilog built natively for
the platform, so HDL mode needs no browser, no network and no WASM. The page is not
copied or changed for the app: it is served from the app's resources over `app://`, and
finds the native engine through `window.rvNative`. What the app changes, and the
measured speed, are in [§5.18 of the specs](../riscv_simulator_specs.md#518-the-desktop-app).

| File | What it is |
|---|---|
| `main.js` | The main process: the `app://` scheme, the window, and the IPC handlers behind the bridge |
| `preload.js` | `window.rvNative`, the page's only way to the machine |
| `hdl_native.js` | Runs one Icarus stage in a temporary directory, and reads an HDL folder. Shared with `riscv_simulator_tests/test_hdl_native.js` |
| `verilator_native.js` | Builds and caches Verilator models, finds a C++ compiler or downloads Zig, and runs a model |
| `scripts/build-iverilog.sh` | Builds Icarus from source into `iverilog/<os>-<arch>/` |
| `scripts/build-verilator.sh` | Builds Verilator from source into `verilator/<os>-<arch>/` (`bin/verilator_bin` and `include/`) |
| `build/entitlements.mac.plist` | macOS hardened-runtime entitlements; `ivl` and `vvp` load plugins at run time |
| `build/icon.svg`, `build/icon.png` | The page's favicon at 1024 px; electron-builder makes the `.icns` and `.ico` from the PNG |
| `../.github/workflows/desktop.yml` | Builds the installers for all three platforms |

`iverilog/`, `verilator/`, `node_modules/` and `dist/` are build output and not committed.

## Running it from the repository

```bash
cd electron
npm install
npm run build:iverilog     # once; needs a C++ compiler, autoconf, gperf, flex, bison
npm run build:verilator    # once; also needs perl, python3, help2man, libfl-dev
npm start
```

`build:iverilog` writes to `iverilog/linux-x64`, `iverilog/mac-arm64`, `iverilog/win-x64`
and so on, matching electron-builder's `${os}-${arch}`. On Windows it has to run in an
MSYS2 MINGW64 shell, as does `build:verilator`. Without an Icarus build the app still runs, on
the WASM engine; without a Verilator build its Simulator setting is disabled.

Verilator needs a C++20 compiler when the app runs. The app looks for `CXX`, `g++` and
`clang++` (on macOS only with the Xcode command line tools), and otherwise downloads
Zig 0.17.1 into its data folder (`~/.config/RVEduSim/verilator/` on Linux),
where built models are cached too. `RVSIM_FORCE_ZIG=1` skips the system compiler, and
`RVSIM_ZIG_URL` replaces ziglang.org as the download base.

npm may refuse Electron's install script (`allowScripts`); if `node_modules/electron/dist`
is missing, run `node node_modules/electron/install.js`.

## Installers

`npm run dist` packages for the platform it runs on, into `dist/`: an AppImage on
Linux, a one-click NSIS installer on Windows, a dmg on macOS. Each carries only its own
platform's Icarus, so every platform is built on its own machine; the
[workflow](../.github/workflows/desktop.yml) does that on GitHub's runners. Start it
from the Actions tab, or push a tag `desktop-v<version>`, which also makes a draft
release holding the installers. The version shown is `version` in `package.json`.

The page and its resources come from the repository at build time
(`riscv_simulator.html`, `vendor/`, `examples/`), so an installer carries whatever the
page was when it was built.

## Signing

Unsigned installers work, with a warning the first time:

- **macOS** builds are signed ad hoc. The first open is refused; the user allows it in
  System Settings → Privacy & Security → *Open Anyway*.
- **Windows**: SmartScreen shows *Windows protected your PC*; *More info* → *Run anyway*.
- **Linux** has no signing; the AppImage needs `chmod +x`.

To sign, set these repository secrets and the workflow passes them to electron-builder:

| Secret | For |
|---|---|
| `CSC_LINK`, `CSC_KEY_PASSWORD` | macOS Developer ID Application certificate (.p12, base64) and its password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | notarization |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Windows code-signing certificate |

## Testing

From `riscv_simulator_tests/`:

```bash
node test_hdl_native.js     # native Icarus against the WASM build, through the page
node test_verilator.js      # Verilator through the page, against Icarus
node test_electron_app.js   # the app itself, through Playwright; opens a window
RVSIM_APP_EXE=../electron/dist/linux-unpacked/rvedusim node test_electron_app.js
```

`RVSIM_USER_DATA` points the app at a separate profile, which the tests use to start
from a clean one.

## Licence

Icarus Verilog is GPL-2.0. The app runs it as separate programs and ships its
`COPYING` beside them; the source is <https://github.com/steveicarus/iverilog> at the
commit in `resources/iverilog/VERSION`. Verilator is LGPL-3.0 or Artistic-2.0, shipped
with its `LICENSE` in `resources/verilator/`; Zig, downloaded only where needed, is MIT.
