# B9 — Bill (agent report, verbatim; orchestrator annotations at bottom)

## Rows
| Req | Rung | Evidence | Missing link |
|---|---|---|---|
| B9.1 | 5 | `voice-intent-map.ts:55`; SUPPORTED_INTENTS (`intent-classifier.ts:155`); registry (`handlers.ts:1266`, `app.ts:2045-2106`); S1-excluded (`surface.ts:36-52`) correct per B0; surface: `VoiceSessionPanel.tsx` → `POST /api/voice/sessions` → `InAppVoiceAdapter` (`app.ts:6629-6679`). Rung-4: `test/integration/draft-invoice-execution.test.ts` (persistence + one `invoice.created` audit + cross-tenant negative) [RUN-PENDING] | — |
| B9.2 | 5 | `invoices/convert-estimate.ts:45-150` (idempotent, draft = review step, `estimate.converted` audit); `routes/estimates.ts:638-662`; web `ConvertToInvoiceSheet.tsx` | — |
| B9.3 | 5 | `invoices/auto-invoice-on-completion.ts:55-96` (opt-in, raises draft_invoice PROPOSAL); `jobs/completion-effects.ts:47-63` invoked from `routes/jobs.ts:623` AND `update-job-handler.ts:224` | — |
| B9.4 | 5 | `voice-extended-tasks.ts:843-896`; registry `handler-registry.ts:255`; map `voice-intent-map.ts:61`; execution `batch-invoice-handler.ts` wired `handlers.ts:1277` (`app.ts:2059`); full reachability chain VoiceBar→recordings→router; 25/25 unit tests ran green | — |
| B9.5 | 4 | Direct-charge Connect: `payments/stripe-payment-link.ts:34-35` + `stripe-payment-intent.ts` send `Stripe-Account` header; resolver `invoice-payment-link.ts:57-61` (`app.ts:1257-1273`) | No integration test drives a Connect-scoped charge end to end |
| B9.6 | 3 | `stripe-payment-intent.ts:83` `automatic_payment_methods[enabled]=true` on platform-created PI via `<PaymentElement>` (`InvoicePaymentPage.tsx`, `routes/public-payments.ts:126`); unit test 9/9 ran green. Not explicit `us_bank_account` — depends on tenant Stripe Dashboard config; legacy `stripe-payment-link.ts` hosted-link fallback sets no method params | No proof ACH actually renders for a Connect-enabled tenant |
| B9.7 | 4 | `webhooks/routes.ts:1381-1457` processing→credit, `:1474-1520` succeeded→settle, `:1663-1724` failed→reverse (`ach_return`); `test/integration/ach-webhook.test.ts` asserts audit chain + cross-tenant negative + duplicate no-double-credit + both state machines [RUN-PENDING] | — |
| B9.8 | 4/5 | `invoices/payment.ts:43-80` partial/open machine, per-partial receipts (~:179); `public-estimate-service.ts` depositTimingPolicy before/after_approval (:139,352,595,757) | — |
| B9.9 | 5 | `stripe-saved-card.ts` SetupIntent off_session (:108) → `public-portal.ts:1015`; `chargeOffSession` (:203) → `agreements/dues-collector.ts:102` → recurring worker (`app.ts:5708-5760`, 60s sweep) | — |
| B9.10 | 5 | `workers/overdue-invoice-worker.ts:1-75` dunning cadence → send_payment_reminder proposals; `invoice_dunning_events` UNIQUE idempotency; scheduled `app.ts:6110-6120` | — |
| B9.11 | 5 | Sweep raises apply_late_fee via `late-fee.ts`; handler `apply-late-fee-handler.ts` UUIDv5 idempotent line, open/partially_paid only, integer cents; wired `handlers.ts:1396-1400` | — |
| B9.12 | 5 | `send-payment-reminder-handler.ts:77-143` 72h cooldown, record-first-write, 23505 race → idempotent success, per-proposal manual step key. Commit 80a2733 verified: separate real fix (record_payment link cleanup ordering, pinned by test) | — |
| B9.13 | 5 | Auto-renew `agreement-run.ts renewExpiringAgreements` per sweep tick (`recurring-agreements-worker.ts:57-73`); member pricing `member-pricing.ts:29-54` consumed at `routes/estimates.ts:232` + `routes/invoices.ts:174`; priority booking `member-pricing.ts:60-81` → `public-portal.ts:583,670` (60-day horizon, `booking-availability.ts:54`) | — |
| B9.14 | 5 | `invoices/payment.ts:96-190` receipt on every successful recordPayment incl. crash-recovery branch, per-partial receipts, webhook + voice handler shared path | — |
| B9.15 | 5 | All money columns INTEGER (`schema.ts:560-561` etc.); NUMERIC only non-money; `billing-engine.ts:78-80` Math.round; `parseAmountMention` transient parseFloat → Math.round(*100); no float persistence path; `ai_runs.cost_micro_cents` BIGINT | — |

## Watchlist re-verification
- ACH origination: MOVED — automatic_payment_methods on platform-created PI is real origination (conditional on tenant Dashboard); B9.7 lifecycle fully implemented + integration-pinned.
- WISETACK: backend WIRED (`routes/financing.ts` @ `/api/financing`, `app.ts:4723-4736`; webhook HMAC `app.ts:784`; config fails closed `shared/config.ts:379-391`). BUT `financing-provider.ts:159-160` reads process.env RAW (C8.2b violation). Frontend `InvoiceFinancingPanel.tsx` built + unit-tested, ZERO render sites — dead component. PRD-v4 does not list financing anywhere (not even non-goals) → undocumented scope, needs Part F entry.

## Deltas
- Financing: undocumented scope (backend wired, frontend dead), not a violated non-goal — PRD-v4 A8 non-goals list omits it.
- Reality ahead on ACH (genuine upgrade since prior downgrade).
- B9.2/B9.3/B9.13 exceed what docs suggest.

## Judgment calls (agent)
- B9.5 rung 4: header wiring proven, no Connect-scoped charge integration test.
- B9.6 rung 3: origination real but conditional; no rendering proof.
- Ran all permitted unit/contract tests (all green); integration cited [RUN-PENDING].
- git show 80a2733 read directly; distinct from reminder guard; both real.

## ORCHESTRATOR ANNOTATIONS (adjudication)
1. [RUN-PENDING] resolved: full integration suite ran centrally 2026-07-28 — 179 files / 925 tests / 0 fail, includes `draft-invoice-execution.test.ts` and `ach-webhook.test.ts` → B9.1 rung-4 leg and B9.7 CONFIRMED observed-pass.
2. CONFLICT with B1 report on `invoice-payment-link.ts:57-61`: B9 called it "gated on chargesEnabled (B1.10 enforcement)"; B1 showed it is a silent fallback to the PLATFORM account when Connect inactive (`public-invoice-service.ts:235-250` documents this). Adjudicated: B1's reading is correct — the line routes rather than gates. B9.5's "funds settle to the tenant's connected account" holds ONLY for Connect-active tenants; for everyone else funds settle to Rivet's account. B9.5 stays rung 4 with this caveat recorded; the violation is charged to B1.7/B1.10.
