#!/usr/bin/env bash
#
# sync-to-install.sh
#
# Pulls the latest committed state from this dev repo into the live
# pi install location, so the installed copy always tracks what was
# committed (and pushed) from this repo.
#
# Why: the live install at ~/.pi/agent/extensions/pi-dual-agent is
# where pi actually loads the extension. If you edit the installed
# copy directly, those edits live only in the working tree of the
# install repo and can be destroyed by `git reset --hard` or a
# `git pull` — exactly the failure mode that bit us before. Doing
# all edits here in the dev repo, committing, pushing, and then
# running this script keeps the dev repo as the single source of
# truth.
#
# Usage:
#   ./scripts/sync-to-install.sh
#
# What it does:
#   1. Checks the dev repo is clean (uncommitted changes here would
#      be lost on the next commit anyway — fail fast so you don't
#      forget to commit them).
#   2. Verifies the dev repo is in sync with origin/master. If not,
#      it pushes — but only if a `origin` remote is configured and
#      reachable. Skips the push (with a warning) if you have no
#      network or no credentials.
#   3. In the install location, refuses to run if there are
#      uncommitted changes (they would be overwritten by the
#      fast-forward). The user must commit, stash, or discard them
#      manually before re-running.
#   4. `git pull --ff-only` in the install location. Refuses a
#      non-fast-forward merge, which would mean the install and
#      dev copies diverged — also a "stop and think" situation.
#
# Override the install path with PI_INSTALL_DIR if your install is
# not at the default location.

set -euo pipefail

# Resolve the dev repo root from the script's own location so the
# script works regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default install location. Override with PI_INSTALL_DIR=...
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.pi/agent/extensions/pi-dual-agent}"

# --- Colors for the warning/error lines (auto-disabled if no TTY) ---
if [ -t 1 ]; then
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  GREEN='\033[0;32m'
  NC='\033[0m'
else
  RED=''; YELLOW=''; GREEN=''; NC=''
fi

warn()  { printf "${YELLOW}warning:${NC} %s\n" "$*"; }
fail()  { printf "${RED}error:${NC} %s\n" "$*" >&2; exit 1; }
ok()    { printf "${GREEN}%s${NC}\n" "$*"; }

# --- Step 1: dev repo must be clean ---
cd "$DEV_DIR"
if ! git diff --quiet HEAD 2>/dev/null || ! git diff --cached --quiet HEAD 2>/dev/null; then
  fail "Dev repo has uncommitted changes. Commit them first:
       cd $DEV_DIR
       git add -A && git commit -m '...'
       Then re-run this script."
fi

# --- Step 2: dev repo should be in sync with origin/master ---
# Allow a missing/unreachable remote — fall through with a warning
# so the script still works offline as long as dev's HEAD already
# matches what the install needs.
if git remote get-url origin >/dev/null 2>&1; then
  if git fetch origin master 2>/dev/null; then
    DEV_HEAD="$(git rev-parse HEAD)"
    REMOTE_HEAD="$(git rev-parse origin/master)"
    if [ "$DEV_HEAD" != "$REMOTE_HEAD" ]; then
      # Dev is ahead of origin — try to push. If push fails (no
      # network, no creds), continue with a warning since the
      # install pull will work as long as origin is up to date
      # by the time it runs.
      if git push origin master 2>/dev/null; then
        ok "Pushed dev → origin/master"
      else
        warn "Could not push to origin. Install will pull once
origin is updated."
      fi
    fi
  else
    warn "Could not fetch origin. Proceeding with local dev HEAD."
  fi
else
  warn "No 'origin' remote configured. Skipping push check."
fi

# --- Step 3: install dir must exist and be a git repo ---
if [ ! -d "$INSTALL_DIR" ]; then
  fail "Install directory does not exist: $INSTALL_DIR
       Create it (e.g. by running 'pi install .' in the dev repo)
       or set PI_INSTALL_DIR to the correct path."
fi

cd "$INSTALL_DIR"
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail "Install directory is not a git repo: $INSTALL_DIR
       If you copied the files manually (not via git), initialise
       a repo there or re-install via 'pi install .'."
fi

# Refuse if install has uncommitted changes — those would be
# clobbered by the fast-forward pull.
if ! git diff --quiet HEAD 2>/dev/null || ! git diff --cached --quiet HEAD 2>/dev/null; then
  fail "Install repo has uncommitted changes:
       cd $INSTALL_DIR
       git status   # see what's there
       git stash    # save them
       # or: git checkout -- .   # discard them (CAREFUL)
       Then re-run this script."
fi

# --- Step 4: fast-forward pull ---
# --ff-only is the safety belt: if the install has diverged from
# origin/master (someone committed there directly), a regular
# `git pull` would silently create a merge commit. Refusing to
# merge forces the user to reconcile manually, which is the right
# thing when the goal of this workflow is to keep dev as the
# single source of truth.
if ! git pull --ff-only origin master 2>&1; then
  fail "Install repo has diverged from origin/master. Resolve manually:
       cd $INSTALL_DIR
       git status
       # either: rebase onto origin/master (preserves your commits
       #         on top of the new history), or
       #       reset --hard origin/master (discards local commits).
       Then re-run this script."
fi

ok "Synced. Install at $INSTALL_DIR is now at $(git rev-parse --short HEAD)."
