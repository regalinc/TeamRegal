#!/usr/bin/env bash
# Commits + pushes whatever scripts/sync.js just wrote under docs/data, called
# by the "Commit updated data" step of .github/workflows/sync.yml.
#
# Why this is a script and not inline YAML: the sync itself takes ~20 minutes,
# and anything else that pushes to main in that time (the hourly Bouncie bot,
# the local refresh scripts, a human commit) makes a plain
# `git push origin HEAD:main` fail as non-fast-forward -- discarding the whole
# 20 minutes of work at the last second. ~13 of every 100 runs died that way
# (found 2026-11-02; every failure window had another push inside it).
#
# So instead: stash the files this run changed, re-sync to the CURRENT origin/main,
# lay those files back on top, commit, push, and retry on a lost race. Only the
# files this run actually changed are carried over, so a stale copy of another
# workflow's data (e.g. bouncie.json) can never overwrite its newer version.
#
# Env overrides (used by the local test): SUBJECT, MAX_ATTEMPTS, RETRY_SLEEP.

set -euo pipefail

SUBJECT="${SUBJECT:-Sync Housecall Pro data [skip ci]}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-5}"
RETRY_SLEEP="${RETRY_SLEEP:-5}"

git config user.name "hcp-sync-bot"
git config user.email "actions@users.noreply.github.com"

# Files this run changed (modified or new), relative to the checkout.
mapfile -t CHANGED < <(git status --porcelain --untracked-files=all -- docs/data | sed 's/^...//')
if [ "${#CHANGED[@]}" -eq 0 ]; then
  echo "No data changes."
  exit 0
fi

STASH="$(mktemp -d)"
trap 'rm -rf "$STASH"' EXIT
for f in "${CHANGED[@]}"; do
  mkdir -p "$STASH/$(dirname "$f")"
  cp "$f" "$STASH/$f"
done
echo "Carrying ${#CHANGED[@]} changed file(s): ${CHANGED[*]}"

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  # Start from the newest main every attempt, then put this run's data on top.
  git fetch -q origin main
  git reset -q --hard origin/main
  for f in "${CHANGED[@]}"; do
    mkdir -p "$(dirname "$f")"
    cp "$STASH/$f" "$f"
  done
  git add -- "${CHANGED[@]}"

  if git diff --cached --quiet; then
    echo "Already identical to origin/main; nothing to commit."
    exit 0
  fi

  # Consecutive bot-only data commits are collapsed into one (amend +
  # force-push) so a 1-hour cadence doesn't bloat history -- same convention
  # as before. Only amend if HEAD is exactly this workflow's own previous
  # commit AND has a parent (amending a parentless HEAD would orphan the
  # branch). The lease pins the SHA we just fetched, so if anyone pushed since,
  # the push fails safely and the next attempt starts over from the new tip.
  if [ "$(git log -1 --pretty=%s)" = "$SUBJECT" ] && git rev-parse -q --verify HEAD^ >/dev/null; then
    TIP="$(git rev-parse HEAD)"
    git commit --amend -q -m "$SUBJECT"
    PUSH=(git push --force-with-lease="main:$TIP" origin HEAD:main)
  else
    git commit -q -m "$SUBJECT"
    PUSH=(git push origin HEAD:main)
  fi

  if "${PUSH[@]}"; then
    echo "Pushed on attempt $attempt."
    exit 0
  fi

  echo "Push lost a race on attempt $attempt/$MAX_ATTEMPTS; retrying on the newest main."
  sleep "$RETRY_SLEEP"
done

echo "Could not push after $MAX_ATTEMPTS attempts." >&2
exit 1
