# Decision Log — GTM Run 1

Format: Q → A → why. (Guardrail 6: never ask; answer with research + reasoning.)

**D1. Which pricing/trial to publish?** → Solo $299 / Shop $499 / Pro $799, 14-day trial with card. Why: 14 days is hard-coded in the product's Stripe checkout; tiers come from the committed landing draft and sit in PRD §12's $300–500 band (Pro is the growth tier above ICP core).

**D2. No Stripe keys in environment — how to satisfy "prove e2e in test mode"?** → Implement the real Stripe Checkout subscription flow (trial_period_days=14, card capture, webhook state machine for trialing/active/past_due/canceled) driven by env keys; add an explicit DEMO mode (no key present) that renders a clearly-labeled simulated checkout exercising the same internal state machine; prove the Stripe code paths against stripe-mock in automated tests. Why: a live Stripe account credential cannot be created autonomously; this ships 100% of the code and the full click-through, with key-paste as the only go-live step. Logged as a cut: no real Stripe-hosted checkout screen in preview.

**D3. No ESP/Twilio keys — nurture wiring?** → Email-only sequence engine (Resend-compatible HTTP transport) with a preview transport that renders sends to an inspectable mailbox page; recipients restricted to a hardcoded test-contact allowlist regardless of transport. Why: satisfies "built and wired, test contacts only" without a credential; SMS branch documented but not wired (no Twilio key).

**D4. Founder video without avatar assets or ElevenLabs key?** → Produce founder video from the existing storyboard: title cards + product screenshots + burned-in caption narration in brand voice, rendered with ffmpeg. Why: no voice/avatar credential; an honest, watchable founder message beats a fake voice. Noted in recap as cut scope.

**D5. Which demo video to embed?** → Verify all three existing mp4s frame-by-frame; embed the voiced 90s cut if it shows the real product UI, else best alternative. Re-encode ≤1.2MB 720p for deploy payload limits.

**D6. Site stack?** → Next.js (App Router, static generation, no DB) in projects/serviceos-gtm/run-1/site; deployed with Vercel MCP as project `rivet-serviceos-marketing`, target preview. Why: guardrail-recommended, SSG = crawlable + fast CWV, and the only authed deploy path is the Vercel MCP.

**D7. Product hand-off URL?** → Configurable NEXT_PUBLIC_APP_URL; preview points at a /go-live-pending interstitial explaining the hand-off (the product app URL is a go-live checklist item). Why: production app domain not discoverable in repo (env examples use yourdomain.com placeholders); pointing preview at a live tenant app is guardrail-adjacent risk.

**D8. Schema Review/AggregateRating?** → Omitted. No real reviews exist; inventing them violates Guardrail 4 and Google spam policy.

**D9. Demo videos in docs/marketing are synthetic slide animations, not real product recordings (verified frame-by-frame vs packages/web source).** → Re-shoot: boot the real packages/web SPA headlessly with seeded data (packages/web verify harness), drive the actual flows with Playwright video recording, cut a new 60–90s demo with caption narration; regenerate founder video screenshots from real captures. Why: DoD requires the demo to show the REAL product; embedding the mockup would be a placeholder pretending to be finished. The old mockup is kept in video/legacy-mockup/ for reference only.

**D10. WebFetch returned 403 all session (tool-level).** → Research sourced via WebSearch result citations; every load-bearing competitor number phrased "as published, July 2026" with URL; red team re-attempts direct fetch verification before ship. If still unverifiable, the number is cut or hedged per claims.md.

**D11. Deploying a site with ~2.5MB of video through the files-inline Vercel MCP tool would blow the orchestrator context.** → Bootstrap deploy: upload only package.json + fetch-source.mjs; prebuild downloads the pinned commit tarball from the PUBLIC GitHub repo (codeload.github.com, no auth — visibility verified) and extracts the site source+media before `next build` runs on Vercel. Deploy always equals a pushed, reviewable commit SHA. Vercel CLI has no auth here (verified); MCP is the only deploy path.

**D12. Real product UI displays an "ACH / Bank transfer" option although ACH is not configured/exercised (claims.md ban).** → Marketing assets never show or claim ACH (founder video screenshot cropped above the ACH row; captions say card + payment links). Flagged in recap as a PRODUCT follow-up: hide the ACH option in-app until configured. Product code untouched per Guardrail 3.
