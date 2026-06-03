# Fieldly — Go-to-Market Brief

**Date:** 2026-06-03
**Stage:** Public launch (Wave 3 entry)
**Owner:** Founder
**Document status:** Ready for marketing execution

---

## 1. One-paragraph pitch

Fieldly is the AI back office for solo home-service operators. It answers
the phone in your shop's voice, drafts quotes from the call, sends invoices
when the job is done, and chases payment — and surfaces only the
30-second decisions that actually need you. Built for the 1–3 truck HVAC
or plumbing shop that can't afford an office manager and can't grow without
one.

**Tagline:** _You learned the trade. We'll run the business._

---

## 2. The wedge

> **AI dispatcher replaces hiring a human dispatcher.**

This is the single sentence we lead with. Three reasons it works:

1. **It's a job, not a feature.** Owners know what a dispatcher costs and
   what a dispatcher does. Replacing one is a P&L decision, not a "try
   this AI thing" decision.
2. **It's the bleeding wound.** Every owner we've talked to is
   dispatching from their truck. They lose at least one job a week to
   missed calls. The number is concrete and they feel it.
3. **It's not a competitor's wedge.** ServiceTitan sells "operations
   software." Housecall Pro sells "all-in-one." Rosie / Goodcall sell
   "AI receptionist" (book-and-forget, no quoting, no follow-up). Nobody
   else is saying "the dispatcher is the bottleneck and we replace it."

Adjacent jobs we then expand into (without re-positioning): drafting
estimates, sending invoices, chasing payment, monitoring reviews.

---

## 3. ICP

### Primary (V1)

**Owner-operator HVAC or plumbing shops, 1–3 trucks, $200K–$1M revenue,
no dedicated office staff.** US-based. English-speaking.

Bull's-eye persona: **Mike (HVAC, 2 trucks, $680K, Phoenix)** —
documented in full at `docs/strategy/day-in-the-life.md`.
Secondary persona: **Jenna (solo plumber, $340K, Cleveland)** — proves
the wedge holds for solo operators.

### Disqualifying signals

- 5+ employees with a dedicated office manager
- Already on ServiceTitan and happy
- Wants to grow into a 20-truck fleet (different product)
- Doesn't carry a smartphone

### Why now (the demand-side story)

Three things became true in the last 18 months:
1. Real-time voice models hold a competent service-business conversation
   under $1/min in COGS.
2. SMS + Stripe + Twilio + OpenAI are mature enough that an AI can run
   an entire money flow end to end.
3. The owner-operator labor crisis (no admin staff available, no time
   to train one) is forcing demand. Ten years ago the answer was
   "hire a receptionist." Today nobody can.

---

## 4. Pricing

| | Fieldly |
|---|---|
| **Price** | **$297 / month** |
| **Free trial** | 14 days, no card required |
| **Includes** | Unlimited inbound calls, unlimited SMS, AI quoting, AI invoicing, payment chasing, review monitoring, end-of-day digest |
| **AI voice minutes** | 500 / month included; $0.30 / min after |
| **Phone number** | One US local number included |
| **Onboarding** | Self-serve in 15 min, white-glove available |

**Why this price**:
- Anchored against the cost of a part-time dispatcher ($2,400+/mo) and
  the cost of one lost emergency job (~$500–1,500).
- Single tier removes the "which plan should I pick" objection that
  kills SMB conversions.
- Margin: gross margin >70% at expected usage (200 mins/mo median per
  PRD §11 voice budget).

**Stripe configuration**: one product, one price (`STRIPE_PRICE_ID` env
var). 14-day trial baked into the Checkout Session. Webhook flips
`tenants.subscription_status` to `active` on `checkout.session.completed`.

---

## 5. Positioning vs. competitors

| Player | Their pitch | Where they leave the owner stuck |
|---|---|---|
| **ServiceTitan** | "Field-service operations platform" | $400+/mo, weeks to onboard, requires a dispatcher to operate |
| **Housecall Pro** | "All-in-one home service software" | Owner still answers the phone, writes the quote, sends the invoice |
| **Jobber** | "Field service CRM" | Same — software, not staff |
| **Rosie / Goodcall / Numa** | "AI receptionist" | Books an appointment. Doesn't quote, invoice, chase payment, or monitor reviews. And papers over its mistakes. |
| **Fieldly** | **AI back office** | Replaces the dispatcher, not the truck. The owner runs the trade; we run the business side. |

