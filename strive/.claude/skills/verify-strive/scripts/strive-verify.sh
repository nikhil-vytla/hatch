#!/bin/sh
# Drive a real, isolated strive for verification. Each run NAME gets its own
# STRIVE_HOME and tmux session, so runs never touch the user's daemon.
set -eu
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
EVIDENCE="$ROOT/.audit/evidence"
cmd="${1:-help}"; name="${2:-}"
home="/tmp/strv-verify-$name"
sess="strv-verify-$name"
bin="${STRIVE_VERIFY_BIN:-$ROOT/target/debug/strive}"

need_name() { [ -n "$name" ] || { echo "usage: $0 $cmd NAME ..." >&2; exit 2; }; }

case "$cmd" in
  build)
    cd "$ROOT" && cargo build --quiet && bun install --silent >/dev/null && echo "built $bin" ;;
  start)
    need_name; repo="${3:-$ROOT}"; shift $(( $# < 3 ? $# : 3 ))
    tmux has-session -t "$sess" 2>/dev/null && { echo "run $name already exists; stop it first" >&2; exit 1; }
    mkdir -p "$home" "$EVIDENCE/$name"
    tmux new-session -d -s "$sess" -x 110 -y 32 -c "$repo" \
      "STRIVE_HOME=$home STRIVE_TUI='bun $ROOT/packages/tui/src/main.ts' $bin $*; echo \"[strive exited \$?]\"; sleep 600"
    "$0" wait "$name" "strive" 5 >/dev/null && echo "started $name in $repo (STRIVE_HOME=$home)" ;;
  restart)
    # Quit the TUI and open it again in the same home and directory, with new strive args.
    need_name; repo="$3"; shift 3
    tmux kill-session -t "$sess" 2>/dev/null || true
    tmux new-session -d -s "$sess" -x 110 -y 32 -c "$repo" \
      "STRIVE_HOME=$home STRIVE_TUI='bun $ROOT/packages/tui/src/main.ts' $bin $*; echo \"[strive exited \$?]\"; sleep 600"
    "$0" wait "$name" "strive" 5 >/dev/null && echo "restarted $name in $repo with: strive $*" ;;
  journal)
    # Path of a session's journal in this run's home, for tamper checks.
    need_name; echo "$home/sessions/$3/journal.jsonl" ;;
  cli)
    need_name; shift 2
    out="$(STRIVE_HOME=$home "$bin" "$@" 2>&1)" && code=0 || code=$?
    printf '$ strive %s\n%s\n[exit %s]\n' "$*" "$out" "$code" | tee -a "$EVIDENCE/$name/cli.txt" ;;
  type)
    need_name; tmux send-keys -t "$sess" -l "$3"; sleep 0.15 ;;
  key)
    need_name; tmux send-keys -t "$sess" "$3"; sleep 0.15 ;;
  send)
    need_name; tmux send-keys -t "$sess" -l "$3"; sleep 0.15
    case "$3" in /*) tmux send-keys -t "$sess" Escape; sleep 0.05 ;; esac
    tmux send-keys -t "$sess" Enter; sleep 0.2 ;;
  screen)
    need_name; tmux capture-pane -t "$sess" -p ;;
  wait)
    need_name; text="$3"; timeout="${4:-5}"; i=0
    while ! tmux capture-pane -t "$sess" -p | grep -qF -- "$text"; do
      i=$((i+1)); [ "$i" -gt "$((timeout*20))" ] && { echo "timed out waiting for: $text" >&2; tmux capture-pane -t "$sess" -p >&2; exit 1; }
      sleep 0.05
    done
    tmux capture-pane -t "$sess" -p ;;
  snap)
    need_name; label="$3"; f="$EVIDENCE/$name/$label.txt"
    tmux capture-pane -t "$sess" -p > "$f" && echo "$f" ;;
  doctor)
    need_name
    tmux has-session -t "$sess" 2>/dev/null && echo "tmux session: $sess" || echo "tmux session: none"
    STRIVE_HOME=$home "$bin" status 2>&1 || true ;;
  stop)
    need_name
    STRIVE_HOME=$home "$bin" stop >/dev/null 2>&1 || true
    tmux kill-session -t "$sess" 2>/dev/null || true
    rm -rf "$home"
    echo "stopped $name; evidence kept in $EVIDENCE/$name" ;;
  *)
    echo "usage: $0 build | start NAME [REPO [STRIVE_ARGS...]] | restart NAME REPO [STRIVE_ARGS...] | journal NAME SESSION_ID | send NAME TEXT | type NAME TEXT | key NAME KEY | wait NAME TEXT [SECS] | screen NAME | snap NAME LABEL | cli NAME ARGS... | doctor NAME | stop NAME" ;;
esac
