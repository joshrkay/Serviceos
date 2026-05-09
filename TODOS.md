# TODOS — Deferred from /autoplan (2026-04-16)

All 4 originally-deferred items have been closed in this PR. This file now
tracks follow-ups surfaced during /review that were intentionally not fixed.

---

## Executor double-execution on multi-instance deploys ✅ CLOSED

Surfaced during `/review` of PR #89 and originally deferred to keep that PR
focused. The fix shipped in commit `22f84b4` ("Add stale executing proposal
recovery with retry limits") and is safe for horizontal scale.

**What's in place:**

- `'executing'` lifecycle state with `claimed_by` / `claimed_at` /
  `execution_retry_count` columns (`packages/api/src/proposals/proposal.ts`,
  `packages/api/src/proposals/lifecycle.ts:11`).
- Atomic claim:
  `UPDATE proposals SET status = 'executing', claimed_by = $2, claimed_at = NOW() WHERE id = $1 AND status = 'approved' RETURNING *`
  in `PgProposalRepository.claimForExecution`
  (`packages/api/src/proposals/pg-proposal.ts:285-296`). Concurrent workers
  see at most one `RETURNING` row; losers get `null` and skip.
- Crash recovery via `PgProposalRepository.resetStaleExecuting`
  (`packages/api/src/proposals/pg-proposal.ts:298-325`): proposals stuck in
  `'executing'` past `staleMinutes` (default 10) are reset to `'approved'`
  with `execution_retry_count + 1`, or moved to `'execution_failed'` once
  retries reach `maxRetries` (default 3).
- Worker wiring: `runExecutionSweep`
  (`packages/api/src/workers/execution-worker.ts`) runs reset →
  `findReadyForExecution` → atomic claim → `executor.execute`. Driven from
  `packages/api/src/app.ts:1089-1101` on a 1s `setInterval`.
- Executor accepts both `'approved'` and `'executing'` so the claimed
  proposal flows through unchanged
  (`packages/api/src/proposals/execution/executor.ts:70`).

Safe to scale past one Railway dyno.
