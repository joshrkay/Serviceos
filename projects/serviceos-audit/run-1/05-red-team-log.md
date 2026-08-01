# Track D — Red-Team Attack Log (run-1, 2026-07-10)

Each row is one attack **attempted** against the real code path, with its outcome and `file:line`
evidence (Guardrail 3). "Holds" = the attack failed to break the system and I can point at the code
that stopped it. Independent (orchestrator-run) attacks below; the discovery workflow's dedicated
red-team subagents corroborate and extend these (voice/LLM domain especially).

## Tenant isolation (RLS)

| # | Attack | Outcome | Evidence |
|---|---|---|---|
| T1 | Find any `tenant_id` table lacking FORCE RLS to read cross-tenant via the app role | **holds** | Runtime catalog test `test/integration/rls-force-catalog.test.ts` (added this run) proves all ~116 tenant tables `relforcerowsecurity=true` except the 2 documented exemptions |
| T2 | Reach an exempt table (`oauth_states`, `platform_deprovision_log`) under the app-runtime role to read all tenants | **holds** | schema.ts migration `219_rls_app_runtime_revoke_exempt` REVOKEs the app-runtime role's grant on any tenant_id-without-RLS table — the role literally cannot reach them; they're only touched via the privileged connection |
| T3 | Issue a tenant-path query with **no** `app.current_tenant_id` set (hope for NULL→all rows) | **holds (fail-closed)** | Policies use `current_setting('app.current_tenant_id')::UUID` without `missing_ok` → Postgres **errors** instead of returning rows; pinned by 8 cases in `tenant-isolation.leak.test.ts:989-1136` |
| T4 | Use a repo `findByTenant`/`findById` whose SQL forgot the `tenant_id` predicate (superuser pool bypasses RLS) | **holds** | RV-003 fixed the known offenders (users, pending_invitations, onboarding_session); `tenant-isolation.leak.test.ts` runs those repos through the SUPERUSER pool so the repo's own `WHERE tenant_id` is the only guard proven |
| T5 | Intentional cross-tenant sweep (execution worker) runs as an anonymous privileged query | **holds (auditable)** | `withCrossTenantSweep` runs under the **named** `rls_cross_tenant` BYPASSRLS role, reset on release (`rls-cross-tenant-sweep.test.ts` proves current_user + no pool leak) |

**Verdict: no cross-tenant leak found.** RLS FORCE is complete + fail-closed + backstopped by grant revocation.

## Money flow

| # | Attack | Outcome | Evidence |
|---|---|---|---|
| M1 | Slip a float/non-integer into a money field via tax/discount/fee math | **holds** | All money math funnels through `applyBps` (Math.round → integer) and integer arithmetic; property test `billing-engine.property.test.ts` asserts integer-cents on every `DocumentTotals` field over 16k randomized inputs |
| M2 | Drive `totalCents` negative with a pathological over-discount | **holds** | `calculateDocumentTotals` clamps `Math.max(0, …)` on total + fee base; property test asserts non-negativity under discount > subtotal |
| M3 | Replay a Stripe webhook to double-apply a payment | **holds (durable)** | DB-backed dedup: `webhook_events` + `UNIQUE INDEX idx_webhook_idempotency (source, idempotency_key)` (migration 012) — survives restart; `ach-webhook.test.ts`, `webhooks.test.ts` |
| M4 | Race two concurrent approvals/deliveries to execute the same proposal twice | **holds** | Atomic CAS claim: `claimForExecution` `UPDATE … WHERE id=$1 AND status='approved'` (`pg-proposal.ts:412-422`) — 2nd worker matches 0 rows; `payment-duplicate-race.test.ts`, `late-fee-idempotency.test.ts` |
| M5 | Negative/zero unit price or quantity into a line item | **holds** | `validateLineItem` rejects negative/non-integer `unitPriceCents` and negative quantity (`billing-engine.ts:214-233`) |

**Verdict: no money-integrity break found.**

## Auth / approval bypass

| # | Attack | Outcome | Evidence |
|---|---|---|---|
| A1 | Hit the proposal-approval endpoint unauthenticated | **holds** | `routes/proposals.ts` mutation routes chain `requireAuth, requireTenant, requirePermission` (`:98,156,173,255`) |
| A2 | Execute an **un-approved** proposal | **holds** | Execution reads only `status='approved'` (`pg-proposal.ts:400`); claim requires `status='approved'` (`:417`) |
| A3 | Approve/execute **another tenant's** proposal | **holds** | Proposal repo is tenant-scoped + RLS FORCE on `proposals`; cross-tenant `findById` returns null (`tenant-isolation.leak.test.ts` PgProposalRepository cases) |
| A4 | Double-execute via crash/stale-claim to re-run a side effect | **holds** | `resetStaleExecuting` only resets rows past a stale window with retry budget (`pg-proposal.ts:425-447`); idempotency-lock on execution |

**Verdict: no auth/approval bypass found.**

## Voice / LLM abuse (independent partial; workflow red-team extends)

| # | Attack | Outcome | Evidence |
|---|---|---|---|
| V1 | Caller free-text jailbreak flips brand-voice tone ("be casual and rude") | **holds** | Tone rendered as non-overridable system authority; caller context can never jailbreak it — `composer.test.ts:203` "tone is the authority" |
| V2 | LLM emits an owner-**banned** phrase (ignoring the negative prompt) → ships to customer | **was open → fixed this run** | Was enforced only as a prompt hint; now `enforceBannedPhrases` strips it in code before send (commit `be185d4`) |
| V3 | Uncatalogued AI price auto-approves past the catalog resolver | **holds (by design)** | CLAUDE.md invariant + `catalog-resolver.ts`: uncatalogued lines cap confidence below auto-approve threshold (corroborated by workflow Estimates/Voice auditors) |

**Criticals: 0.** The one open item (V2 banned-phrase enforcement) was fixed + regression-tested this run
and re-attacked (the composer test proves a banned phrase the model emits never reaches output).

*Additional workflow-confirmed attacks (if any survive adversarial verification) are appended after
the discovery run completes.*
