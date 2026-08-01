# B4 — Book (agent report, condensed)

| Req | Rung | Key evidence | Missing link |
|---|---|---|---|
| B4.1 | 5 | `create-voice-turn-processor.ts:1445-1531` draft-born proposals; handlers registered; boot guard; `voice-inbound-appointment.test.ts:160-229` (1 audit row) [suite-confirmed] | cross-tenant proof lives in sibling `appointments.test.ts:216` |
| B4.2 | 2 | `checkFeasibility` (`scheduling/feasibility.ts:145-211`) wired ONLY into `create-scheduling.ts:96` (B5 reassign/reschedule) + dispatch `/check-feasibility` route | never called by any of the 3 booking-creation paths (live call, recorded voice, public web) |
| B4.3 | 3 | public-booking `isSlotFree` atomic (:345); `DefaultSlotConflictChecker` wired `app.ts:2621-2625` → `create-appointment-task.ts:632-656` (conflict → clarification w/ alternatives); 63/63 unit pass | LIVE INBOUND CALL has zero conflict check at proposal-creation |
| B4.4 | 5 | `lifecycle.ts:113-117` isSystemActor forbids system approve; `actions.ts:173,211-218` missingFields refusal; SMS-tap RV-071 | — |
| B4.5 | 3 | confirmation sends on approval (`app.ts:2071` schedulingNotifier → handlers) | NOT brand-voice: fixed i18n template (`notifications/i18n/en.ts:23-25`); brand_voice never consulted; second impl `appointment-confirmation-notifier.ts` dead in production |
| B4.6 | 3 | `appointment-reminder-worker.ts` 24h lead, hourly leader-locked `app.ts:6292-6318` | customer-facing send has no DB-gated audit+cross-tenant proof (owner-push idempotency only) |
| B4.7 | 5 | create/reschedule/cancel in intents+map+handlers with real repos (`handler-registry.ts:178-225`), both voice router :454 and assistant :1595; S2 unrestricted (`surface.ts:107`); boot guard | reschedule/cancel lack dedicated DB tests |
| B4.8 | 5 | `foldResolution` (`entity-resolution.ts:355-387`); live-call disambiguation `transitions.ts:852-858`, escalation :882-883; clarifications never auto-approve; `entity-resolution.test.ts:142,159,168,406` incl. real cross-tenant [suite-confirmed] | L406 e2e persists proposal via InMemory repo |
| B4.9 | 5 | public-booking atomic single `create_booking` proposal (:333-439); live call: one proposal + SCH-02 job auto-open (`handlers.ts:386-459`); classifier single-intent by design | — |
| B4.10 | 3 | 48h constants (`proposal.ts:93-100`), applied at creation (:874-876); sweep `proposal-expiry-worker.ts` @ `app.ts:6420` w/ `proposal.expired` audit; unit 12/12 | no integration test (mocked-DB only) → caps at 3 |

DELTAS (CRITICAL): live-call datetime parser `ai/agents/customer-calling/entity-resolution.ts:204-241` `parseNaturalDatetime` uses Date.UTC with NO tenant timezone — "Thursday at 2pm" books 14:00 UTC. Used by BOTH transports via `resolveTurnEntities` (`create-voice-turn-processor.ts:1042-1070`) for create/reschedule. The timezone fixes (85ad37e, ba064b6) touched other modules only. Affects B4.1/B4.2 correctness and B2.7.
Also: dead `appointment-confirmation-notifier.ts`; B4.9 public-booking stronger than PRD implies; drive-time feasibility lives in B5, not B4.

ORCHESTRATOR: cited integration files in centrally-run suite → observed pass. B2.7 adjudicated DOWN to 3 on the strength of the Date.UTC finding (see run log).
