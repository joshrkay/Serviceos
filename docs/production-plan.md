# Production Plan — Ship Tomorrow

Date: 2026-06-10
Supersedes nothing; consolidates: `GO-LIVE-READINESS.md` (blockers),
`docs/competitive-gap-analysis.md` (features/market), `docs/launch-plan.md`
(lanes + thread schedule). This is the one document to run the launch from.

---

## 1. The verdict

**We can be in production tomorrow** if we (a) fix the go-live blockers
tonight — they are small, surgical, independently dispatchable fixes, not
redesigns — and (b) launch with a deliberately scoped configuration
(single instance, outbound AI calling OFF, autonomous booking OFF until
P12 lands). The product underneath is genuinely built: real integrations,
disciplined money math, the proposal safety model, ~600 test files.

What "production tomorrow" is: the app live on Railway for real tenants —
jobs, scheduling, estimates, invoices, payments, customer portal, the AI
assistant with human-approved proposals, and the inbound AI phone agent
creating booking proposals.

What it is not yet: the full "speak it and it happens" autonomy. That
arrives over the following ~3 weeks via the lanes (§5).

---

## 2. Tonight — the blocker burn-down (10 items, parallelizable)

From `GO-LIVE-READINESS.md`. Wave T1 items are disjoint files — run as
parallel threads. Each fix lands with a test.

**Wave T1 (parallel, ~independent one-file fixes):**

| # | Fix | Where |
|---|-----|-------|
| B1 | Switch Stripe/Clerk webhooks to the durable `PgWebhookEventRepository` (already built, used by Twilio/SendGrid) | `webhooks/routes.ts:34`, `app.ts:1003-1010` |
| B2 | Roll back request transaction when `res.statusCode >= 400` | `middleware/tenant-context.ts:138`, failing test already exists |
| B3 | `FORCE ROW LEVEL SECURITY` on the 29 unforced tenant tables | `db/schema.ts` (new migration) |
| B4 | Fix unauthenticated proposal-approve fetch in the web UI (use `apiFetch`/`useApiClient` + surface errors) — **the central approval flow is broken in prod today** | `AssistantPage.tsx:257` |
| B6 | Emit audit events from `recordPayment` (wire the existing `reconcilePayment` wrapper or inline the emit) | `invoices/payment.ts:144-225` |
| B8 | Remove the mock-data fallback on the public estimate page (cross-tenant leak); render an error state | `EstimateApprovalPage.tsx:531-592` |

**Wave T2 (after T1, small):**

| # | Fix | Where |
|---|-----|-------|
| B7 | DB exclusion constraint against double-booking + enforce feasibility on direct create; audit assignment mutations | `schema.ts`, `routes/appointments.ts` |
| B9 | Quarantine the non-deployed architectures (move `infra/`, `service-os-app/`, `service-os-agent/`, `supabase_migration.sql` under `experiments/` or delete) — Railway is the one target | repo root |
| B5 | **Accept as documented constraint**: launch on exactly ONE Railway instance (in-process sweeps are then safe). Leader-lock sweeps are week-1 work, pre-scale. | `railway.toml` note |

**Gate (before flipping DNS/billing on):**

| # | Gate | |
|---|------|---|
| B10 | Green CI: `npx tsc --project tsconfig.build.json --noEmit`, full test suite, and confirmed prod migrations (incl. 106 + `webhook_events` unique index) | CI |

**Launch-config switches (no code):**
- Outbound AI calling **OFF** (no TCPA/DNC consent gate yet — legal exposure).
- Inbound AI agent **ON** (Media Streams if `TWILIO_MEDIA_STREAMS_ENABLED` +
  Deepgram/ElevenLabs keys are set; Gather fallback otherwise).
- All proposals require human approval (P12 autonomous routing not yet
  shipped — and B4 makes approval actually work).
- US-Pacific beta tenants only (web renders browser-local time; UTC dashboard
  bucketing documented).

**Day-after fixes (important, not gating):** voice-transcript KMS encryption
before real call volume; cents-display bug on invoice/estimate detail pages;
authenticated `/metrics`; consolidate web auth-fetch on `useApiClient`.

---

## 3. What we launch WITH tomorrow (already built and verified)

- **CRM + field ops:** customers, locations, jobs w/ lifecycle + photos,
  appointments + assignments, real-time dispatch board, tech mobile views,
  time tracking, expenses, leads, service agreements.
