#!/bin/sh
# Repetitions of the DeepSeek benchmark: reps.sh <lang> <first-rep> <last-rep> [scenarios...]
# Results go to results/<scenario>-<lang>-r<rep>/.
cd "$(dirname "$0")"
lang=$1; first=$2; last=$3; shift 3
for rep in $(seq "$first" "$last"); do
  for sc in ${@:-expenses gateway}; do
    SCENARIO=$sc NODE_USE_ENV_PROXY=1 timeout 2400 node --experimental-strip-types --no-warnings grow.ts "$lang" --out "../results/$sc-$lang-r$rep" > "../results/$sc-$lang-r$rep.log" 2>&1
    tail -1 "../results/$sc-$lang-r$rep.log"
  done
done
