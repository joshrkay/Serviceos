# PRD v4 — Part E: State Table

**Generated:** 2026-07-29, by the read-only state-verification run (`projects/rivet-part-e/master-prompt.md`).
**Input:** PRD v4 Part B (117 requirements, B1.1–B10.10; 19 tagged 🎙️).
**Method:** 10 lifecycle-section verification agents + a voice-reachability trace + a runtime-truth track, adjudicated centrally. Every verdict cites `file:line`, a test run and observed passing, a command output, or a probe result. Documentation was never accepted as evidence. Full per-section evidence: `projects/rivet-part-e/reports/`. This run modified nothing outside `projects/rivet-part-e/` and this file.

---

## 1. Summary

- **117 requirements scored.** Rung distribution: **0 Absent: 7 · 1 Specced: 1 · 2 Present: 14 · 3 Wired: 48 · 4 Proven: 3 · 5 Reachable: 44 · 6 Live: 0 assessed.** *(Corrected post-review — see run log #16–20.)*
- **Voice coverage (headline): 3 of 19 🎙️ requirements reach rung 5 — 16%** (B7.1, B7.7, B9.1). A second, deliberately separated number: **8 of 19 (42%) are functionally completable by a spoken sentence** (spoken → approvable proposal → correct execution); five of those lack the real-DB proof rung 5 presupposes under this run's ordinal reading of the ladder. *(Corrected post-review — run log #16–18.)* Both numbers are far below what the code's own intent map implies (35 mapped intents, both drift contract tests green): the map is intact, but **six voice actions are broken one layer below it** — the drafting-task ↔ execution-handler payload contract, which nothing tests. See §5 (voice matrix).
- **Track C (rung 6): NOT assessed per-service — Railway credentials were absent.** Every per-service env cell is `UNKNOWN — no credential`. Partial runtime truth was recovered read-only via authorized connectors and is decisive where it exists: **PostHog ingestion is observed through 2026-07-28 but cannot be attributed to an environment or service** (no env property in the taxonomy — the cells stay UNKNOWN); the **live Stripe "Rivet" platform account has webhooks pointed at production Railway, currently zero connected Connect accounts, and zero platform-account payment intents** — no tenant bank is connected today and no platform-account payment has ever been created. (A previously-connected-then-removed account, and any direct charges scoped to it, would be invisible to these probes — the claim is scoped to current account-level observations.) See §6.
- **The single worst finding:** the live inbound-call path parses spoken datetimes with `Date.UTC` and **no tenant timezone** (`packages/api/src/ai/agents/customer-calling/entity-resolution.ts:204-241`) — a caller's "Thursday at 2pm" books 14:00 UTC. The timezone fixes shipped this month (`85ad37e`, `ba064b6`) touched every path except this one.
- **The most dangerous voice defect:** voice-dictated job notes (`add_note`) pass the approval gate and then **fail at execution** (`targetId` never populated from the resolved entity) — the owner approves, nothing saves, no error reaches them (B7.4).
- **The money-rail invariant is violated by design:** invoice payment links silently fall back to Rivet's platform Stripe account when a tenant's Connect account isn't active (`public-invoice-service.ts:235-250`) — and in production, *no* tenant has an active Connect account, so every live payment link would settle to Rivet's own account (B1.7/B1.10 + Stripe probe).
- **Weakest lifecycle section: B2 Situational Context** (mean rung 1.6) — geocoding does not exist anywhere in the shipping code, there is no place/address entity kind, the four-level address-bias order is absent, and service territory is consulted only by two structured web forms, never by voice.
- **Three watchlist seeds were refuted** (reality ahead of prior documentation): the correction loop is built, wired, and integration-proven; QuickBooks sync is real end-to-end with a full UI; the delayed thank-you SMS worker exists and is wired. Offline voice capture is also real on mobile (seed said specced-not-built). FORCE RLS is complete (119/119 tables, test-verified) — the seeded "one table missing" was already remediated.

---

## 2. The state table

Rung = highest rung fully satisfied, ordinal (Wired-but-unproven = 3; see run log R1/R2 for the normalization rules). `[suite]` = the cited Docker-gated integration test ran in this run's central suite execution — **179 files / 925 tests / 0 failures** — and was observed passing.

### B1 — Setup

| Req | Requirement | Tag | Rung | Evidence | Missing link |
|---|---|---|---|---|---|
| B1.1 | Tenant provisioned on signup; email+password or Google SSO | 📱 | 3 | Clerk `<SignIn>` `packages/web/src/components/auth/LoginPage.tsx:65`; bootstrap on `user.created` `packages/api/src/webhooks/routes.ts:330,820-830` | Google actually enabled is Clerk-dashboard config — UNKNOWN (rung-6 class) |
| B1.2 | tenant_id + RLS FORCE everywhere | ⚙️ | 4 | `test/db/schema.test.ts` ran 17/17: 119/119 ENABLE-RLS tables also FORCE; exemptions pinned (`oauth_states`, `platform_deprovision_log`, `schema.ts:5315-5331`) | Runtime role enforcement is boot-asserted (`config.ts:399-411`) but rung 6 unverified |
| B1.3 | Multiple users per tenant | 📱 | 3 | `routes/users.ts:110-130`; `users` FORCE RLS `schema.ts:3260` | No dedicated real-DB proof cited |
| B1.4 | Roles owner·admin·dispatcher·technician; techs can't approve money | ⚙️ | 2 | `auth/rbac.ts:1` + DB CHECK `schema.ts:46` define only 3 roles; technician lacks `proposals:approve` (`rbac.ts:183-243`) | `admin` role specced, never built |
| B1.5 | Owner invites team; 2–3-question tech setup | 📱 | 3 | Invites wired `routes/users.ts:703-786` + `TeamMembersSheet.tsx` | Clerk redirect targets `/accept-invitation` — **no such route** in `packages/web/src/routes.ts`; no tech mini-setup exists |
| B1.6 | Every action attributable in audit trail | ⚙️ | 3 | `proposals/actions.ts:230-258` (actor id+role+channel, RV-073); `routes/users.ts:151-168,278-290` | — |
| B1.7 | Tenant's own Stripe; Rivet never holds funds | 📱 | 2 | `billing/stripe-connect.ts` wired (`app.ts:1087-1147,5073`) — but `invoices/public-invoice-service.ts:235-250` + `invoice-payment-link.ts:57-61` **silently fall back to the platform account** when Connect inactive | Invariant violated by documented design; live probe: 0 Connect accounts exist |
| B1.8 | Self-serve bank connection in-app | 📱 | 5 | `PaymentMethodsSheet.tsx` → `routes/billing.ts:120-210` (onboarding link, status, disconnect); Connect `account.updated` mirroring observed in `[suite]` | Never completed by any real tenant (probe: 0 accounts) — rung 6 fails |
| B1.9 | Connection status visible/recoverable | 📱 | 5 | `PaymentMethodsSheet.tsx:114-210` (4 states); `mapAccountToStatus` `stripe-connect.ts:123-134` | — |
| B1.10 | Money movement blocked until Connect active | ⚙️ | 2 | Only Terminal gates (`routes/terminal.ts:48-68` `CONNECT_REQUIRED`); `sendInvoice` (`send-service.ts:278-306`) and payment-link mint (`routes/invoices.ts:435-463`) never check | Primary invoice path silently degrades instead of blocking |
| B1.11 | Stripe-hosted surfaces only (PCI) | ⚙️ | 5 | Stripe Elements only: `InvoicePaymentPage.tsx:8-11,333`, `PortalPaymentMethods.tsx:10,41` | — |
| B1.12 | Subscription billing ≠ Connect, never confused | ⚙️ | 3 | Separated services/routers/columns; `stripe-connect.ts:4-10` | — |
| B1.13 | Phone number provisioned in-app w/ polling | 📱 | 5 | `onboarding/v2/steps/PhoneStep.tsx` full search→claim→poll→retry flow | — |
| B1.14 | Service territory captured | 📱 | 3 | `IdentityStep.tsx:72-75,141-152,230-262` → `/identity`; columns `schema.ts:2616-2617,3809` | Captured but unused by B2 interpretation (see B2.1) |
| B1.15 | Hours, timezone, after-hours policy | 📱 | 3 | Editable TZ select (`IdentityStep.tsx:38-40,79,275-279`); seeders no longer guess (`c020eb5`; ran `onboarding-phone.route.test.ts` 9/9) | — |
| B1.16 | Price book imported or built | 📱 | 3 | `settings/PriceBookPage.tsx`; `catalog_items` FORCE RLS `schema.ts:1032` | Import→resolver wiring not fully traced this run |
| B1.17 | Vertical pack selected; multi-trade additive | 📱 | 2 | `verticals/packs/electrical.ts` registered but self-labeled `second_class` "basic residential triage" | A8's electrical feature set (permits/AHJ/two-person/license) entirely absent — gates a launch vertical |
| B1.18 | Brand voice captured, then locked | 🎙️ | 3 | `tenants/brand/brand-voice-router.ts:63-129` @ `app.ts:5441`; lock `schema.ts:5948`; UI `BrandVoiceSheet.tsx`; `brand-voice.integration.test.ts` `[suite]` (no cross-tenant negative → caps 3) | **No voice on-ramp**: no capture intent in `SUPPORTED_INTENTS` or the map — a 🎙️ requirement with no spoken path |
| B1.19 | Conversational onboarding, 10–15 exchanges, clarification loop | 🎙️ | 3 | Real multi-turn FSM `ai/orchestration/onboarding-conversation.ts` (5 states, clarification counts, persisted `onboarding_session` FORCE RLS); route `app.ts:5492`; `onboarding-conversation.test.ts` `[suite]` | **Zero clients call it** (grep web+mobile: nothing). Shipped UX is the form wizard. Text-only — no STT leg; no `tools` state |
| B1.20 | Onboarding skippable, banner, inline gaps | 📱 | 3 | `OnboardingGuard` (`ProtectedRoute.tsx:66-93`); `UpgradeNudgeBanner` in `Shell.tsx:24,413` | Inline dependency-gap notes unconfirmed |

### B2 — Situational context

| Req | Requirement | Tag | Rung | Evidence | Missing link |
|---|---|---|---|---|---|
| B2.1 | Territory = outermost prior on location interpretation | ⚙️ | 2 | Model + `checkServiceArea` (`scheduling/service-area.ts:23-35`) wired only into `public-booking.ts:316`, `public-portal.ts:704-707` | Never consulted by voice/AI address interpretation — no caller in tasks/handlers/resolver reads `service_area_*` |
| B2.2 | 4-level address bias order | ⚙️ | 0 | No bias/priority mechanism over address sources anywhere in `packages/api/src` | Entire mechanism absent |
| B2.3 | Partial address resolves in-territory, proximity tie-break | ⚙️ | 0 | Only `parseSpokenAddressParts` (`shared/src/contracts/spoken-address.ts:134`) — a regex splitter; no candidate matching | Text extraction exists; resolution does not |
| B2.4 | Out-of-territory never silently accepted | ⚙️ | 2 | Web forms 400 `OUT_OF_SERVICE_AREA` (`public-portal.ts:704-710`) | No territory check exists on any voice/AI path — the surface the requirement is about |
| B2.5 | Addresses geocoded + validated before landing | ⚙️ | 0 | `grep -rli geocod` over all packages: **zero source hits**. `service_locations.latitude/longitude` nullable, never populated; travel-time providers only *consume* lat/lng | Geocoding does not exist (contradicts the PRD's own B2 note claiming it is wired) |
| B2.6 | Ambiguity → one-tap clarification, never a guess (addresses) | ⚙️ | 2 | `voice_clarification` contract real for 7 entity kinds | No `place` kind exists (`entity-resolver.ts:23-36`) — an ambiguous address structurally cannot reach the contract |
| B2.7 | Relative time resolves tenant-local, stored UTC | ⚙️ | 3 | Recorded-voice path proven: `resolve-datetime.ts` (chrono+luxon, ambiguity-refusing; ran 13/13) wired `create-appointment-task.ts:562` | **Live-call path broken**: `entity-resolution.ts:204-241` `parseNaturalDatetime` builds `Date.UTC(...)` with **no tenant timezone** — used by both transports for create/reschedule |
| B2.8 | System knows who's speaking; shapes scope | ⚙️ | 2 | Role gating fails closed for 4 owner-grade lookups (`voice-lookup-answer.ts:88-93,263-274`) | `lookup_day_overview` doc-claims owner-scoped but is unrestricted; content never reshaped — "my schedule" never means "my jobs" for a technician |
| B2.9 | Names resolve against this tenant only | ⚙️ | 5 | Tenant-scoped SQL, e.g. `pg-entity-resolver.ts:459-472` inside `withTenantConnection`; cross-tenant negative `entity-resolution.test.ts:168` `[suite]` | — |
| B2.10 | Location context for the inbound call agent | ⚙️ | 0 | Inbound flow (`twilio-adapter.ts:2977-3100`) handles name+caller-ID only; `resolveSpokenAddress` never invoked from telephony | No landmark/cross-street handling of any kind |

### B3 — Capture

| Req | Requirement | Tag | Rung | Evidence | Missing link |
|---|---|---|---|---|---|
| B3.1 | AI answers 24/7 in brand voice | ⚙️ | 5 | `routes/telephony.ts:337-481` live entry; after-hours :421-444; brand greeting `twilio-adapter.ts:457-498` | — |
| B3.2 | Caller resolved; unknowns → lead | ⚙️ | 5 | `identify-caller.ts:18-77` @ `twilio-adapter.ts:1216`; leads :1329; `identify-caller.test.ts` `[suite]` | audit+cross-tenant pair split across files |
| B3.3 | Intent + urgency classified | ⚙️ | 5 | `detectEmergency` both transports (`twilio-adapter.ts:1553`, `mediastream-adapter.ts:2066`); urgencyTier → `state-machine.ts:64-65` | — |
| B3.4 | Severity triage per vertical | ⚙️ | 2 | `ai/skills/classify-urgency-tier.ts` complete + unit-tested — **zero production callers**; `loadTriageRules` zero callers | Fully built engine unreachable from any entry point |
| B3.5 | Vulnerability signals elevate urgency | ⚙️ | 5 | `vulnerability-grader.ts` + hook wired both transports (`app.ts:4266-4267,4362-4363,4492-4493`); RLS proof `tenant-isolation.leak.test.ts:748-789` `[suite]` | `weather` signal is LLM self-report — the weather-provider integration was cut (`vulnerability-triage-hook.ts:134-139`) |
| B3.6 | Urgency+vulnerability → patch-through | ⚙️ | 3 | `patch-owner-through.ts` ladder, audited (:121-261); wired via same live hook (`app.ts:4287-4296`) | Mutation/audit path with no real-DB test of the patch action itself (`tenant-isolation.leak.test.ts` covers only the triage-event repo) — rung 4 unmet under R1, capped at 3 |
| B3.7 | Dropped-call SMS recovery <60s w/ context | ⚙️ | 5 | Durable scheduler (`sms/recovery/scheduler.ts`, +60s) @ teardown `twilio-adapter.ts:3308-3329`; worker `app.ts:5860-5900`; `dropped-call-worker.test.ts:220,362-414` audit+RLS `[suite]` | — |
| B3.8 | B2B/property-manager routes differently | ⚙️ | 2 | `account_type` widened (migration 183, `schema.ts:4555-4562`); `assembleB2bAccountContext` called live (`twilio-adapter.ts:1309`) — but `session.b2bAccountContext` **written once, read nowhere**; prompt-injection fn zero callers | Recognized, then ignored — nothing routes differently. (Old seeded defect fixed; new one found) |
| B3.9 | Equipment/asset history on call | ⚙️ | 0 | No equipment table/repo/context field anywhere | Absent |
| B3.10 | Unclaimed inbound SMS → threaded convo | ⚙️ | 5 | Terminal fallback slot (`sms/inbound-dispatch.ts:114-124`) @ `app.ts:3461-3462`; RLS proof `inbound-sms-capture.test.ts:207-227` `[suite]` | — |
| B3.11 | Customer MMS photo → draft estimate | ⚙️ | 3 | Full chain: webhook → `mms_ingest` queue → worker → `customer-mms-intake.ts` → vision task w/ catalog cap → `draft_estimate`; `mms-to-quote.int.test.ts:115-163` audit `[suite]` | No cross-tenant negative for this path → caps 3 |
| B3.12 | Never quotes firm price / never negotiates | ⚙️ | 5 | FSM holding line + audit (`transitions.ts:314-354`); invariant tests ran 7/7 (callback-only, draft) | Reactive-only; structural protection otherwise |
| B3.13 | Public web booking, no login | 📱 | 5 | `routes/public-booking.ts` pre-auth (`app.ts:3150`); `/book` outside ProtectedRoute (`routes.ts:48`) | — |

### B4 — Book

| Req | Requirement | Tag | Rung | Evidence | Missing link |
|---|---|---|---|---|---|
| B4.1 | Call → booking proposal, not booking | ⚙️ | 5 | Draft-born proposals (`create-voice-turn-processor.ts:1445-1531`); `voice-inbound-appointment.test.ts:160-229` (post-approval persistence + 1 audit) `[suite]` | Correct wall-clock time is broken — see B2.7/UTC bug |
| B4.2 | Drive-time feasibility at booking | ⚙️ | 2 | `checkFeasibility` (`scheduling/feasibility.ts:145-211`) wired only into dispatch-side (`create-scheduling.ts:96`, `/check-feasibility`) | Never called by any of the three booking-creation paths |
| B4.3 | Conflict detection | ⚙️ | 3 | Web atomic `isSlotFree` (`public-booking.ts:345`); recorded-voice `DefaultSlotConflictChecker` → clarification w/ alternatives (`create-appointment-task.ts:632-656`; 63/63 unit) | **Live inbound call has zero conflict check** at proposal creation |
| B4.4 | Owner approves | 📱 | 5 | `isSystemActor` bar (`lifecycle.ts:113-117`); missingFields refusal (`actions.ts:211-218`); SMS tap RV-071 | — |
| B4.5 | Confirmation in brand voice | ⚙️ | 3 | Sends on approval (`app.ts:2071` → handlers) | Fixed i18n template (`notifications/i18n/en.ts:23-25`) — brand voice never consulted; second notifier impl dead in prod |
| B4.6 | Day-before reminder | ⚙️ | 3 | `appointment-reminder-worker.ts` 24h, hourly leader-locked `app.ts:6292-6318` | Customer-send leg has no real-DB audit+cross-tenant proof |
| B4.7 | Book / move / cancel by speaking | 🎙️ | 3 | All three intents → map → task handlers → registered execution handlers w/ real deps (`handler-registry.ts:176,218,222`; `handlers.ts:1243,1287,1294`); resolved ids consumed (`voice-extended-tasks.ts:232-234,331-333`); boot guard `app.ts:2111`; create leg proven `voice-inbound-appointment.test.ts` `[suite]` | Conjunctive requirement: reschedule/cancel execution handlers have **no** real-DB proof (no integration test exercises them with audit + cross-tenant), so rung 4 is unmet for two of three verbs under R1 — capped at 3 despite full spoken-chain reachability. Appointment-resolution heuristic also narrow without a customer name |
| B4.8 | Ambiguity → clarification, never a guess | ⚙️ | 5 | `foldResolution` (`entity-resolution.ts:355-387`); live-call disambiguation `transitions.ts:852-858`; `entity-resolution.test.ts:142,159,168,406` incl. cross-tenant `[suite]` | e2e leg persists via in-memory repo |
| B4.9 | New customer + job = one combined proposal | ⚙️ | 5 | Atomic single `create_booking` (`public-booking.ts:333-439`); voice: one proposal + SCH-02 job auto-open (`handlers.ts:386-459`) | — |
| B4.10 | Proposals expire after 48h | ⚙️ | 3 | Constants + creation-time application (`proposal.ts:93-100,874-876`); sweep + `proposal.expired` audit (`proposal-expiry-worker.ts` @ `app.ts:6420`); unit 12/12 | Mocked-DB only — no integration test for the sweep |

### B5 — Dispatch

| Req | Requirement | Tag | Rung | Evidence | Missing link |
|---|---|---|---|---|---|
| B5.1 | Dispatch board day view | 📱 | 5 | `DispatchBoard.tsx` @ `routes.ts:88`; 26/26 tests ran | — |
| B5.2 | Drag-and-drop → proposal, not mutation | 📱 | 5 | `DispatchBoard.tsx:584` always POSTs `/api/proposals` | — |
| B5.3 | Assign work by speaking | 🎙️ | 3 | Intent+map+handler wired (`handlers.ts:1273`); technician name resolves (probe) | **Blocked**: `voice-extended-tasks.ts:378` pushes `appointmentId` into `missingFields` unconditionally, ignoring the resolver's id → `approveProposal` refuses (`actions.ts:214-219`); also "assign NAME to JOB" phrasing risks classifying as `add_crew_member`, and a job-name-only reference falls to soonest-appointment-tenant-wide (`pg-entity-resolver.ts:397-437`) |
| B5.4 | Tech notified push+SMS | ⚙️ | 2 | Full impl (`assignment-notifications.ts`) called from `assignment.ts:282,321` — but `TechnicianAssignmentNotifier` **never instantiated** in `app.ts`; module instance stays undefined | Permanent no-op; wire the constructor + setter |
| B5.5 | "On my way" by app/SMS/voice | 🎙️ | 3 | App leg wired (`TechnicianDayView.tsx:510` → `dispatch/routes.ts:262-310`, audit :53) | Voice leg: no intent (and `JobStatus` has no `en_route`); SMS leg: no OMW keyword (only out/sick/unavailable) — 1 of 3 named channels |
| B5.6 | GPS-ping drive-time ETA SMS | ⚙️ | 2 | Branded en-route SMS sends (`delay-notifications.ts:139-142,419-452`) but "ETA" = scheduled window (:443-447); pings captured write-only, zero readers; no ETA computation exists | The defining computation is absent |
| B5.7 | Proactive late-arrival update | ⚙️ | 2 | `computeDispatchLateness` complete, 13/13 unit — zero production callers | No worker/route invokes it |
| B5.8 | No-show/cancel → cascade reschedule proposals | ⚙️ | 3 | SMS OUT/SICK/UNAVAILABLE → `from-tech-out.ts:136` per-appointment proposals (ready_for_review); registered `app.ts:1883-1904`; `tech-status-sms.test.ts:198` audit `[suite]` | Only the tech-self-reports-out branch exists — an appointment marked `no_show` (`appointment-lifecycle.ts:37`) or a single cancellation does **not** cascade (`createRescheduleProposalsFromTechOut` has exactly one caller); test also lacks the cross-tenant negative, so rung 4's bar is unmet under R1 |
| B5.9 | Electrical license/two-person flags | ⚙️ | 0 | Zero "license"/"two-person" hits repo-wide; electrical pack has no such concept | Absent |

### B6 — Execute

| Req | Requirement | Tag | Rung | Evidence | Missing link |
|---|---|---|---|---|---|
| B6.1 | One-handed, gloves, daylight | 📱 | 3 | `min-h-11` on `TechJobView.tsx:458,509,530`; reachable via `technician/day` | Mandated proof pattern absent: no jsdom class-contract or 320px Playwright test for this screen |
| B6.2 | Photo capture, clock-in gated | 📱 | 3 | Capture real (`TechJobView.tsx:486-545` + `routes/job-photos.ts`) | Clock-in gating has **zero** implementation client or server |
| B6.3 | Time entries by voice | 🎙️ | 3 | Full chain probe-verified approvable+executes (`handler-registry.ts:252` → `handlers.ts:1319`; `TimeEntryService` `app.ts:2083`); 33/33 unit | No integration test exercises the execution handler → Wired-but-unproven |
| B6.4 | Offline capture queues + syncs | ⚙️ | 5 | `packages/mobile/src/offline/` (journal, crash-safe recovery, voice+approval lanes) mounted `app/_layout.tsx:24,42`; voice auto-enqueues (`useVoiceCapture.ts:62-66`); 27/27 ran | Photos not in queue (no mobile camera UI); web field surface has no offline story |

### B7 — Narrate

| Req | Requirement | Tag | Rung | Evidence | Missing link |
|---|---|---|---|---|---|
| B7.1 | Push-to-talk from any screen | 🎙️ | 5 | `VoiceBar` in `Shell.tsx:480,605` (every authed route, `routes.ts:62`) + `V` shortcut :266-274 → `/api/voice/recordings` → transcription → router (`app.ts:1720-1740,2828`) | — |
| B7.2 | Speech → typed proposal pipeline | ⚙️ | 5 | Full chain wired (`app.ts:1721-1744,2703,2828-2829`); 89/89 router tests ran | — |
| B7.3 | Free-text refs incl. **place** resolve to IDs | ⚙️ | 3 | 7 kinds wired (`entity-resolver.ts:23-36`, `app.ts:2677-2681`); ambiguity → clarification | No `place` kind — spoken addresses pass through as raw text |
| B7.4 | Job notes dictated | 🎙️ | 3 | Chain wired (`handler-registry.ts:229` → `handlers.ts:1297`) | **Approves, then fails at execution**: task never sets `targetId` from resolved entities (`voice-extended-tasks.ts:460-484`) while the handler requires a UUID (`voice-extended-handlers.ts:94-99`); probe: `EXEC {"success":false,...}` with empty `missingFields` |
| B7.5 | Parts by speaking (name+qty+**unit**) | 🎙️ | 0 | No parts/materials intent exists; `ExtractedEntities` has no qty/unit fields; `lineItemSchema` (`contracts.ts:306-329`) has no `unit` | Nearest neighbors are estimate line-item editing (B7.6, no unit) and `log_expense` (drops job link); job-level parts capture absent |
| B7.6 | Spoken line-item to existing estimate | 🎙️ | 3 | `update_estimate` chain; `resolveEstimateIdGate` lifts on unambiguous match (`estimate-edit-task.ts:265,350-356`); required-deps handler (`handlers.ts:1400`); 31/31 unit ran | No integration test exercises `UpdateEstimateExecutionHandler` (verified: zero files import it; `invoice-pricing-source.test.ts:438` calls `applyEstimateEdits` directly, no audit/cross-tenant assertions) — rung 4 unmet under R1 |
| B7.7 | Job status by voice | 🎙️ | 5 | `update_job` chain; repo-verified gate (`job-edit-task.ts:309-330`); `update-job-execution.test.ts:44,208` persist+audit+cross-tenant `[suite]` | Gate lift is LLM-echo-dependent (prompt-hint seam) |
| B7.8 | Expense by voice | 🎙️ | 3 | Chain executes (probe) with audit | **Job link silently dropped**: `log_expense` absent from `JOB_REF_INTENTS` (`entity-resolution.ts:85-93`), task never sets `jobId` (`voice-extended-tasks.ts:1070`), handler reads it (`log-expense-handler.ts:40`) — corrupts job P&L; no integration test |
| B7.9 | Read-only lookups by voice | 🎙️ | 3 | P11-001 exclusion real (`voice-action-router.ts:1188`; `voice_lookup_answered` audit :2319-2336); 14 skills; cross-tenant proof `voice-lookup-answer.test.ts:131-145` `[suite]` | `lookup_leads` + `lookup_catalog` classifiable but **silently skipped** (`voice-lookup-answer.ts:675`); "truck inventory" has no domain at all |
| B7.10 | Crew add/remove by voice | 🎙️ | 3 | Chain wired (`handlers.ts:1274,1275`); tech name resolves | **Blocked**: `missing=['appointmentId']` unconditional (`voice-extended-tasks.ts:423,444`); intents not in `APPOINTMENT_REF_INTENTS` so the spoken appointment ref is never resolved; probe confirms |
| B7.11 | Code-checked capability matrix (drift test) | ⚙️ | 5 | Ran both contract tests: 11/11 PASS (single map, doc pinned, no second copy) | Matrix proves the *map*; the drafting↔execution payload layer is untested (see B7.4/B7.10 class) |
| B7.12 | Unwired deps fail loudly | ⚙️ | 3 | `assertVoiceHandlersWired` at boot (`app.ts:2111-2115`) — but treats handlers lacking `isFullyWired()` as wired (`wiring-assertions.ts:53`); only 15/38 implement it; `batch_invoice`/crew/`reassign` retain synthetic-uuid passthrough (`batch-invoice-handler.ts:48-50`, `crew-handler.ts:115-119,150-152`, `reassignment-handler.ts:156-161`) unguarded | Guard must default-fail on missing `isFullyWired()`, or the four handlers need it |

### B8 — Quote

| Req | Requirement | Tag | Rung | Evidence | Missing link |
|---|---|---|---|---|---|
| B8.1 | Estimate from spoken description or photo | 🎙️ | 3 | Voice chain contract-pinned (ran 5/5); resolver-authored gate (`estimate-task.ts:226-237`); photo chain registered `app.ts:4854-4902` | Prior citation was a false positive: `draft-invoice-execution.test.ts` mentions `DraftEstimateExecutionHandler` only in a comment (:202) and never executes it; `autonomous-close-chain.test.ts` executes a `draft_estimate` against real PG but asserts neither the estimate audit event nor a cross-tenant negative — rung 4 unmet under R1 |
| B8.2 | Catalog-resolved; uncatalogued caps 85% | ⚙️ | 5 | `UNCATALOGUED_CONFIDENCE_CAP=0.85` (`catalog-resolver.ts:98`); grounding before `createProposal` (`estimate-task.ts:251-255,432`); 70/70 ran | — |
| B8.3 | Confidence markers surfaced | ⚙️ | 5 | `lineItemConfidenceSignals` (:705-733) → `payload._meta` → `InboxPage.tsx:36,347,433` | — |
| B8.4 | Supervisor reviews **every** quote | ⚙️ | 3 | Reviewer real (4 checks, 60s budget, `app.ts:6799`) | Called from exactly 2 sites, both `voice-action-router.ts` — MMS-drafted and web-wizard quotes never reviewed |
| B8.5 | Inline-editable review | 📱 | 5 | `NewEstimateFlow.tsx:376-479` | — |
| B8.6 | Good/better/best tiers | ⚙️ | 5 | `tier-structure.ts` wired both tasks; customer picker `EstimateApprovalPage.tsx:713-1000`; 10/10 ran | — |
| B8.7 | Delivery channel configurable per tenant | ⚙️ | 3 | Channels sms/email/both per send (`send-service.ts:598-632`) | No tenant-level setting exists; send is a separate step, not on-approval |
| B8.8 | Customer approves via token link | ⚙️ | 5 | `public-estimates.ts` unauthenticated (`app.ts:3024`); token ≥16 (:526); `/e/:id` public (`routes.ts:45`) | — |
| B8.9 | Auto follow-up, default-on, disableable | ⚙️ | 3 | Sweep default-on (`estimate-reminder-worker.ts` @ `app.ts:~6351`); `estimate-nudge.test.ts` `[suite]` | **No disable mechanism exists** per-estimate or globally |
| B8.10 | Nudge by voice | 🎙️ | 3 | Chain wired (`handlers.ts:1300`, deps `app.ts:2089-2096`) | **Blocked**: `missing=['estimateId']` unconditional by design comment (`voice-extended-tasks.ts:667`); spoken nudge can't complete |
| B8.11 | Pushback → owner proposal; AI never negotiates | ⚙️ | 5 | Deterministic guardrail + recommendations; wired voice (:497-498) + SMS; invariant 3/3 ran | — |
| B8.12 | Guardrail at execution boundary | ⚙️ | 3 | No discount-executing proposal type (invariant-pinned) | Zero negotiation-aware checks in any execution handler — boundary enforcement absent |
| B8.13 | Deposit on acceptance, both policies | ⚙️ | 5 | Both policies (`public-estimate-service.ts:346-628`); Stripe link :736; webhook credit (`webhooks/routes.ts:1167-1203`); pay surfaces everywhere money is owed; `deposit-concurrent-credit.test.ts` `[suite]` | — |
| B8.14 | Electrical permit line + AHJ marker | ⚙️ | 1 | Spec only. `electrical.ts` has zero "permit"; AHJ zero repo-wide; `missing-items.ts`/`estimate-context.ts` dead code | Not built |

### B9 — Bill

| Req | Requirement | Tag | Rung | Evidence | Missing link |
|---|---|---|---|---|---|
| B9.1 | Invoice from a spoken sentence | 🎙️ | 5 | Full chain; resolver-authored customer id (`invoice-task.ts:254-261`); `draft-invoice-execution.test.ts:156-194` cents+audit+cross-tenant `[suite]`; issue leg also voice-reachable (`issue-invoice-conversation-resolution.test.ts` `[suite]`) | One sentence yields a *draft*; issuing is a second (also speakable) act — by design |
| B9.2 | Estimate → invoice w/ review step | 📱 | 5 | `convert-estimate.ts:45-150` idempotent, draft status, audit; UI sheet | — |
| B9.3 | Auto-invoice on completion | ⚙️ | 5 | Opt-in proposal-raising (`auto-invoice-on-completion.ts:55-96`); fires from route AND voice handler (`completion-effects.ts:47-63`) | — |
| B9.4 | Batch invoice by voice | 🎙️ | 3 | Chain wired; approvable (probe `missing=[]`); per-job idempotent fan-out (`batch-invoice-handler.ts:59-80`) | No integration test; handler has synthetic-passthrough w/o `isFullyWired` (B7.12 hole) → Wired-but-unproven |
| B9.5 | Payment link; funds settle to tenant account | ⚙️ | 3 | Direct-charge `Stripe-Account` header (`stripe-payment-link.ts:34-35`, `stripe-payment-intent.ts`); resolver `app.ts:1257-1273` | No real-DB test asserts a Connect-scoped charge (rung 4 unmet under R1) — and settlement-to-tenant holds **only** when Connect is active; otherwise the silent platform fallback (B1.7) violates the requirement's substance. Live probe: no tenant is Connect-active |
| B9.6 | Card + platform-originated ACH | ⚙️ | 3 | `automatic_payment_methods` on platform-created PI (`stripe-payment-intent.ts:83`, 9/9 unit ran) via `<PaymentElement>` | ACH not explicitly requested — depends on tenant Stripe dashboard; hosted-link fallback sets no method params; no rendering proof |
| B9.7 | ACH processing→credit, succeeded→settle, failed→reverse | ⚙️ | 4 | `webhooks/routes.ts:1381-1457,1474-1520,1663-1724`; `ach-webhook.test.ts` audit chain + cross-tenant + duplicate-safety `[suite]` | Rung 5 needs a real customer path exercised with ACH enabled — unproven |
| B9.8 | Partial payments + deposits | ⚙️ | 4 | Status machine (`invoices/payment.ts:43-80`); per-partial receipts; both deposit policies; `deposit-concurrent-credit.test.ts` `[suite]` | — |
| B9.9 | Saved cards / off-session auto-pay | ⚙️ | 5 | SetupIntent off_session (`stripe-saved-card.ts:108` → `public-portal.ts:1015`); `chargeOffSession` → dues collector → 60s worker (`app.ts:5708-5760`) | — |
| B9.10 | Automatic dunning cadence | ⚙️ | 5 | `overdue-invoice-worker.ts` → reminder proposals; `invoice_dunning_events` UNIQUE; scheduled `app.ts:6110-6120`; `payment-reminder-dedup.test.ts:241` `[suite]` | — |
| B9.11 | Late fees | ⚙️ | 5 | Sweep-raised proposals; UUIDv5-idempotent line, integer cents (`apply-late-fee-handler.ts`); `late-fee-idempotency.test.ts` `[suite]` | — |
| B9.12 | Reminder + late fee by voice | 🎙️ | 3 | Both chains wired (`handlers.ts:1345,1394`); double-send guard proven (`send-payment-reminder-handler.ts:77-143`) | **Blocked by voice**: `missing=['invoiceId']` (+`feeCents`) unconditional (`voice-extended-tasks.ts:711,817`; probe) — approval refused until screen edit |
| B9.13 | Memberships: auto-renew, member pricing, priority booking | ⚙️ | 5 | All three wired: `agreement-run.ts` per sweep tick; `member-pricing.ts:29-54` @ estimates:232/invoices:174; horizon widening `public-portal.ts:583,670`; `agreements.test.ts` `[suite]` | — |
| B9.14 | Receipt on payment | ⚙️ | 5 | Every successful `recordPayment` incl. recovery branch (`invoices/payment.ts:96-190`); per-partial receipts | — |
| B9.15 | Integer cents end to end | ⚙️ | 5 | All money columns INTEGER; `Math.round` engine (`billing-engine.ts:78-80`); transient-parse-only floats; no float persistence path found | — |

### B10 — Close

| Req | Requirement | Tag | Rung | Evidence | Missing link |
|---|---|---|---|---|---|
| B10.1 | Automated review request | ⚙️ | 5 | 24h sweep, default TRUE (`review-request-worker.ts:60-80`, `schema.ts:5236`) @ `app.ts:6547`; `review-request-sweep.test.ts` `[suite]` | — |
| B10.2 | Review gating 4+→Google, else private | ⚙️ | 5 | `public-feedback.ts:137-150`; below-4 private; owner dashboard | — |
| B10.3 | Review monitoring + AI response, owner-approved | 📱 | 3 | Ingestion wired (`app.ts:6462-6478`); per-component `approved:false` gates (`build-proposal.ts:137,158,169`); comms class never auto-approves | **The promised review UI does not exist** — no web code references the sub-components; generic approve executes zero sub-actions |
| B10.4 | EOD digest 6–9pm tenant-local = the dashboard | ⚙️ | 3 | Full pipeline + tenant-local buckets (`daily-digest-worker.ts` @ `app.ts:6004-6070`); sections incl. "unsure about" rendered `DigestPage.tsx:428-467` | `digest_enabled` defaults FALSE (`schema.ts:4079`) and **no UI can turn it on**; no 18:00–21:00 window constraint |
| B10.5 | Correction loop: lessons forward, digest-reported, reversible | ⚙️ | 5 | Extractor → cascade+audit (`apply-undo.ts:52-97`) @ executor seam (`app.ts:480,2201`); digest leg; undo inside 5s window (`actions.ts:461-483`); `correction-loop.test.ts` audit+RLS `[suite]` | Lesson undo bounded to the 5s proposal window |
| B10.6 | Conservative extraction | ⚙️ | 5 | Single-rate agreement, catalog-bound SKU, contiguous-phrase-or-null, template-or-skip (`correction-extractor.ts:141-251`); unit ran | — |
| B10.7 | QuickBooks one-way sync | ⚙️ | 3 | Real paginated push (`sync-service.ts:80-93`); OAuth routes; 5-min sweep (`app.ts:6262-6280`); full UI from Settings; `accounting-sync.test.ts` incl. cross-tenant `[suite]` | Audits only to `accounting_sync_log`, never `audit_events` — rung 4's audit leg unmet by the letter |
| B10.8 | Audit + undo + idempotency on every mutation | ⚙️ | 3 | 5s window (`lifecycle.ts:53`, `actions.ts:433-438`); DB UNIQUE idempotency (`schema.ts:734,1559`); audit calls throughout handlers (sampled) | Not exhaustively re-audited across all 38 handlers this run |
| B10.9 | Unified comms inbox + AI replies | 📱 | 5 | `CommsInboxPage.tsx` @ `/comms-inbox`; suggest-reply gated route; calls thread as system events (`inbound-call-log.ts:57-67`) | — |
| B10.10 | Owner replies send directly, audited+DNC; AI via proposals | 📱 | 5 | `reply-service.ts:347` direct+DNC+audit; `conversation-reply-send.test.ts` cross-tenant+DNC `[suite]`; comms class never auto-approves | — |

---

## 3. Rollups

| Section | Reqs | 0 | 1 | 2 | 3 | 4 | 5 | Mean |
|---|---|---|---|---|---|---|---|---|
| B1 Setup | 20 | – | – | 4 | 11 | 1 | 4 | 3.25 |
| **B2 Situational context** | **10** | **4** | – | **4** | **1** | – | **1** | **1.60** |
| B3 Capture | 13 | 1 | – | 2 | 4 | – | 6 | 3.54 |
| B4 Book | 10 | – | – | 1 | 5 | – | 4 | 3.70 |
| B5 Dispatch | 9 | 1 | – | 3 | 3 | – | 2 | 2.78 |
| B6 Execute | 4 | – | – | – | 3 | – | 1 | 3.50 |
| B7 Narrate | 12 | 1 | – | – | 7 | – | 4 | 3.42 |
| B8 Quote | 14 | – | 1 | – | 6 | – | 7 | 3.86 |
| B9 Bill | 15 | – | – | – | 4 | 2 | 9 | 4.33 |
| B10 Close | 10 | – | – | – | 4 | – | 6 | 4.20 |
| **Total** | **117** | **7** | **1** | **14** | **48** | **3** | **44** | **3.46** |

**B2 is the weakest section, and it is not close** — mean 1.60 against 2.78 for the next-weakest (B5). The product's entire "what the system knows before anyone speaks" layer — geocoding, address candidates, territory-as-prior, speaker-scoped context — is between absent and unreachable, while the PRD calls it the thing that makes a spoken sentence resolvable. B5 Dispatch is the second-weakest: three of its nine requirements are complete implementations with zero production callers or an un-instantiated notifier.

The strongest sections are the money loop (B9, B10) — which is also where the most real-DB proof lives — with the caveat that its rung-6 story is empty (no live payment ever attempted, no tenant bank ever connected).

---

## 4. Delta list (both directions)

**Documentation claims the code does not support:**
1. PRD-v4's own B2 note: geocoding/service-location lat-lng "exist and are wired" — **geocoding does not exist in the repo at all**; only travel-time consumers of never-populated lat/lng columns do.
2. PRD-v4's Part E sample row cites B7.5 at `handlers.ts:412` — that line is inside `CreateAppointmentExecutionHandler`; no parts handler exists anywhere (B7.5 is rung 0).
3. B1.4: four roles specced; three exist (`admin` absent from `rbac.ts:1` and the DB CHECK).
4. B1.7/B1.10 ("Rivet never holds tenant funds" / "blocked, never silent"): contradicted by an intentional, commented platform-account fallback (`public-invoice-service.ts:235-250`).
5. B8.4 "supervisor reviews every quote": only voice-router-drafted quotes are reviewed; MMS and web-wizard quotes never are.
6. B8.9 "disableable per estimate or globally": no disable mechanism exists.
7. B8.7 "delivery channel configurable per tenant": per-send choice only; no tenant setting.
8. B10.4 "6–9pm tenant-local… this is the dashboard": default-off, no UI toggle, no window constraint — true for zero real tenants.
9. `app.ts:2109`'s claim that "every voice-reachable persistence handler now reports isFullyWired": 15/38 do; four voice handlers retain the synthetic-passthrough pattern unguarded.
10. `reputation/build-proposal.ts`'s "operator approves each component in the review UI": that UI does not exist.
11. `lookup_day_overview` self-documents "owner/operator-scoped"; it is unrestricted.
12. Stale comments: `schema.ts:2898-2900` (property-type detector no longer exists); `assignment-notifications.ts:6-8` (claims SMS deferred; it's implemented — and neither channel is wired).
13. Master prompt / PRD C8.2a name `check:env-declared`; the actual script is `check:env-coverage`.

**Reality ahead of documentation:**
1. Correction loop (B10.5/6): believed specced-not-built; actually built, wired at the executor seam, integration-proven with audit + RLS — plus an undocumented WS20 extension (repeated corrections mint an owner-reviewed `update_catalog_item` meta-proposal, integration-tested).
2. QuickBooks sync (B10.7): believed UI-stub/backend-missing; actually a real paginated push with OAuth, worker, and complete UI.
3. Delayed post-job thank-you SMS: believed a competitive gap; `thank-you-sms-worker.ts` exists, wired (`app.ts:6519`), DNC-aware, default-on.
4. Offline voice capture (B6.4): believed specced-not-built; a crash-safe journal+flush subsystem is live in `packages/mobile`.
5. FORCE RLS: the seeded "one table missing" was already remediated (migration 130); coverage is complete and contract-tested.
6. Voice on-ramp seeds (crew/batch/late-fee/reminder/nudge): all six intents now exist in classifier+map with handlers — the *map-level* gap closed (though four of them are still voice-incompletable one layer down; see §5).
7. Entity resolver: a `technician` kind shipped (PRD B2 note says it doesn't exist).
8. B2B recognition: `account_type` gained `property_manager` and live-path assembly (the seeded dead detector was replaced wholesale) — though the assembled context is still unconsumed.
9. ACH: upgraded from webhook-detection to platform-originated `automatic_payment_methods`, with the full processing/succeeded/failed lifecycle integration-proven.
10. Wisetack financing: not in PRD-v4 at all (not even as a non-goal), yet backend-wired unconditionally at `/api/financing` with boot-validated webhook secret; the web panel is built but rendered nowhere. Needs a Part F decision entry.
11. The spoken-address *symptom* fix shipped: incomplete addresses are preserved verbatim and surfaced as blocking gaps (never silently dropped) — the substance of B2 remains unbuilt.

---

## 5. Voice reachability matrix (Track B)

Of 19 🎙️ requirements: **3 reach rung 5** (B7.1, B7.7, B9.1) → **16% strict voice coverage**. **8 are functionally completable by voice** (adds B4.7, B6.3, B7.6, B8.1, B9.4 — completable but lacking full real-DB proof) → 42%. The break points:

| 🎙️ Req | Verdict | Break point |
|---|---|---|
| B1.18 brand voice | ✗ no on-ramp | No capture intent exists |
| B1.19 conversational onboarding | ✗ no surface | Engine wired; zero clients; text-only |
| B4.7 book/move/cancel | ✓ completable (rung 3) | Reschedule/cancel execution legs lack real-DB proof |
| B5.3 assign | ✗ blocked | `missingFields=['appointmentId']` unconditional (`voice-extended-tasks.ts:378`) → approval refused |
| B5.5 on-my-way | ✗ no voice leg | No intent; no `en_route` JobStatus; no SMS keyword |
| B6.3 time entry | ✓ completable (rung 3) | No integration proof |
| B7.1 push-to-talk | ✓ rung 5 | — |
| B7.4 notes | ✗ **approves then fails** | `targetId` never set; handler rejects post-approval |
| B7.5 parts | ✗ absent | No intent; no unit field anywhere |
| B7.6 line-item to estimate | ✓ completable (rung 3) | Execution handler has no integration proof |
| B7.7 job status | ✓ rung 5 | — |
| B7.8 expense | ✗ wrong row | Executes but silently drops the spoken job link |
| B7.9 lookups | ◐ partial | 14 skills work; `lookup_leads`/`lookup_catalog` silently skipped; no inventory domain |
| B7.10 crew | ✗ blocked | `['appointmentId']` unconditional; intents not in `APPOINTMENT_REF_INTENTS` |
| B8.1 estimate | ✓ completable (rung 3) | Estimate execution lacks audit+cross-tenant real-DB proof |
| B8.10 nudge | ✗ blocked | `['estimateId']` unconditional by design comment |
| B9.1 invoice | ✓ rung 5 | — |
| B9.4 batch invoice | ✓ completable (rung 3) | No integration proof; unguarded passthrough |
| B9.12 reminder/late fee | ✗ blocked | `['invoiceId']` (+`feeCents`) unconditional |

**Inverse enumerations** (mechanical, contract-test-pinned, both tests ran green):
- **Handlers with no voice on-ramp:** exactly three, all documented-intentional and contract-pinned — `create_booking` (FSM path), `update_catalog_item` (WS20), `adopt_entity_alias` (U4).
- **Intents with no handler:** zero. The 25 unmapped intents decompose into 16 `lookup_*` (read-only by design — but **two have no skill case and are silently skipped**), the three hard-refused approval/edit intents, `complaint`/`negotiation` (synthetic-key routes to capture-class types), and four FSM-side non-action intents.
- **The real drift is one layer below the tested matrix:** seven voice-mapped actions (`add_note`, `reassign_appointment`, `add_crew_member`, `remove_crew_member`, `send_estimate_nudge`, `send_payment_reminder`, `apply_late_fee`) discard resolver output or gate unconditionally. B7.11's contract tests cannot see this class; nothing tests the drafting-task ↔ execution-handler payload contract.

**D-014 (canonical inbound path): undeterminable from code alone — and here is precisely why.** Twilio Gather and Media Streams are **one stack, two transports** (media-streams wires the same `processCallerUtterance`, `app.ts:4425`; mid-call degradation resumes the same session via `/voice/gather-fallback`). VAPI **cannot book** — its webhook (`webhooks/routes.ts:2579`) records telemetry only. Provisioning points the number at `/api/telephony/voice` (`provision-twilio.ts:283`), which alone would make the Twilio FSM canonical — but step 4.5 (`provision-twilio.ts:364-410`), active only when `VAPI_API_KEY` is set, imports the number into Vapi, whose effect on the number's `VoiceUrl` is invisible to this repo. Closing D-014 requires two runtime facts: (a) whether `VAPI_API_KEY` is set in production (it is undeclared in every env manifest, which suggests not), and (b) the live Twilio number's actual `VoiceUrl`. If VAPI is uncredentialed — the likely case — **the canonical path is the Twilio FSM, Media Streams transport when configured, Gather otherwise.**

**Voice approval refusal (B0/D-013):** enforced and contract-pinned. Recorder channel: `voice-action-router.ts:1331-1339` (skip + warn). In-app voice: `routes/assistant.ts:1058-1090` (audited refusal). Permitted only on verified owner telephony sessions, hard-gated on `ownerSession` (`create-voice-turn-processor.ts:2115-2127,2196-2205`).

---

## 6. Track C — runtime truth

**Railway credentials absent → per-service variable state UNASSESSED.** Everything below is code truth plus authorized read-only connector probes (`projects/rivet-part-e/track-c-probes.md`). Direct production HTTP probes were blocked by this session's egress policy (proxy 403) — health state is UNKNOWN-blocked, not "down".

Per service × dependency (web / worker / voice share one image, split by `PROCESS_ROLE`; `railway*.toml` confirmed `[build]`/`[deploy]` only). One late observation: the Railway PR-environment bot for this run's PR listed only `@serviceos/api`, `@serviceos/web`, and Postgres — no separate worker/voice services in that environment. PR environments may not mirror production, so whether production actually runs the three-way `PROCESS_ROLE` split (and therefore whether the worker's sweeps run anywhere) is itself **UNKNOWN — no credential**, and materially so: if no `PROCESS_ROLE=worker` service exists, every sweep in §"worker-gated" (dunning, digest, reminders, QBO sync, SLO monitor) is dark in production.

| Dependency | web | worker | voice | Basis |
|---|---|---|---|---|
| Twilio voice | UNKNOWN — no credential | N/A | UNKNOWN — no credential | Webhook route always mounted (`routes/telephony.ts:337`); number's live VoiceUrl unreadable |
| Twilio SMS | UNKNOWN — no credential | N/A | N/A | STOP/DNC code + `tenant_dnc_list` exist; delivery unverified |
| Voice stack (STT→gateway→TTS) | UNKNOWN — no credential | N/A | UNKNOWN — no credential | Wired unconditionally when enabled && role≠worker |
| LLM gateway + `ai_runs` | UNKNOWN — no credential | UNKNOWN | UNKNOWN | `PgAiRunRepository` injection unconditional given pool (`app.ts:1442,1458`); rows-being-written unverifiable |
| Stripe platform | **partially LIVE** | N/A | N/A | Probe: livemode account "Rivet", 2 enabled webhooks → `serviceosapi-production.up.railway.app/webhooks/stripe`, both platform-scoped (`application:null`), enabled-event sets overlapping on all money-critical events (`payment_intent.succeeded/processing/payment_failed`, `checkout.session.completed/expired`, `setup_intent.succeeded`, `charge.refunded`, `charge.refund.updated`, `charge.dispute.created`, `account.updated`) — those deliver twice; a few events are single-endpoint. Event-ID dedupe absorbs duplicates per code + integration tests, not verified against live delivery. Webhook-secret set-ness per service UNKNOWN |
| Stripe Connect | **live-NOT-ONBOARDED (current)** | N/A | N/A | Probe: **zero currently connected accounts** — no tenant is Connect-onboarded today; **zero platform-account payment intents ever**. Account-scoped direct charges on a since-removed connected account would be invisible to these probes; the "never moved real money" reading is the probable but not provable interpretation |
| Clerk | UNKNOWN — no credential | UNKNOWN | UNKNOWN | Dev-token paths NODE_ENV-gated at runtime; **the test-key-prefix refusal is dead code** (see below) |
| Sentry | UNKNOWN — no credential | UNKNOWN | UNKNOWN | 3 of 4 claimed paths `instrument()`ed; **Stripe webhook (`webhooks/routes.ts:962`) has zero instrumentation** — its P1 alert can never fire (seed confirmed) |
| QuickBooks | UNKNOWN — no credential | UNKNOWN — no credential | N/A | OAuth creds undeclared in every manifest — suggests not-configured but cannot prove a dashboard variable unset (the declared≠set lesson, C8.1c) |
| SendGrid | UNKNOWN — no credential | N/A | N/A | Required unless `EMAIL_ENABLED=false` |
| PostHog | UNKNOWN — ingestion observed, attribution unavailable | UNKNOWN — same | N/A | Probe: Rivet events ARE ingesting through 2026-07-28 (`proposal_executed` 238/30d, `job_created` 527, …) — but the taxonomy has **no environment property**, so the events cannot be attributed to production vs staging vs a local process, nor to a specific service. Also: **no `$pageview`** (web capture absent everywhere) and **no `$ai_generation`** (LLM analytics not wired) |
| Storage (R2) | UNKNOWN — no credential | UNKNOWN | UNKNOWN | `R2_BUCKET`/`R2_PUBLIC_URL` undeclared in prod manifest |
| Push / EAS | UNKNOWN — no credential | N/A | N/A | `EXPO_ACCESS_TOKEN` undeclared in every manifest (suggests not-configured but cannot prove a dashboard variable unset); provider constructed unconditionally |
| Wisetack | UNKNOWN (likely off) | N/A | N/A | Provider degrades to manual without key; routes mounted unconditionally |
| VAPI | UNKNOWN (likely off) | UNKNOWN | UNKNOWN | Undeclared everywhere; client null without key; decides D-014 |

**Config-hygiene findings (code-side, decisive):**
- `check:env-declared` does not exist; `check:env-coverage` ran clean but validates one manifest and parks 32 vars on an "unreviewed" allowlist. Independent union-of-four-manifests count: **67 of 160 env vars read by the API are declared nowhere** (seed said 61/115 — moved).
- **333 raw `process.env` reads across 82 files** bypass the Zod config (which coerces `""`→`undefined` at `config.ts:180-184`); 20 of those vars have a validated `config.X` that is ignored — including ~16 raw reads of `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` and `CLERK_SECRET_KEY` passed with no guard at `app.ts:5047`.
- **The production boot assertions are dead code**: `validateEnvSchema`/`prodEnvSchema` (`config.ts:592-664`) — which refuse `DEV_AUTH_BYPASS`, `CLERK_DEV_HMAC_TOKENS`, and test-prefix Clerk keys in prod — are called only from tests, never from boot. The first two have independent runtime `NODE_ENV` gates; **`ALLOW_CLERK_TEST_KEYS` has no runtime backstop at all.**
- `ALLOW_MISSING_CRITICAL_CONSTRAINTS` (`db/migrate.ts:127-134`): deliberate operator hatch to skip the double-booking constraint postcondition; nothing asserts it's unset in production.
- The one strong boot gate: `RLS_RUNTIME_ROLE=true` is genuinely required at boot in prod/staging (`config.ts:399-411`) with a live role-assumability probe (`app.ts:935`).

---

## 7. Punch list — ordered by persona impact

1. **Spoken booking times are wrong on the live call path.** `parseNaturalDatetime` (`ai/agents/customer-calling/entity-resolution.ts:204-241`) uses `Date.UTC` with no tenant timezone, on both transports, for create and reschedule. Mike's caller says "Thursday at 2pm"; the FSM holds/offers 14:00 UTC (7am Phoenix). Daily path, silent, wrong-by-hours. The July timezone fixes missed this module.
2. **Dictated job notes approve and then vanish.** `add_note` voice payload carries only `targetReference`; `missingFields` stays empty; execution requires a UUID and fails after the owner's approval (`voice-extended-tasks.ts:460-484` vs `voice-extended-handlers.ts:94-99`). The exact "looked like it worked, nothing saved" class Gap-2 was declared closed on — alive on the highest-frequency narrate action.
3. **The money rail would settle to Rivet's own account.** Payment links silently fall back to the platform Stripe account when Connect is inactive (`public-invoice-service.ts:235-250`; only Terminal gates) — and the live platform has **zero Connect accounts**, so this is not an edge case: it is what would happen to every tenant today. Violates B1.7's core invariant.
4. **Six spoken money/dispatch actions can't be completed by speaking.** Reassign, crew add, crew remove, estimate nudge, payment reminder, late fee all gate unconditionally on ids the resolver either found or never looked up (`voice-extended-tasks.ts:378,423,444,667,711,817`) — the sentence produces an unapprovable draft and a screen visit. The voice thesis silently degrades to "dictation plus data entry" on these paths.
5. **Spoken expenses lose their job.** `log_expense` drops the spoken job reference (not in `JOB_REF_INTENTS`; task never sets `jobId`), so job P&L — a headline spoken question (B7.9) — silently under-counts costs.
6. **A wrong address can sail through.** No geocoding, no place resolution, no territory prior on any voice path (B2.1–B2.6, B2.10). The PRD's "confidently wrong address on a real job" failure mode has no guard between transcript and proposal.
7. **The supervisor reviews a minority of quotes.** MMS-photo and web-wizard estimates bypass `getSupervisorReviewGate` entirely (only two call sites, both in the voice router) — Jenna's "photo quote too generic" bad day is exactly the unreviewed path (B8.4).
8. **Jenna's property-manager caller is recognized and then treated like everyone else.** `session.b2bAccountContext` is written once, read nowhere; the priority/prompt consumers have zero callers (B3.8).
9. **The digest — "the dashboard" — is off for everyone.** `digest_enabled` defaults false and no UI can flip it; no tenant sees the product's flagship close-of-day surface without a raw API call (B10.4). Same class: the review-response approval UI doesn't exist, so drafted responses can never post (B10.3).
10. **Technicians are never told they were assigned.** The notifier is fully built and never instantiated — a permanent no-op (`app.ts` never constructs `TechnicianAssignmentNotifier`) (B5.4).
11. **The loud-failure guarantee has a hole.** The boot guard skips handlers without `isFullyWired()` — 23 of 38, four of which retain the synthetic-uuid passthrough (B7.12). Add the default-fail or the four implementations, and a payload-contract drift test for the B7.4/B7.10 class.
12. **Observability would miss a payment-path outage.** Stripe webhook uninstrumented (Sentry P1 can never fire); prod boot assertions dead code; `ALLOW_CLERK_TEST_KEYS` unbackstopped; 67 env vars undeclared; duplicate Stripe webhook endpoints doubling delivery.
13. **Two spoken questions get silence.** `lookup_leads` and `lookup_catalog` classify and are then skipped with only an info log (B7.9).
14. **Electrical at launch is ungated by reality.** Pack is a second-class triage stub; permits/AHJ/license/two-person are rung 0–1 (B1.17, B5.9, B8.14). A8's Reversal 1 currently has no build behind it.
15. **Built-but-orphaned inventory** for the fix run to wire or delete per hygiene rules: conversational-onboarding engine (no client), per-vertical triage engine (no callers), dispatch-lateness engine (no callers), `AppointmentConfirmationNotifier`, `InvoiceFinancingPanel`, `buildCorrectionLessonDrafts`, `vulnerable-customer.ts` seams, `/accept-invitation` unrouted redirect.

---

## 8. Run log — judgment calls

1. **The input file was absent at run start.** `PRD-v4-DRAFT-spine-lifecycle.md` was in neither the repo, its git history, nor connected Dropbox/Drive. Per the never-ask rule a provisional spine was reconstructed from the master prompt + repo claims; the authoritative file arrived mid-run via upload and **replaced the reconstruction before any agent consumed it**. All 117 rows key to the authoritative Part B.
2. **R1 — ladder read as ordinal.** "Highest rung fully satisfied" is applied cumulatively: a mutation-bearing requirement without real-DB proof (audit + cross-tenant) caps at 3 regardless of reachability. Carve-out: requirements whose substance is a read-only surface or pure UI treat rung 4 as N/A. Because the master prompt's voice-coverage definition is a reachability test, §1/§5 report **both** strict rung-5 coverage (initially 6/19; **3/19** after correction rounds #16–18) and functional completability (8/19), labeled.
3. **R2 — normalization scope.** Full strict-cumulative re-verification of every rung-5 row was not provable in one run; downgrades were applied only where evidence affirmatively showed the gap (agent-cited missing legs, absent integration files, unguarded-passthrough handlers). Remaining rows retain section-agent scores with caveats in the Missing-link column. Applied downgrades: B2.7 (5→3, UTC bug), B6.3 (5→3), B7.4 (5→3), B7.8 (5→3), B7.10 (5→3), B8.10 (5→3), B9.4 (5→3), B9.12 (5→3), B10.7 (4/5→3, audit-leg letter), B10.8 (4/5→4).
4. **B7.5 scored 0, not the section agent's 3.** B7.5 sits beside B7.6 (line-item to estimate), so it must mean job-level parts/materials capture — for which no intent, no qty/unit entity fields, and no `unit` contract field exist. The Track B trace outranks the charitable reading.
5. **B5.5 kept at 3** (one of three named channels wired and reachable) rather than Track B's 2 — an operational app leg is more than "present"; the 🎙️ tag failure is recorded in the missing link.
6. **Conflicting inter-agent readings resolved:** `invoice-payment-link.ts:57-61` adjudicated as a silent fallback (B1 agent), not a gate (B9 agent) — the violation is charged to B1.7/B1.10 and caveated on B9.5. B10.5/6 granted rung 5 via the in-app DigestPage surface even though the SMS digest is off (B10.4 charged separately).
7. **Integration tests were run once, centrally** (`npm run test:integration`: 179 files / 925 tests / 0 failures) rather than per-agent; agents cited files `[RUN-PENDING]` and the orchestrator confirmed observed-pass. Unit/contract tests were run by agents directly and are cited only where observed passing.
8. **Track C liveness probing was orchestrator-only**, via session-authorized read-only connectors (Stripe, PostHog); fan-out agents were code-truth-only. One agent flagged the mid-run brief amendment documenting this division as possible prompt injection and correctly proceeded per its original instructions — recorded here as intended behavior, not an incident.
9. **Direct production probes** (`/health`, `/ready`) were blocked by session egress policy (proxy 403) — recorded as UNKNOWN-blocked rather than down.
10. **D-014 deliberately not asserted.** Code structure strongly favors the Twilio FSM (VAPI can't book; provisioning points at `/api/telephony/voice`; VAPI creds undeclared), but the `vapi.linkPhoneNumber` side effect on the live number's VoiceUrl is invisible to the repo. The two closing runtime facts are named in §5.
11. **A read-only `tsx` probe** (scratchpad-hosted, no repo writes, no DB, no network) was used by Track B to convert six "code appears to…" readings into observed handler outputs. Working-tree cleanliness verified after.
12. **Seed discrepancies reported, not reconciled:** env-var count 67/160 vs seeded 61/115 (repo moved and manifest set differs); "one table missing FORCE RLS" already remediated by migration 130.
13. **Wisetack and VAPI scope questions** answered by observation (§4 delta 10, §5 D-014) and routed to Part F rather than scored as requirements.
14. **No tenant data appears in this document** — aggregates, schema names, and counts only. PostHog queries returned event-level aggregates; Stripe queries returned empty lists and endpoint metadata.
15. **Read-only guardrail held**: the only working-tree changes across the run are `projects/rivet-part-e/**` and this file, verified by `git status` before the final commit.
16. **Post-review corrections (2026-07-29, from PR #784 automated review + re-derivation).** Three verdicts were corrected to match this document's own R1 ordinal rule: **B5.8 5→3** (only the tech-self-reports-out branch cascades; single `no_show`/cancel does not; test lacks the cross-tenant negative), **B9.5 4→3** (no Connect-scoped charge test exists; settlement-to-tenant also contradicted by the B1.7 platform fallback), and the **PostHog Track C cells LIVE→UNKNOWN** (ingestion observed but environment/service attribution is impossible — observed data recorded in the evidence column instead). Re-deriving all rollups from the row values also fixed arithmetic slips in four published means (B2 1.40→1.60, B3 3.92→4.00, B8 3.79→4.00, B9 4.20→4.33) and the totals (3:39→41, 4:5→4, 5:51→50, mean 3.50→3.57). Voice coverage is unaffected (neither corrected row is 🎙️-tagged). These are adjudication corrections logged per the document's own rule that hand-edits without provenance void the evidence.
17. **Second post-review correction round (2026-07-29, same source).** Three more verdicts corrected under R1/R2: **B4.7 5→3** (conjunctive — reschedule/cancel execution handlers have no real-DB proof; only the create leg does; the row's own missing-link column recorded the gap), **B3.6 5→3** (mutation/audit path, no real-DB test of the patch action itself), and **QuickBooks Track C cells not-configured→UNKNOWN** (manifest omission cannot prove a deployed dashboard variable unset — the run briefly committed the very declared≠set fallacy C8.1c warns about). Ripple: strict voice coverage **6/19→5/19 (26%)** — functional completability stays 8/19; distribution 3:41→43, 5:50→48; B3 mean 4.00→3.85, B4 3.90→3.70, total mean 3.57→3.54. The Phase 1 fix-run target (14/19) is unaffected: its item 9 requires the reschedule/cancel real-DB proofs that restore B4.7 to rung 5.
18. **Third post-review correction round (2026-07-29, same source; test-file claims independently re-verified before applying).** **B7.6 5→3** (zero integration files exercise `UpdateEstimateExecutionHandler`; `invoice-pricing-source.test.ts:438` calls `applyEstimateEdits` directly with no audit/cross-tenant assertions) and **B8.1 5→3** (the `draft-invoice-execution.test.ts` citation was a comment-grep false positive — line 202 references `DraftEstimateExecutionHandler` in a comment only; `autonomous-close-chain.test.ts` executes an estimate against real PG without the estimate audit event or a cross-tenant negative). Strict voice coverage **5/19→3/19 (16%)**; functional stays 8/19; distribution 3:43→45, 5:48→46, mean 3.54→3.50. Also narrowed two Track C epistemic overclaims: the Stripe "zero Connect accounts / zero payments **ever**" claims are scoped to current account-level observations (a removed connected account and its account-scoped direct charges would be invisible to the probes), and the Push/EAS cell now reads `UNKNOWN — no credential` (same declared≠set correction as QuickBooks). The stale 32% figure in the self-grade was recomputed. Phase 1 prompt gained item 10 (proof-only restoration of B7.6 + B8.1), keeping its 14/19 target arithmetically honest: 3 green + 8 focus + B4.7/B7.6/B8.1 restored by items 9–10.
19. **Fourth post-review correction round (2026-07-29, same source).** **B10.8 4→3** (conjunctive "every mutation" verified only by sampling; no single real-DB test asserts it — the same R1 standard applied everywhere else). Rollup-table transcription errors fixed against the row values: B7 counts corrected to 0:1/3:7/5:4 (mean 3.42 was already right), B10 to 3:4/5:6 (mean 4.30→4.20), totals to 3:46/4:3/5:46 (mean 3.50). Narrative B2 mean references updated to 1.60 (two stale 1.4 spots), and punch-list #4's count corrected from five to six (it names six actions). Full section-by-section recount performed; distribution and means now reproduce from the rows exactly.
20. **Fifth post-review correction round (2026-07-29, same source).** **B3.2 5→3** (unknown-caller → lead creation has no real-DB audit + cross-tenant proof; the cited test covers phone matching only) and **B3.10 5→3** (audit-event assertion unexercised). Ripple: B3 mean 3.85→3.54, distribution 3:46→48, 5:46→44, mean 3.50→3.46; voice numbers unaffected. The Stripe duplicate-webhook claim was refined using the probe's actual `enabled_events` data: both endpoints are platform-scoped and overlap on all money-critical events (those deliver twice); "every event delivered twice" was too strong, and the dedupe evidence is code + integration tests, not observed live delivery. The Phase 1 prompt's B1.19 E2E criterion was extended to require a 10–15-exchange conversation (the source requirement's stated depth) rather than a 6-turn script. Finally, noted without editing the input documents: the master prompt's/PRD C8.2b's "a raw empty string is truthy" premise is technically wrong in JavaScript (`""` is falsy) — the real raw-`process.env` hazards are `!== undefined`/presence checks and passing `""` onward to consumers; none of this run's config-path findings depended on the imprecise premise (each raw read was cited by location, not classified by that rule).

---

## Self-grade against the definition of done

- ✅ Every Part B requirement ID has a row (117/117; no blanks — `UNKNOWN` used only where legal).
- ✅ Every rung verdict cites file:line, an observed test run, a command output, or a probe result.
- ✅ No verdict rests on documentation; doc/code disagreements are in §4.
- ✅ Every seeded watchlist item independently re-verified with its own citation (several refuted).
- ✅ Voice coverage computed and stated (16% strict / 42% functional after post-review corrections — run log #16–18), with the definitional split disclosed.
- ✅ Handlers-without-on-ramps (3, intentional, pinned) and intents-without-handlers (0, with the two silently-skipped lookups flagged) both enumerated.
- ✅ Track C: per-service table with no blanks; UNKNOWN — no credential stated prominently, partial connector probes labeled as such.
- ✅ Delta list runs both directions (13 doc-ahead, 11 reality-ahead).
- ✅ D-014 answered to the limit of code truth and explicitly marked undeterminable beyond it, with the two closing facts named.
- ✅ Repository unchanged outside `projects/rivet-part-e/` and this document.
- ✅ No placeholder pretending to be a finding.
