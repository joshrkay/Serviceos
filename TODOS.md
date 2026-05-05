# TODOS — Deferred from /autoplan (2026-04-16)

All 4 originally-deferred items have been closed in this PR. This file now
tracks follow-ups surfaced during /review that were intentionally not fixed.

---

## Executor double-execution on multi-instance deploys ✅ CLOSED

`packages/api/src/proposals/execution/executor.ts:17-72` checks
`proposal.status === 'approved'` from the in-memory object returned by
`findReadyForExecution`, runs the handler's side effects, THEN calls
`updateStatus('executed')`. With more than one API instance running, two
workers can both claim the same approved proposal via `findReadyForExecution`
and run the handler twice (customer created twice, appointment booked twice,
etc.).

This was surfaced during `/review` of PR #89 but explicitly deferred to keep
the P0-gap PR focused. Not a problem today because ServiceOS runs a single
Railway dyno, but any horizontal scale flips this on.

**Fix:** atomic claim via `UPDATE proposals SET status = 'executing' WHERE id
= $1 AND status = 'approved' RETURNING *` before running the handler. If the
update returns no row, another worker claimed it — skip. Add an `'executing'`
ProposalStatus (or a dedicated `claimed_by` + `claimed_at` column pair) and
thread it through the lifecycle.

**Effort:** ~30 min CC + careful thinking about crash recovery (what if the
handler crashes mid-execution — do we reset `executing` back to `approved` on
a timeout?). Flag before scaling past one dyno.
