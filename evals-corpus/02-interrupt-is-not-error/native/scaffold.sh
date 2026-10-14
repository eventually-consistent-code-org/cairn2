#!/bin/bash

########################
# Script by John Reed  #
# 2026-10-13           #
########################

# Builds the review-corpus workspace for corpus/02-interrupt-is-not-error (issue #334):
#   main               the fix's state of the files it touched
#   corpus/02-interrupt-is-not-error   that state with the fix reverted -- the defect, back
# Runs in the harness's empty workspace before the agent starts.

set -euo pipefail
case_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "building corpus workspace for corpus/02-interrupt-is-not-error..."
git init -q -b main .
cp -R "$case_dir/fixture/." .
git add -A
git -c user.name="cairn corpus" -c user.email="corpus@invalid" commit -q --no-verify -m "baseline"
git checkout -q -b corpus/02-interrupt-is-not-error
git apply --whitespace=nowarn "$case_dir/revert.patch"
git add -A
git -c user.name="cairn corpus" -c user.email="corpus@invalid" commit -q --no-verify -m "candidate change"
git checkout -q main
echo "corpus workspace ready: main and corpus/02-interrupt-is-not-error."
