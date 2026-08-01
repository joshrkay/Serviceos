# AI Service OS → Rivet — PRD v4.2 Addendum
## Reconciliation of the PRD to the as-built code

**Status:** Draft for founder review
**Date:** 2026-06-20
**Amends:** *AI Service OS — Master PRD v4.1*
**Companion:** `docs/prd-v4.1-feature-diff.md` (story-by-story status of all 149 stories)

### How to read this
v4.1 described the product as *planned*. This addendum records where the *built* product
diverged — and for the items it covers (**name, architecture, pricing, integrations, and scope
beyond the 16 epics**) it supersedes v4.1. The feature *intent* of v4.1's epics/stories still
stands except where noted. This is structured as an amendment; it can be expanded into a full
v5 rewrite if preferred.

Most divergences are **deliberate decisions that solve the same problem a different way** — many
with decision records. They are not gaps. See *§4 Decisions of record*.

---

## 1 · What changed since v4.1
- **Renamed** AI Service OS → **Rivet**; repositioned from "the office manager you can't afford"
  to a sharper wedge: **"an AI dispatcher that replaces hiring a human dispatcher."** Public
  launch 2026-06-03. Tagline retained: *You learned the trade. We'll run the business.*
- **Re-platformed entirely** off v4.1's "locked" stack to **TypeScript/Express + React/Vite on
  Railway**. The v4.1 stack (Next.js / Supabase / LangGraph) now exists only as quarantined
  prototypes in `/experiments`.
- **Pricing changed** to **flat $297/mo + 500 voice min + $0.30/min overage** (was $99/mo + a
  0.5% payment fee) — resolving v4.1's open "metered vs flat" decision toward flat-with-overage.
- **Inbound voice** is consolidating on a **native Twilio FSM**; the managed Vapi path is legacy.
- **Significant scope was built beyond the 16 epics** (new product modules + a voice
  data/eval/training stack + QA/CI infrastructure + a parallel rewrite).
- **~87% of the 149 stories are built-or-substantial** (96% of P0). Two genuine P0 gaps remain.

---

## 2 · Identity & positioning  *(amends §1, §4)*
- **Product name:** Rivet — "Your AI dispatcher."
- **Wedge:** "AI dispatcher replaces hiring a human dispatcher" — a job-to-replace, not a feature.
  Lead source framing unchanged: the phone is the most expensive leak.
- **Persona unchanged:** the 1–3 truck HVAC/plumbing owner with zero switching cost.

---

## 3 · Architecture (as-built)  *(replaces §6 "Architecture (Locked)")*

| Concern | v4.1 "locked" | As-built | Decision record |
|---|---|---|---|
| Frontend | Next.js / Vercel | **React + Vite + React Router / Railway** | Implicit (D-001 rejects Vercel+Supabase; prototype quarantined) |
| AI runtime | LangGraph + FastAPI (Python) | **TypeScript / Express + provider-agnostic AI gateway** | D-005 (provider-agnostic gateway) |
| Orchestration | n8n Cloud | **Postgres-backed queue + ~27 workers + DLQ** | **ADR `docs/decisions/p0-028-queue-choice.md`** |
| Database | Supabase | **Managed Postgres host + in-code migrations**; RLS + pg_trgm retained | `production-readiness-scope.md`; D-001 |
| Inbound voice | Vapi *or* Retell | **Native Twilio FSM** (Vapi legacy) | **D16** (`2026-06-11-rivet-architect-plan.md`) — *confirm w/ owner* |
| Contractor STT | Deepgram Nova-3 | Deepgram (streaming) + **Whisper** (async upload) | `remaining-features.md` |
| TTS | — | **ElevenLabs** (streaming) | new |
| Email | — | **SendGrid** | new |
| Payments | Stripe-hosted + 0.5% fee | Stripe-hosted + **Stripe Connect** (tenant payouts); fee dropped | see §5 |
| Accounting | QuickBooks + Invoice Ninja | **QuickBooks one-way** only (Invoice Ninja dropped; Xero stub) | priority/Wave 3 |
| LLM routing | Tiered (light/Sonnet) | **Tiered Haiku/Sonnet**, env-configurable | retained |
| Auth / SMS | Clerk / Twilio | Clerk / Twilio | retained |

