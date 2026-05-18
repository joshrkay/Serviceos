# Wave C — Bad Day Recovery

**Goal:** Give the tenant a system response when something goes wrong with a customer interaction — specifically, when a customer leaves a public negative review, the system surfaces it, drafts an owner-approved response, and (where warranted) proposes a service credit. After Wave C merges, a tenant's owner should be able to: (1) see new Google Business reviews within 15 minutes of posting, (2) review a 3-component draft proposal (public reply / private follow-up / optional service credit), (3) approve any subset of components, and (4) trust that no PII leaks publicly and no credit exceeds the $100 / 12-month cap.

The wave's framing is **bad-day-recovery**: the negative review is the worst thing that arrives in the owner's day, and the system's job is to make the response take 30 seconds instead of an hour — without giving up the owner's judgment.

**Pre-Wave-C requirements** (must merge before any Wave-C dispatch):
- **B1 — P4-015** (brand voice profile). The review-response composer needs a tenant brand-voice profile to draft public replies that sound like the owner, not like a generic LLM. Without P4-015, PR c of P7-026 has no voice to inject and would either ship robotic copy or block on a stand-in. PR a and PR b of P7-026 do not depend on B1 — they could in principle run earlier — but coordinating sub-PR pre-flights is messier than just gating the whole story on B1.

If B1 is not merged, **do not dispatch P7-026 PR c.** Holding PR a / PR b is also recommended unless the dispatcher has cycles to track the partial state.

## Wave C story set

| Wave | Story | Layer | Story body | Dispatch addendum |
|---|---|---|---|---|
| 7-Wave-C1 | **P7-026** (a/b/c) | Reputation / API | `phase-7-gap-stories.md` | `p7-dispatch-addendum.md` |

Other Wave-C sub-waves (C2, C3) are not yet specified. The wave label `7-Wave-C1` is intentional: it leaves room for follow-ups (e.g. inbound complaint SMS, refund-proposal flow, customer-followup loops) without re-numbering this dispatch.

## Dispatch order

```
              ┌──────────────────────────────┐
              │ Pre-Wave-C blocker:          │
              │ B1 = P4-015 (brand voice)    │
              └────────────┬─────────────────┘
                           │
                           ▼
              ┌──────────────────────────────┐
              │  P7-026 PR a (poll + model)  │  ← single agent
              │  ~migrations 105, 106        │
              └────────────┬─────────────────┘
                           │ (merge)
                           ▼
              ┌──────────────────────────────────┐
              │  P7-026 PR b (classify + match)  │  ← single agent
              │  no migrations                   │
              └────────────┬─────────────────────┘
                           │ (merge)
                           ▼
              ┌──────────────────────────────────────┐
              │  P7-026 PR c (proposal + execution)  │  ← single agent
              │  ~migration 107                      │
              └──────────────────────────────────────┘
```

**Why sequential, not parallel:** the new `packages/api/src/reputation/` module is the shared allowed-files surface for all three PRs. Two agents working it simultaneously will produce overlapping diffs that don't merge cleanly. A single agent per PR, in sequence, is the conservative path.

**Single-agent assignment:** dispatching all three PRs to the same agent (resumed via SendMessage between PRs) is preferred over three independent agents, because the agent carries the module context (model shapes, repo helper names, test fixtures) forward and avoids re-learning each PR.

## What the wave delivers

### P7-026 — Google Business review monitoring + draft response

**Why:** today, a 1-star review arrives at the owner's phone via Google's notification, with no system response. The owner either drops what they're doing and crafts a reply (which is often emotionally-loaded and brand-damaging), or they let it sit unread for days. Both are bad outcomes. The system can do the first 80% — fetch the review, classify it, draft a calibrated response, propose a credit if appropriate — and let the owner spend 30 seconds reviewing instead of 30 minutes drafting.

**Outcome (after all 3 PRs land):**
- 15-minute polling per tenant against Google Business Profile, with exponential backoff on 429.
- Reviews are classified `praise | specific_complaint | vague_complaint` (regex first, LLM fallback at confidence ≥ 0.8).
- Reviewers are conservatively matched to customers (name score ≥ 0.8 AND visit within 60 days); ambiguous matches return `null` rather than guessing.
- A 3-component proposal arrives in the owner's inbox: public reply (PII-redacted), private follow-up (only if matched), optional service credit (tiered by classification + rating, capped at $100 per customer per 12 months at draft time).
- Owner approves any subset; execution handler runs only the approved components and is idempotent.

**Risks** (full list in `docs/superpowers/contracts/p7-dispatch-addendum.md` § Risk note):
- **Conservative matching.** False positives are worse than false negatives — apologizing to the wrong person and crediting them is brand-damaging in a different way.
- **PII redaction runs on the final draft, not just the input.** LLMs can re-introduce PII even if the input was clean.
- **Credit cap enforced at draft time, not approval time.** Post-approval "your credit was capped" is a confusing surprise.
- **429 backoff is per-tenant.** A noisy tenant must not poison other tenants' poll cadence.

