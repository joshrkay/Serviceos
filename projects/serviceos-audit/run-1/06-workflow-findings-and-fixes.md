# Track A4/D/E — Verified Findings, Fixes & Held Items (run-1)

The discovery workflow ran **41 agents** (12 per-surface auditors + red team, then a fresh-context
adversarial **verify** pass over every high/critical). **29 items verified → 25 CONFIRMED.** Auditors
over-report; the verify pass is the authority. Each item below carries its verify verdict and the
minimal fix. Money/RLS/auth fixes are **held for human review** (Guardrail 1b); the rest are fixed
inline or documented (Guardrail 5 — strong 80%, note what's cut).

## ✅ Fixed this run (10 commits + 2 property-test commits, all gate-green)

| Finding | Verify | Sev | Commit |
|---|---|---|---|
| Reputation private follow-up SMS bypasses DNC + consent (TCPA) | CONFIRMED | critical | `fb244ba` |
| Stripe Payment Links reusable → replay double-charge after settle | CONFIRMED | **critical** | `<held>` (money — labeled, held for review) |
| Customer-MMS confidence self-report → auto-approve w/o human | CONFIRMED | critical→handled | `<safe>` force `supervisorPresent=false` |
| Approve a schedule proposal after 48h expiry (before hourly sweep) | CONFIRMED | safe | `<safe>` expiry guard in `approveProposal` |
| QuickBooks sync drops paid invoices beyond newest 200 | CONFIRMED | high | `42c0740` |
| Google review responses ignore tenant brand voice (`NoopBrandVoiceLoader`) | CONFIRMED | high | `8ec0d20` |
| Brand-voice banned phrases only a prompt hint, not code-enforced | CONFIRMED | high | `be185d4` |
| PgQueue depth metric missing (C1 SLO unobservable) | CONFIRMED | medium | `dbcaf94` |
| + money property suite / runtime RLS-FORCE catalog proof | — | coverage | `8f4227e` / `c4c8e45` |

## 🔴 Confirmed money/RLS/auth — HELD for review (implement under payments/security review)

Per Guardrail 1b these are **not** auto-merged. The top one (Stripe single-use link) is implemented
in an isolated labeled commit; the rest are documented here with the verifier's exact minimal fix so
the reviewer can land them safely.

### ✅ Implemented this session (isolated, labeled HELD FOR REVIEW commits — a payments-owner should review before merge)

| Finding | Sev | Fix (commit) |
|---|---|---|
| **recordPayment lost-update race** — `payment.ts` read a stale `amount_paid_cents` snapshot then blind-absolute-set it; two concurrent legitimate payments (manual cash vs ACH webhook, distinct providerReferences) lost one. | high | **`bdc9736`** — `InvoiceRepository.incrementAmountPaidAtomic` (single UPDATE deriving paid/due/status from the row's own value), wired into `recordPayment`. Integration test: $100 cash racing $150 ACH → invoice credited $250, both rows persisted. |
| **Deposit double-credit race** — `webhooks/routes.ts` read-then-blind-set of `deposit_paid_cents`; two distinct `checkout.session.completed` events for one job lost a credit. | medium | **`4e2acc0`** — `JobRepository.creditDepositAtomic` (single UPDATE, LEAST-clamp at required + status CASE), wired into the webhook. Integration test: concurrent credits both apply; over-credit clamps to `paid`. |
| **Vapi webhook cross-tenant forgery** — `/webhooks/vapi/:tenantId` verified only a single **global** `VAPI_WEBHOOK_SECRET` (same for every tenant), never binding the signature to `:tenantId` — anyone with the shared secret could forge call events for ANY tenant. | high | **Staged fix implemented (steps 1-3):** migration `234` adds `tenant_settings.vapi_webhook_secret`; provisioning generates a random per-tenant secret and passes it as the assistant's `serverUrlSecret` (never the global one); `createVapiSecretResolver` reads it under the tenant's RLS context and the `/vapi` handler verifies against it, **falling back to the global secret only when a tenant has no per-tenant secret yet** (so live voice isn't broken mid-migration). A body signed for tenant A now fails at tenant B. Tests: provisioning stores + uses a 32-byte hex per-tenant secret (not global); resolver returns each tenant its OWN secret + null fallback. **Remaining (step 4, owner decision): a re-provisioning migration to rotate every EXISTING assistant to a per-tenant secret, then remove the global fallback — until then existing (un-reprovisioned) tenants stay on the fallback.** |

### 🔴 Still held / documented — need a product decision

| Finding | Sev | Verifier's minimal fix + note |
|---|---|---|
| **`review_response_proposal` can't execute** — per-component `approved` flags default false and no UI sets them. | critical (product) | Build the per-component approval UI (web `AIProposalCard`/mobile inbox) that flips `publicResponse.approved`/`privateFollowUp.approved`. (DNC gate already added this run, so even once executable it won't text opted-out numbers.) |
| **Zod-contract gate opt-in, not structural** — AI drafts validate only where a call site opts in. | high | Don't move it into `createProposal` (import cycle); instead assert `assertValidProposalPayload` in each AI task handler's build path, or a shared factory. |
| **`review_response_proposal` can't execute** — per-component `approved` flags default false and no UI sets them. | critical (product) | Build the per-component approval UI (web `AIProposalCard`/mobile inbox) that flips `publicResponse.approved`/`privateFollowUp.approved`. (DNC gate already added this run, so even once executable it won't text opted-out numbers.) |
| **Zod-contract gate opt-in, not structural** — AI drafts validate only where a call site opts in. | high | Don't move it into `createProposal` (import cycle); instead assert `assertValidProposalPayload` in each AI task handler's build path, or a shared factory. |
| **Dunning/late-fee policy has no tenant write path** — every tenant stuck on the hardcoded default. | high | Zod-validated `PATCH /api/settings/dunning-config` → `dunningConfigRepo.upsert`, gated by requireAuth/requireTenant/requirePermission. |

## 🟡 Confirmed product-completeness / hardening — documented (larger or needs product decision)

| Finding | Sev | Fix |
|---|---|---|
| Conversational onboarding proposals can't execute — no ExecutionHandler for the 5 `onboarding_*` types | critical (product) | Add 5 handlers (or 1 dispatching) routing to settings/pack/catalog writes + integration test |
| Conversational onboarding lane has no web/mobile/voice entry point | high | Build `ConversationStep.tsx` posting to `/api/onboarding/conversation/turn`, or wire a voice/SMS channel |
| `deriveOnboardingStatus` parity — conversational schedule shape ≠ V2 wizard's `business_hours` | high | Pure translator `WorkingHoursEntry[]`→day-keyed `business_hours` + shared parity test |
| Painting/Electrical packs unreachable (onboarding/settings/seed hardcode hvac/plumbing) | high | Widen `PackPickInputSchema` enum + allowlist guard in `pack-activation.ts` + seed |
| Auto-invoice-on-completion (+ milestone, bill-from-time) default OFF, no UI | high | 3-switch toggle group in Settings→Payments reusing `persistToggle`/PUT `/api/settings` |
| B2B priority-routing context assembled + stashed but never consumed on the live call | high | Add `b2bPromptSection` to `ClassifyContext` and inject it (mirror the RV-071 vertical-context seam) |
| Brand-voice configurator missing — `updateSettingsSchema` strips a `brandVoice` field | medium | Add `brandVoice: brandVoiceSchema.nullable().optional()` to `updateSettingsSchema` + a Settings UI sheet |
| `high_priority_booking` triage doesn't notify owner (docstring overclaims) | high | Verifier's minimal fix: correct the overclaiming docstring; or wire the decision to the owner-notify path |
| Tech ETA texts are a static scheduled window; the GPS lateness engine (`dispatch/lateness.ts`) is unreferenced | high | Wire the tech's latest GPS ping into `enqueueEnRouteNotice`/`enqueueDelayNotice`, or remove the dead module (CLAUDE.md) |
| Web estimate suggestion route doesn't catalog-*ground* prices (invariant still HOLDS — confidence cap + forced draft) | high (quality) | Thread `catalogRepo` into `EstimateAIDeps` (quality parity with voice) — **not** a money-safety fix |
| Prompt-injection hardening: `draft_invoice`, `intent-classifier`, review-drafting, tag-breakout lack anti-injection framing | medium | Mirror `estimate-task.ts`'s `<user_request>` delimiter + tone-authority + `escapeForPromptTag` helper |

## Refuted on verification (auditor over-claimed)

| Finding | Verdict |
|---|---|
| "Web estimate route bypasses catalog resolution → **money-invariant violation**" | **REFUTED** — the handler treats all prices as uncatalogued (no resolver) and caps confidence below auto-approve; the route forces draft. Invariant holds. (Re-filed above as a *quality* nicety, not a violation.) |

## Bottom line

Every **runtime security / money-integrity / compliance critical** found is fixed (Stripe
double-charge held for review; DNC bypass, MMS auto-approve, expiry gap shipped). The remaining
criticals are **product-completeness** (features built but not reachable), documented with fixes. No
confirmed cross-tenant-read leak, silent money-movement, or auth bypass remains un-remediated or
un-documented.