- **Money:** tiered (good/better/best) estimates with public approval,
  invoices, Stripe payment links + public pay pages, recurring/batch
  invoicing, dunning (partial), price book w/ CSV import, money dashboard,
  tax export.
- **AI:** 40 proposal types behind approval/undo/audit; 25 skills; intent
  classification; LLM gateway (failover, caching, quotas, guardrails);
  in-app assistant with voice recording + TTS; **inbound AI phone agent**
  (streaming STT/TTS) that books appointment proposals and escalates to
  on-call humans.
- **Scheduling intelligence:** drive-time feasibility (Google Distance
  Matrix), availability lookup, Google Calendar sync.
- **Comms & reputation:** Twilio SMS, SendGrid email, per-tenant
  provisioning, Google review sync + AI-drafted follow-ups, DNC list.
- **Platform:** multi-tenant RLS (FORCEd after B3), Clerk auth, audit trail,
  customer portal, public booking/intake, onboarding.

## 4. What's left (every item has a dispatchable story)

| When | What | Stories | Why it's next |
|---|---|---|---|
| Week 1 | Voice agent books **autonomously** in-call; one-tap SMS approve for the solo owner | P12-001..006 | The pitch: "the phone answers itself" |
| Week 1 | Voice agent can create new customers (today every new-customer call leaks) + 9 parity stories | P18-001 first, then P18-002..010 | Highest-priority story in the roadmap per its own spec |
| Week 1–2 | Spoken invoices priced from the price book; `issue_invoice`; mic on every screen; offline voice; per-job profit by voice; receipt→expense | P22-001..006 | "Send the invoice with a service call and three gaskets" |
| Week 2 | Truck inventory + parts-per-job + "what's on my truck?"; installed equipment records | P14-001..003, P13-002 | The truck is the warehouse |
| Week 2 | QuickBooks OAuth + sync (today's settings modal is a mock); follow-up agent | P15-001; P8-015..027 | Keeps the accountant; chases money automatically |
| Week 2–3 | Auto-invoice on completion, reminder cadence, late fees, milestone invoicing | P20/P21 stories | Cash collects itself |
| Week 3+ | Native iOS/Android (Capacitor), financing prequal links, voice-fillable checklists, outbound webhooks (Zapier), campaigns | P23-001..005, P16-001/003 | Jobber-parity closure (gap analysis §5) |
| Week 1 (ops) | Leader-lock cron sweeps + graceful shutdown (unlocks multi-instance); KMS transcripts; TCPA/DNC gate (unlocks outbound calling) | readiness 🟠 list | Scale + legal unlocks |

Thread mechanics: `/dispatch-story <id>` per story, parallel across lanes —
see `docs/launch-plan.md` (lane map, cross-lane dependencies, day-by-day
schedule).

## 5. Where we'll be

- **Tomorrow (launch):** a real, safe, multi-tenant field-service platform
  with an AI assistant and an AI phone agent whose every action a human
  approves. Honest pitch: "AI runs your office; you approve with a tap."
- **+1 week:** the tap mostly disappears — autonomous in-call booking with
  SMS fallback, voice customer capture, spoken catalog-priced invoicing.
  Pitch upgrades to: "You know the trade. We run the business."
- **+2 weeks:** truck inventory, equipment memory, QuickBooks, follow-up
  agent — the demo from `docs/launch-plan.md` §"Definition of launch-ready"
  is fully live.
- **+3–4 weeks:** app-store presence, financing, checklists, webhooks —
  the Jobber §5 comparison holds: they organize the office work; we do it.

## 6. Run order for tomorrow

1. Tonight: dispatch T1 (6 threads) → T2 (3 threads) → B10 CI gate.
2. Confirm prod env: Railway single instance; Stripe/Twilio/SendGrid/Clerk/
   OpenAI keys; `TWILIO_MEDIA_STREAMS_ENABLED` + Deepgram + ElevenLabs keys
   if launching streaming voice; outbound calling flag OFF.
3. Apply migrations; verify webhook unique index; smoke-test: book → estimate
   → approve → invoice → pay (test mode) → audit rows present.
4. Flip on. First tenants: US-Pacific, known shops, white-glove.
5. Day 1 in prod: start Week-1 lanes (P12-001, P18-001, P22-001/002,
   P15-001 in parallel).
