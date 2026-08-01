# feat: Review 4★ Gating — Low-Rating Digest Line (E5)

**Created:** 2026-06-14
**Depth:** Standard (3 units)
**Status:** plan
**Parent:** `docs/plans/2026-06-14-001-feat-prd-gap-closure-roadmap-plan.md` → Wave 1 epic **E5**.

## Summary
Complete the proactive review-request gate from PRD §6.11. The ≥4★ → Google/Yelp path and the <4★ → internal-only path already work in code; the one missing piece per **§6.11 step 5 ("Outcome logged + digest line")** is surfacing the day's feedback — especially low ratings — to the owner in the end-of-day digest. This adds a feedback aggregate query, a "Feedback" line in the digest SMS, and a test that pins the existing rate-then-route web gate.

## Problem Frame
PRD §6.11 specifies a review-request flow that gates by rating (≥4 → public review link, <4 → internal only) and reports the **outcome in a digest line**. Verification (2026-06-14) found the gate itself already shipped — `packages/api/src/routes/public-feedback.ts:128` returns review links only at `rating>=4`, and `packages/web/src/components/customer/FeedbackPage.tsx` shows public-review buttons only when those links are present. What's missing: the owner never *learns* a low rating came in. Low ratings sit in `feedback_responses` (stored + audited) but nothing surfaces them. The owner runs the business from the digest (locked Decision #2), so the digest is where a low rating must appear (Decision #15: no new admin work — no dashboard hunt required).

## Requirements
- **R1.** The end-of-day digest reports the day's feedback outcome: response count, average rating, and an explicit low-rating count (≤3★). *(PRD §6.11 step 5; Decision #2.)*
- **R2.** The aggregate is tenant-scoped and bounded to the tenant-local digest day (UTC-stored, tenant-tz windowed).
- **R3.** The existing rate-then-route web gate is pinned by tests: ≥4★ renders public-review buttons, <4★ does not — with ≥44px tap targets.
- **R4.** No new owner interruption: low ratings ride the existing digest SMS, not a new per-event message (PRD §6.11 reserves immediate SMS for the *Google-monitoring* path, not review requests).

