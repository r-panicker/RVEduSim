#!/usr/bin/env bash
# Builds Icarus Verilog from source and copies the pieces the app runs
# (ivlpp, ivl, vvp.tgt, the VPI modules and vvp) into OUT, flat.
#   build-iverilog.sh OUT
# Pinned to the commit the WASM engine in vendor/verisim/ was built from, so
# the native and in-browser engines behave the same.
set -euo pipefail
OUT=$(mkdir -p "$1" && cd "$1" && pwd)
REV=${IVERILOG_REV:-c7530db}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git clone --quiet https://github.com/steveicarus/iverilog.git "$WORK/src"
cd "$WORK/src"
git checkout --quiet "$REV"
sh autoconf.sh >/dev/null

# readline is only for vvp's interactive prompt; leaving it out keeps the
# binaries free of a library the user may not have. History has checks of its
# own, which find readline's add_history and header where readline is
# installed, so they are turned off too.
case "$(uname -s)" in
  Linux|MINGW*|MSYS*) EXTRA_LDFLAGS="-static-libstdc++ -static-libgcc" ;;
  *)                  EXTRA_LDFLAGS="" ;;
esac
ac_cv_lib_readline_readline=no ac_cv_header_readline_readline_h=no \
ac_cv_lib_readline_add_history=no ac_cv_lib_history_add_history=no ac_cv_header_readline_history_h=no \
  ./configure --quiet --prefix="$WORK/inst" LDFLAGS="$EXTRA_LDFLAGS" >/dev/null
make -s -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" >/dev/null
make -s install >/dev/null

LIB="$WORK/inst/lib/ivl"
EXE=""; case "$(uname -s)" in MINGW*|MSYS*) EXE=".exe" ;; esac
cp "$LIB/ivlpp$EXE" "$LIB/ivl$EXE" "$LIB/vvp.tgt" "$LIB/vvp.conf" "$LIB"/*.vpi "$LIB"/*.sft "$OUT/" 2>/dev/null || true
cp "$WORK/inst/bin/vvp$EXE" "$OUT/"
for f in ivlpp ivl vvp vvp.tgt; do [ -e "$OUT/$f$EXE" ] || [ -e "$OUT/$f" ] || { echo "missing $f" >&2; exit 1; }; done
case "$(uname -s)" in
  Darwin) strip -x "$OUT"/ivlpp "$OUT"/ivl "$OUT"/vvp "$OUT"/*.tgt "$OUT"/*.vpi ;;
  *)      strip "$OUT"/ivlpp$EXE "$OUT"/ivl$EXE "$OUT"/vvp$EXE "$OUT"/*.tgt "$OUT"/*.vpi ;;
esac
# On Windows, the MinGW runtime DLLs the binaries still need go beside them,
# and the DLLs those need in turn. objdump reads each file's import table;
# ldd would start the file, which fails for vvp.tgt and the .vpi modules,
# DLLs without a .dll name.
case "$(uname -s)" in MINGW*|MSYS*)
  bin=$(dirname "$(command -v gcc)")
  todo=("$OUT"/*.exe "$OUT"/*.tgt "$OUT"/*.vpi)
  while [ ${#todo[@]} -gt 0 ]; do
    f=${todo[0]}; todo=("${todo[@]:1}")
    for d in $(objdump -p "$f" | awk '/DLL Name:/ { print $3 }'); do
      if [ -f "$bin/$d" ] && [ ! -f "$OUT/$d" ]; then cp "$bin/$d" "$OUT/"; todo+=("$OUT/$d"); fi
    done
  done ;;
esac
git -C "$WORK/src" log -1 --format='%H %cd' > "$OUT/VERSION"
cp COPYING "$OUT/COPYING"
echo "Icarus Verilog $(cat "$OUT/VERSION") -> $OUT"
