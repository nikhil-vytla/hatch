#!/usr/bin/env bash
# Run one task inside the extracted-rootfs chroot under strace, capturing
# every file open, read, pread and file-backed mmap with fd->path resolution
# (-y). Produces traces/<task>.raw for the analyzer.
#
# Usage: ./trace_task.sh task_csv_report
set -euo pipefail
cd "$(dirname "$0")"

TASK="$1"
ROOTFS=./image/rootfs
OUT=./traces/"$TASK".raw

sudo rm -rf "$ROOTFS/work" "$ROOTFS/task"
mkdir -p "$ROOTFS/task"
cp "tasks/$TASK.sh" "$ROOTFS/task/"
chmod +x "$ROOTFS/task/$TASK.sh"

sudo strace -f -qq -y \
    -e trace=openat,open,read,pread64,mmap,execve \
    -o "$OUT" \
    chroot "$ROOTFS" /bin/sh "/task/$TASK.sh" > "./traces/$TASK.stdout" 2>&1 \
    || { echo "task failed, see traces/$TASK.stdout"; exit 1; }

sudo chown "$(id -u):$(id -g)" "$OUT"
echo "traced $TASK: $(wc -l < "$OUT") syscall lines"