**The honesty wedge.** Every AI receptionist on the market hides its
mistakes. Fieldly surfaces them. The end-of-day digest has a
"what I wasn't sure about today" section. That's the trust pillar
nobody else will copy because nobody else wants to admit AI is
sometimes wrong.

---

## 6. Messaging by surface

### Homepage hero
- **H1:** Your AI dispatcher.
- **Sub:** Fieldly answers your phone, books your jobs, sends your
  quotes, and chases your invoices. You approve what matters in
  30 seconds a day.
- **CTA:** Start 14-day free trial — no card.

### Email/cold outreach (one-liner)
"Replace your dispatcher with AI. Fieldly answers every call in
your shop's voice and books the job — for the cost of half a tank
of gas a day."

### Social (X / LinkedIn launch post)
> Most HVAC owners I know are dispatching from inside an attic on
> a 102° day. We built Fieldly because they shouldn't have to.
> AI answers the phone, books the job, sends the quote, chases
> the invoice. Owner approves what matters in 30 seconds a day.
> $297/mo. 14-day trial. Link below.

### Sales / demo opener
"I'm going to read you a typical Tuesday for a 2-truck HVAC shop.
Stop me when it sounds like you." (Then read Mike's Tuesday
without-column from `day-in-the-life.md`.)

---

## 7. Soft-launch channel plan (this week)

Day 1–2 (build): land critical fixes (webhook idempotency, estimate
page mock-data leak, RLS FORCE), ship landing page, rebrand to Fieldly,
wire Stripe pricing, set up PostHog.

Day 3 (quiet launch): open signups to a closed list of ~10 trusted
operators we've already talked to. Onboard each personally over video
call. Goal: 3 active tenants taking real inbound calls by Friday.

Day 4–5 (broaden): one post on each of these surfaces:

| Channel | Asset | Expected outcome |
|---|---|---|
| **X (founder account)** | Launch post with Mike's without/with table | 500–2K impressions, 10–30 trial signups |
| **LinkedIn (founder + warm network)** | Same message, longer-form | 100–500 impressions, higher-quality leads |
| **r/HVAC + r/Plumbing** | Honest "we built this — would love feedback" post | 50–200 upvotes if landed well, churn-prone signups; high feedback value |
| **Direct email to 20 warm contacts** | Personal "would you try this and tell me what's broken" | 5–10 actual conversations |
| **Local FB groups (HVAC owners, plumbers)** | Same as Reddit, geographic | Slow but high intent |

