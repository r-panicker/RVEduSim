# `desktop/` — the desktop app

The page, built into `../dist/` by `npm run build`, in a [Tauri](https://tauri.app) window
(the system's webview), with Icarus Verilog and Verilator built natively for the platform, so
HDL mode needs no network and no WASM. The page is not changed for the app: it is carried
inside the app and finds the native engine through `window.rvNative`. What the app changes,
and the measured speed, are in [§5.18 of the specs](../riscv_simulator_specs.md#518-the-desktop-app).

| Path | What it is |
|---|---|
| `native/` | The Rust engine behind `window.rvNative`: Icarus stages in temporary directories (`icarus.rs`), Verilator builds, cached models and live runs (`verilator.rs`, with `live.cpp` compiled into every model), finding a C++ compiler or downloading Zig, reading an HDL folder (`folder.rs`), and killing jobs by id (`jobs.rs`) |
| `native/src/bin/bridge.rs` | `rvnative-bridge`: the same engine over JSON lines on stdin and stdout, which `riscv_simulator_tests/native_bridge.js` drives |
| `app/` | The Tauri shell: `src/main.rs` (the window and the commands behind the bridge), `src/rvnative.js` (`window.rvNative`, set up before the page loads), `tauri.conf.json` and one config per platform naming its bundles and resources |
| `app/entitlements.plist` | macOS hardened-runtime entitlements; `ivl` and `vvp` load plugins at run time |
| `app/app-icon.png` | The page's favicon at 1024 px; `npx tauri icon desktop/app/app-icon.png -o desktop/app/icons` makes `icons/` |
| `scripts/build-iverilog.sh` | Builds Icarus from source into `iverilog/<os>-<arch>/` |
| `scripts/build-verilator.sh` | Builds Verilator from source into `verilator/<os>-<arch>/` (`bin/verilator_bin` and `include/`) |
| `../tools/stage_desktop.js` | Copies the built page, CodeMirror and the prebuilt processor (`examples/hdl/`) into `web/`, which the app carries; the example programs are read from the RVEduSim site |
| `../.github/workflows/desktop.yml` | Builds the installers for all three platforms |
| `../.github/workflows/toolchain.yml`, `scripts/toolchain-key.js` | Builds Icarus and Verilator for every platform once, as a prerelease the installer workflow downloads |

`iverilog/`, `verilator/`, `web/` and `target/` are build output and not committed.

## Running it from the repository

Needs Rust, Node.js 20 or later, and on Linux the WebKitGTK and GTK development packages
(`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`).

```bash
npm install                                                  # at the repository root
bash desktop/scripts/build-iverilog.sh desktop/iverilog/linux-x64    # once; needs a C++ compiler, autoconf, gperf, flex, bison
bash desktop/scripts/build-verilator.sh desktop/verilator/linux-x64  # once; also needs perl, python3, help2man, libfl-dev
npm run desktop:build
desktop/target/release/rvedusim
```

The folder names are `linux-x64`, `win-x64` and `mac-arm64`. On Windows the build scripts
have to run in an MSYS2 MINGW64 shell. Without an Icarus build the app still runs, on the
WASM engine; without a Verilator build its Simulator setting is disabled.

Verilator needs a C++20 compiler when the app runs. The app looks for `CXX`, `g++` and
`clang++` (on macOS only with the Xcode command line tools), and otherwise downloads
Zig 0.17.1 into its data folder (`~/.local/share/io.github.r-panicker.rvedusim/verilator/`
on Linux), where built models are cached too. `RVSIM_FORCE_ZIG=1` skips the system
compiler, `RVSIM_ZIG_URL` replaces ziglang.org as the download base, and
`RVSIM_USER_DATA` points the app at another data folder.

## Installers

`npm run desktop:bundle` packages for the platform it runs on, into
`target/release/bundle/`: a `.deb` and an AppImage on Linux, an NSIS installer on
Windows, a dmg on macOS. Each carries only its own platform's Icarus and Verilator, so every
platform is built on its own machine; the [workflow](../.github/workflows/desktop.yml) does
that on GitHub's runners. Start it from the Actions tab, or push a tag
`desktop-v<version>`, which also makes a draft release holding the installers. Started
from the Actions tab with *release* ticked, it makes the same draft for the version in
`app/tauri.conf.json`; publishing the draft creates the tag on the commit that was built.
The version shown is `version` in `app/tauri.conf.json` (and `Cargo.toml`).

The `.deb` depends on `libwebkit2gtk-4.1-0` and recommends `g++`; it is for Ubuntu 24.04
and later. The AppImage carries WebKitGTK and runs on older systems too; the workflow builds
it on Ubuntu 22.04.

The workflow does not build Icarus and Verilator itself when the
[Toolchain workflow](../.github/workflows/toolchain.yml) has published them: it downloads
the prerelease named `toolchain-<hash>`, where the hash is of the two build scripts
(`node scripts/toolchain-key.js` prints it). After changing either build script, run the
Toolchain workflow from the Actions tab; until then the installer workflow builds them
from source as a fallback. On Windows it also runs the Verilator suite with
`RVSIM_FORCE_ZIG=1`, which covers a computer without MinGW's g++.

## Signing

Unsigned installers work, with a warning the first time:

- **macOS** builds are signed ad hoc. The first open is refused; the user allows it in
  System Settings → Privacy & Security → *Open Anyway*.
- **Windows**: SmartScreen shows *Windows protected your PC*; *More info* → *Run anyway*.
- **Linux** has no signing; the AppImage needs `chmod +x`.

To sign, set these repository secrets:

| Secret | For |
|---|---|
| `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_SIGNING_IDENTITY` | macOS Developer ID Application certificate (.p12, base64), its password, and its name |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | notarization |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Windows code-signing certificate (.pfx, base64) and its password |

## Testing

From `riscv_simulator_tests/`:

```bash
node test_hdl_native.js     # native Icarus against the WASM build, through the page
node test_verilator.js      # Verilator through the page, against Icarus
node test_desktop_app.js    # the built app, through tauri-driver; opens a window
```

The first two run the engine through `rvnative-bridge`, which they build with cargo.
`test_desktop_app.js` needs `cargo install tauri-driver` and the platform's WebDriver
(`webkit2gtk-driver` on Linux, `msedgedriver` matching WebView2 on Windows; macOS has none).
`RVSIM_APP_EXE` names another build of the app, such as an AppImage.

## Licence

Icarus Verilog is GPL-2.0. The app runs it as separate programs and ships its
`COPYING` beside them; the source is <https://github.com/steveicarus/iverilog> at the
commit in the bundled `iverilog/VERSION`. Verilator is LGPL-3.0 or Artistic-2.0, shipped
with its `LICENSE` in `verilator/`; Zig, downloaded only where needed, is MIT. The
AppImage also carries WebKitGTK, GTK and the libraries they use, under their own licences
(mostly LGPL).
