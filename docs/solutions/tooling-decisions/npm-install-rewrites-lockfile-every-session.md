---
module: tooling-session-start
tags: [npm, package-lock, libc, musl, claude-code-remote, session-start-hook, git-hygiene]
problem_type: environment-failure
---

# `npm install` in the session-start hook rewrote package-lock.json every session

## Symptom

Every Claude Code remote session opened with a dirty working tree:

```
$ git status --short
 M package-lock.json

$ git diff --numstat package-lock.json
0	42	package-lock.json
```

42 deletions, **0 additions**, in a session where nobody touched a dependency.
The stop hook (`~/.claude/stop-hook-git-check.sh`) then refused to let the
session end: *"There are uncommitted changes in the repository."*

The diff was always identical — 14 blocks of:

```diff
       "dev": true,
-      "libc": [
-        "glibc"
-      ],
       "license": "MIT",
```

## Why it happened

`.claude/hooks/session-start.sh` ran `npm install` to bootstrap the workspace.
Under this image's npm (10.9.7 / Node 22.22.2), `npm install` **strips the
`libc` field** from 14 Linux native-binary optional dependencies:
`@tailwindcss/oxide-linux-*`, `@rolldown/binding-linux-*-musl` and siblings.

`npm install` is allowed to rewrite the lockfile — that is its job. `npm ci` is
the one that is not.

## Why this was not cosmetic

The tempting read is "lockfile metadata noise, just revert it." Two things make
that wrong:

1. **`libc` is functional.** npm uses it to select the glibc vs musl build of a
   native binary. Dropping it is a regression for any musl/Alpine environment,
   not a formatting change. Committing the stripped version would have shipped
   that regression.
2. **It trained the stop hook to cry wolf.** A tree that is *always* dirty is a
   tree where nobody reads the diff. The signal was destroyed for every real
   lockfile change that might follow.

It was reverted by hand four times in one session before being fixed properly.

## Fix

`.claude/hooks/session-start.sh` now uses `npm ci`, wrapped so a failure cannot
abort the rest of the hook:

```bash
install_dependencies() {
  echo "[session-start] Installing workspace dependencies (npm ci)…"
  if npm ci; then
    return 0
  fi
  # npm ci fails hard when package.json and package-lock.json disagree.
  # That is a real signal — but it must not leave the session without
  # node_modules, and `set -e` would otherwise abort before Docker starts.
  echo "[session-start] WARNING: npm ci failed — …falling back to npm install…"
  npm install || echo "[session-start] WARNING: npm install also failed…"
}
```

The `set -euo pipefail` at the top of the hook is why the fallback matters: a
bare `npm ci` that fails would kill the hook at step 1, so the Docker daemon
would never start and the integration testcontainer images would never be
pre-pulled. The symptom would present as *"integration tests are broken"*, far
from its cause.

## Cost, measured in this image

| Command | Wall time | Touches the lockfile? |
|---|---|---|
| `npm install` (warm) | **4.8s** | Yes — 42 deletions, every run |
| `npm ci` | **32.7s** | **No** |

~28s per session start. That is the price of a reproducible tree and a
`git status` worth reading.

## The property worth keeping

With `npm ci` as the default path, **a dirty `package-lock.json` now means
something.** Before this change the correct response was "revert it, it's
noise." After it, the correct response is "read it — something really did
change." The fallback branch says so explicitly in its warning text, because the
one case that still runs `npm install` is the case where the lockfile genuinely
is out of sync.

## Related

- `docs/solutions/test-failures/docker-hub-cdn-blocked-in-remote-sessions.md` —
  the other session-start hook fix, same file, same class of problem.
