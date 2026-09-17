# API make-it-work pass — 2026-09-17

Scope: `packages/api`, shared libs, `scripts/smoke.sh`, env-verify scripts, on
branch `albert/claude-sonnet-buildout` (isolated worktree
`/Users/macmini/Serviceos-worktrees/sonnet`).

## What was fixed

Three test files had drifted out of sync with the source they pin against:

1. **`packages/api/test/ai/voice-turn/voice-turn-processor.test.ts`**
   The I6 off-surface-injection test ("an S2 operation surfaced on the
   untrusted S1 surface is denied") destructured `auditRepo` from `makeCtx()`
   but the destructure was missing `auditRepo`, so later assertions against
   `auditRepo.getAll()` referenced an out-of-scope variable. Added
   `auditRepo` to the destructure.

2. **`packages/api/test/invariants/i1-no-ai-repository-writes.structural.test.ts`**
   Two `KNOWN_VIOLATIONS` entries pin exact line numbers in
   `create-voice-turn-processor.ts` (`callMeBackRepo.create` and the E1
   appointment-cancel write). The source had shifted since those lines were
   recorded (`2698`→`2715`, `2863`→`2880`). Updated both to the current
   line numbers; verified against the live source that each line still
   contains the exact statement the entry describes.

3. **`packages/api/test/invariants/i9-one-totals-engine.structural.test.ts`**
   Same drift pattern: the unrounded-subtotal violation pinned at
   `create-voice-turn-processor.ts:443` had shifted to `:444` (verified the
   line is `return sum + (typeof li.unitPrice === 'number' ? li.unitPrice * qty : 0);`).
   Updated the doc-comment reference and the `CLASSIFIED` entry.

These are documentation/pin-style structural tests (they assert that a
recorded violation still lives at the line the reviewer verified, so silent
line drift doesn't quietly invalidate the audit trail) — no production code
changed.

## Verification

```bash
# Production build typecheck (Railway's tsconfig) — clean
cd packages/api && npx tsc --project tsconfig.build.json --noEmit

# The three touched files
npx vitest run \
  test/ai/voice-turn/voice-turn-processor.test.ts \
  test/invariants/i1-no-ai-repository-writes.structural.test.ts \
  test/invariants/i9-one-totals-engine.structural.test.ts
# → 3 files passed, 98 passed | 2 expected fail (100)

# Full API unit suite
npx vitest run
# → 1257 files passed, 1 file failed (1263)
#   16295 passed | 10 expected fail | 13 skipped | 38 todo (16357)
```

## Remaining API risk

- **`test/ai/gateway/breaker-abort-cascade.test.ts` — variation C is flaky
  under full-suite load.** Failed once in the full 1263-file run
  (`expected Error: boom {status:503} to be an instance of BreakerOpenError`)
  but passed 3/3 in isolated reruns immediately after. This is a
  timing-sensitive circuit-breaker half-open-recovery assertion; under full
  parallel-worker CPU contention its internal timers apparently drift enough
  to miss the open→half-open transition window. Not touched in this pass —
  pre-existing flakiness, not caused by the changes above, and no
  intersection with the files changed here. Worth a follow-up to make the
  breaker test clock-mocked (fake timers) instead of relying on real
  `setTimeout` windows, so it's deterministic under load.
- `scripts/smoke.sh` and the deployed-voice-path (Layer 3) were not
  exercised — they need a running API + Postgres + a `SMOKE_API_TOKEN`,
  none of which were available in this pass (disk headroom on the host was
  constrained to ~1GB for most of this session, so no new services/DB
  containers were started; Layer 1/2 of smoke.sh were not run for the same
  reason — Layer 2 alone is a full boot of the voice-action-router, which
  is redundant with the unit suite above and adds import-time risk on tight
  disk).
- Host disk headroom recovered from ~127MB free to ~1.1GB free partway
  through this session, but the underlying host-wide APFS container is at
  ~99% capacity across multiple worktrees/checkouts unrelated to this repo.
  If disk fills again mid-run, `npx vitest`/`npx tsc` may fail with ENOSPC
  rather than a real code failure — worth ruling out disk first before
  trusting a red run on this host.

## Verify locally

```bash
cd packages/api
npx tsc --project tsconfig.build.json --noEmit
npx vitest run
```
