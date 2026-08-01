# B7 — Narrate (agent report, verbatim)

## Rows

| Req | Rung | Evidence | Missing link |
|---|---|---|---|
| B7.1 | 5 | `Shell.tsx:480,605` mounts `<VoiceBar>` (desktop+mobile) wrapping every authed route; `VoiceBar.tsx:194` POSTs `/api/voice/recordings`; route `routes/voice.ts:386-387`, mounted `app.ts:5461` | — |
| B7.2 | 5 | `onTranscribed` enqueues `voice_action_router` (`app.ts:1721-1744`); worker built `app.ts:2703`, registered `app.ts:2828-2829`; router imports classifier + resolver + createProposal. Ran `test/workers/voice-action-router.test.ts` → 89/89 pass | — |
| B7.3 | 3 | EntityKind = 7 kinds incl. technician (`entity-resolver.ts:23-36`, `pg-entity-resolver.ts:51-61`), wired `app.ts:2677-2681,2762`; ambiguity → voice_clarification. NO place/address kind; addresses ride as raw free text (`intent-classifier.ts:315,366`) | No place kind — spoken place references pass through verbatim, never resolved |
| B7.4 | 5 | `add_note` intent → `addNotePayloadSchema` (`contracts/notes.ts:14-21`) → `AddNoteExecutionHandler` (`voice-extended-handlers.ts:56,69`, isFullyWired, WS3) | — |
| B7.5 | 3 | name+qty+price wired end-to-end (`estimate-editor.ts:30-44`, `estimate-edit-task.ts:41-79`; 31/31 pass). NO unit-of-measure field on `LineItem` (`shared/billing-engine.ts:19-45`); catalog `unit: CatalogUnit` exists but `catalog-resolver.ts:558` grounds only unitPriceCents — unit dropped | "+ unit" clause has no data path to persisted line item |
| B7.6 | 5 | estimate-edit chain → `applyEstimateEdits` (`estimate-editor.ts:199-204`) → `UpdateEstimateExecutionHandler` (`update-estimate-handler.ts:47-146`, repo required non-optional); `update_estimate` in map + intents; tests pass | — |
| B7.7 | 5 | `update_job` intent → schema (`contracts.ts:188-205`) → `UpdateJobExecutionHandler` (`update-job-handler.ts:71,101`, isFullyWired) | — |
| B7.8 | 5 | `log_expense` → `logExpensePayloadSchema` (`contracts/log-expense.ts:16-22`) → `LogExpenseExecutionHandler` (`log-expense-handler.ts:23,30`, isFullyWired, WS3) | — |
| B7.9 | 3 | schedule/customer-history/job-P&L/balances lookups exist (`ai/skills/lookup-*.ts`), in SUPPORTED_INTENTS (`intent-classifier.ts:81-129`), shared deps `app.ts:2687` → in-app router `app.ts:2825` + telephony `app.ts:5571`. Truck inventory: ZERO code | No truck-inventory skill/intent/schema at all |
| B7.10 | 5 | crew intents in classifier+map; handlers (`crew-handler.ts:18,128`) with real assignmentRepo (`app.ts:1214`) via registry (`handlers.ts:1279-1280`); 13/13 tests pass. Caveat: handlers lack isFullyWired — functional today by composition-root accident | See B7.12 |
| B7.11 | 5 | Ran both contract tests → 11/11 PASS: single canonical map, catalog doc ↔ code pinned, no second map copy in src/ | — |
| B7.12 | 3 | `assertVoiceHandlersWired` at boot (`app.ts:2111-2115`, `wiring-assertions.ts:60-80`) BUT covers only handlers implementing isFullyWired (`wiring-assertions.ts:53` treats absent method as wired). Only 11/35 types covered (WS3 list pinned `wiring-assertions.test.ts:83-95`). `batch_invoice` (`batch-invoice-handler.ts:33-49` self-documented synthetic-id passthrough), crew handlers (`crew-handler.ts:115-119,150-152`), `reassign_appointment` (`reassignment-handler.ts:156-161`) have the forbidden pattern, unguarded. Guard's own tests 9/9 pass | Guard must fail loudly for handlers lacking isFullyWired, or the 4 unguarded handlers need isFullyWired added |

## Watchlist re-verification

- Place/address kind: CONFIRMED ABSENT (EntityKind union + pg switch read exhaustively).
- Truck inventory: CONFIRMED ABSENT (grep zero hits).

## Deltas

- `app.ts:2109` comment "Every voice-reachable persistence handler now reports isFullyWired (WS3)" overstates reality — 4 voice-reachable handlers with the degraded synthetic-uuid pattern are invisible to the guard; masked only because the composition root happens to always construct the repos.
- Reality ahead of docs: the catalog contract-test mechanism is stronger than the PRD describes (11/11 pinned assertions), though it does not extend to wiring depth.

## Judgment calls

- B7.3/B7.9 scored 3 (conjunctive lists with one named member at rung 0 → silent wrong behavior for that member).
- B7.5 scored 3 ("unit" is a third of the required structure, zero code path).
- B7.10 "5 (functional)" — feature works; the loud-failure guarantee gap is charged to B7.12.
- Catalog doc treated as evidence only via its passing pinning test.
