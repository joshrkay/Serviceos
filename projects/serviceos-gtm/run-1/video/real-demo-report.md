# Real-Product Demo Video — Build Report

**Status: REAL-FOOTAGE** ✅

The hero demo is cut from genuine screen recordings of the actual Rivet/ServiceOS
web app (`packages/web`) booted headlessly and driven in Chromium. It replaces the
prior SYNTHETIC slide-animation `demo-hero.mp4` (now relocated to `legacy-mockup/`).

> Product-name note: the shipped app is branded **"Rivet"** in every screen (the
> "ServiceOS" wordmark only ever existed in the synthetic mockups). Brand cards and
> the end card therefore say **Rivet** to match what is actually on screen. Company
> is Rivet, product is ServiceOS (per `brand/guidelines.md`).

## What booted
Followed the project `packages/web:verify` harness (InMemory, no Clerk cloud):
- **API**: `packages/api` `src/index.ts` via `node -r ts-node/register`, `NODE_ENV=dev
  DEV_AUTH_BYPASS=true`, no `DATABASE_URL` → InMemory repos (Docker/Postgres not
  needed). Health 200.
- **Web**: `vite` in `VITE_AUTH_MODE=dev` (Clerk shim), viewer signed in as owner
  `dev_owner`. `.env.local` per the skill (removed at teardown).
- **Chromium**: preinstalled build at `/opt/pw-browsers/chromium-1194/...`, viewport
  1280×800, deviceScaleFactor 2.

## What was seeded (real HTTP API, integer cents, Phoenix HVAC "M&R Mechanical")
Custom seed over the real API (`scratchpad/demo-seed.mjs`), grounded in
`packages/api/src/shared/contracts.ts`:
- **5 customers** with clean names + Phoenix AZ addresses: Maria Alvarez (no-cooling,
  2 kids — urgency), Tom Khan, Raj Patel, Linda Johnson, Carlos Ramirez.
- **Today's schedule**: 3 appointments (8:00 Alvarez, 10:30 Khan, 13:30 Patel) with
  real summaries.
- **Estimate — Khan**: catalog-grounded AC diagnostic + capacitor, $353, Draft.
- **Estimate — Patel**: good/better/best **tiers** (14/16/20 SEER2), $24,230, Draft
  (line-item `groupKey`/`groupLabel`).
- **Invoice — Johnson**: issued → payment recorded → **Paid** (shows as $196
  collected on Home money summary).
- **Invoice — Ramirez**: issued + **Stripe payment link** generated (dev
  `MockPaymentLinkProvider` → `pay.mock.com` URL), Unpaid $449.45.
- **Approval-queue proposal**: one pending AI `draft_estimate` proposal ("Replace
  failed blower motor…") via `POST /api/estimates/suggest` → renders in the Inbox
  with a **"Review recommended" confidence flag** + Reject/Approve.

## Scenes captured (raw clips in `raw/*.webm`, all real UI, legible)
1. **Approvals + confidence** — `/inbox`: pending proposal card, "Review recommended"
   amber confidence marker, one-tap Approve button.
2. **Estimate tiers** — `/estimates/:id` (Patel): Good/Better/Best line items, $24,230.
3. **Estimate (clean)** — `/estimates/:id` (Khan): catalog-priced line items, $353.
4. **Invoice + payment link** — `/invoices/:id` (Ramirez): payment journey, live
   `pay.mock.com` link, "Resend payment link".
5. **Schedule** — `/schedule`: today's 3 appointments with Phoenix customers/times.
6. **AI Assistant** — `/assistant`: "Rivet AI · Online" context chips (3 active jobs,
   $1,850 pending, 2 items need attention) + suggestion chips.
7. **Customer timeline** — `/customers/:id` (Patel): records, jobs, contact info.
8. **Home** — `/`: owner command surface, stat cards, chat/voice bar, money summary.

## What could NOT be captured (skipped honestly, not faked)
- **End-of-day digest web view** (`/digest`): the surface exists but is empty ("No
  digest for this day") — digests are produced by a background worker with no HTTP
  generation endpoint on InMemory. Skipped. The "tells you what it wasn't sure about"
  trust beat is instead shown honestly via the visible **"Review recommended"**
  confidence flag in the approvals scene.
- **Booking proposal from an overnight call**: no authenticated create-booking HTTP
  path (LLM-gateway only), and the public-booking flow 404s without a configured
  booking page on a fresh tenant. The approval-queue scene therefore uses a real
  pending AI `draft_estimate` proposal — captioned generically ("nothing runs without
  you"), never claiming "booked 4 jobs overnight".
- **Approve click**: approving the bare `/suggest` draft errors ("no customer/job
  link") because it lacks entity linkage — so scene 1 shows the pending card + live
  Approve button **without** clicking (the button/capability is real; the caption
  describes the visible button, not a fabricated result).
- **Tenant business-name/timezone** (`PUT /api/settings`) 404s on a fresh InMemory
  tenant (no settings row). Cosmetic only — the in-app chrome is always "Rivet"; the
  shop name "M&R Mechanical" still appears in the estimate customer message. Tenant tz
  stayed America/New_York; visible times render fine.

## Honest-caption compliance
Every lower-third caption describes something **visibly on screen** or a **✅ claim**
from `claims.md`. Notably: the invoice screen shows an "ACH / Bank transfer" row
(product UI), but the caption says **"Card payments — no account needed"** — never
"ACH" (a banned claim). "Priced from your own price book", "Estimates with good,
better, best options", "It flags what it is not sure about", "Run the business by chat
or voice", "Every customer on one timeline" all trace to ✅ rows and are visible.
End card uses the locked tagline "You handle the work. We handle the business." +
"14-day free trial" (✅). No testimonials/stats/counts.

## Final specs
- **`demo-hero.mp4`** — 1280×720, H.264 (high) + AAC silence, 30 fps, **62.5 s**,
  **2,097,428 bytes (2.0 MB, ≤2.2 MB target)**, `+faststart`, two-pass @230 kbps.
  Structure: dark Gunmetal (#16212B) brand title cards → 8 real-UI scenes with
  Hot-Rivet-accented lower-third captions → end card. Real UI ≈ **78% of runtime**
  (13.5 s of cards vs 49 s of product), verified by extracting 12 frames across the
  timeline: captions legible/high-contrast, no cut-off text, 5–7 s/scene pacing.
- **`demo-poster.jpg`** — 1280×720, **48.5 KB**, clean real-UI frame (Patel tiered
  estimate, no caption).
- **`real-screens/{approvals,estimate,invoice}.jpg`** — high-res (1600 px wide) real
  UI stills to replace synthetic screenshots in the founder video/site.
- **`raw/*.webm`** — 8 source screen recordings.
- **`legacy-mockup/{demo-hero.mp4,demo-poster.jpg}`** — the prior SYNTHETIC outputs,
  relocated (not overwritten).

## Provenance / hygiene
- Product code READ-ONLY: `git status packages/` is clean — no tracked product files
  modified. Scratch driver scripts and `.env.local` were removed at teardown.
- Seed script (`scratchpad/demo-seed.mjs`) and Playwright drivers used only the real
  public HTTP API + the documented dev harness.
