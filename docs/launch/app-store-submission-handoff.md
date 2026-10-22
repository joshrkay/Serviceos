# App Store Submission Handoff (shipgate, 2026-07-24)

The shipgate audit verdict and the exact human steps between merging PR #738
and pressing "Submit for Review". Code-side blockers are closed; everything
below needs Josh (credentials, artwork, or a production action an agent
must not take autonomously).

## Verdict

**Conditional GO.** Both gates pass on the code side:

- **G1 (App Review conformance):** all 8 Class A vectors closed in code/docs
  (PR #738) or reduced to the provisioning steps below. Clean passes:
  permission strings (mic/camera/BT/location specific and truthful), no
  placeholder copy, no background audio, truthful encryption declaration,
  no social login (no Sign in with Apple obligation), guarded cold start.
- **G2 (tenant isolation):** 118/118 tenant tables ENABLE+FORCE RLS with
  correct policies; the only 2 exemptions are documented and test-pinned;
  confirmed against a real materialized Postgres catalog
  (`rls-tenant-isolation` + `rls-runtime-audit`, RLS_RUNTIME_ROLE=true).

## Human checklist (in order)

1. **Merge PR #738** (all CI green, incl. the new integration test).
2. **Artwork (A-5).** ~~Replace the four blank placeholder PNGs~~ Done
   2026-10-21: `packages/mobile/assets/*.png` are the marketing-site "R."
   mark rendered by `packages/mobile/scripts/generate-brand-assets.py`.
   Designer artwork, if any, is a drop-in replacement.
3. **EAS + Apple credentials (A-6).** In `packages/mobile`:
   `eas init` (fills `extra.eas.projectId`), then fill
   `eas.json → submit.production` (`appleId`, `ascAppId`, `appleTeamId`;
   Play `serviceAccountKeyPath` when Android goes). Set production
   `EXPO_PUBLIC_API_URL` + `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` on EAS
   (see `eas.env.example`). Credentials never in git.
4. **Demo accounts (A-7).** Provision `reviewer-supervisor@…` +
   `reviewer-technician@…` on ONE seeded demo tenant in production
   (`packages/api/scripts/seed.ts` against prod `DATABASE_URL`, or manual).
   Passwords go only in App Store Connect / Play confidential fields.
   Also confirm in the Clerk dashboard: session lifetime + bot protection
   won't lock a reviewer out mid-review. The demo emails are
   `info+reviewer-supervisor@` / `info+reviewer-technician@therivetapp.com`
   (plus-addressed into the real `info@therivetapp.com` inbox, decided
   2026-10-21): the OTP step (A-1 fix) emails a real code there. Verify by
   signing in from a device Clerk has never seen.
5. **Privacy URL (A-4 residual).** Verified 2026-10-21: `/privacy` and
   `/terms` return 200; `/download` returned 404, so the listing's support
   URL is now `https://therivetapp.com/contact` (a `/support` page in the
   Rivet-Marketing repo can replace it later). Support email is
   `info@therivetapp.com`.
6. **App Privacy questionnaire.** Answers derived from code are in
   `packages/mobile/store/app-store-listing.md` (contact info, user content
   incl. voice audio + photos, foreground-only precise location, payment
   via Stripe Terminal SDK only, identifiers; NO analytics SDK in the
   mobile binary).
7. **Screenshots** for the listing (real ones — placeholders rejected).
8. **Build + submit**: `eas build --profile production --platform ios`,
   then `eas submit`. Paste `packages/mobile/store/app-review-notes.md`
   into App Review Information (it now covers click-to-call and account
   deletion). The store identifier is `com.therivetapp.app` on both
   platforms and v1 ships without Tap to Pay (D-046).

## What shipped in PR #738 (for reference)

A-1 real OTP entry on sign-in (bypass gated to `+clerk_test`); A-2 unused
NSLocationAlways* strings dropped from the plist; A-3 in-app account
deletion (Settings flow + `DELETE /api/users/me`, 16D soft-delete, atomic
last-owner guard, audit event, reads exclude deleted); A-4 store docs on
the canonical domain; A-8 review-notes coverage for click-to-call +
deletion.

## Deferred (post-submission)

See `docs/RIVET_DEFERRED_QUEUE.md` — 10 Class C items with evidence,
including the two consciously downgraded from A (JSON-404 middleware,
Stripe timeouts) and three real production-robustness items on the voice
path (call-duration cap, transcript persistence, LLM failover config).
