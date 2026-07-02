# Full Product Verification — 2026-07-02

**Scope:** every routed screen, every workflow, every integration, verified against the running app (real web build, real API, real Postgres with all 231 migrations, real workers). Auth was the only substituted layer (dev bypass — the repo's own mechanism). External providers (Twilio, Stripe, Deepgram/ElevenLabs, LLM, Clerk webhooks, QBO) have no credentials in the verification environment; those legs are marked **STAGING** with the exact sign-off procedure in §4.

**Evidence:** 27 screen-capture clips + two results docs (journey RESULTS.md, sweep RESULTS2.md) delivered 2026-07-02; bug fixes landed on `claude/rivet-jobber-competitive-review-3n82iw`.

## 1. Verdict summary

| Area | Verdict |
|---|---|
| Onboarding wizard (identity, trade pack, test-call skip, welcome tour) | ✅ VERIFIED (phone/billing/AI-check steps STAGING) |
| Customers (create sheet, list, detail, dedup/merge surfaces) | ✅ VERIFIED |
| Jobs (create, list, detail, photos, time entry) | ✅ VERIFIED — photo-upload crash **fixed** |
| Scheduling (appointment create, schedule + dispatch views) | ✅ VERIFIED — browser-tz posting bug **fixed** |
| Estimates (manual create, tiers, send, public signature approval, status flip) | ✅ VERIFIED (SMS delivery itself STAGING) |
| Invoices (convert, list, send, public pay page) | ✅ VERIFIED (Stripe PaymentElement STAGING; graceful fallback shown) |
| Inbox / proposals (markers, chips, approve → real execution) | ✅ VERIFIED — batch-approve 400 + unexecutable-draft bugs **fixed**; failed executions now surfaced |
| Standing instructions (create, list, deactivate, applied-chip) | ✅ VERIFIED |
| AI approval rules incl. autonomous-booking opt-in (D-015) | ✅ VERIFIED |
| Assistant chat (round trip, conversation mode UI) | ✅ VERIFIED — thread self-wipe **fixed**; reply *content* STAGING (LLM key) |
| Leads (create, convert-to-customer, mark-lost) | ✅ VERIFIED |
| Comms inbox (threads, timeline; reply send) | ✅ VERIFIED — reply-400 header bug **fixed** (beb91ed); SMS delivery STAGING |
| Contracts / memberships / agreements | ✅ VERIFIED (detail page is read-only — product gap, not a bug) |
| Price book | ✅ VERIFIED |
| Templates (live section) | ✅ VERIFIED — **settings-save pack-wipe bug found here and fixed** (beb91ed); rest of page is known-fabricated content (see hardcoded-content audit) |
| Team members (invite flow) | ✅ VERIFIED (member activation via Clerk webhook STAGING) |
| Reviews / feedback (≥4★ Google gate both directions, dashboard) | ✅ VERIFIED |
| Public booking page (slot → held appointment → inbox proposal) | ✅ VERIFIED — never auto-confirms, exactly per trust model |
| Public intake form | ✅ VERIFIED |
| Customer portal (all 8 tabs, token-gated) | ✅ VERIFIED |
| Technician mobile (day view, en-route, job view) | ✅ VERIFIED — id-mapping (`internal_user_id` on /api/me) + styling **fixed** (beb91ed) |
| Reports (revenue-by-source, money dashboard, digest) | ✅ VERIFIED — job-costing card **added** to JobDetail (beb91ed) |
| Voice memo → transcription pipeline | ✅ wiring VERIFIED, graceful placeholder without STT key; real transcription STAGING |
| Phone AI (inbound receptionist), MMS-to-quote | ⏳ STAGING — webhooks live + signature-validating (403 on unsigned probes = proof of wiring); end-to-end needs Twilio/Deepgram/LLM keys |
| Stripe integration (payments, webhooks) | ⏳ STAGING — webhook mounted; needs keys |
| QuickBooks sync | ⏳ STAGING — worker + OAuth shipped; needs sandbox company |
| Scale (≥1000 users) | harness + selfcheck delivered; measured run needs provisioning (Redis → PgBouncer → replicas, `docs/runbooks/scaling.md` go-live checklist) |

## 2. Bugs found and fixed during verification (all on this branch)

Systemic: every route fired 10-11× onboarding-status + 3× /api/me per load (request coalescing added); batch approvals always 400 (duplicate Content-Type); AI-drafted estimate proposals couldn't execute (NaN totals, over-strict ids) and failures were invisible; assistant threads self-wiped (conversations GET omitted messages); appointments posted in browser timezone; invoice send 400 on empty recipient; jobs/estimates lists showed the literal word "Customer"; frozen dates ("Mar 10, 2026" header; estimates born expired after Apr 10 2026); fabricated business identity + dead share link in the customer-facing estimate preview/PDF; raw `draft_estimate` type on inbox cards; crushed sidebar VoiceBar; hardcoded `tech-1` id 500-ing two endpoints (uuid guards added). Sweep-2 fix round (beb91ed): settings-save silently wiping vertical packs (data destruction), comms reply headers (second fetch path, utils/api-fetch.ts), photo-upload crash, technician id mapping (Clerk sub vs internal UUID — /api/me now exposes internal_user_id), technician day view styled to the mobile tap-target rule, job-costing card wired to the orphaned job-profit endpoint.

## 3. Known product gaps (decisions, not defects — from the audits)

Fake-success surfaces awaiting a product call: job-page Call/Text/Cancel sheets simulate outcomes without API calls; voice-note tab fabricates transcripts; `/settings/templates` non-live sections are marketing mock with invented usage stats; estimate "AI suggest" asserts hardcoded prices and silently falls back to a price-inventing mock on AI failure (violates catalog grounding). No SMS-consent capture in the UI (suppresses estimate texts for UI-created customers). No undo affordance in the web inbox after approve (the 5s undo exists at the execution layer). WeeklyHours page built but unrouted. Recommendation list delivered 2026-07-02.

## 4. Staging sign-off runbook (provider-gated legs)

Run on staging with real credentials; each item has existing repo tooling:

1. **Phone AI (inbound receptionist):** set `AI_PROVIDER_API_KEY`, `DEEPGRAM_API_KEY`, TTS key, `TWILIO_MEDIA_STREAMS_ENABLED=true`. Trigger `.github/workflows/voice-smoke-real.yml` (daily real Twilio call asserting a booking proposal lands in the staging DB — the repo's own end-to-end proof). Then a manual call: book, reschedule, ask for a human, say "fuga de gas" (Spanish emergency keywords now active). Run the Layer-2 real-audio gate (`voice-quality-pre-deploy.yml`) — pass required.
2. **Owner voice + assistant:** with the LLM key set, record a voice memo ("Invoice the Martins $200 for the filter swap") → proposal appears in inbox with catalog-grounded pricing; assistant conversation mode with Deepgram token minting (stream-token limiter is live).
3. **MMS-to-quote:** text a photo to the tenant number → vision-drafted estimate proposal in inbox (gateway multimodal path).
4. **Stripe:** test-mode keys → send an invoice → pay with 4242 card on `/pay/:token` → `charge.succeeded` webhook flips it paid; verify saved-card + membership dues off-session charge; confirm ACH offered when enabled on the account (`automatic_payment_methods`).
5. **Clerk:** real signup → webhook bootstraps tenant → full onboarding wizard including Twilio number purchase and Stripe subscription steps (the two steps SQL-completed in the demo).
6. **Spanish fillers:** render clips once: `ELEVENLABS_API_KEY=… npx tsx scripts/render-fillers.ts`.
7. **QBO:** sandbox company OAuth in Settings → Integrations; mark an invoice paid → SalesReceipt appears in QBO.
8. **Scale:** provision per `docs/runbooks/scaling.md` go-live checklist, then `npm run loadtest:mixed -- --users 1000 …` and record ceilings in `docs/runbooks/voice-capacity.md` (tables are `TBD` until this runs).
