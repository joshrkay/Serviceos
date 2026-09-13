# Blocked on Josh — the parking lot for the PRD rung map

**What this file is.** The map that moves every `docs/PRD-v5-as-built.md` user-story row to its
proven rung (GitHub issue #995) has a rule: a row blocked on a **product decision**, a
**credential**, or **hardware** is parked here with its blocker named — *surfaced, never answered
by an agent*. Agents append rows as move tickets hit them; Josh answers in the last column (or on
ticket #1000, which mirrors this file). A blank answer means the row still waits.

**How to read a row.** *Decision* is the PRD's own label (§14 O-numbers, §8.8's Q12) or the
concrete credential/hardware. *What blocks* is the fact, with the file that proves it. *Rows
waiting* names the §5/§8 rows and the rung they cannot reach until the answer lands.

---

## Decisions (product, not engineering)

| Decision | What blocks | Rows waiting | Parked | Answer |
|---|---|---|---|---|
| **O-2** Who signs off on the E1 life-safety script? | `E1_SCRIPT_REVIEW_REQUIRED=true` is hard-coded and boot only warns (*"E1 life-safety script is an UNREVIEWED PLACEHOLDER"* on every API start); no write surface exists for `tenant_settings.e1_reviewed_script` — it is one of the twelve keys absent from `updateSettingsSchema` (PRD §12.4c). Not an engineering decision. | **2.5**, **I8** — both can reach 4 (Docker proof) and 5 (reachable) speaking the placeholder; **rung 6 / launch** waits here | 2026-09-12 | |
| **O-4** Per-approval voice codes, or accept static PIN exposure? | The voice-approval PIN is a static per-tenant secret re-spoken on every recorded approval; redaction shipped, per-approval codes did not (§12.2). PRD §14: *"Money-class voice approval should not be considered shipped until this resolves."* | **I3** (spoken challenge on money/irreversible) — stops at 4; 5 is claimable only if the static PIN is accepted | 2026-09-12 | |
| **O-6** Which realtime transport carries voice approval? | An approval exchange does not fit inside the resilient transport's hang timer (§14). | **I3**; the §8.6 voice-approval rows on the phone surface | 2026-09-12 | |
| **O-9** Does "a second classifier reviews every booking and quote" still hold, or does the commitment change? | `getSupervisorReviewGate()` has 2 call sites against 93 `createProposal(` sites; the conditional site skips `draft` (low-confidence) quotes; default mode `shadow` never holds; `pricing_anomaly` is not in `CUSTOMER_HARM_CHECKS` so it cannot hold in any mode (§12.4e). Two honest resolutions; *continuing to state it as written is the one option that is not available.* The supervisor gate is untouchable on this map. | **C5** (rung 2, NOT KEPT), **7.11** (rung 3) — neither moves | 2026-09-12 | |
| **Q12** Discount/tax defect: fail closed, alert loudly, or leave it? | The full discount is subtracted from both the tax base and the subtotal — systematic under-taxing on mixed-taxability invoices (§12.3, worked example: $5 under-collected on a $200 invoice). Discount/tax math is untouchable on this map. | No story row; blocks the §12.3 proportional-allocation fix | 2026-09-12 | |

## Credentials

| Credential | What blocks | Rows waiting | Parked | Answer |
|---|---|---|---|---|
| **Intuit OAuth consent — one human click** | Intuit has no client-credentials flow: a person must click through the real consent screen once (sandbox or live company) from the shipped settings UI, yielding a refresh token (100 days rolling / 5 years hard). Automating the click is an Intuit Developer ToS grey zone (§3.1). Needs a free Intuit developer app: client id, client secret, a registered redirect URI (localhost permitted for sandbox). Research: map ticket #1003. | **9.11** — stops at 4 (also needs its `sweep-tenant-fanout.test.ts` entry: `runAccountingSyncSweep` iterates tenants via `findAllActive()` and has none) | 2026-09-12 | |
| **Google Business Profile OAuth on a connected tenant** | Review monitoring needs a tenant with a completed Google connect flow; classification and drafting are unit-only until then (§8.9 row 9.4). | **9.4** — rung 5 | 2026-09-12 | |
| **Railway access + production-read permission** (for the tenant census) | `railway whoami` → Unauthorized on this Mac; no local production `DATABASE_URL`; the session's permission mode denies production reads. Needs `! railway login` (or a read-only `Postgres-0yDO` URL) plus a permission rule for `psql`/`railway`. Map ticket #998 carries the exact read-only query plan (ids and counts only). | The **rung-6 decision** (#999): whether ≥2 real tenants with live traffic exist decides if any row's target is 6 or the map's ceiling is 5 | 2026-09-12 | |

## Hardware

| Hardware | What blocks | Rows waiting | Parked | Answer |
|---|---|---|---|---|
| *(none parked)* | Research #1002 found the mobile offline-reconnect edge (**5.4**) provable hermetically with Maestro on the Android emulator (real airplane-mode toggle + real process kill, `expo-dev-client` build, no macOS runner). Whether to build that harness is the §8.5 move ticket's call, not a hardware blocker. | — | — | — |

## Scope questions pending on the map (Josh answers on the ticket, not here)

| Question | Ticket | Rows |
|---|---|---|
| Rung-0 rows: build, fix the lie, or park? — **answered 2026-09-12:** 4.10 **out of scope** (§12.7); 4.9 **fix the lie** (empty skill list → explicit audited outcome, regrade at 2, #1017); 6.8 **parked** (no `place` entity on this map, #1019); I18 **§5.0c (a)+(b)** on #1021 (target rung 4), (c) out | #1001 (closed) | 4.9, 4.10, 6.8, I18 |
| Rung 6: which two real tenants — or is 5 the ceiling? | #999 (waits on #998) | every row's target rung |

## Open in §14 but blocking no row on this map

O-1 (price: code says $50/$150 two tiers, GTM says one tier at $297 with metered overage) · O-3 (trust ladder: three tier names, one behaviour) · O-5 (e-signature as a legal claim needs a document hash and certificate) · O-7 (equipment history: named as a differentiator, no entity exists) · O-8 (north-star instrumentation — **gains a deadline the moment rung 6 is in play**: it must be answered before a tenant goes live).

---
*Every blocker above was verified against `origin/main` at `2c2aa6d90` (PR #994 landed) or the research tickets named. When Josh answers, the answering session records the answer here, on the ticket, and in the row's Confirm cell — a status change is never one edit (PRD §11.0d).*

### Per-assignment technician SMS — tenant control? (from #1010 review, issue #1033)
- **What:** `TechnicianAssignmentNotifier` is now registered (PR #1029). Every assign/unassign/reassign texts the technician whenever a delivery provider is wired; the only switches are the global `SMS_ENABLED` kill switch and whether the tech has a mobile on file. Dispatch churn sends one text per hop.
- **Josh's call:** add a per-tenant `notifyTechniciansBySms` (default on or off?) and/or a churn window? Push notifications are unaffected (per-user mutes apply).
- **Until decided:** nothing to build; issue #1033 holds the analysis.

### §8.12 memberships — what does "bills itself" minimally mean? (from #1023, issue #1058)
- **What:** the recurring-agreements sweep renews and bills on real rows (proven, `membership-renewal-sweep.test.ts`). **Corrected on review (PR #1053) — an earlier version of this entry said *every* dues invoice is an undunnable draft, which is wrong.** On the CONFIGURED path (`autoCollectDues` + a saved default card + a Stripe key) `app.ts:5760-5766` issues the invoice with a 30-day due date *before* charging, so a decline leaves an open, dunnable invoice — proven at real Postgres, and the real overdue sweep then chases it. The gap is the **DEFAULT** path (`autoCollectDues` defaults to false in `createAgreement`) and the **no-saved-card** case (`no_card` returns before issuance, `dues-collector.ts:85`): there the invoice is `draft` with no `due_date`, so dues are not collectable without a human and the 8.9 cadence cannot reach them. Numbering as `AGREEMENT-<epoch ms>` outside the tenant sequence holds on both paths. The gaps are pinned by ordinary tests asserting the current wrong value.
- **Josh's call:** does "recurring revenue is actually recurring" require (a) issuing the dues invoice, (b) a due date so the cadence chases it, (c) numbering off the tenant sequence — all three, or a different minimum? The correction above sharpens this into a concrete choice: the configured path already does (a) and (b), so is the answer *"auto-collect IS the intended path, and the default should flip / onboarding must drive owners to it"*, or *"the default path must stand on its own and issue dues regardless"*? The severity turns on how many real memberships sit on the default path or have no saved card — which only you can see.
- **Until decided:** row 8.12 stays at 3 STORY NOT MET; #1058 holds the analysis with file:line.

### Stripe test-mode key for `StripeDuesCollector` (from #1023) — Credentials
- **What:** **narrowed on review (PR #1053).** The orchestration is now proven at real Postgres by injecting `stripeFetch` — the HTTPS boundary only, as the deposit-checkout path already does — leaving the real collector, invoice ops, `issueInvoice`, `recordPayment` and repositories in the path; success, 402 decline (with decline metadata surviving to the audit row) and no-card are all covered. The earlier claim that "any injected collector is *mocked is not proven*" conflated injecting a fake `DuesCollector` (which would be) with injecting the HTTP boundary (which is not). What a test-mode credential would still add is narrower: that Stripe's API accepts our PaymentIntent request shape and that real decline codes come back in the shape we parse. Same credential unblocks §8.5's off-session-charge half (see the #1022 entry above).
- **Row waiting:** 8.12's "dues collect" clause; 8.5b/c.

### Spanish E1 life-safety gap — who owns the fix? (from #1014 lane B, issue #1056)
- **What:** "fuga de gas" classifies **E2**, not E1: the caller is bridged to the dispatcher, never told to evacuate, the call is not closed, and a booking drafted earlier in the call stays live (`emergency-tier.ts:213/265`, English-only `E1_HAZARD_PHRASES` at `:73`). Proven end to end at the real handler; pinned as a characterization test plus an `it.fails`.
- **Josh's call:** name the owner for a life-safety change to `emergency-tier.ts` semantics (the fix shape is small — carry the detector's `language` into the E1 candidate, or add the Spanish hazard phrases — but it sits next to O-2 and needs trade standing, not a test lane).
- **Until decided:** row 2.5 is graded on the English path with the Spanish gap named; #1056 holds the analysis.

### §8.5 payments — three blockers surfaced by the #1022 lane (branch `cloud/payments-8-8`, 2026-09-12)
- **Saving a card on file writes no audit event** (engineering gap that needs a money-code change, so no lane on
  this map may close it): `packages/api/src/webhooks/routes.ts:1074-1139` stores the PaymentMethod (ids, brand,
  last4, expiry, default flag, Connect account) and records it with `logger.info` only. No
  `entityType: 'payment_method'` event exists anywhere in `src`. **Row waiting:** §8.5's stored-card half — its
  move is *the audit read-back*, and there is nothing to read; it stays where the #1009 entry audit put it
  (4−, T1, no audit) until someone lands the emission in a money-class branch. Full evidence:
  `docs/audit/lane-reports/1022-payments.md` (row 8.5b).
- **Stripe test-mode credentials** (none in the cloud sandbox; the repo's only record/replay layer,
  `CassetteLLMGateway` in `src/ai/voice-quality/cassette-gateway.ts`, records LLM exchanges — nothing records
  Stripe HTTP): `chargeOffSession`
  (`src/payments/stripe-saved-card.ts:184`) is proven only against a hand-written `StripeFetch` stub. **Row
  waiting:** §8.5's off-session-charge half — a mocked client is not proof, so it stays at 3.
- **Card-present hardware + Terminal credentials:** `src/payments/stripe-terminal.ts` is likewise stubbed-fetch
  only (`test/payments/stripe-terminal.test.ts`). Per #1022 no Terminal proof was built; shares #1018's 5.5
  finding. **Row waiting:** §8.5's card-present half — stays at 3.

### #1011 §E parking lot (per-tenant flag write path + strict-schema settings, issue #995)

Surfaced by the design pass (#1011, 2026-09-12) and this PR-3 lane. Each is
named, not answered — see this file's own rule at the top.

- **(E1) O-2, narrower question: may an owner ever EDIT the spoken E1
  life-safety script, and behind what gate?** O-2 above asks who *signs off*
  on the placeholder script; this is the separate write-path question the
  design pass raised when it kept `e1ReviewedScript` out of the generic
  settings PUT (decision #7, PR-2): if an owner is ever allowed to edit it,
  the write needs its own reviewed/gated path (legal + trade sign-off,
  per O-2), not a bare boolean/string field on `PUT /api/settings`. **Until
  decided:** `e1ReviewedScript` stays unreachable from every settings
  surface; rows 2.5/I8 are unaffected (they speak the placeholder either way).
- **(E2) `aiModel` after provisioning — ever owner-editable, or fixed for the
  tenant's lifetime?** PRD §12.4c (decision #8) leaves `aiModel` as a
  dedicated-writer / not-user-settable field, untouched by this ticket's
  scope. Open question: should an owner ever be able to switch which model
  backs their tenant's AI after initial provisioning, and if so through what
  surface (settings, support-assisted, platform-admin only)? **Until
  decided:** no write path exists or is planned; `aiModel` stays
  provisioning-time-only.
- **(E3) Is owner consent sovereign over the platform ramp?** `_resolve` in
  `pg-tenant-feature-flags.ts` returns a tenant override **before** the
  platform fallback (verified, decision #1's evidence) — so a tenant that has
  explicitly opted in or out always wins over a platform-level ramp or
  kill-switch for that flag. Open question: should that hold unconditionally,
  or should a platform-level safety kill-switch be able to override a
  tenant's own consent in an emergency (e.g., a defect discovered in a
  capability a tenant has already turned on)? **Until decided:** the current,
  shipped precedent is tenant-override-wins, unconditionally, for both
  `dropped_call_recovery` and `voice_vulnerability_triage`.
- **(E4) The Settings label for `autonomousCloseEnabled` is a placeholder.**
  The shipped copy — "One approval for phone-quoted work" — was written to
  ship something legible, not as a considered product label; the design pass
  flagged it may need a rename (and, separately, whether the underlying
  column name should change to match). **Until decided:** the copy and
  column stay as shipped; do not treat "One approval for phone-quoted work"
  as a finalized product name in specs, docs, or comms.
- **(E5) Speed-to-lead: wire it or retire it.** `sendSpeedToLeadResponse` is a
  complete module (`leads/speed-to-lead.ts`) with zero production callers
  outside its own unit test (decision #6, PR-2 design pass:
  `git grep -l sendSpeedToLeadResponse` → 2 files). It is not a schema gap —
  its keys were deliberately kept out of `updateSettingsSchema` — it is a
  built-and-never-wired module, the exact shape CLAUDE.md's Code Hygiene
  section asks to either wire or delete. **Josh's call:** wire it into a real
  trigger site (which one?) or delete the module and its test. **Until
  decided:** the module stays dormant; no row on this map claims it.
- **(E6) Which Playwright runner counts for rung 5 — ratify.** Map research
  #1004 and this ticket's design pass (§C) both settled on **chromium +
  a local Postgres testcontainer** (docs/testing-strategy.md "Real-Postgres
  Playwright locally") as the rung-5 reachability runner, explicitly NOT
  `chromium-devauth` (in-memory repos, fails "mocked is not proven") and NOT
  `qa-matrix` (needs a deployed environment, not hermetic). This PR-3 lane
  used exactly that runner for `weekly-feedback-toggle.spec.ts` and
  `capabilities-toggle.spec.ts`. **Josh's call:** formally ratify
  chromium+testcontainer as the map's one rung-5 runner definition (issue
  #995) so future lanes stop re-litigating it per ticket. **Until decided:**
  treated as adopted-but-not-ratified; this lane followed it.
- **(E7) Can 2.7 claim rung 5 without a live Twilio line?** Row 2.7
  (dropped-call recovery) is a phone-surface capability. This lane proved the
  owner-facing settings write path reaches real Postgres end-to-end
  (`capabilities-toggle.spec.ts`), but the capability itself only fires from
  a real dropped call on a live Twilio line — §8.2's lane, not this one. Open
  question, same shape as 2.6's telephony gap: does an owner-facing write
  path plus a hermetic Postgres proof cap at 4, with 5 reserved for a signed
  Twilio-shaped webhook driving the real `/api/telephony/*` routes (per map
  research #1004), or does some other proof satisfy 5 for a phone-surface
  row? **Until decided:** 2.7's rung is Fable's call per the ticket's
  resolution comment; this lane does not claim 5.
### 3.8 customer confirmation — what happens when no delivery provider is configured? (from the dormant-rows lane, issue #1077)
- **What:** the confirmation path IS wired (`TransactionalCommsService` as `schedulingNotifier`, `app.ts:1910`) and proven at real Postgres — but there are **four distinct boots on which an approved booking produces no dispatch row, no audit event and no owner-visible signal**, and they are NOT the same failure. Corrected in review (PR #1076): an earlier version of this entry said the launch flags cause the no-op fallback. They do not — `TELEPHONY_ENABLED`/`EMAIL_ENABLED` never reach `createMessageDeliveryProvider`.
  1. **mode `'none'`** — no Twilio and no SendGrid credentials at all: `messageDelivery` is null, the handler falls back to `NoopSchedulingConfirmationNotifier` (`handlers.ts:381`). *This is the only one that involves the no-op.*
  2. **both launch flags off, credentials present** — the factory returns a NON-NULL provider (the flags are invisible to it); `GatedMessageDelivery` then suppresses every send at runtime and `sendCustomerMessage` swallows it per channel. Live notifier, no rows.
  3. **`autoSendAppointmentReminders = false`** — owner-reachable from settings; one flag governs both reminders and booking confirmations.
  4. **one credential leg only** — SMS creds and no SendGrid boots a non-null provider whose email leg throws at send time, so a customer reachable only by email gets nothing (proven at real Postgres, tenant `Deadleg`).
  A second, never-constructed implementation (`AppointmentConfirmationNotifier`) duplicates the live one and carries the same (3) early return.
- **Josh's call:** record a failed dispatch row / emit an audit event / refuse to execute / accept and document — **and note a fix aimed only at (1) leaves (2), (3) and (4) untouched**; plus delete or promote the dead class.
- **Until decided:** row 3.8 is graded on the wired path (4, T1) with the condition named in its cell; #1077 holds the analysis.

### 4.7 lateness from truck location — wire or retire? (from the dormant-rows lane, issue #1079)
- **What:** `computeDispatchLateness` is complete and unit-tested but has no runtime caller; pings are ingested and the board has a ready `lateness` seam the route never supplies. One adapter wires it; one deletion retires it.
- **Josh's call:** wire (and decide where the owner sees it, that `autoNotifyCustomer` never fires without approval, and the per-query cost) or retire (delete the evaluator, its tests, the field and the hook; mark 4.7 not-built).
- **Until decided:** row 4.7 stays at 2 (dormant, pinned); #1079 holds the analysis.

### 9.5 service-credit cap at execute time (from the dormant-rows lane, issue #1080) — money
- **What:** the cap holds at draft (credit omitted, proven) but `executeServiceCredit` never re-reads the rolling sum, so a delayed approval can execute past $100 (proven: $140). The source header claims an at-execute cap that does not exist.
- **Josh's call:** refuse-and-surface at execute (recommended), or accept the window and document it.
- **Until decided:** row 9.5 is at 4 on its criterion; #1080 holds the analysis.

### 5.5 doorstep card — live simulated-reader run (from the §8.5 Opus money lane, ticket #1018; mirrors #1000)
- **Credential needed:** a **Stripe TEST-mode secret key** (`sk_test_…`) for the Rivet platform account, **plus a Connect test connected account** with the `card_payments` capability active (Stripe: *"Terminal connected accounts must have the `card_payments` capability to perform transactions"*). Both are sandbox-only; no live key, no real money. Nobody but Josh can issue them.
- **What it would buy:** Stripe **does** ship a server-side simulated Terminal reader that needs no hardware, and it is reachable over plain REST — which is all this repo uses (there is **no `stripe` npm package anywhere in the monorepo**; every Stripe call is a hand-rolled `fetch` against `https://api.stripe.com/v1/…`, so there is no SDK version to be compatible with and no `Stripe-Version` header pinned). With the credential above, the `card_present` PaymentIntent this repo already creates could actually be *presented, captured and settled* by Stripe, against the tenant's connected account, and the resulting real `payment_intent.succeeded` delivered to the repo's own webhook — closing the one thing the Docker-gated proof cannot close.
- **What is already proven without it:** `packages/api/test/integration/stripe-terminal-doorstep.test.ts` — the clean 409 and the settlement leg at real Postgres, with Stripe's REST stubbed at four named calls only (see `docs/audit/lane-reports/execute-8-5-terminal.md`).
- **Exact sequence such a run would use** (direct charges — all on the connected account via `Stripe-Account`, exactly as `payments/stripe-terminal.ts` already does):
  1. `POST /v1/terminal/locations` — `Stripe-Account: {{acct}}`, `display_name`, `address[…]` *(the repo's `ensureTerminalLocation`)*
  2. `POST /v1/terminal/readers` — `Stripe-Account: {{acct}}`, `registration_code=simulated-wpe`, `location={{tml_…}}` → `device_type: simulated_wisepos_e`, `livemode: false` **(the simulated reader; this call does not exist in the repo yet — test-only)**
  3. `POST /v1/payment_intents` — `Stripe-Account: {{acct}}`, `amount`, `currency`, `payment_method_types[]=card_present` *(the repo's `createTerminalPaymentIntent`, unchanged)*
  4. `POST /v1/terminal/readers/{{tmr_…}}/process_payment_intent` — `payment_intent={{pi_…}}` **(test-only)**
  5. `POST /v1/test_helpers/terminal/readers/{{tmr_…}}/present_payment_method` — no params defaults to Visa `4242424242424242` for a `card_present` intent **(test-only; simulates the tap)**
  6. the resulting **real** `payment_intent.succeeded` is replayed into `POST /webhooks/stripe` (`stripe listen --forward-to`), settling through the repo's existing branch.
  Sources: https://docs.stripe.com/terminal/references/testing · https://docs.stripe.com/api/terminal/readers/process_payment_intent · https://docs.stripe.com/api/terminal/readers/present_payment_method · https://docs.stripe.com/terminal/features/connect.md?connect-charge-type=direct
- **Rows waiting:** **5.5** — the live-charge half (a card actually captured by Stripe) stays unproven at any rung without this; also **8.5's card-present leg** (§8.8), parked at 3 for the same missing key. Neither can be answered by an agent.
- **Parked:** 2026-09-12 · **Answer:**

### #1102 Stripe settlement — refuse or skip a mis-accounted event? (from the §8.5 Opus money lane's F5, Fable re-grade 2026-09-13) — money, security
- **What:** every settlement branch in `packages/api/src/webhooks/routes.ts` (payment_intent.succeeded ≈1519, checkout.session.completed ≈1206, payment_intent.processing ≈1436, ≈1718) settles from `pi.metadata.tenant_id` + `invoice_id` and never compares `event.account` with the tenant's own `stripe_connect_account_id`. A tenant with a connected account can therefore mark ANOTHER tenant's invoice paid with a genuine, correctly-signed Stripe event (pinned at real Postgres: `stripe-terminal-doorstep.test.ts` `it.fails('PRODUCT DEFECT: a connected account can settle ANOTHER tenant's invoice …')`; the victim never enabled Connect and ends with a `paid` invoice, a completed payments row and both audit rows).
- **Josh's call (the fix lane implements the first unless told otherwise):** (1) **refuse** a connected-origin event whose `account` does not match the tenant's own connected account — a 4xx-class outcome, an audit row naming the reason, the `webhook_events` row not marked processed-as-settled (Stripe retries; the operator sees it); or (2) **200 + skipped** with the same audit row (kinder to the retry queue, silent to Stripe). Either way platform-origin events (no `event.account`) keep today's behaviour, asserted by a control test.
- **Until decided:** row 5.5's settlement half is graded 3 (T1 FAILED — #1102); the clean-409 half keeps 4 (T1). The fix PR is Opus, isolated branch `fix/stripe-webhook-account-binding`, draft; Josh reviews and merges.
- **Parked:** 2026-09-13 · **Answer:**
