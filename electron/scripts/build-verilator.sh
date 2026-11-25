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
# Homebrew's flex generates the lexer, so its FlexLexer.h has to be the one
# included, not the copy in Apple's SDK, which declares a different class.
EXTRA_CPPFLAGS=""
if [ "$(uname -s)" = Darwin ] && command -v brew >/dev/null; then
  FLEX_PREFIX=$(brew --prefix flex)
  export LEX="$FLEX_PREFIX/bin/flex"
  EXTRA_CPPFLAGS="-I$FLEX_PREFIX/include"
  echo "flex: $LEX ($("$LEX" --version)), FlexLexer.h:"
  ls -l "$FLEX_PREFIX/include" || true
  for h in "$FLEX_PREFIX/include/FlexLexer.h" "$(xcrun --show-sdk-path 2>/dev/null)/usr/include/FlexLexer.h"; do
    if [ -f "$h" ]; then echo "  $h: $(grep -c yyread "$h" || true) yyread"; fi
  done
fi
./configure --quiet --prefix="$WORK/inst" CPPFLAGS="$EXTRA_CPPFLAGS" LDFLAGS="$EXTRA_LDFLAGS" >/dev/null
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
