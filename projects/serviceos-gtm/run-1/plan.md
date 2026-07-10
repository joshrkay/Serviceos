# ServiceOS GTM Run 1 — Orchestration Plan

**Mission:** Ship the Rivet/ServiceOS marketing funnel — SEO/AEO site + demo video + Stripe test-mode trial signup + nurture — to a live Vercel preview. Orchestrator: Fable. Workers: Sonnet/Opus subagents.

## Locked facts (ground truth — verified in repo)
- Positioning: "You handle the work. We handle the business." Wedge: Jobber gives better paperwork; Rivet does the paperwork.
- ICP: 1–3-truck owner-operator (Mike Rivera HVAC / Jenna Walsh plumbing / going-independent tech), no office staff. HVAC + plumbing V1.
- Trial: **14 days** (packages/api/src/billing/subscription.ts `createTrialCheckoutSession` — Stripe Checkout, card up front, billing starts day 15).
- Pricing tiers (committed marketing pricing, docs/marketing/landing-page.html, consistent with PRD §12 $300–500/mo): **Solo $299/mo, Shop $499/mo, Pro $799/mo**.
- Product onboarding entry: product web app signup (Clerk) → onboarding wizard (signup → identity → pack → phone → billing → ai_check → test_call). Funnel hands off via link to the product app URL (env-configurable; placeholder in preview).
- **Banned claims (downgraded 🔧 in PRD §5 / prd-v3-code-status.md — NEVER claim as shipped):**
  1. MMS-to-quote (photo ingest only; image→estimate not built)
  2. ACH payments (card + payment links live; ACH not configured/exercised)
  3. B2B account recognition (binary flag only; no PM routing/sub-accounts)
  Also not shipped: tip capture, tap-to-pay, financing, equipment registry, truck inventory, per-job profit voice query, native mobile (PWA only), offline voice capture.
- No fabricated testimonials, logos, ratings, metrics. No Review/AggregateRating schema (no real reviews exist).

## Environment constraints (answered myself; never ask)
- Vercel MCP authed (team cartboost / team_KEMR3LPq4GdaG3eg61Lj7ZwT) → deploy target = `deploy_to_vercel`, target: "preview".
- NO Stripe keys in env → build real Stripe Checkout integration (env-driven, test-mode only) + self-contained **demo checkout mode** when no key set, so preview is clickable e2e; prove integration code with stripe-mock (Docker) tests. Go-live checklist step: paste test/live keys.
- NO ESP/Twilio/ElevenLabs keys → nurture engine wired to Resend-compatible transport with file/preview transport in preview mode, test contacts only. Founder video: no avatar/ElevenLabs → cut from storyboard + screenshots + burned-in captions/text narration; note the cut.
- Demo videos already exist (docs/marketing/*.mp4, prior run) → verify content shows real product, compress for deploy payload.

## Tracks → status
1. Research (keyword/AEO map) — agent
2. Brand system — agent
3. Site (Next.js 14+, App Router, SSG, separate project in run-1/site) — agents
4. Video (verify existing demo; build founder video) — agent
5. Signup + Stripe trial (test mode + demo fallback) — agent
6. SEO tech+content — agents
7. AEO (llms.txt, entity def, Q&A, comparison tables) — agents
8. Nurture (7-stage email drip) — agent
9. Red team + fix — skeptic agents
10. Package + preview + recap.html + go-live checklist

## Deploy plan
- Site lives at projects/serviceos-gtm/run-1/site (Next.js, static-first).
- Build locally to verify; deploy source via mcp__Vercel__deploy_to_vercel (preview). Videos compressed ≤ ~1.2MB each, shipped as base64 public/ assets. Incremental deploys same project name: `rivet-serviceos-marketing`.
- Production go-live = user's action only (checklist).
