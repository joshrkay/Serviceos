# Rivet vs. Jobber — Voice-First Competitive Readiness Review

**Date:** 2026-07-02 · **Method:** every verdict verified against `/packages` source (code wins over docs); Jobber's 2026 bar verified against current public sources the same day. Companion build plan: `docs/plans/2026-07-02-001-feat-rivet-jobber-agent-wave-plan.md`.

**Governing test:** if a competitive capability cannot be completed by speaking a sentence, it does not count as parity — it's a gap.

---

## Executive summary (the blunt version)

1. **Rivet is much closer to Jobber parity than Rivet's own gap docs believe.** Four of the six "PRD-parity gaps" tracked in the 2026-06-14 roadmap are already closed in code (MMS-to-quote, GPS/ETA texts, B2B account hierarchy, tech-status SMS wiring), and two audit findings from 2026-06-15 (confidence markers unrendered, correction loop unwired) have since been fixed. The stale docs are a liability: they make the team re-plan work that shipped.
2. **Jobber's AI now writes to the system too.** "Jobber AI Voice and Chat" (launched 2025-09-25) executes 100+ task types — creating quotes, sending invoices, messaging clients — by voice on **all plans**, and the $99/mo AI Receptionist books directly into the Jobber calendar. The old pitch "their AI recommends, ours operates" is dead. The defensible wedge is now **the trust architecture** (typed Zod proposals, human approval, audit trail, undo, catalog-grounded pricing, one-tap clarification instead of silent guesses — none of which Jobber shows evidence of) **plus the closed-loop receptionist plus flat $99/mo** against Jobber's realistic $377–$527/mo for an AI-forward 1–5-person shop.
3. **The voice agents are demo-grade-plus with industry-top bones.** Real barge-in, streaming STT/TTS, filler-audio latency masking, and a best-in-class eval harness (daily real-call smoke test asserting DB effects) all exist — but the fast path ships **off by default**, the owner assistant is an async memo-recorder rather than a conversation, Spanish never reaches the live stream, standing instructions (the keystone of the directed-assistant thesis) have **zero code**, and every unsupervised AI booking still waits for a human tap. Closing these is the build wave.
4. **Scale is unproven.** The system runs one process on one replica, and the capacity tables say `TBD`. The architecture is ready for 1000 concurrent users; nothing has been provisioned or measured. (Track C of the build plan.)

---

## A. Competitive scorecard

Legend: **WIN** Rivet ahead · **PARITY** equivalent · **GAP** Jobber ahead · **CLAIM≠REALITY** docs overclaim vs code. "Voice" = owner can complete it by speaking (yes / partial / no / n-a for customer-facing surfaces).

