#!/bin/sh
D=$(cd "$(dirname "$0")/.." && pwd)
cd "$D" && exec java -Xlog:disable -cp "$(cat build/classpath.txt)" clojure.main showcase/demo.clj
