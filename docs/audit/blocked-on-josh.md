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

### 3.8 customer confirmation — what happens when no delivery provider is configured? (from the dormant-rows lane, issue #1077)
- **What:** the confirmation path IS wired (`TransactionalCommsService` as `schedulingNotifier`, `app.ts:1910`) and proven at real Postgres — but when `createMessageDeliveryProvider` resolves mode `'none'` (no Twilio and no SendGrid credentials, which is production today with the EMAIL/TELEPHONY launch flags off) the handler falls back to a no-op and an approved booking produces no dispatch row, no audit event and no owner-visible signal. A second, never-constructed implementation (`AppointmentConfirmationNotifier`) duplicates the live one.
- **Josh's call:** record a failed dispatch row / emit an audit event / refuse to execute / accept and document; and delete or promote the dead class.
- **Until decided:** row 3.8 is graded on the wired path (4, T1) with the condition named in its cell; #1077 holds the analysis.

### 4.7 lateness from truck location — wire or retire? (from the dormant-rows lane, issue #1079)
- **What:** `computeDispatchLateness` is complete and unit-tested but has no runtime caller; pings are ingested and the board has a ready `lateness` seam the route never supplies. One adapter wires it; one deletion retires it.
- **Josh's call:** wire (and decide where the owner sees it, that `autoNotifyCustomer` never fires without approval, and the per-query cost) or retire (delete the evaluator, its tests, the field and the hook; mark 4.7 not-built).
- **Until decided:** row 4.7 stays at 2 (dormant, pinned); #1079 holds the analysis.

### 9.5 service-credit cap at execute time (from the dormant-rows lane, issue #1080) — money
- **What:** the cap holds at draft (credit omitted, proven) but `executeServiceCredit` never re-reads the rolling sum, so a delayed approval can execute past $100 (proven: $140). The source header claims an at-execute cap that does not exist.
- **Josh's call:** refuse-and-surface at execute (recommended), or accept the window and document it.
- **Until decided:** row 9.5 is at 4 on its criterion; #1080 holds the analysis.