| # | Workflow | Jobber (2026) | Rivet shipped state (code-verified) | Voice | Verdict |
|---|---|---|---|---|---|
| 1 | Phone answering | AI Receptionist ($99/mo add-on) answers calls/texts, books simple jobs, keyword handoff to humans | Full inbound FSM: identify → qualify → book → escalate (`ai/agents/customer-calling/transitions.ts`, `telephony/`), emergency fast-path, ~70-cassette eval corpus + daily real-call CI smoke | n-a | **WIN** on depth & trust; but see #2 |
| 2 | Autonomous booking close | Receptionist books **directly into the calendar** | Booking becomes a `create_appointment` proposal; with no supervisor present it **always waits for the owner's tap** (`auto-approve.ts:82` returns null unsupervised) | n-a | **GAP** (by policy, not capability — addressed by opt-in autonomous lane, UB-D) |
| 3 | Online booking | Public booking widget | `/book` page + `routes/public-booking.ts` (17KB), feasibility-checked slots | n-a | PARITY |
| 4 | Scheduling | Manual + AI suggestions | Voice-driven create/reschedule/cancel/confirm with drive-time feasibility (`scheduling/feasibility.ts`) | yes | **WIN** |
| 5 | Dispatch / assignment | Drag-drop board | Dispatch board + voice `reassign_appointment` — but a spoken technician name **cannot resolve** (no `technician` entity kind), so voice reassign stalls in draft (`voice-extended-tasks.ts:323`) | partial | **CLAIM≠REALITY** (PRD says ✅; fixed by U1) |
| 6 | GPS + ETA texts | Auto ETA on departure | Shipped end-to-end and stronger: GPS pings → lateness engine (`dispatch/lateness.ts`) → auto-late-notify + en-route SMS (queue → worker → Twilio, `app.ts:1892/3867`) | partial | **WIN** |
| 7 | "On my way" | Mobile button | `POST /dispatch/appointments/:id/en-route` + SMS keyword; tech-status keywords wired (`app.ts:1556`) | yes | PARITY+ |
| 8 | Quoting / estimates | Template editor, tiered, e-sign | Voice-drafted catalog-priced line items, tiered, portal approval `/e/:id`, signature capture | yes | **WIN** (e-sign is a canvas blob, not compliance-grade — fine for ICP) |
| 9 | MMS / photo-to-quote | Not offered | **Shipped**: customer MMS → vision model → catalog-grounded draft estimate (`sms/customer-mms/`, `ai/tasks/mms-estimate-task.ts`; gateway is multimodal) | n-a | **WIN** (docs stale — 06-14 roadmap still calls this missing) |
| 10 | Invoicing | Batch + progress invoicing | Batch runs, progress schedules, late fees, multi-step dunning, auto-invoice on completion, estimate nudges — all shipped (`invoices/`) | partial (batch/issue/send yes; **schedules had no voice on-ramp** — closed by U2) | PARITY+ |
| 11 | Payments — card | 2.9% + $0.30, saved cards, auto-pay | Stripe PaymentElement + links + saved cards (off-session membership dues) + refunds + Connect | partial (record_payment by voice) | PARITY |
| 12 | Payments — ACH | ~1% ACH | One-time ACH acceptance live-capable (`automatic_payment_methods`, full processing/settle/reverse lifecycle); **recurring/mandated ACH absent** (saved methods are card-only) | no | **GAP** (recurring ACH — punch list, Josh-gated) |
| 13 | Tips / Tap to Pay / instant payout | All three | None | no | **GAP** (deliberate — see Won't-build for Tap-to-Pay hardware; tips is a future pay-page toggle) |
| 14 | Financing | Wisetack built-in | Wisetack shipped (`routes/financing.ts`, webhook wired) | no | PARITY (docs stale — PRD says Wave 3) |
| 15 | Two-way SMS | Grow tier+ ($199+) | Two-way SMS/MMS + unified `CommsInboxPage` + per-customer timeline, AI-suggested replies | partial | **WIN on price** (Jobber gates this at $199/mo) |
| 16 | CRM depth | Full CRM, custom fields | Contacts, tags, groups, custom fields (customer+job), multi-location, dedup/merge, B2B parent/sub hierarchy + PM type (migrations 180/183) live in voice context | partial (lookups + update_customer) | PARITY+ |
| 17 | Equipment records | Basic asset notes | **Not modeled** — no equipment table; receptionist cannot know "the Carrier unit from May" | no | **GAP** (P24 — cut from this wave by Josh; punch list) |
| 18 | Client portal | Client Hub (approve/pay/tip/appointments/request) | Token portal: estimates, invoices, pay, book, request service, payment methods, agreements (`routes/public-portal.ts`, 42KB) | n-a | PARITY (no tip; no login either — simpler) |
| 19 | Reviews | Marketing Suite add-on ($39–79/mo) | Review-request worker, Google polling, AI response drafting + gating, feedback flow — included flat | partial (**respond-to-review had no voice on-ramp** — closed by U3) | **WIN on price** |
| 20 | Memberships | Full engine | Agreements + member pricing + off-session dues + recurring jobs + maintenance contracts | partial (lookup_agreements) | PARITY+ (docs stale — PRD once said specced) |
| 21 | Reporting | Job costing at Grow+; dashboards | Digest-as-dashboard (SMS deep-link), job costing/profit rollups, time tracking, voice `lookup_revenue`/`lookup_job_profit` | yes | **WIN** for ICP (deliberately not a BI suite) |
| 22 | QuickBooks | Deep two-way | One-way paid-invoice push (OAuth, worker, dedup) | no | **GAP** (accepted — D-010 locked one-way manual-trigger for beta) |
| 23 | Route optimization | Available add-on | Drive-time feasibility only; no multi-stop optimization | no | **GAP** (low priority for 1–3 trucks; punch list, not this wave) |
| 24 | Owner AI assistant | **Jobber AI Voice/Chat: 100+ tasks, all plans** | 31 speakable actions + 2 special-cased + 16 voice lookups, every one proposal-gated & audited; assistant is **async record→poll, not conversational** | partial | **GAP on experience, WIN on trust** (UB-B closes the experience gap) |
| 25 | Standing instructions ("always do X") | Custom automation builder (Grow+) | **Zero code** — the keystone directed-assistant concept is unimplemented | no | **GAP** (UB-A builds v1) |
| 26 | Spanish-language calls | Not offered by receptionist | Language detector + multilingual TTS exist, but the live stream opens Deepgram hard-`en` (`mediastream-adapter.ts:636`) | n-a | white-space **both** miss → UB-C makes it a WIN |
| 27 | Price | $39–$599/mo + $29/user + $99 AI + $79 marketing → **$377–$527 realistic** | **Flat $99**, everything included | — | **WIN** (structural) |

## B. Voice-forward gap list (weighted heaviest — these break the thesis)

1. **Owner assistant is not conversational.** Push-to-talk memo → upload → poll → proposal (`AssistantPage.tsx`); seconds-to-tens-of-seconds per turn, no barge-in, no spoken replies. Jobber's voice assistant is live. *→ UB-B.*
2. **Standing instructions don't exist.** "From now on, always add a $79 diagnostic fee" has no intent, no store, no injection point. This is the single largest gap between the product thesis ("the owner directs; the AI executes with leverage") and the code. *→ UB-A.*
3. **Voice technician assignment stalls.** `reassign_appointment` exists but spoken names can't resolve (no `technician` entity kind) — every voice reassign lands in draft for hand-fixing. *→ U1.*
4. **Orphaned handlers** (built, unreachable by voice, pinned by the catalog contract test): `create_invoice_schedule` ("50% now, 50% on completion"), `review_response_proposal` ("respond to that 1-star review"), `create_booking` (customer-call FSM path — intentionally deferred). *→ U2, U3.*
5. **No unsupervised close.** The receptionist qualifies and holds a slot, then waits for a tap — in a shop with no dispatcher, "AI answers and books" is really "AI answers and queues." *→ UB-D (opt-in, default off, undo-first).*
6. **Zero discoverability.** VoiceBar says "Ask Rivet AI anything…" — the 31 speakable actions are invisible, so owners never learn the vocabulary. *→ U7.*
7. **Spanish never reaches the stream** despite the detector, multilingual TTS, and a Spanish booking test existing. *→ UB-C.*
8. **Fast path off by default.** Barge-in + streaming + filler audio (the entire "feels human" stack) is gated behind `TWILIO_MEDIA_STREAMS_ENABLED`, which ships false; default calls run turn-based `<Gather>`. *(Cut from this wave by Josh — provisioning/ops item; punch list.)*
9. Category C white-space: assign-closest-certified-tech (P25), serviced-equipment capture (P24). *(Punch list.)*

## C. Claim-vs-reality (code wins)

**Stale-pessimistic — the docs claim gaps that are closed (update the docs, don't rebuild the features):**
| Doc claim | Reality |
|---|---|
| 06-14 roadmap E1: "MMS→estimate core missing; gateway text-only" | Shipped end-to-end: `customer-mms-intake.ts` → `mms-ingest-worker.ts` → `mms-estimate-task.ts`; gateway has `LLMContentPart`/image parts + vision routing |
| E3: "account_type only residential/b2b; no hierarchy; dead code" | Migration 180 added `parent_account_id`, 183 added `property_manager`; `b2b-account-context.ts` is live in the call path |
| E4: "ETA calc/renderer/worker missing" | `dispatch/lateness.ts` + `renderEnRouteTemplate` + delay-notification worker wired (`app.ts:1892/3867`) |
| 06-15 audit #12: "`registerTechStatusKeywords()` never called" | Called at `app.ts:1556` |
| 06-15 audit: "pricingSource rendered nowhere" | `InboxPage.tsx:241-358` renders per-line badges + overall confidence, with tests |
| 06-15 audit: "correction lessons no production caller" | Wired at `app.ts:1828` (execution), edit/undo routes, digest reads lessons; integration-tested |

**Stale-optimistic — the PRD claims ✅ where code disagrees:**
| PRD claim | Reality |
|---|---|
| §5 #5 voice dispatch assignment ✅ | Technician names can't resolve; drafts stall (fixed by U1) |
| §5 #18 ACH ✅→🔧 | Correctly downgraded; one-time acceptance is live-capable, recurring ACH absent |
| Supervisor "second classifier reviews every booking" (Decision #6) | Supervisor *presence gating* is live and load-bearing; the review pipeline exists but the per-tenant flag is off — "reviews every booking" is not what runs |
| Vulnerability/weather triage ✅ | Wired but fail-closed behind per-tenant `voice_vulnerability_triage` flag; off by default |
| §5 2026-06-14 reconciliation "per D-012" | D-012 is the negotiation engine; the reconciliation has no decision-log entry. Citation mismatch — fix in PRD |
| "Voice-first across the board" | 31 actions + 16 lookups is strong, but the two on-ramp orphans + non-conversational assistant undercut the claim until this wave lands |

**Also worth saying plainly:** `docs/remaining-features.md` is stale and should be deleted or regenerated; the 06-14/06-15 audit docs should get a "superseded by this review" header, or the next planning cycle will re-open closed gaps again.

## D. Prioritized punch list

**This wave (approved plan — competitive value ÷ build cost, guardrails intact):**
| Rank | Item | Closes / sharpens | Voice on-ramp sentence |
|---|---|---|---|
| 1 | UB-A standing instructions v1 | Keystone thesis gap; Jobber's automation builder equivalent, but directed + proposal-gated | "From now on, always add a $79 diagnostic fee to AC calls" |
| 2 | UB-B conversational assistant | Jobber AI Voice experience parity, keeps trust gate | (any sentence, now live) |
| 3 | UB-D autonomous booking lane (opt-in) | The closed-loop claim vs Jobber's direct booking — with undo + audit Jobber lacks | n-a (receptionist closes; owner says nothing — that's the point) |
| 4 | U1 technician resolution | Fixes the broken ✅ dispatch row | "Assign Carlos to the 2 pm" |
| 5 | UB-C Spanish streaming | White-space neither has; big for trades ICP | "Para español…" / caller just speaks Spanish |
| 6 | U2 invoice-schedule on-ramp | Progress-invoicing parity, spoken | "Set up 50% deposit, 50% on completion" |
| 7 | U3 review-response on-ramp | Review management, spoken | "Respond to that 1-star review" |
| 8 | U7 "you can say…" | Makes the 31 actions discoverable | — |
| 9 | Track C (UC-1…6) | 1000-concurrent-user readiness (R0) | — |

**Next (Josh-gated, in rough order):** Media Streams default-on + measured capacity (ops); equipment registry + receptionist cross-call memory (P24 — the Avoca-beating move); recurring ACH mandate (E2b, money — pause-and-ask); tips toggle on pay page (money); outbound speed-to-lead calls (comms policy design needed); voicemail-to-action; live-call auto-approve site (UB-D PR4); Spanish for the owner assistant.

## E. Won't-build (traps under flat pricing / North-Star breakers)

- **Drag-drop dispatch console as a primary surface** — the board exists as fallback; investing in it competes with our own thesis.
- **Marketing automation / campaign engine** — Jobber charges $79/mo because campaigns are an engagement treadmill; bounded, approval-gated re-engagement already exists (`lifecycle-email-worker`). A campaign builder drags us into deliverability, list hygiene, and content tooling — a different company.
- **Per-seat anything** — seat management only makes sense when you charge per seat. We don't.
- **Executive BI / advanced reporting suite** — the digest is the dashboard (locked). Job costing by voice already answers the owner's real question.
- **Franchise / multi-branch roll-up** — ServiceTitan's ICP, PRD non-goal, and the CRM plan's branch phase is decision-gated. Not for 1–5-person shops.
- **Tap-to-Pay hardware this wave** — Stripe Terminal is real work with physical-world support burden; revisit when field-payment demand is measured (tips first, it's software-only).
- **No-code workflow builder** — standing instructions (voice, bounded, proposal-gated) are our answer; a visual builder is Jobber's Grow-tier moat, not ours.
- **Referral program engine** — review flow + service credits cover the loop; referral tracking is Marketing-Suite bait.
- **Removing/weakening the approval gate globally** — UB-D is the only sanctioned exception: two capture-class booking types, opt-in, default off, undo-first, D-015-documented. Money and comms stay hard-blocked. Anyone proposing more autonomy than that re-litigates D-004 first.

---

*Report generated as U0 of the approved wave. Sources: repo state at commit `1bf2863`; Jobber public pricing/feature/press pages via 2026-07-02 web verification (direct fetches of getjobber.com were proxy-blocked; claims cross-checked across independent 2026 sources — pricing conflicts flagged in the plan appendix).*
