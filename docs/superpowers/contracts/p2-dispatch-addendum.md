# Phase 2 (Proposal Engine + AI Safety) — Multi-Agent Dispatch Addendum

This addendum extends `docs/stories/phase-2-gap-stories.md` with the metadata needed to dispatch each story to a Claude agent running in an isolated worktree.

For every story, the agent prompt should include:
- The full body of the story from `phase-2-gap-stories.md`
- This addendum's per-story block
- `repository-conventions.md` and `freeze-list.md` from `docs/superpowers/contracts/`

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 2-Wave-C0 | P2-034, P2-035 | parallel (disjoint files) | unblocks Wave C1: P6-028 |

P2-034 (inbound SMS dispatcher) and P2-035 (APPROVE ALL endpoint) ship together as part of Wave C blockers. They touch disjoint files and can run as parallel agents. See `docs/superpowers/plans/2026-05-17-wave-c-bad-day-recovery.md` for the wave-level context.

---

## P2-034 — Inbound SMS content dispatcher

**Wave:** 2-Wave-C0 (Wave-C blocker B3)
**Migration number reserved:** none (no schema change)
**Forbidden files:**
- `packages/api/src/sms/tech-status/**` (P6-028 owns these — this story only adds the dispatcher surface)
- `packages/api/src/notifications/**` (outbound SMS is unaffected)
- `packages/api/src/telephony/twilio-signature.ts` (signature verification is reused, not modified)
- `packages/shared/**`
- `packages/api/src/db/**`

**Allowed files (concrete list):**
- `packages/api/src/sms/inbound-dispatch.ts` (new)
- `packages/api/src/sms/inbound-dispatch.test.ts` (new)
- `packages/api/src/webhooks/routes.ts` (modify — invoke dispatcher after `markProcessed` on the `recordTwilio('sms')` arm only)
- `packages/api/src/webhooks/routes.test.ts` (modify — add a passing-keyword test if not present)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run -t "P2-034|inbound-dispatch|recordTwilio"
```

**Pre-flight:** none (the signature path + idempotency path are already on main).

**Risk note:**
- **Never throw out of the dispatcher.** Twilio retries on 5xx; a buggy handler that throws would cause unlimited message resends. Catch + audit + return `{handled: false}`.
- **Registry mutated only at module-init time.** Do NOT support runtime registration — it would create a race against module-load order and make tests flaky. Handlers register at import time via a top-level side effect or an explicit `registerKeywordHandler()` call from a known init module.
- **Case-insensitive, trimmed.** "OUT" / "out" / "  OUT  " must all match. Use `body.trim().split(/\s+/)[0].toUpperCase()`.

**Implementation hints:**
1. Read `webhooks/routes.ts` lines 1235–1245 first. The structure is: signature verify → `recordReceipt` → `markProcessed` → return 200. Insert the dispatch call between `markProcessed` and the 200.
2. The dispatcher signature is `dispatchInboundSms(ctx): Promise<{handled, handler?, reason?}>` — log the result via the existing audit repo (`auditRepo.record('sms.inbound.dispatched', {...})`) but do not surface anything to Twilio beyond the existing 200.
3. The keyword router is a `Map<string, KeywordHandler>` keyed by uppercased keyword. The handler advertises its keywords; the registrar populates the map and throws on collisions.
4. Do NOT couple to P6-028's tech-status handler in this story — it lands as part of P6-028's PR. The dispatcher's only test fixtures are mock handlers.

---

## P2-035 — Batch proposal approval (APPROVE ALL)

**Wave:** 2-Wave-C0 (Wave-C blocker B2)
**Migration number reserved:** none (no schema change)
**Forbidden files:**
- `packages/api/src/proposals/contracts.ts` (proposal contracts are Tier 2 STABLE)
- `packages/api/src/proposals/proposal.ts` (P7-026 owns the additive `ProposalType` enum bump separately)
- `packages/api/src/proposals/auto-approve.ts` (auto-approve is confidence-based; batch approval is owner-initiated — different surface)
- `packages/api/src/proposals/execution/**` (execution path is unchanged — re-uses `approveProposal()`)
- `packages/shared/**`
- `packages/api/src/db/**`

**Allowed files (concrete list):**
- `packages/api/src/proposals/actions.ts` (modify — add `approveProposalsBatch()`)
- `packages/api/src/proposals/actions.test.ts` (modify — add batch tests)
- `packages/api/src/routes/proposals.ts` (modify — add POST `/api/proposals/approve-batch`)
- `packages/api/src/routes/proposals.test.ts` (modify — add route tests)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run -t "P2-035|approveProposalsBatch|approve-batch"
```

**Pre-flight:** none.

**Risk note:**
- **No cross-proposal transaction.** Wrapping the batch in a single transaction would mean one stale ID rolls back all approvals — the opposite of what owners expect ("approve everything you can"). Per-proposal `approveProposal()` calls; accumulate `failed[]`.
- **Per-proposal RBAC.** Authorization happens inside `approveProposal()`, not at the route boundary alone. If one ID belongs to a different tenant or a status that this role can't approve, that specific ID lands in `failed[]` with a clear `reason`.
- **One audit event per approval.** Do NOT collapse into a "batch_approve" event — downstream consumers (audit log UI, exports) already index per-proposal events.
- **Cap at 50.** This is a UX feature, not a bulk admin tool. 50 is the practical owner-tap ceiling; anything larger is suspicious and should be rejected with a 400.

**Implementation hints:**
1. Read `routes/proposals.ts:97–130` first. The singular `POST /:id/approve` is the template — extract the body shape and Zod schema for re-use.
2. The batch route accepts `{proposalIds: string[]}`; the body validator is `z.object({ proposalIds: z.array(z.string().uuid()).min(1).max(50) })`.
3. The action function preserves order (`failed[]` entries reference the input ID, not an index).
4. RBAC at the route is `requirePermission('proposals:approve')` — same as the singular endpoint. Per-proposal RBAC inside `approveProposal()` is unchanged.
5. Audit: each successful `approveProposal()` call already emits `proposal.approved` via the existing audit repo; do nothing additional.

---

## Universal pre-flight checks

Same as `p0-dispatch-addendum.md` § Universal pre-flight checks. Apply to every Phase 2 story before launching the dispatch agent.
