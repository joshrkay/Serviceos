# Track A2/A3 — PRD-vs-Code Reconciliation (run-1, 2026-07-10)

**Method:** every row verified against current `/packages` code (trust the code — Guardrail 3),
re-checking the seeded overclaims from the stale `docs/prd-v3-code-status.md` (dated 2026-06-20;
multiple W1 features have merged since). Status ∈ {built, partial, claimed-not-built, doc-drift}.
Independently corroborated by the discovery workflow's per-surface auditors + reconciliation agent.

## Headline

The 2026-06-20 status doc **materially under-counts the build** — nearly every item it flagged
"partial / not built" is now **shipped**. The docs lag the code, exactly as the mission predicted.
The genuine remaining gap this run found and fixed is the **brand-voice banned-phrase enforcement**
(soft prompt → code-level). RLS, money-idempotency, auth, and webhook-durability invariants all
hold with `file:line` evidence.

## Seeded overclaims — current status

| # | Claim (seed) | Status now | Evidence (file:line) |
|---|---|---|---|
| 1 | MMS-to-quote (image→estimate) | **built (intake+analysis)** | `sms/customer-mms/customer-mms-intake.ts`; vision analysis via `ai/gateway` + `ai/pg-diff-analysis.ts` (depth corroborated by workflow Comms/Estimates auditors) |
| 2 | ACH payments | **built** | `payments/payment-service.ts`, `payments/stripe-saved-card.ts`, `invoices/payment.ts`; regression `test/integration/ach-webhook.test.ts` (NSF/return reversal tested) |
| 3 | B2B account recognition | **built (beyond binary flag)** | `ai/agents/customer-calling/b2b-account-context.ts`; `test/integration/customer-account-type.test.ts`, `customer-parent-lookup.test.ts` (sub-accounts) |
| 4 | tech ETA texts | **built** | `sms/tech-status/handler.ts` (on-my-way / I'm-out → customer SMS); `scheduling/travel-time/` for drive-time |
| 5 | Inngest-vs-PgQueue mismatch | **resolved — no mismatch** | `workers/thank-you-sms-worker.ts:31` + `review-request-worker.ts:29` document "Why not Inngest: db-backed durable queues"; real impl `queues/pg-queue.ts` |
| 6 | conversational onboarding loop | **built** | `ai/orchestration/onboarding-conversation.ts`, `routes/onboarding-conversation.ts`, `ai/agents/onboarding/transitions.ts` |
| 7 | painting vertical pack | **built** | `verticals/packs/painting.ts`, registered in `verticals/registry.ts` |
| 8 | 2-hour delayed thank-you SMS | **built** | `workers/thank-you-sms-worker.ts` |

## Go-live hardening — re-verified

| Item | Status | Evidence |
|---|---|---|
| Webhook dedup durability | **built (DB-backed, durable)** | `webhook_events` table + `UNIQUE INDEX idx_webhook_idempotency ON webhook_events(source, idempotency_key)` (schema migration `012_create_webhook_events`); `webhooks/pg-webhook-event.ts` |
| Transaction rollback on 4xx/5xx | **built** | `db/tenant-transaction.ts`; corroborated by workflow Proposal/Money auditors |
| RLS FORCE on all entity tables | **built (2 documented exceptions, backstopped)** | schema.ts: 116 `tenant_id` tables all `FORCE ROW LEVEL SECURITY` except `oauth_states` + `platform_deprovision_log` (migration `218` COMMENT rationale; migration `219` REVOKEs the app-runtime role's grant on any tenant_id-without-RLS table; pinned by `test/db/schema.test.ts` RLS_EXEMPT_TABLES) |
| Authenticated proposal-approval endpoint | **built** | `routes/proposals.ts:4,98,156,173,255` — `requireAuth, requireTenant, requirePermission` on mutation routes |
| Leader-elected cron | **built** | advisory-lock leader election (`proposals/execution/idempotency-lock.ts`, `app.ts` sweep wiring) |
| Payment audit events | **built** | `payments/payment-service.ts` emits audit on payment mutations |
| 48h proposal-expiry default | **built** | `proposals/proposal.ts:770-772` — `expiresAt: input.expiresAt ?? defaultProposalExpiry(...)`; `SCHEDULE_PROPOSAL_EXPIRY_MS = 48h` (`proposal.ts:97`) |

## Genuine findings this run

| Finding | Severity | Category | Status |
|---|---|---|---|
| Brand-voice **banned phrases enforced only as a soft LLM prompt hint** (`prompts.ts:135`), no code-level post-generation validation — an owner's locked correction could still ship. Contradicts the composer's own "the model is never trusted" invariant (which it honors for `maxChars`). | high | brand-voice | **FIXED** — commit `be185d4`, `enforceBannedPhrases()` + 8 regression tests |
| Brand-voice **composer wired to only ~3 outbound surfaces** (reschedule drafts, dropped-call recovery, one `app.ts` path). "Every AI utterance sounds like the shop" (day-in-the-life #12) is only partially realized — dunning, digest, review responses, proposal SMS use separate drafting paths. | medium | brand-voice/persona-fit | **observation** (surface-coverage expansion is a larger change; flagged, not force-fixed) |

*(Additional workflow-confirmed defects appended in `05-findings-and-fixes.md` after adversarial verification.)*
