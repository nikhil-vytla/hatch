#!/bin/sh
D=$(cd "$(dirname "$0")/.." && pwd)
rm -rf /tmp/kernel-gateway-showcase
cd "$D" && SCENARIO=gateway exec java -Xlog:disable -cp "$(cat build/classpath.txt)" clojure.main showcase/gateway_demo.clj