## Risks across the wave

1. **P4-015 dependency is real.** PR c's public-response composer is a thin wrapper around the brand-voice profile. If B1 is dispatched in a separate wave that doesn't land, PR c blocks. Track B1 explicitly before dispatching PR c.

2. **Migration numbers 105 / 106 / 107.** Confirm these are still the next-available keys in `packages/api/src/db/schema.ts` before each PR's pre-flight. The addendum reserves them, but if migration keys 101–104 (B4 / B5 / B6 / P6-028's 103/104) have shifted, re-check. Don't dispatch PR a without re-confirming.

3. **`proposals/proposal.ts` is a Tier-2 surface.** PR c adds `'review_response_proposal'` to `ProposalType` and a bucket entry to `actionClassForProposalType`. Both are additive changes (allowed under Tier-2 rules in `freeze-list.md`). The reviewer should confirm no rename or removal sneaks in.

4. **No coupling to the infra redactor.** `packages/api/src/logging/redact.ts` is the key-pattern infra-redactor; the review-response PII redactor (`packages/api/src/reputation/pii-redact.ts`) is a separate content-level redactor. Coupling them would create a confusing two-purpose utility — the addendum forbids the file explicitly.

5. **Google Business Profile sandbox token.** PR a's worker should be tested against a real sandbox token on staging before merging. Mocking the API end-to-end is acceptable for unit tests, but the 429-backoff path needs at least one real-API smoke before relying on it.

6. **Owner-approved only.** The auto-approve path is explicitly forbidden for `review_response_proposal`. Reviewer must verify no code path routes review responses through `proposals/auto-approve.ts`.

## Verification surface (post-Wave-C1)

| Path | Manual check | Owner |
|---|---|---|
| Post a 5-star review on the sandbox profile → within 15 min, a `praise`-classified proposal arrives in the owner inbox with a public-reply-only component (no credit, no private follow-up unless matched) | sandbox + manual check | post-merge QA |
| Post a 1-star review with a specific complaint ("the tech never showed up") from a known customer (recent appointment) → proposal arrives with all 3 components: public reply (PII-redacted), private follow-up, $100 credit (or less if cap is approached) | sandbox + manual check | post-merge QA |
| Post a 1-star review from a name that does NOT match any customer → proposal arrives with public-reply only; matcher returned `null`; no private follow-up, no credit | sandbox + manual check | post-merge QA |
| Trigger a Google Business 429 → worker writes `backoff_until = NOW() + 30s` (or more on consecutive 429s); skips the tenant on next tick; resets on first 200 | log inspection on staging | post-merge QA |
| Approve only the public-reply component of a proposal → public reply ships; private follow-up and credit do not | manual via owner inbox | post-merge QA |
| Re-run the execution handler against an already-executed sub-action → no-op, no duplicate side effect | unit test + manual | post-merge QA |

## Out of scope for Wave C1 (deferred)

- **Inbound complaint SMS / call.** Customers who complain via SMS or voice (rather than a public review) are not covered by this wave. A future Wave-C2 may add an inbound-complaint classifier that emits a similar 3-component proposal.
- **Refund proposals.** Service credit is not a refund. A refund flow needs Stripe refund API wiring, refund-eligibility rules, and a separate proposal type. Out of scope.
- **Yelp / Facebook / Nextdoor.** Only Google Business Profile is in scope for P7-026. Other platforms have different APIs, different quota models, and different PII norms. A future story can extend the `reputation/` module.
- **Sentiment trend dashboards.** Aggregating reviews into a tenant-level sentiment trend is a separate analytics surface; this wave only handles single-review response.
- **Auto-approve any review response.** Always owner-approved. If auto-approve becomes desirable later (e.g. for praise-only responses), it would be a separate story with its own risk review.

## Coordinator runbook

When you're ready to dispatch Wave C:

1. **Verify B1 (P4-015) has merged on main:**
   ```bash
   git log origin/main --oneline | grep -E "P4-015" | head -3
   ```
   Should report a merged commit. If not, hold and surface to the user.

2. **Verify migration keys 105 / 106 / 107 are still free** in `packages/api/src/db/schema.ts`. If they've been taken, re-coordinate with the addendum before launching PR a.

3. **Dispatch P7-026 PR a** (single agent):
   ```
   /dispatch-story P7-026  (PR a — poll + model)
   ```
   Wait for merge before continuing.

4. **Dispatch P7-026 PR b** (same agent if available, resumed via SendMessage):
   ```
   /dispatch-story P7-026  (PR b — classifier + match + redact)
   ```
   Wait for merge before continuing.

5. **Dispatch P7-026 PR c** (same agent if available):
   ```
   /dispatch-story P7-026  (PR c — proposal + credit + execution)
   ```

6. **Manual QA pass** against the verification-surface table above. The 429-backoff path requires log inspection on staging; do not skip it.

7. **Update this doc's "Out of scope" → "Done" section** as items land. If Wave C2 (inbound-complaint SMS) is dispatched later, link its plan here.
