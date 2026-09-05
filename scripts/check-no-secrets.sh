#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Fails closed if anything that looks like a credential reached the tree.
#
# The repo is PRIVATE today but is intended to be published GPLv3, and git
# history outlives a visibility setting: a secret committed now is still in the
# history on the day it goes public. So this guards the working tree as if the
# repo were already public, which is the only assumption that stays safe.
#
# Run in CI and as a pre-commit hook.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Google AI keys are here because a real one was nearly pasted into the tree:
# the JWT pattern below does not match them, and the receipt scanner is the
# first feature that needs one. AIza... is the classic form, AQ.… the newer.
PATTERN='eyJ[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|AQ\.[A-Za-z0-9_-]{30,}|BEGIN .*PRIVATE KEY|password[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']'
# Only git-tracked files. Two reasons, and the second matters more: recursing
# the whole directory dragged in android/build and .gradle -- the 45MB APK and
# thousands of intermediates -- which took this hook from instant to minutes.
# It is also the correct scope. An untracked file cannot be committed, and a
# gitignored build artifact is not where a secret leaks from.
HITS=$(git ls-files -z 2>/dev/null   | xargs -0 grep -InE "$PATTERN" 2>/dev/null   | grep -v '^scripts/check-no-secrets\.sh:'   | grep -viE 'CHANGE_ME|placeholder|<your|example' || true)

if [ -n "$HITS" ]; then
  echo "Possible secret in the working tree:" >&2
  echo "$HITS" >&2
  exit 1
fi
echo "check-no-secrets: clean"
