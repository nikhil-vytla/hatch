#!/bin/sh
D=$(cd "$(dirname "$0")" && pwd)
[ -f "$D/build/classpath.txt" ] || "$D/setup.sh" >&2
exec java -Xlog:disable -Xlog:all=off -XX:+UseSerialGC -XX:TieredStopAtLevel=1 -Xshare:auto \
  -XX:+AutoCreateSharedArchive -XX:SharedArchiveFile="$D/build/kernel.jsa" \
  -cp "$(cat "$D/build/classpath.txt")" kernel.main "${1:-$D/data}"
