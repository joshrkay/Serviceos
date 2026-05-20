# Phase 7 (Integrations + Beta Hardening) — Multi-Agent Dispatch Addendum

This addendum extends `docs/stories/phase-7-gap-stories.md` with the metadata needed to dispatch each story to a Claude agent running in an isolated worktree.

For every story, the agent prompt should include:
- The full body of the story from `phase-7-gap-stories.md`
- This addendum's per-story block
- `repository-conventions.md` and `freeze-list.md` from `docs/superpowers/contracts/`

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 7-Wave-C1 | P7-026 (split into PR a/b/c — sequential, single agent each) | sequential within story | none — independent of other Wave C1 stories |

P7-026 (Google Business review monitoring) is the heaviest Wave-C1 story. It splits into three sequential PRs because the new `packages/api/src/reputation/` module is the shared allowed-files surface — three agents cannot work it simultaneously. See `docs/superpowers/plans/2026-05-17-wave-c-bad-day-recovery.md` for the wave-level context.

---

## P7-026 — Google Business review monitoring + draft response

**Wave:** 7-Wave-C1 (depends on Wave-C blocker B1 = P4-015)
**Migration numbers reserved:**
- `105_google_reviews` — reviews model (PR a)
- `106_review_poll_state` — poll cursor + backoff state (PR a)
- `107_service_credits` — issuance tracking with 12-month $100 cap query (PR c)

**Forbidden files:**
- `packages/api/src/logging/redact.ts` (this is the key-pattern infra-redactor; review-response needs a separate content-level redactor under `packages/api/src/reputation/pii-redact.ts` — do not couple)
- `packages/api/src/notifications/**` (existing SMS/email senders are reused; not modified)
- `packages/api/src/proposals/contracts.ts` (the `review_response_proposal` payload schema lives in `packages/shared/src/contracts/review-response-proposal.ts` and is consumed via barrel; do not redefine in `contracts.ts`)
- `packages/api/src/proposals/actions.ts` (P2-035 owns the only edit; this story extends `proposals/execution/` only)
- `packages/api/src/proposals/auto-approve.ts` (review responses are always owner-approved)
- `packages/api/src/customers/dedup.ts` (existing dedup helper is reused, not modified)
- `packages/api/src/invoices/deposit-credit.ts` (separate concept — invoice-deposit credit is not the same as service credit)

**Allowed files (concrete list, per PR):**

PR a (poll + model):
- `packages/api/src/reputation/review.ts` (new — model)
- `packages/api/src/reputation/pg-review.ts` (new — repo)
- `packages/api/src/reputation/google-business-client.ts` (new — OAuth + API wrapper)
- `packages/api/src/reputation/poll-state.ts` (new — backoff state repo)
- `packages/api/src/workers/google-reviews.ts` (new — 15-min interval worker)
- `packages/api/src/db/schema.ts` (modify — add keys `105_google_reviews`, `106_review_poll_state`)
- corresponding `.test.ts` files

PR b (classifier + match + redact):
- `packages/api/src/reputation/classifier.ts` (new — deterministic regex + LLM fallback)
- `packages/api/src/reputation/match-customer.ts` (new — conservative: name>0.8 AND visit≤60d)
- `packages/api/src/reputation/pii-redact.ts` (new — content-level: last names, addresses, phones, emails)
- corresponding `.test.ts` files

PR c (proposal + credit + execution):
- `packages/shared/src/contracts/review-response-proposal.ts` (new — Zod 3-component payload)
- `packages/api/src/reputation/credit-tier.ts` (new — tier + 12-month cap query)
- `packages/api/src/reputation/draft-public-response.ts` (new — composer with `intent='review_public_response'`)
- `packages/api/src/reputation/draft-private-followup.ts` (new — composer with `intent='review_private_followup'`)
- `packages/api/src/reputation/build-proposal.ts` (new — assembles the 3-component payload)
- `packages/api/src/proposals/proposal.ts` (modify — additive: add `'review_response_proposal'` to `ProposalType`; bucket as `'comms'` in `actionClassForProposalType`)
- `packages/api/src/proposals/execution/review-response-handler.ts` (new — executes only approved components)
- `packages/api/src/db/schema.ts` (modify — add key `107_service_credits`)
- corresponding `.test.ts` files

**Verification gate (single command, per PR):**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run -t "P7-026"
```

**Pre-flight (for the first PR):**
- P4-015 (brand voice) has merged on main (PR c needs it; PR a/b don't, but coordinating sub-PR pre-flights is harder than just gating the whole story)
- Migration keys 101–104 (B4, B5, B6, P6-028's 103/104) have either landed or this story uses the next free key — re-check `packages/api/src/db/schema.ts` before each PR

**Risk note:**
- **Conservative customer matching.** False positives are worse than false negatives — guessing the wrong customer and sending them a private apology + service credit is brand-damaging. Default to "no match" on any ambiguity; the proposal still ships, just without the private-component pre-fill.
- **Public response cannot include PII even if the LLM is tempted.** The redactor runs on the final draft — not just the input — so any leaked PII from the input gets stripped before the proposal hits the owner's inbox.
- **$100 cap is enforced at draft time, not approval time.** Approval time is too late — if the owner taps approve and the cap is exceeded, the right behavior is "the credit was capped at $X" which is a confusing post-approval surprise. Enforce during draft via the 12-month sum query.
- **Backoff on 429.** Google Business Profile has aggressive quotas. The worker reads `review_poll_state.backoff_until` and skips the tenant entirely if `NOW() < backoff_until`. On 429, write `backoff_until = NOW() + min(2^n * 30s, 60min)` and increment `consecutive_429_count`. Reset on first success.
- **Component-independent approval.** The owner can approve public-only, private-only, credit-only, or any combination. The execution handler reads the payload's `approved` flags and runs only those sub-actions. Do NOT short-circuit "all approved" — the owner may want to send the public response while still drafting the private follow-up.

**Implementation hints:**
1. **PR a first.** Get the worker running on staging with a real Google Business Profile sandbox token before writing the classifier. The poll cadence + backoff is the most operationally-risky piece.
2. **PR b's classifier** is deterministic-first: regex for "thanks/great/amazing" → praise; regex for specific complaint patterns (no-show, wrong tech, etc.) → specific_complaint; everything else → LLM fallback. The LLM should classify with a confidence — anything <0.8 lands in `vague_complaint`.
3. **PR b's matcher** joins `customers` to `appointments` (or `jobs`) on `customer_id` with `WHERE appointment.scheduled_start > NOW() - INTERVAL '60 days'` and scores name match via the existing `customers/dedup.ts` helper. Returns `null` if score <0.8.
4. **PR c's credit-tier** is a pure function: `(classification, rating) => 0 | 25 | 50 | 100` (praise → 0; 1-star specific → 100; 1-star vague → 50; 2-star → 25). Then the cap query: `SELECT COALESCE(SUM(amount_cents), 0) FROM service_credits WHERE customer_id = $1 AND issued_at > NOW() - INTERVAL '12 months'` — if `sum + tier > 10000`, downgrade the tier or omit the credit component entirely.
5. **PR c's execution handler** dispatches three sub-handlers based on payload flags: `executePublicResponse`, `executePrivateFollowup`, `executeServiceCredit`. Each is idempotent (re-applying an already-executed sub-action is a no-op).

---

## Universal pre-flight checks

Same as `p0-dispatch-addendum.md` § Universal pre-flight checks. Apply to every Phase 7 story before launching the dispatch agent.
