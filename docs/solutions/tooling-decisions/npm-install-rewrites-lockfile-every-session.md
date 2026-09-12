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

**The implementation is `install_dependencies()` in
`.claude/hooks/session-start.sh`. Read it there; it is not reproduced here.**

An earlier draft of this note pasted the function inline, and that copy was
still the **first** version after the shipping hook had been through five more
rounds of fixes — so the "reusable snippet" in the knowledge base was the one
with the known bugs in it. Caught in review (Codex P2, PR #994).

A solutions note that duplicates code becomes a second thing to keep correct,
and the copy nobody runs is the one that rots. What is worth recording here is
the *shape* of the problem and the cases the implementation has to handle —
that list is durable, the code is not:

| Case | Required behaviour |
|---|---|
| `npm ci` succeeds | nothing else happens |
| ci fails, `npm install` rewrites the lockfile | restore the snapshot |
| ci fails, lockfile untouched | leave it |
| both fail | leave it |
| **lockfile absent** before the hook ran | delete one the fallback created |
| **lockfile zero bytes** before the hook ran | restore it; do not treat empty as missing |
| snapshot cannot be taken | **skip the fallback** — an install with no undo is worse than no install |
| `INT`/`TERM`/`HUP` mid-install | restore from a trap, then **exit** `128+n`; do not resume |
| signal *during* the restore | re-entrant call must redo it, not skip it |

Every row after the fourth was a separate review finding, and four of them were
introduced by the fix before them.

### The fallback needed a second pass

The first version of this fix ran a bare `npm install` in the fallback and told
the reader *"if package-lock.json is modified after this, the change is REAL:
review and commit it deliberately."* **That is right for one of the two failure
causes and actively wrong for the other**, and the hook cannot distinguish them:

- **package.json really diverged** → the fallback's lockfile change is meaningful.
- **registry unreachable** → a warm npm cache can still let `npm install`
  succeed, and its only change is the `libc` stripping. The warning would then
  be telling someone to commit the exact musl regression this fix exists to
  prevent.

Caught in review on PR #994. The fallback now snapshots the lockfile, runs
`npm install` for its `node_modules`, and restores the file if it changed —
saying loudly that it did so and that a genuine mismatch has to be regenerated
deliberately. **The invariant now holds on every path: the hook never writes
`package-lock.json`, so a dirty lockfile always means a human did it.**

The `set -euo pipefail` at the top of the hook is why a fallback exists at all: a
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
