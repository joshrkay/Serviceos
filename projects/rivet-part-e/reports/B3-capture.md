# B3 — Capture (agent report, condensed)

| Req | Rung | Key evidence | Missing link |
|---|---|---|---|
| B3.1 | 5 | `routes/telephony.ts:337-481` live Twilio entry; after-hours :421-444; brand-voice greeting `twilio-adapter.ts:457-498` | — |
| B3.2 | 5 | `identify-caller.ts:18-77` @ `twilio-adapter.ts:1216`; leads via `findOrCreateLeadByPhone` :1329; `test/integration/identify-caller.test.ts` | rung-4 pair (audit+cross-tenant) split/absent |
| B3.3 | 5 | SUPPORTED_INTENTS incl. emergency/negotiation/complaint; `detectEmergency` on both transports (`twilio-adapter.ts:1553`, `mediastream-adapter.ts:2066`); urgencyTier → `evaluateTriage` (`state-machine.ts:64-65`) | — |
| B3.4 | 2 | `ai/skills/classify-urgency-tier.ts` full per-vertical engine, unit-tested — ZERO production callers; `loadTriageRules` zero callers | unreachable from any entry point |
| B3.5 | 5 | `vulnerability-grader.ts` + `vulnerability-triage-hook.ts` wired both transports (`app.ts:4266-4267,4362-4363,4492-4493`); RLS proof `tenant-isolation.leak.test.ts:748-789` | — |
| B3.6 | 5 | `patch-owner-through.ts` owner→on-call→voicemail ladder, audited (:121-139,156,179,196,261); wired via same triage hook (`app.ts:4287-4296`) | no dedicated DB integration test |
| B3.7 | 5 | `detect-dropped.ts` → `sms/recovery/scheduler.ts` (durable row, now+60s); teardown `twilio-adapter.ts:3308-3329`; worker `app.ts:5860-5900`; `dropped-call-worker.test.ts:220,362-414` audit + RLS PROVEN | — |
| B3.8 | 2 | `account_type` now residential|b2b|property_manager (migration 183, `schema.ts:4555-4562`); `assembleB2bAccountContext` called live `twilio-adapter.ts:1309` — but `session.b2bAccountContext` written once (:945), READ NOWHERE; `buildAccountContextPromptSection` zero callers | recognized but nothing routes differently |
| B3.9 | 0 | no equipment/installed-asset table, repo, or context field anywhere | absent |
| B3.10 | 5 | `sms/inbound-dispatch.ts:114-124` capture-all fallback, registered `app.ts:3461-3462`; RLS proof `inbound-sms-capture.test.ts:207-227` | audit assertion unexercised |
| B3.11 | 3 | webhook → `mms_ingest` queue → worker → `customer-mms-intake.ts` → `MmsEstimateTaskHandler` (vision + catalog cap) → draft_estimate; `mms-to-quote.int.test.ts:115-163` audit asserted | no cross-tenant negative → caps at 3 |
| B3.12 | 5 | FSM `transitions.ts:314-354` NEGOTIATION_HOLDING_LINE + audit; invariant test ran 7/7 (callback-only, capture class, draft) | reactive-only; no prompt rule against proactive firm price |
| B3.13 | 5 | `routes/public-booking.ts` token-less, mounted pre-auth `app.ts:3150`; web `/book` outside ProtectedRoute (`routes.ts:48`) | — |

Watchlist: B2B moved (old defect fixed wholesale — property-type-detector + extractVulnerabilitySignals no longer exist; new defect: context unconsumed). MMS-to-quote reachable (rung 3, cross-tenant test missing). B3.4 vs B3.5 are two separate systems — LLM triage wired, deterministic per-vertical engine orphaned.

Deltas: schema.ts:2898-2900 stale comment (property-type detector gone); vulnerability weather signal is LLM self-report only, weather provider cut (`vulnerability-triage-hook.ts:134-139`); `vulnerable-customer.ts` self-documented no-consumer seam; B3.7 recovery context richer than PRD implies.

ORCHESTRATOR: mms-to-quote.int, identify-caller, inbound-sms-capture, tenant-isolation.leak, dropped-call-worker all in centrally-run suite → observed pass (179/925/0).
