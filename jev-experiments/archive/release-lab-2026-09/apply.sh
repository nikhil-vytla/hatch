#!/bin/sh
set -eu
work=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$work/../.." && pwd)
cd "$root"
test -f "$work/ci/jev-checks.yml" || { echo 'Missing provider-free CI workflow source.' >&2; exit 1; }
git apply --check "$work/application.patch"
if [ -e .github/workflows/jev-checks.yml ] && ! cmp -s "$work/ci/jev-checks.yml" .github/workflows/jev-checks.yml; then
  echo 'Existing Jev CI workflow differs. Review it before applying this patch.' >&2
  exit 1
fi
git apply "$work/application.patch"
mkdir -p .github/workflows
cp "$work/ci/jev-checks.yml" .github/workflows/jev-checks.yml
printf '%s\n' 'Applied application changes and provider-free CI. Install Bun packages and run roadmap verification before release.'
