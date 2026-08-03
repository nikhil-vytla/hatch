#!/bin/sh
# Stand-in agent task: shell-tool heavy. Search the stdlib tree for a symbol,
# inspect matches, apply an edit to a copied file. Exercises coreutils,
# grep/sed/find, i.e. the classic terminal-agent syscall surface.
set -e
mkdir -p /work
cd /usr/local/lib/python3.12
grep -rl "def bisect_right" . | head -5 > /work/hits.txt
find . -name "json" -maxdepth 2 -type d >> /work/hits.txt
cp ./bisect.py /work/bisect_patched.py
sed -i 's/def bisect_right/def bisect_right_patched/' /work/bisect_patched.py
wc -l /work/bisect_patched.py > /work/done.txt
cat /work/hits.txt /work/done.txt
