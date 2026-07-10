# Approved Claims Dossier — the honesty standard for ALL copy

Source of truth: docs/PRD-v3.md §5 (status-verified 2026-06-14/20 vs code), docs/prd-v3-code-status.md, FUNNEL.md. Every marketing sentence must trace to a ✅ row here or a fetched external URL. If it's not here, it doesn't ship.

## ✅ Claimable as SHIPPED (verified built & wired)
- AI answers the phone 24/7 in the shop's own voice, classifies intent, checks real availability (drive time + conflicts), and proposes the booking; owner approves with one tap by SMS. Loop closes without a dispatcher.
- Emergency + vulnerability detection (medical, elderly, weather): AI stops booking and patches straight to the owner's phone.
- Dropped call → automatic SMS recovery to the caller within ~60s.
- Back-office by voice: schedule/revenue lookups, voice-issued invoices ("Invoice the Martins…" → catalog-priced draft), voice assignment & reschedule, "I'm out" cascade reschedule, "on my way" → ETA text.
- Estimates: voice-drafted from calls, priced from the tenant's own price book (catalog resolver; uncatalogued items always flagged for human review), good/better/best tiers, e-sign + Stripe deposit on acceptance, automatic follow-up cadence on unsold estimates.
- Invoicing: auto-draft on job completion, Stripe payment links, dunning cadence, auto-accruing capped late fees.
- Payments: card + Stripe payment links. (NOT ACH — see banned.)
- Memberships: auto-renew (saved card, off-session), member pricing, priority booking.
- Client hub: token-gated link, no login — approve estimates, pay invoices.
- Reviews: post-job review requests with 4★ gating to Google; Google review monitoring; AI-drafted public response + private apology, owner-approved.
- Trust layer: every AI action is a typed proposal needing human approval, with audit trail and undo; supervisor second-pass agent reviews bookings/quotes; negotiation guardrail (AI never discounts); confidence markers on uncertain parts/prices; correction loop (owner edits teach the system; digest reports what it learned).
- End-of-day SMS digest: the day's P&L, pipeline, follow-up outcomes + "what I wasn't sure about" + "what I learned."
- QuickBooks: one-way sync, paid invoices → QBO.
- Unified inbox (SMS/email/calls one timeline) with AI-suggested replies in brand voice.
- Onboarding: signup → live AI phone agent flow (number provisioning, brand voice, test call); target < 48h to first AI-handled call. (Phrase as design target, not measured stat.)
- Platform: money in integer cents; per-tenant isolation (RLS); every mutation audited.
- 14-day free trial, card required, cancel anytime before day 15. Solo $299 / Shop $499 / Pro $799 per month.

## 🚫 BANNED — never claim as shipped (downgraded or unbuilt)
1. **MMS/photo-to-quote** — photo ingest exists; image→estimate analysis NOT built. (May describe as "coming"/roadmap only if clearly labeled.)
2. **ACH payments** — not configured/exercised. Say "card payments + payment links," never ACH.
3. **B2B / property-manager account recognition & routing** — binary flag only. No PM routing, sub-accounts, priority flows. Jenna's Greenfield story = vision, not shipped; don't use as capability claim.
- Also NOT shipped: tip capture, tap-to-pay, consumer financing, equipment registry (HVAC unit history), truck inventory, per-job profit by voice, native iOS/Android app (PWA only — say "works on your phone," not "native app"), offline voice capture, route optimization (drive-time feasibility only).

## 🚫 Fabrication bans
- No testimonials, customer names, customer counts, logos, star ratings, "trusted by," revenue-saved stats.
- No invented market stats — every external number needs a fetched URL captured in research/sources.md.
- "Owner hours returned" = the metric we optimize, not a measured result. Phrase as design goal ("built to give you back your evenings"), never "saves 15 hrs/week" as fact. Day-in-the-life narratives must be framed as illustrative scenarios ("Meet Mike — a day with Rivet looks like this"), not case studies of real customers.
- Competitor claims (Jobber AI Receptionist behavior, pricing) must cite fetched URLs from research.
