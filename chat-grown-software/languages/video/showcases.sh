#!/bin/sh
# Record the five showcase transcripts as videos (videos/*.mp4).
cd "$(dirname "$0")/.."
S=${TMPDIR:-/tmp}
rec() { # name title transcript
  lines=$(grep -c . "$3"); speed=$(awk -v n="$lines" -v c="$(wc -c < "$3")" 'BEGIN { s = (n*0.35 + c*0.014) / 80; if (s < 1) s = 1; printf "%.2f", s }')
  node --experimental-strip-types --no-warnings video/build.ts text "$S/$1.json" "$2" "$speed" "$3" && node --experimental-strip-types --no-warnings video/record.ts "$S/$1.json" "videos/$1.mp4"
}
rec elixir-gateway-hot-deploy "Erlang/Elixir: hot-deploying an LLM gateway under live traffic" elixir/showcase/gateway-transcript.txt
rec clojure-gateway-code-as-data "Clojure: auditing an LLM gateway's billing code as data" clojure/showcase/gateway-transcript.txt
rec racket-prompt-injection "Racket: prompt-injected code changes vs. the kernel's gates" racket/showcase/injection-transcript.txt
rec lean-gateway-proved-quota "Lean 4: an LLM rate limiter whose quota law is proved" lean/showcase/gateway-transcript.txt
rec smalltalk-gateway-live-image "Pharo Smalltalk: the live image as an LLM gateway console" smalltalk/showcase/gateway-transcript.txt