---

## 4 · Decisions of record (why the divergences are not gaps)
Recovered decisions that supersede v4.1's named choices. Full reclassification in
`prd-v4.1-feature-diff.md` → *Divergence reclassification*.

| Superseded v4.1 line | Solved instead by | Record |
|---|---|---|
| n8n orchestration | Postgres queue + workers (same durability/retry/idempotency) | **ADR p0-028** (explicit) |
| Supabase | managed Postgres + app-layer RLS | production-readiness-scope; D-001 |
| Next.js / LangGraph | React+Vite / TS gateway | implicit (D-001, D-005) |
| Invoice Ninja (13.3) | native invoicing + **Stripe Connect** + QuickBooks (Rivet owns the cash funnel) | priority + functional replacement |
| 0.5% payment fee (8.7) | flat $297/mo subscription | GTM brief (§5) |
| Vapi | native Twilio FSM | D16 (confirm) |

**Two ADRs still worth recording:** a **pricing ADR** (locks §5 and formally kills 8.7) and a
**tech-stack-rejection ADR** (Next.js/Python — today only documented in `/experiments` READMEs).

---

## 5 · Pricing & economics (as-built)  *(replaces §7)*
- **Plan:** flat **$297 / month**, 30-day trial. (was $99/mo)
- **Voice:** **500 minutes included + $0.30/min overage.** (resolves v4.1's metered-vs-flat open item)
- **0.5% payment fee:** **dropped** — superseded by the flat subscription.
- **Built:** subscription billing is live (`billing/subscription.ts` — trial, checkout, customer
  portal; price via `STRIPE_PRICE_ID`).
- **Not built (open):** post-trial **voice-overage metering/billing** — only trial gating
  (100-min cap) exists today. This is the one revenue-relevant gap (see §7).

---

## 6 · Scope built beyond v4.1 (fold into canon)
Real, shipped capability with no home in v4.1's 16 epics. Recommend promoting to first-class epics:

- **Epic 17 · Platform Billing** — tenant SaaS subscription (trial, checkout, portal).
- **Epic 18 · Service Agreements / Memberships** — recurring jobs+invoices, member pricing,
  priority booking, off-session dues collection.
- **Epic 19 · Reputation** — Google review mirroring + AI reply drafting.
- **Epic 20 · Customer Portal** — token-scoped self-service (booking, invoices, estimates).
- **Epic 21 · Localization (EN/ES)** — bilingual voice/SMS/email; a deliberate market choice that
  pairs with the Spanish voice corpus.
- **Epic 22 · Voice Quality & Eval** — 3,600+ labeled-utterance corpus, eval harness
  (`packages/voice-eval`), CI quality gates, `serviceos_training` pipeline.
- **Cross-cutting (governance, already partly in Epic 14):** active-learning correction loop,
  quality/beta-readiness gates, CSAT feedback, escalations + on-call rotation, lookup-events
  telemetry.
- **Not product — note for the record:** QA matrix + 82 integration + 44 e2e tests + 8 CI
  workflows; the `/rewrite` parallel rebuild (not deployed); a ~309-story execution backlog.

---

## 7 · Open / not-yet-built  *(honest gap list)*
- **9.12 Voice-overage metering** — *revenue-relevant*; required by the §5 pricing model.
- **5.5 48h proposal expiry** — `expiresAt` field + check exist; no creation path sets the TTL.
- **Epic 11 Inventory (stock)** — deferred *by design* (all P1/P2); no quantity-on-hand model.
- **MVP-hardening 🟡s** — re-audit Epic 2 onboarding (the FSM agent under-counts), wire 15.2
  speed-to-lead auto-response trigger.

---

## 8 · Still-open decisions  *(carries §12 forward)*
1. **Lock pricing?** Confirm flat $297/mo + overage. If locked, 8.7 is permanently obsolete and
   9.12 is the only monetization work left.
2. **Confirm D16** — deprecate Vapi in favor of the native Twilio FSM for all new voice work.
3. **Self-serve booking pattern** — keep direct-write-then-owner-review for voice/online bookings,
   or hold high-value bookings for confirmation (unchanged from v4.1).
4. **Job-costing epic** — time tracking + expense capture feed it; the costing layer is still
   unscoped.