What we are **not** doing this week:
- No Product Hunt launch (premature; we want a private validation week first)
- No paid acquisition (channel won't pay back at this MRR / CAC)
- No press (no story yet beyond "we exist")

The week-2 plan, conditional on green metrics: Product Hunt + a
founder blog post about why we built it.

---

## 8. Success metrics — first 14 days

| Metric | Target | Source |
|---|---|---|
| Trial signups | 25 | PostHog `signup` event |
| Onboarding completion rate | >60% | Onboarding status API |
| Time from signup to first AI-handled call | <48h | `voice_sessions` + tenant created_at |
| Trial → paid conversion | ≥20% by day 28 | Stripe subscription_status |
| Active operators by day 7 | 5+ | Operators with ≥1 inbound AI call in last 24h |
| Owner approvals/day, median | <15 | proposal table by tenant |
| Critical incidents (data leak, double-charge, missed emergency) | 0 | Sentry + manual review |
| NPS or "would you tell a friend" by day 14 | >40 | Direct outreach to active tenants |

If trial→paid conversion is under 10% by day 28, the wedge is wrong;
re-evaluate before scaling channels.

---

## 9. Risk register (launch-week)

| # | Risk | Mitigation |
|---|---|---|
| 1 | AI mis-quotes during a trial; operator loses a job and churns | Confidence markers + supervisor agent + honest digest; manual review of every Day-1 proposal for the first 10 customers |
| 2 | Webhook double-charges a customer | Blocker #1 fixed before launch (PG idempotency repo) |
| 3 | Tenant isolation bug exposes data cross-tenant | RLS FORCE migration before launch; manual smoke test |
| 4 | Voice quality is poor and operator's customer hangs up | Voice-quality launch gate from `voice-quality-launch-gate.md`; single instance; sub-800ms TTFA spot-check |
| 5 | Stripe trial expires silently and operator's AI goes dark | Trial expiry warning at 3d / 1d / day-of; operator can extend via chat |
| 6 | Onboarding stalls at AI-check step (model not provisioned) | Pre-seed default model on tenant creation; hot-fix this before launch |
| 7 | We get press attention before we're ready | We're not pursuing press this week. If inbound press happens, point at the brief and ask for week 4 |
| 8 | Single-instance deploy can't handle load spike | Documented constraint. Capacity is ~50 concurrent tenants on current Railway plan. Beyond that, leader-locked cron + horizontal scale |

---

## 10. Pre-launch checklist (in priority order)

### Must-fix code (Day 1–2)
- [ ] Stripe + Clerk webhooks use durable PG idempotency repo
- [ ] EstimateApprovalPage no longer falls back to mock data on network error
- [ ] FORCE ROW LEVEL SECURITY on all tenant-scoped tables
- [ ] AI model provisioning on tenant creation (default to `AI_DEFAULT_MODEL`)
- [ ] Pack activation seeds default job types and templates
- [ ] Production TypeScript build green (`npx tsc --project tsconfig.build.json --noEmit`)

### Must-have marketing (Day 2)
- [ ] Public landing page at fieldly.app `/`
- [ ] Rebrand cleanup (all user-facing "ServiceOS" → "Fieldly")
- [ ] Pricing visible on landing + Stripe Checkout configured to $297/mo
- [ ] PostHog wired with `signup`, `onboarding_step_completed`, `first_ai_call`, `trial_to_paid` events

### Must-have ops (Day 2–3)
- [ ] Production domain DNS pointed at Railway (`fieldly.app`, `api.fieldly.app`)
- [ ] TLS cert provisioned
- [ ] Sentry alerting wired to founder phone for critical errors
- [ ] Voice-quality Layer 1 gate signed off (per `voice-quality-launch-gate.md`)

### Must-have content (Day 3)
- [ ] Founder X post drafted
- [ ] Founder LinkedIn post drafted
- [ ] Reddit posts drafted (r/HVAC, r/Plumbing)
- [ ] Cold email template for 20 warm contacts
- [ ] Support email + Slack channel for trial users

### Should-have (week 1, post-launch)
- [ ] FAQ page
- [ ] Demo video (60s screen recording of the digest + an approval)
- [ ] One-pager PDF for sales conversations
- [ ] Help center with 5 articles: how to forward your line, how
      approvals work, how to change your AI's voice, how to invite
      a tech, how trial billing works

---

## 11. Open questions

1. **Domain**: confirm `fieldly.app` vs `fieldly.com` vs other. Anything
   we register today will need DNS + TLS + Clerk app rename before
   Friday.
2. **Voice number**: do we provision a Fieldly support number for trial
   users to call us, separate from their provisioned business number?
3. **Free-trial gating**: 14 days, or 14 days + 100 AI-minute cap
   (whichever comes first)? Cap protects margin if a high-volume shop
   signs up and never converts.
4. **Warm list**: confirm the 10 trusted operators for Day 3 quiet
   launch — names and outreach owner.
5. **Founder availability**: who's on call for Day 3–7 if a critical
   incident hits at 2 AM?

---

## 12. Companion documents

- `docs/PRD.md` — product strategy and locked decisions
- `docs/strategy/day-in-the-life.md` — Mike and Jenna's days
- `docs/superpowers/runbooks/solo-owner-public-launch.md` — ops runbook
- `docs/superpowers/runbooks/voice-quality-launch-gate.md` — voice gate
- `GO-LIVE-READINESS.md` — code blocker list

---

_This document is the marketing source of truth. When messaging on
any surface (landing, social, sales, email) disagrees with this
document, this document wins. Edit it; don't fork it._
