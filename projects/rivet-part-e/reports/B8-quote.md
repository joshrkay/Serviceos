# B8 — Quote (agent report, condensed)

| Req | Rung | Key evidence | Missing link |
|---|---|---|---|
| B8.1 | 5 | voice: intent+map+handler pinned by contract test (ran 5/5); photo: mms pipeline registered `app.ts:4854-4902`; 53/53 unit pass | persistence proof "partial" per catalog |
| B8.2 | 5 | `UNCATALOGUED_CONFIDENCE_CAP = 0.85` (`catalog-resolver.ts:98`); grounding BEFORE createProposal (`estimate-task.ts:251-255,432`); 70/70 pass | — |
| B8.3 | 5 | `lineItemConfidenceSignals` (:705-733) → payload._meta → InboxPage renders (:36,347,433); clarification channel :308-315 | — |
| B8.4 | 3 | `ai/supervisor/reviewer.ts` 4 checks, 60s budget, wired `app.ts:6799` | gate called from exactly 2 sites, both voice-action-router (:1793, :2178-2179). MMS quotes and web-wizard quotes NEVER reviewed — "every quote" false |
| B8.5 | 5 | `NewEstimateFlow.tsx:376-479` editable line items; wired EstimatesPage/CustomersPage | — |
| B8.6 | 5 | `tier-structure.ts` wired both tasks; customer tier picker `EstimateApprovalPage.tsx:713-1000`; 10/10 pass | — |
| B8.7 | 3 | channels sms/email/both (`send-service.ts:598-632`); per-send picker | no tenant-level channel setting exists; also send is a separate explicit step, not on-approval |
| B8.8 | 5 | `public-estimates.ts` no auth, mounted `app.ts:3024`; token min-16 (:526); `/e/:id` outside ProtectedRoute | — |
| B8.9 | 3 | `estimate-reminder-worker.ts` default-on sweep (`app.ts:~6351-6371`) | NO disable mechanism per-estimate or global — entirely unimplemented |
| B8.10 | 5 | send_estimate_nudge full chain; 25/25 pass | — |
| B8.11 | 5 | deterministic guardrail + RECOMMENDATIONS; wired voice (:497-498) + SMS; invariant test 3/3 pass (no discount fields ever) | — |
| B8.12 | 3 | detection at proposal-creation is deterministic regex (partial mitigation); no discount-executing proposal type exists | ZERO negotiation-aware checks in any execution handler — boundary enforcement absent |
| B8.13 | 5 | both deposit timing policies (`public-estimate-service.ts:346-628`); Stripe link :736; webhook credit `webhooks/routes.ts:1167-1203`; pay surfaces on approval page + portal lists | — |
| B8.14 | 1 | electrical.ts has zero "permit"; AHJ zero repo-wide; `verticals/missing-items.ts` + `estimate-context.ts` dead code | only the PRD spec exists |

Watchlist: estimate-nudge on-ramp gap FIXED (intent+map+handler+tests).
Deltas: B8.4 "every quote" overclaim; B8.9 disable overclaim; B8.7 tenant-config overclaim; B8.14 pack-exists-but-empty; catalog resolver more sophisticated than PRD line (price-conflict carve-out, SKU-exact matching, empty-catalog bug closed :647-693).
