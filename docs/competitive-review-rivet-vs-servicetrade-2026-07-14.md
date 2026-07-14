# Rivet vs. ServiceTrade — Feature Comparison

**Date:** 2026-07-14 · **Method:** every Rivet verdict verified against `/packages` source (code wins over docs); ServiceTrade's 2026 capabilities verified against public product, pricing, and review sources the same day (direct fetches of servicetrade.com were proxy-blocked at 403; claims cross-checked across GetApp, Capterra, Software Advice, G2, and ServiceTrade's own press/feature pages). Companion inventory drawn from the codebase sweep of 2026-07-14. Sibling doc: `docs/competitive-review-rivet-vs-jobber-2026-07-02.md`.

**Read this first — they barely compete for the same buyer.** ServiceTrade is a **commercial** field-service platform for **multi-truck mid-market-to-enterprise contractors** (commercial HVAC/mechanical, fire protection, kitchen-exhaust cleaning, commercial refrigeration/electrical, food & medical equipment). Its gravity is **asset/equipment records, code-compliant inspections, and deficiency-to-repair revenue** across large customer portfolios, priced **~$89/technician/month billed annually** (Select/Premium/Enterprise; enterprise = call sales). Rivet is a **flat-$99/mo voice-first AI back office for 1–5-person residential shops**. Jobber is Rivet's real head-to-head (same ICP); ServiceTrade is a different weight class. This doc therefore reads as **"where do they overlap, and who wins the overlap"** — not "who's the better product," because they're built for different companies.

**Governing test (unchanged):** if a capability can't be completed by speaking a sentence, it doesn't count as parity for Rivet's thesis — it's a gap. Against ServiceTrade the second axis matters just as much: **can the buyer's compliance/asset workflow even be represented in the data model?**

---

## Executive summary (the blunt version)

1. **The overlap is real but partial, and the ICPs diverge.** Both do scheduling/dispatch, quoting, invoicing, payments, a customer portal, a technician mobile app, service agreements, and accounting sync. In that overlap Rivet wins on **real-time voice, the AI trust architecture, and price**; ServiceTrade wins on **asset/equipment depth, code-compliant inspection reporting, commercial multi-site portfolios, and two-way accounting**. Outside the overlap they're solving different problems.

2. **Rivet's flagship has no ServiceTrade equivalent.** ServiceTrade has *no native real-time inbound phone agent* — it reaches for a third-party integration (Whippy) when contractors want AI call handling. Rivet's inbound FSM (identify → qualify → book → escalate, emergency fast-path, streaming STT/TTS, eval corpus + daily real-call CI) is a genuine white-space win. So is the **proposal → approval → 5-second undo → audit** trust layer: ServiceTrade's AI drafts and recommends; Rivet's AI *writes to its own system of record* behind a typed, human-approved, reversible, audited gate. Nothing in ServiceTrade's "Smart AI" shows that architecture.

3. **ServiceTrade's two structural advantages are exactly Rivet's two biggest gaps.** ServiceTrade is asset-centric and inspection-centric to its core; Rivet **has no installed-equipment/asset registry and no inventory** (both spec-only — gaps G3/G4, `docs/stories/phase-13-gap-stories.md`, `phase-14-gap-stories.md`). Rivet *does* have real inspections/checklists (Job Forms, `packages/api/src/job-forms/`), but not ServiceTrade's code-compliance reporting formality or deficiency-to-quote conversion funnel. If the buyer's business *is* recurring inspections on tracked equipment, ServiceTrade is purpose-built and Rivet is not.

4. **"ServiceTrade AI" (Stella / Smart AI) is workflow-embedded assist, not an operator.** Stella Quote speeds deficiency-quote turnaround; Stella agents draft ready-to-review quotes and dispatch-ready schedules; Smart Transcribe turns audio memos into text; Smart Comment cleans up tech notes; Smart Summary/Insights surface context. All valuable, all **draft/recommend inside the office UI** — none of it is a conversational operator with write access, and none of it carries an undo/audit trust envelope. Rivet's defensible wedge in the overlap is: *their AI helps the office type faster; ours answers the phone and does the work, reversibly.*

