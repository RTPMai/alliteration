#!/usr/bin/env bash
# alliteration. — test runner
#
#   bash test/run.sh
#
# Every change runs this. Never let the suite go red.

set -uo pipefail
cd "$(dirname "$0")/.."

echo ""
echo "alliteration. test suite"
echo "========================"

status=0

for f in test/*.test.cjs; do
  echo ""
  echo "$(basename "$f")"
  if ! node "$f"; then
    status=1
  fi
done

echo ""
if [ "$status" -eq 0 ]; then
  echo "SUITE GREEN"
else
  echo "SUITE RED"
fi
echo ""

exit "$status"
