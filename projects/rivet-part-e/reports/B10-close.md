# B10 — Close (agent report, condensed verbatim; orchestrator note at bottom)

## Rows
| Req | Rung | Evidence | Missing link |
|---|---|---|---|
| B10.1 | 5 | `workers/review-request-worker.ts:60-80` (24h sweep, `send_review_request` default TRUE `schema.ts:5236`); wired `app.ts:6547`; `test/integration/review-request-sweep.test.ts` [RUN-PENDING]; unit 92 pass | — |
| B10.2 | 5 | `routes/public-feedback.ts:137-150` — reviewUrls only when rating>=4; below-4 persisted private; owner surface `FeedbackDashboard.tsx` | — |
| B10.3 | 3 | Ingestion `workers/google-reviews.ts` wired `app.ts:6462-6478`; drafts `reputation/build-proposal.ts` (3 components, all `approved:false` @137,158,169); execution `review-response-handler.ts` per-component gated, comms class never auto-approves (`proposal.ts:393`) | NO UI anywhere references publicResponse/privateFollowUp/serviceCredit (grep zero); generic approve flips only top-level status (`actions.ts:220-224`) → executes ZERO sub-actions. The promised "review UI" doesn't exist |
| B10.4 | 3 | `workers/daily-digest-worker.ts` (tenant-local buckets, 15-min sweep `app.ts:6004-6070`); `digest-service.ts` unsureAbout/learnedToday sections; `DigestPage.tsx:428-467` renders them | `digest_enabled` defaults FALSE (`schema.ts:4079`) and NO UI sets digestEnabled/digestTime/digestChannel (grep zero) — only raw PATCH /api/settings. Also no 18:00–21:00 constraint (`settings.ts:213` accepts any HH:MM). Integration test lacks audit + cross-tenant on send path |
| B10.5 | 4/5 | Extraction `correction-extractor.ts`; cascade+audit `apply-undo.ts:52-97`; wired executor onExecuted `app.ts:480,2201` → `record-on-execution.ts`; digest `learnedToday` (`app.ts:6027`, `DigestPage.tsx:454-467`); undo `apply-undo.ts:111-142` via `undoProposal` (`actions.ts:461-483`, 5s `lifecycle.ts:53`); `test/integration/correction-loop.test.ts` audit+RLS negative [RUN-PENDING] | Reversal bounded by 5s proposal-undo window; no dedicated lesson-undo UI |
| B10.6 | 4/5 | `correction-extractor.ts:141-251` — single-rate agreement (:151), catalog-bound SKU (:171), contiguous-phrase-or-null (:104-128), template-or-skip (:232); unit tests pass | — |
| B10.7 | 4/5 | `integrations/accounting/sync-service.ts` real paginated QBO push (:80-93); OAuth `routes/integrations.ts:29-33`, `app.ts:5068`; 5-min sweep `app.ts:6262-6280`; full UI `QuickBooksConnect.tsx` from SettingsPage; `test/integration/accounting-sync.test.ts` incl. cross-tenant negative (:444) [RUN-PENDING] | Sync audits only to `accounting_sync_log`, not general `audit_events` |
| B10.8 | 4/5 | `UNDO_WINDOW_MS=5000` (`lifecycle.ts:53`), `actions.ts:433-438`; `routes/one-tap-undo.ts`; UNIQUE(tenant_id, idempotency_key) on proposals (`schema.ts:734`) + executions (`schema.ts:1559`); audit call-sites throughout execution/*.ts | Pattern verified via sampled handlers, not exhaustive 30-handler sweep |
| B10.9 | 5 | `CommsInboxPage.tsx` @ /comms-inbox (`routes.ts:235`); suggest-reply `routes/conversations.ts:280-284`; voice calls thread as system_event (`inbound-call-log.ts:57-67`, `outbound-call-service.ts:232,242,300`) | — |
| B10.10 | 5 | `reply-service.ts:347` direct send, DNC via `dncRepo.isOnDnc`, audited (:478-479); route `conversations.ts:352-360`; `test/integration/conversation-reply-send.test.ts` cross-tenant + DNC-blocks [RUN-PENDING]; AI comms stay proposal-gated (`proposal.ts:393`) | — |

## Watchlist re-verification
- Correction loop "specced-not-built": FALSE — built, wired, integration-proven. Bonus undocumented WS20: repetition → `update_catalog_item` meta-proposal (`correction-repetition.ts`, integration-tested). Orphan found: `build-correction-drafts.ts` exported, referenced only by tests — dead code.
- QuickBooks "UI stub, backend missing": FALSE — real backend push + complete UI.
- Thank-you SMS gap: FALSE — `workers/thank-you-sms-worker.ts` (2h delay, `send_thank_you_sms` default TRUE `schema.ts:4834`), 10-min sweep `app.ts:6519`, DNC-aware with suppression audit.

## Deltas
- `build-proposal.ts` doc comment promises a "review UI" that doesn't exist anywhere in packages/web.
- B10.4 "6–9pm tenant-local, this is the dashboard": unenforced window + opt-in-off + no UI → not true for any real tenant.
- Reality ahead: WS20 correction-repetition meta-proposal; thank-you SMS + voice-in-timeline both fully wired despite gap notes.

## Judgment calls (agent, condensed)
- B10.3 rung 3: reaching a surface whose approve is a no-op doesn't count as reachable.
- B10.4 rung 3: default-off + no toggle = unreachable for a real owner.
- B10.5/6 dual 4/5: loop is invisible-by-design; owner-edit → digest-report is the persona surface.
- accounting_sync_log ≠ audit_events, flagged not silently accepted.

## ORCHESTRATOR NOTE
All [RUN-PENDING] files (review-request-sweep, google-reviews-worker, correction-loop, correction-repetition-meta-proposal, accounting-sync, conversation-reply-send, conversation-consent-ordering, daily-digest-worker, digest-reflection) are in the centrally-run integration suite: 179 files / 925 tests / 0 failures (2026-07-28) → CONFIRMED observed-pass.
