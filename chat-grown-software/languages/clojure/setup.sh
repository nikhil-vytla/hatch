#!/bin/sh
# One-time (idempotent): resolve deps, AOT-compile the kernel into build/classes, write the runtime classpath,
# and warm an AppCDS archive so run.sh starts fast.
set -e
D=$(cd "$(dirname "$0")" && pwd)
cd "$D"
mkdir -p build/classes
export CLJ_CACHE="$D/build/cpcache"
CP=$(clojure -Spath)
rm -rf build/classes/*
clojure -M -e "(binding [*compile-path* \"build/classes\"] (compile 'kernel.main))" >&2
jar cf build/kernel.jar -C build/classes . 
JARS=$(echo "$CP" | tr ':' '\n' | grep -v '^src$' | tr '\n' ':')
echo "$D/build/kernel.jar:${JARS%:}" > build/classpath.txt
rm -f build/kernel.jsa
W=$(mktemp -d)
echo '{"op":"observe"}' | "$D/run.sh" "$W" >/dev/null 2>&1 || true
rm -rf "$W"
