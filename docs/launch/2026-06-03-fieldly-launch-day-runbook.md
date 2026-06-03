# Fieldly — Launch-Day Runbook

**Date:** 2026-06-03
**Owner:** Founder
**Status:** Operational checklist for go-live

This is the ordered list of things that need to happen, by whom, in
what order, to flip the public switch. It is a companion to
`2026-06-03-fieldly-gtm-brief.md` (strategy) and
`docs/superpowers/runbooks/solo-owner-public-launch.md` (voice
quality gate). When this doc and those disagree, this one wins for
launch-week sequencing.

---

## Day-by-day (this week)

### Day 0 — Today

- [x] GTM brief written (`2026-06-03-fieldly-gtm-brief.md`)
- [x] Landing page shipped at `/` (unauth) / dashboard preserved (auth)
- [x] Brand cleanup pass: Fieldly everywhere user-facing
- [x] Launch-day social posts drafted (`2026-06-03-fieldly-launch-posts.md`)
- [x] Estimate-page mock-data leak fixed (privacy blocker)
- [x] Webhook idempotency confirmed durable (PR #457)
- [ ] AI model auto-provisioned on tenant create (in flight)
- [ ] Pack activation auto-seeds job types &amp; templates (in flight)
- [ ] FORCE RLS on all tenant tables (in flight)

### Day 1 — Tuesday

**Code (founder + agents):**

- [ ] Land remaining critical blockers (txn rollback on error,
      payment audit events, double-booking exclusion constraint).
      See `GO-LIVE-READINESS.md` blockers #2, #6, #7.
- [ ] Full production tsc build green: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
- [ ] Web build green: `cd packages/web && npx vite build`
- [ ] Run the on-branch test suite end to end: `cd packages/api && npm test`

**Ops (founder):**

- [ ] Register / confirm domain (`fieldly.app` or alternative)
- [ ] Point DNS to Railway: `fieldly.app`, `app.fieldly.app`, `api.fieldly.app`
- [ ] Provision TLS cert (Railway auto-cert + verify)
- [ ] Update Clerk application URLs and allowed origins for the new domain
- [ ] Update Stripe webhook URL to the new domain
- [ ] Update Twilio webhook URL to the new domain
- [ ] Set up Stripe product + recurring price ($297/mo, 14-day trial)
- [ ] Copy the Stripe price ID into Railway `STRIPE_PRICE_ID`

### Day 2 — Wednesday

**Production env vars** (Railway API service):

| Variable | Value |
|---|---|
| `TWILIO_MEDIA_STREAMS_ENABLED` | `true` |
| `TTS_PROVIDER` | `elevenlabs` |
| `ELEVENLABS_API_KEY` | _secret_ |
| `DEEPGRAM_API_KEY` | _secret_ |
| `DATABASE_URL` | _linked Postgres_ |
| `AI_PROVIDER_API_KEY` | _OpenAI key_ |
| `AI_DEFAULT_MODEL` | `gpt-4o-mini` |
| `STRIPE_API_KEY` | _live key_ |
| `STRIPE_PRICE_ID` | _price id from Day 1_ |
| `STRIPE_WEBHOOK_SECRET` | _signing secret_ |
| `CLERK_SECRET_KEY` | _live key_ |
| `CLERK_WEBHOOK_SECRET` | _signing secret_ |
| `SENDGRID_API_KEY` | _live key_ |
| `SENTRY_DSN` | _live DSN_ |

**Production env vars** (Railway web service, build-time):

| Variable | Value |
|---|---|
| `VITE_ONBOARDING_V2_ENABLED` | `true` |
| `VITE_CLERK_PUBLISHABLE_KEY` | _live pub key_ |
| `VITE_STRIPE_PUBLISHABLE_KEY` | _live pub key_ |
| `VITE_API_BASE_URL` | `https://api.fieldly.app` |

**Voice-quality gate:**

- [ ] Record voice-quality cassettes locally (requires `ANTHROPIC_API_KEY`
      on a trusted machine): `cd packages/api && npm run voice-quality:refresh`
- [ ] Run `npm run voice-quality:check-cassettes` until exit 0
- [ ] Run `npm run voice-quality` until `launchGate.pass === true`
- [ ] Founder records human sign-off in
      `docs/superpowers/plans/2026-05-19-solo-owner-launch-audit.md`

**Smoke test on staging:**

- [ ] Sign up as a fresh tenant
- [ ] Complete onboarding (identity → pack → phone → billing → AI check → test call)
- [ ] Make a real Twilio call to the provisioned number
- [ ] Verify an estimate proposal appears in inbox with one-tap approval
- [ ] Verify trial subscription is `active` in Stripe
- [ ] Verify Sentry catches a forced error

### Day 3 — Thursday (Quiet launch)

**08:00 PT — Pre-flight:**

- [ ] Production `tsc --project tsconfig.build.json --noEmit` exit 0
- [ ] All migrations applied: confirm with `list_migrations` against prod DB
- [ ] `/health` returns 200 on prod API
- [ ] `/ready` returns 200 on prod API
- [ ] Hit the landing page on the new domain — visual check on desktop + mobile

**09:00 PT — Open signups:**

- [ ] Confirm domain points to landing page
- [ ] Send the cold-email template to the 20 warm contacts
      (`2026-06-03-fieldly-launch-posts.md` §4)

**Throughout the day:**

- [ ] Founder is on call. Sentry alerts forwarded to phone.
- [ ] Manually onboard each new signup over a 20-minute video call
- [ ] Hand-review every Day-1 proposal for the first 10 customers
      (catches AI mistakes before they reach the customer)

### Day 4 — Friday (Broaden)

**10:00 PT — X thread** (`2026-06-03-fieldly-launch-posts.md` §1)
**11:00 PT — LinkedIn post** (§2)
**12:00 PT — r/HVAC + r/Plumbing** (§3) — Mon–Thu only for Reddit
**Throughout — Founder responsive in DMs**

### Day 5 — Saturday

- [ ] Triage incoming signups
- [ ] Reach out personally to anyone stalled in onboarding
- [ ] Post in local Facebook groups (`2026-06-03-fieldly-launch-posts.md` §5)
- [ ] Check Sentry + Stripe + Twilio dashboards for anomalies

### Day 7 — Monday post-launch

- [ ] Review trial → paid conversion (target: nonzero by day 7)
- [ ] Pull the metric set from the GTM brief §8
- [ ] Decide: ProductHunt next week? Y/N

---

## Hard gates (do not proceed past one without it)

1. **No public launch** until production `tsc` build is green on the
   live branch.
2. **No public launch** until voice-quality `launchGate.pass === true`.
3. **No public launch** until tenant-isolation smoke test (sign up two
   tenants, confirm they cannot see each other's data) passes.
4. **No public launch** until Stripe webhook signing secret is set and
   verified — silent failures here lead to ghost subscriptions.
5. **No public launch** until founder phone is on Sentry critical
   alerts and someone is on call.

---

## Rollback (if something goes wrong)

Per `docs/superpowers/runbooks/solo-owner-public-launch.md` §Rollback:

1. **Voice goes bad** — route Twilio inbound DIDs back to voicemail or a
   recorded "we're upgrading, leave a message" TwiML.
2. **Onboarding breaks** — set web env `VITE_ONBOARDING_V2_ENABLED=false`
   and redeploy. Restores legacy 9-step wizard.
3. **Webhooks misfire** — pause Stripe + Clerk webhook delivery in the
   provider dashboards (do NOT delete; pause). Drain the backlog after
   fixing.
4. **Site down** — revert the web deploy to the previous green build
   via Railway. The DB stays.
5. **Comms** — email or call any pilot tenants affected. Note in
   support CRM.

---

## Post-launch (week 2+)

- [ ] Product Hunt launch (if Day 7 metrics are green)
- [ ] Founder blog post: "Why we built Fieldly"
- [ ] One demo video (60s screen recording of digest + approval)
- [ ] FAQ page on landing site
- [ ] Build the 5 help-center articles (forward your line, how
      approvals work, change AI voice, invite a tech, trial billing)
- [ ] Decide on Stripe annual discount tier
- [ ] Capture first 3 customer testimonials

---

## Open questions before launch day

1. Confirmed domain? (`fieldly.app` vs other)
2. Founder availability for on-call hours during Days 3–5?
3. Warm-list of 20 contacts ready for cold email?
4. Twilio phone number budget for first 10 tenants?