5. **Price and target size cut opposite ways.** ServiceTrade's per-tech model (~$89/tech/mo annual, enterprise custom) is built for shops with a dispatcher and a dozen trucks; a 5-tech shop is ~$445/mo before the suite/add-on math. Rivet's flat $99 is built for the shop that *is* the owner. Neither is "cheaper" in the abstract — they're priced for different companies.

---

## A. Feature comparison scorecard

Legend: **WIN** Rivet ahead · **PARITY** equivalent for the overlapping use case · **GAP** ServiceTrade ahead · **ICP** capability exists but serves a buyer Rivet deliberately doesn't target. "Voice" = a Rivet owner can complete it by speaking (yes / partial / no / n-a).

| # | Capability | ServiceTrade (2026) | Rivet shipped state (code-verified) | Voice | Verdict |
|---|---|---|---|---|---|
| 1 | Inbound phone answering (AI) | **No native agent**; third-party Whippy integration for AI voice | Full inbound FSM: identify → qualify → book → escalate (`ai/agents/customer-calling/`, `telephony/`), emergency fast-path, streaming STT (Deepgram) + TTS (ElevenLabs), ~70-cassette eval corpus + daily real-call CI | n-a | **WIN** (white-space) |
| 2 | AI as operator vs. assistant | Smart AI / Stella **drafts & recommends** in the office UI (Stella Quote, dispatch-ready schedules) | AI **writes to the system of record** via typed Zod proposals → human approval → 5s undo → audit (`proposals/`, ~40 `ProposalType`) | partial | **WIN on trust architecture** |
| 3 | Scheduling / dispatch board | Strong: schedule board, GPS tech tracking, **multi-stop route optimization** | Real-time dispatch board + presence + lateness/ETA (`dispatch/`), drive-time feasibility (`scheduling/feasibility.ts`); **no multi-stop optimization** | yes (create/reschedule/cancel by voice) | **PARITY on board; GAP on route optimization** |
| 4 | GPS / ETA | GPS tech tracking; office can insert calls by location | GPS pings → lateness engine → auto en-route/late SMS (`dispatch/lateness.ts`, `notifications/delay-notifications.ts`) | partial | **PARITY** |
| 5 | Quoting / estimates | Sales CRM, proposals, **deficiency→quote funnel**, quote→work-order conversion, e-approval | Tiered good/better/best line items, catalog-grounded pricing, deposits, portal e-approval `/e/:id`, nudges, revisions (`estimates/`) | yes | **PARITY** (Rivet wins tiering + voice; ST wins deficiency funnel) |
| 6 | Invoicing / billing | Invoicing across large portfolios, batch, QuickBooks/Sage sync | Batch runs, milestone/progress schedules, late fees, multi-step dunning, auto-invoice on completion (`invoices/`) | partial | **PARITY** |
| 7 | Payments | Field payments, one-click online pay, collections | Stripe PaymentElement + links + saved cards + ACH + Wisetack financing (`payments/`, `financing/`) | partial | **PARITY** (Rivet edge: built-in financing) |
| 8 | Inspections / checklists | **Code-compliant inspection manager**, deficiency tracking, formal report generation | Job Forms: tenant-defined typed templates, per-job submission, immutable snapshot (`job-forms/`) + vertical canned checklists | partial | **GAP** (ST purpose-built for code compliance; Rivet has forms, not compliance reporting) |
| 9 | Installed equipment / asset records | **Core** — asset history, per-asset service record, scan on-site | **Not modeled.** No equipment/serial table (spec-only, gap G4, P13-002) | no | **GAP** (structural) |
| 10 | Inventory / truck stock / parts | Parts management | **Not built** (spec-only, gap G3, P14) | no | **GAP** |
| 11 | Work orders / jobs | Full job lifecycle, asset-linked | Full lifecycle, money-state, profit, photos, custom fields, from-estimate (`jobs/`) | partial | **PARITY** (ST links jobs to assets; Rivet has no asset to link) |
| 12 | Service contracts / recurring | Service agreements, recurring inspection contracts, reminders | Agreements + member pricing + off-session dues + recurring-jobs engine + maintenance contracts (`agreements/`, `recurring-jobs/`, `maintenance-contracts/`) | partial | **PARITY** |
| 13 | Customer / service portal | Multi-site portal: service history, approve quotes, preview upcoming | Token portal: estimates, invoices, pay, book, request service, agreements, payment methods (`portal/`, `web/src/pages/portal/`) | n-a | **PARITY** (ST wins commercial multi-site depth; Rivet simpler, no login) |
| 14 | Technician mobile app | Mature native app: photos/video/**audio memos**, time, asset history, scan paperwork, offline | Expo/RN app (jobs/schedule/estimates/invoices/voice) + web PWA; native-polish & offline-voice-queue gaps flagged (R3/R4) | partial | **GAP on maturity** (ST's app is a decade-hardened flagship) |
| 15 | Time tracking / timecards | Timecard module | Time entries → labor-to-invoice (`time-tracking/`) | no | **PARITY** |
| 16 | CRM | Contractor sales CRM, sales funnel | Contacts, tags, groups, custom fields, multi-location, dedup/merge, leads/speed-to-lead (`customers/`, `leads/`) | partial | **PARITY** |
| 17 | Reviews / reputation | Not a core module | Review-request worker, Google polling, AI response drafting + review gating (`reputation/`, `feedback/`) | partial | **WIN** (included flat) |
| 18 | Reporting / analytics | Service-performance, conversion-funnel, portfolio dashboards | SMB money dashboards, job/customer/tech profit rollups, EOD digest, voice ROI (`reports/`, `analytics/`, `digest/`) | yes | **ICP split** (ST = portfolio BI; Rivet = "did I make money on that job", deliberately) |
| 19 | Accounting integration | **Two-way** QuickBooks Desktop **+** Online, Sage Intacct/300/100 | **One-way** paid-invoice push to QuickBooks Online (OAuth, worker, dedup); Xero stub; no Sage (`integrations/accounting/`) | no | **GAP** (ST's accounting breadth is a major enterprise advantage) |
| 20 | Multi-tenancy / audit | Enterprise multi-org | Postgres RLS as the isolation boundary (`middleware/tenant-context.ts`, `db/rls-runtime-role.ts`), audit event on every mutation | — | PARITY (different shape) |
| 21 | Catalog / price book | Service catalog, parts pricing | Price book + CSV import, bundles, vertical packs (hvac/plumbing/electrical/painting), member pricing (`catalog/`, `verticals/`) | partial | PARITY |
| 22 | Standing instructions ("always do X") | Not exposed as a directable AI directive | Domain exists (`instructions/`, `StandingInstructionsSheet.tsx`); depth flagged in the Jobber review | partial | (thesis feature; N/A to ST) |
| 23 | Price / target size | ~$89/tech/mo annual, per-tech, Select/Premium/Enterprise; enterprise custom → built for 5–100+ trucks | **Flat $99/mo**, everything included → built for the 1–5-person shop | — | **ICP split** (not comparable — priced for different companies) |

---

## B. Where ServiceTrade wins (and whether Rivet should care)

1. **Installed-equipment / asset registry** — ServiceTrade's spine. "Pull up the Carrier RTU on Building C, unit 4" is a first-class query there and *does not exist* in Rivet's data model (gap G4). **Care level: high if Rivet ever moves up-market into recurring commercial inspection; low for the residential owner-operator ICP.** It's already the #1 parity gap in the Jobber review too (P24). Spec lives in `docs/stories/phase-13-gap-stories.md`.
2. **Code-compliant inspection reporting + deficiency-to-quote funnel** — ServiceTrade turns a failed inspection line into a tracked deficiency into a quote into a work order, with reports formatted to code authorities. Rivet has real inspections (Job Forms) but not the compliance-report formality or the deficiency funnel. **Care level: high for fire/mechanical compliance buyers; out of scope for residential.**
3. **Inventory / parts / truck stock** — not built in Rivet (gap G3). **Care level: medium — matters even for small shops, but deliberately deferred.**
4. **Two-way, multi-ledger accounting** — QuickBooks Desktop *and* Online, plus three Sage products, syncing customers/jobs/invoices bidirectionally. Rivet does a one-way QBO paid-invoice push (D-010, accepted for beta) and no Sage. **Care level: medium — one-way is a known, documented limitation.**
5. **Commercial multi-site portal depth + mature mobile app** — ServiceTrade's portal handles large multi-location portfolios and its technician app is a decade-hardened flagship (offline, audio memos, asset scan). Rivet's are solid but younger. **Care level: low-to-medium — the residential ICP rarely has multi-site portfolios; native app polish is tracked (R3/R4).**
6. **Multi-stop route optimization** — Rivet has drive-time feasibility, not optimization. **Care level: low for 1–3 trucks (already a punch-list, not-this-wave item).**

**None of these are accidental Rivet omissions except asset/inventory — they're ICP boundaries.** The honest read: if a prospect is a 15-truck fire-protection contractor doing NFPA inspections, send them to ServiceTrade. Rivet shouldn't try to win that deal.

## C. Where Rivet wins (the defensible wedge)

1. **Real-time inbound voice agent** — ServiceTrade has no native equivalent; it integrates a third party. For a shop with no receptionist, "the phone gets answered and the job gets booked" is the whole product, and it's Rivet's. (`telephony/`, `ai/agents/customer-calling/state-machine.ts`.)
2. **AI trust architecture** — typed proposals, human approval, 5-second undo, full audit, catalog-grounded pricing (never trust an LLM-emitted price), one-tap clarification instead of silent guesses. ServiceTrade's Smart AI drafts; it doesn't operate behind a reversible audited gate. This is the single hardest thing for a competitor to copy quickly. (`proposals/`, `ai/resolution/catalog-resolver.ts`.)
3. **Voice-first back office end-to-end** — quote, invoice, reschedule, look up profit, respond to a review — by speaking. ServiceTrade's AI is office-UI-bound.
4. **Included-flat everything** — reviews/reputation, financing, two-way SMS with a unified inbox, EOD digest, membership dues — all in the flat $99 with no per-tech multiplier and no add-on suite math.
5. **Built for the shop that is the owner** — no dispatcher assumed, no seat management, SMB-shaped reporting ("did I make money?") instead of portfolio BI. This is a deliberate anti-enterprise stance, and it's the opposite end of the market from ServiceTrade.

## D. Won't-build (ServiceTrade features that are traps for Rivet's ICP/pricing)

- **Full asset/equipment registry as an enterprise inspection system** — a *lightweight* serviced-equipment memory (P24, "the Carrier unit from May") is worth building for cross-call context; ServiceTrade's full code-compliance asset/inspection suite is a different company for a different buyer.
- **Multi-ledger two-way accounting (Sage 300/100/Intacct)** — enterprise-contractor requirement; one-way QBO is the locked beta stance (D-010).
- **Per-technician / per-seat pricing** — only makes sense when you sell to shops with many techs; Rivet is flat by thesis.
- **Portfolio BI / service-performance analytics suite** — the digest is the dashboard (locked); ServiceTrade's portfolio reporting serves ops managers Rivet doesn't have as users.
- **Multi-stop route optimization engine** — low value at 1–3 trucks; drive-time feasibility is enough.
- **Commercial multi-site portal hierarchies** — the residential ICP doesn't have building portfolios.

---

*Sources: repo state on branch `claude/servicetrade-feature-comparison-tifg0x` at 2026-07-14; ServiceTrade public product/pricing/feature/press pages via 2026-07-14 web verification (servicetrade.com direct fetches were proxy-blocked; claims cross-checked across GetApp, Capterra, Software Advice, G2, and ServiceTrade's own Smart-AI and integrations pages — pricing is per-technician ~$89/mo billed annually per public review aggregators, enterprise custom-quoted). Rivet build-status verified against `/packages` source and the companion `docs/competitive-gap-analysis.md`, `docs/competitive-analysis.md`, and `docs/competitive-review-rivet-vs-jobber-2026-07-02.md`.*
