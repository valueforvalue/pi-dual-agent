# Development Workflow

This repo (`C:\Development\pi-dual-agent`) is the **source of truth** for
`pi-dual-agent`. The **live install** at
`%USERPROFILE%\.pi\agent\extensions\pi-dual-agent` is just a deployment
target — pi loads the extension from there at runtime.

> **Do all editing in this dev repo. Never edit files in the live
> install directly.** Uncommitted changes in the install can be
> silently destroyed by a `git pull` or a `git reset --hard`, with
> no easy way to recover them. We learned this the hard way.

## The loop

1. **Edit, test, iterate** in this dev repo.
   - `cd C:\Development\pi-dual-agent`
   - Make your changes.
   - Run `node test/tool-guard.test.mjs` (no API key needed) to
     sanity-check the tool-guard logic.
   - Run the e2e test (`node test/e2e.mjs`) only when you actually
     want a real LLM call — it will incur cost.

2. **Commit** with a clear message.
   - `git add -A`
   - `git commit -m "..."`
   - One logical change per commit. Don't bundle unrelated edits.

3. **Push to origin**.
   - `git push origin master`
   - This is what makes the commit visible to the sync script (and
     to any other clones of the repo, e.g. on another machine).

4. **Sync to the live install**.
   - `scripts\sync-to-install.bat` (Windows)
   - or `./scripts/sync-to-install.sh` (Git Bash / macOS / Linux)
   - This does a `git pull --ff-only` in the install directory. It
     refuses to run if either the dev repo or the install has
     uncommitted changes — fail-fast is the right behaviour here.

5. **Reload pi** to pick up the new code.
   - `/reload` in the pi prompt.
   - Extensions are loaded once per session, so a reload is needed
     to see the changes take effect.

## Why fast-forward-only?

The sync script refuses non-fast-forward pulls. That means: if the
install ever gets a commit that origin/master doesn't, the sync
will fail rather than silently creating a merge commit.

In normal operation, this shouldn't happen — every edit goes through
this dev repo, gets committed, gets pushed, and then the install
fast-forwards. If the sync fails, it means someone bypassed the
workflow. Resolve it manually (rebase or reset) before re-running
the script.

## What about node_modules and other generated files?

- `node_modules/` is gitignored in both repos. `npm install` in
  either location is fine; the files are local to the clone.
- `package-lock.json` IS committed. If you bump a dependency in
  this dev repo and re-run `npm install`, commit the lockfile
  change alongside the source change. The install repo will pick
  it up on the next sync.

## One-shot recovery from a divergent state

If the live install is somehow out of date and the script refuses
to pull, you can force a resync by hand:

```bash
# In the install directory
cd %USERPROFILE%\.pi\agent\extensions\pi-dual-agent
# Save any local edits you want to keep
git stash
# Wipe local commits and align with origin
git fetch origin
git reset --hard origin/master
# Re-apply your stashed edits (resolve conflicts if any)
git stash pop
```

**Prefer the sync script** — it has the same effect, but it asks
before destroying anything.

## Why two clones instead of a symlink?

The dev repo and the install dir are two separate clones of the
same remote, by design. A symlink would couple them — if one
gets `git reset --hard`'d, both lose the change. Separate clones
mean a mistake in one is contained to that one.
