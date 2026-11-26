#!/usr/bin/env bash
# Builds Verilator from source and copies what the app runs into OUT:
# bin/verilator_bin and the include/ tree of runtime sources the generated
# C++ is compiled against. The Perl wrapper and make are not needed; the
# app calls verilator_bin and compiles the C++ itself.
#   build-verilator.sh OUT
set -euo pipefail
OUT=$(mkdir -p "$1" && cd "$1" && pwd)
REV=${VERILATOR_REV:-v5.054}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git clone --quiet --depth 1 --branch "$REV" https://github.com/verilator/verilator.git "$WORK/src"
cd "$WORK/src"
autoconf
case "$(uname -s)" in
  Linux|MINGW*|MSYS*) EXTRA_LDFLAGS="-static-libstdc++ -static-libgcc" ;;
  *)                  EXTRA_LDFLAGS="" ;;
esac
# Verilator's lexer does not build with flex 2.6.16 and later, whose
# FlexLexer.h declares a yyread the lexer does not define. Where the flex on
# the PATH is that new (Homebrew's, on Apple silicon), flex 2.6.4 is built
# for this build; configure then takes that flex's own FlexLexer.h.
flex_num=$(flex --version | awk '{ split($2, v, "."); print v[1] * 10000 + v[2] * 100 + v[3] }')
if [ "$flex_num" -ge 20616 ]; then
  echo "flex $(flex --version | awk '{ print $2 }') is too new for Verilator $REV; building flex 2.6.4"
  curl -fsSL https://github.com/westes/flex/releases/download/v2.6.4/flex-2.6.4.tar.gz | tar -xz -C "$WORK"
  (cd "$WORK/flex-2.6.4" && ./configure --quiet --prefix="$WORK/flex" --disable-shared >/dev/null &&
     make -s -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" >/dev/null && make -s install >/dev/null)
  export PATH="$WORK/flex/bin:$PATH"
fi
./configure --quiet --prefix="$WORK/inst" LDFLAGS="$EXTRA_LDFLAGS" >/dev/null
make -s -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" >/dev/null
make -s install >/dev/null

EXE=""; case "$(uname -s)" in MINGW*|MSYS*) EXE=".exe" ;; esac
SHARE="$WORK/inst/share/verilator"
rm -rf "$OUT/bin" "$OUT/include"
mkdir -p "$OUT/bin"
# share/verilator/bin/verilator_bin is a Perl shim; the program is in bin/.
cp "$WORK/inst/bin/verilator_bin$EXE" "$OUT/bin/"
[ "$(head -c 2 "$OUT/bin/verilator_bin$EXE")" != "#!" ] || { echo "verilator_bin is a script, not the program" >&2; exit 1; }
cp -R "$SHARE/include" "$OUT/include"
case "$(uname -s)" in
  Darwin) strip -x "$OUT/bin/verilator_bin" ;;
  *)      strip "$OUT/bin/verilator_bin$EXE" ;;
esac
case "$(uname -s)" in MINGW*|MSYS*)
  ldd "$OUT/bin/verilator_bin.exe" | awk '$3 ~ /^\/(mingw64|ucrt64|clang64)\// { print $3 }' | sort -u | xargs -r -I{} cp {} "$OUT/bin/" ;;
esac
echo "$REV $(git log -1 --format=%H)" > "$OUT/VERSION"
cp "$WORK/src/LICENSE" "$OUT/LICENSE" 2>/dev/null || true
echo "Verilator $(cat "$OUT/VERSION") -> $OUT"
