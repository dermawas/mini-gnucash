#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Fails closed if anything that looks like a credential reached the tree.
# This repo is public from its first commit, which is deliberately a stronger
# position than its predecessor: there is no private history for a secret to
# hide in, so the only thing to guard is the working tree.
#
# Run in CI and as a pre-commit hook.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PATTERN='eyJ[A-Za-z0-9_-]{20,}|BEGIN .*PRIVATE KEY|password[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']'
HITS=$(grep -rInE "$PATTERN" . \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.expo \
  --exclude=check-no-secrets.sh 2>/dev/null \
  | grep -viE 'CHANGE_ME|placeholder|<your|example' || true)

if [ -n "$HITS" ]; then
  echo "Possible secret in the working tree:" >&2
  echo "$HITS" >&2
  exit 1
fi
echo "check-no-secrets: clean"