## Key Technical Decisions
- **Digest line, not immediate SMS.** PRD §6.11 **step 5 literally says "digest line"**; the immediate-owner-SMS machinery (`emergency-dispatch-handler`, per-event dispatch) belongs to the separate Google-review-monitoring flow (§6.11 second list). *(Alternative — fire an owner SMS on each <4★ via the emergency-SMS pattern: rejected; it contradicts the §6.11 spec and Decisions #2/#15, and adds interrupt-y messages. Recorded as a deferred enhancement if faster service-recovery is later wanted.)*
- **Aggregate query, not row transfer.** Add `countByRatingInRange(tenantId, utcStart, utcEnd)` returning per-star counts; average / total / low-count derive from it. *(Alternative — fetch the day's response rows and reduce in the builder: rejected; an aggregate is bounded and pins a real `GROUP BY` query with an integration test.)*
- **Integrate on the live digest path only.** Wire into `packages/api/src/digest/digest-service.ts` (`DailyDigestPayload` + `computeDigestPayload`) and `packages/api/src/workers/daily-digest-worker.ts` (`renderDigestSms`). `digest-builder.ts` / `digest-renderer.ts` appear superseded — **do not modify**; confirm dead during execution and leave a hygiene note (out of scope to delete here).
- **No change to the submit path.** `public-feedback.ts` already stores + audits the response and withholds public links at <4★. The digest reads from stored rows, so the route is untouched. *(Keeps the gate's "internal recording" as-is.)*

## Scope Boundaries
**In scope:** feedback aggregate query (interface + in-memory + pg), digest payload field + SMS line + worker dep wiring, and tests (incl. a Docker-gated integration test for the query and a web gate test).

**Non-goals:**
- Immediate per-rating owner SMS / a `low_rating_alerts` table / an internal-feedback queue (the scout sketched these for the immediate path — explicitly not built; deferred).
- Any change to the ≥4★ Google/Yelp link surfacing (already correct) or the Google-review-monitoring flow.
- Reworking the feedback web UI (already implements the gate); U3 is test-only.

### Deferred to follow-up work
- Possible dead code: `packages/api/src/digest/digest-builder.ts` + `digest-renderer.ts` (superseded by digest-service/worker) — verify and remove in a hygiene pass.
- Optional immediate-SMS for very low (1★) ratings for faster service recovery.

## Repository invariants touched
- **`tenant_id` + RLS:** the new query runs inside the repo's tenant context (`withTenant`), mirroring `pg-feedback-response.ts`.
- **Times UTC, rendered/queried in tenant tz:** `feedback_responses.submitted_at` is UTC; the worker derives the tenant-local digest day and passes UTC bounds to the query (reuse the worker's existing tenant-local time logic).
- **Audit events:** no new mutation — the digest line is a read; feedback submission is already audited (`feedback_response.submitted`) and the digest send is already dispatch-audited.
- **No auto-exec / AI gateway / cents / catalog / entity resolver:** not applicable (no proposals, no money, no AI).

## Implementation Units

### U1. Feedback aggregate query (count by rating, in a date range)
- **Goal:** Provide a tenant-scoped, bounded aggregate of feedback ratings for a UTC window.
- **Requirements:** R1, R2.
- **Dependencies:** none.
- **Files:**
  - `packages/api/src/feedback/feedback-response.ts` — add `countByRatingInRange(tenantId, utcStart, utcEnd): Promise<RatingCounts>` to `FeedbackResponseRepository`; add a `RatingCounts` type (`{1..5: number}`); implement in `InMemoryFeedbackResponseRepository`.
  - `packages/api/src/feedback/pg-feedback-response.ts` — implement with a `GROUP BY rating` query over `feedback_responses` filtered by `tenant_id` + `submitted_at >= $start AND submitted_at < $end`, inside `withTenant`.
  - `packages/api/test/feedback/feedback-response-count-by-rating.test.ts` (new — in-memory unit).
  - `packages/api/test/integration/feedback-response-count-by-rating.integration.test.ts` (new — Docker-gated; pins real columns `rating`, `submitted_at`, `tenant_id`).
- **Approach:** Return all five star buckets (missing → 0) so callers derive total/avg/low-count without re-querying. Half-open window `[start, end)`. Index `(tenant_id, submitted_at DESC)` (migration 043) supports the range scan.
- **Patterns to follow:** `pg-feedback-response.ts` `listByTenant` (`withTenant`, `mapRow`, parameterized SQL); in-memory filter/sort in `feedback-response.ts`.
- **Test scenarios:**
  - Happy: responses across ratings 1–5 within window → correct per-bucket counts; ratings outside `[start,end)` excluded.
  - Edge: no responses → all-zero counts; boundary timestamps (== start included, == end excluded).
  - Tenant isolation: another tenant's responses never counted.
  - Integration (Docker-gated, **required** — CLAUDE.md): insert real rows, assert the `GROUP BY` returns correct buckets against the real schema (mocked-DB is insufficient proof).
- **Verification:** unit + integration green; `tsc --project tsconfig.build.json` clean.

### U2. Digest feedback line (payload + render + wiring)
- **Goal:** Surface today's feedback — count, average, and low-rating count — as a line in the end-of-day digest SMS.
- **Requirements:** R1, R4.
- **Dependencies:** U1.
- **Files:**
  - `packages/api/src/digest/digest-service.ts` — add `feedback?: { responses: number; averageRating: number | null; lowRatingCount: number }` to `DailyDigestPayload`; in `computeDigestPayload`, call the feedback query for the digest day and assemble the field; add the feedback repo to `DigestComputeDeps`.
  - `packages/api/src/workers/daily-digest-worker.ts` — render a "Feedback" line in `renderDigestSms` when `feedback.responses > 0` (e.g. `Feedback: 4 today, avg 4.3★ — 1 low rating (≤3★), review in app`); compute the tenant-local day window and pass UTC bounds to the query.
  - `packages/api/src/app.ts` — pass the existing `feedbackResponseRepo` into the digest worker's `computeDeps`.
  - `packages/api/test/digest/digest-feedback-line.test.ts` (new — compute + render unit with a mocked feedback repo).
- **Approach:** average = weighted mean over buckets, rounded to 1 decimal, `null` when 0 responses; low-rating count = buckets 1+2+3. Omit the line entirely when there were no responses (no noise on quiet days). Keep the line within the digest's 320-char section budget.
- **Patterns to follow:** existing `DailyDigestPayload` fields + section assembly in `computeDigestPayload`; the section-rendering style in `renderDigestSms` (label: lines); dep-injection of repos via `computeDeps` in `app.ts`.
- **Test scenarios:**
  - Happy: buckets {5:3, 4:1, 2:1} → `responses 5, avg 4.0, lowRatingCount 1`; render contains the feedback line with the low-rating flag.
  - Edge: zero responses → field reflects 0 / `averageRating null` and the line is **omitted** from the SMS; all-low day → low count == responses.
  - Rounding: avg rounds to one decimal deterministically.
  - Integration: not required at this layer (mocked feedback repo is fine — U1's integration test pins the real query).
- **Verification:** unit green; digest worker still composes/sends (existing digest tests stay green); `tsc` clean.

### U3. Pin the rate-then-route web gate (test-only)
- **Goal:** Lock the existing gate behavior so a regression can't silently start showing public-review buttons to unhappy customers.
- **Requirements:** R3.
- **Dependencies:** none.
- **Files:**
  - `packages/web/src/components/customer/FeedbackPage.test.tsx` — extend.
- **Approach:** Drive the component through submit with a mocked `fetch`: (a) POST returns `{ ok: true, reviewUrls: { google } }` → the "Leave a Google review" link renders; (b) POST returns `{ ok: true }` (no `reviewUrls`, the <4★ case) → no public-review link, only the internal "Thank you" copy. Add a class-contract assertion that the star/submit controls keep ≥44px tap-target classes (the gate is public mobile UI). No component code change expected.
- **Patterns to follow:** existing `FeedbackPage.test.tsx` (vitest + Testing Library + `MemoryRouter`, `vi.stubGlobal('fetch', …)`).
- **Test scenarios:**
  - ≥4★: reviewUrls present → Google/Yelp link(s) shown.
  - <4★: no reviewUrls → no public link; internal thank-you shown.
  - Tap-target contract: star buttons (size-40 + padding) and submit button retain their min-size classes.
  - `Test expectation:` jsdom class-contract + behavior test. A new Playwright viewport spec is **not** added — there is no layout change; the existing e2e pattern covers viewport.
- **Verification:** web test suite green.

## Risks & Dependencies
- **Two digest code paths.** `digest-builder.ts`/`digest-renderer.ts` (direct-SQL, older) vs `digest-service.ts`/`daily-digest-worker.ts` (repo-based, live). Mitigate: integrate only on the live path; confirm the builder/renderer are unreferenced by the worker before assuming dead; do not edit them here.
- **Tenant-tz day window / DST.** The low-rating window must match the digest's own day boundary. Mitigate: reuse the worker's existing tenant-local digest-day computation; don't invent a parallel one.
- **U1 before U2.** The digest line depends on the query.

## Open Questions (deferred to implementation)
- Exact digest line copy/wording and whether to include the average when there are 0–1 responses (lean: show count + low flag always; show avg only when responses ≥ 1).
- Exact name of the worker's existing tenant-local day-window helper (resolve when editing `daily-digest-worker.ts`).

## Sources & Research
- Code verified 2026-06-14: `packages/api/src/routes/public-feedback.ts` (gate at :128), `packages/api/src/feedback/{feedback-response.ts,pg-feedback-response.ts}`, `packages/api/src/digest/digest-service.ts` (`DailyDigestPayload`, `computeDigestPayload`), `packages/api/src/workers/daily-digest-worker.ts` (`renderDigestSms`, sweep, `app.ts:3772`), `packages/web/src/components/customer/FeedbackPage.tsx` + `.test.tsx`. Schema: `feedback_responses` migration 043 (`rating` 1–5 CHECK, index `(tenant_id, submitted_at DESC)`).
- PRD `docs/PRD-v3.md` §6.11 lines 560–565 (step 4 internal-only, **step 5 "Outcome logged + digest line"**); Decisions #2 (digest is the dashboard), #15 (no added admin work).
- No `docs/solutions/` entries for this area.
