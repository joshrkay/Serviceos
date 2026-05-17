# Phase 7 — Integrations + Beta Hardening: Multi-Agent Dispatch Addendum

This addendum extends `docs/stories/phase-7-gap-stories.md` with the metadata
needed to dispatch each story to a Claude agent running in an isolated
worktree.

For every story, the agent prompt should include:
- The full body of the story from `phase-7-gap-stories.md`
- This addendum's per-story block
- `repository-conventions.md` and `freeze-list.md` from
  `docs/superpowers/contracts/`

## Wave plan

| Wave | Stories | Run-mode | Notes |
|---|---|---|---|
| 7-C1 | P7-026 | single agent, 3 commits on one worktree branch | Owner reviews; may split into 3 PRs at push time or merge as one. |

(Phase 7 has many older stories — P7-019 through P7-025 — that pre-date the
dispatch addendum format. They can be dispatched ad-hoc; only stories with
their own block below are wired into `/dispatch-story`.)

## Migration ledger

| Story | Reserved migration numbers | Domain |
|---|---|---|
| P7-026 | 101, 102, 103 | `google_business_connections`, `google_reviews`, `service_credits` |

Coordinator step: re-verify the next free migration number against
`packages/api/src/db/schema.ts` immediately before dispatching, in case
another in-flight branch has consumed numbers since this addendum was written.

---

## P7-026 — Google Business review monitoring + draft response

**Wave:** 7-C1
**Migration number reserved:** 101_create_google_business_connections (also reserves 102_create_google_reviews and 103_create_service_credits — all three numbers must be free before dispatch)

**Forbidden files:**
- `packages/shared/**` except `packages/shared/src/contracts/review-response-proposal.ts` (Tier 1 boundary; only the explicitly-allowed contract file may be added).
- `packages/api/src/db/pg-base.ts` (Tier 1 — RLS/tenant infrastructure).
- `packages/api/src/proposals/proposal.ts` may only be modified to extend the `ProposalType` union (additive — do not rename or remove any existing variant).
- `packages/api/src/proposals/proposal-contracts.ts` (Tier 1 — proposal action contracts).
- `packages/api/src/proposals/contracts.ts` and `packages/api/src/proposals/contracts/**` (consume; do not modify existing proposal payload schemas — the new schema goes in `packages/shared/src/contracts/review-response-proposal.ts` per the story's allowed-files line).
- `packages/api/src/proposals/execution/executor.ts`, `handlers.ts`, `idempotency.ts` (consume; the new handler registers itself via the existing handler registry).
- `packages/api/src/logging/redact.ts` (the story explicitly requires a *separate* content-level PII redactor; do not extend the infra redactor).
- `packages/api/src/webhooks/**` (consume the webhook base; do not modify).
- `packages/api/src/notifications/**` (consume the SMS / email delivery providers; do not modify).
- `packages/api/src/app.ts` (the new worker registers itself via `packages/api/src/workers/worker-registry.ts` — confirm pattern in that file before adding wiring).
- Any file outside the story's "Allowed files" line, including any other migration row in `db/schema.ts` other than the three reserved numbers above.

**Allowed files (concrete list, additive to the story's Allowed files line):**
- `packages/api/src/reputation/**` (new — module root for Google Business client, classifier, customer matcher, PII redactor, credit-tier calculator, draft builders, proposal builder).
- `packages/api/src/workers/google-reviews.ts` (new — polling worker; register in `worker-registry.ts`).
- `packages/api/src/workers/worker-registry.ts` (modify — additive registration entry only, no removals).
- `packages/api/src/proposals/execution/review-response-handler.ts` (new — handler for the new proposal type; register in `handlers.ts`).
- `packages/api/src/proposals/execution/handlers.ts` (modify — additive registration entry only).
- `packages/api/src/proposals/proposal.ts` (modify — append `'review_response'` to the `ProposalType` union; no other change).
- `packages/api/src/db/schema.ts` (modify — append three new entries in `MIGRATIONS`: `101_create_google_business_connections`, `102_create_google_reviews`, `103_create_service_credits`; do not edit any existing migration string).
- `packages/shared/src/contracts/review-response-proposal.ts` (new — Zod schemas for the proposal payload).
- Test files:
  - `packages/api/test/reputation/**` (new) OR `packages/api/src/reputation/__tests__/**` (new — pick one layout consistent with the surrounding code; check whether the closest neighbouring domain uses co-located `__tests__` or sibling `test/<domain>/`).
  - `packages/api/test/workers/google-reviews.test.ts` (new).
  - `packages/api/test/proposals/execution/review-response-handler.test.ts` (new).
  - `packages/shared/src/contracts/__tests__/review-response-proposal.test.ts` (new — if the shared package already has a tests layout) OR `packages/api/test/contracts/review-response-proposal.test.ts` (new — if shared has no test runner wired up).
- Setup/scaffolding (these are pre-created by the coordinator before dispatch and will appear in the diff; the gate's regex must accept them):
  - `docs/stories/phase-7-gap-stories.md` (story spec).
  - `docs/superpowers/contracts/p7-dispatch-addendum.md` (this file).

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npx vitest run -t "P7-026") && \
  git diff --name-only origin/main... | grep -vE "^(packages/api/src/reputation/|packages/api/src/workers/google-reviews\.ts|packages/api/src/workers/worker-registry\.ts|packages/api/src/proposals/execution/review-response-handler\.ts|packages/api/src/proposals/execution/handlers\.ts|packages/api/src/proposals/proposal\.ts|packages/api/src/db/schema\.ts|packages/shared/src/contracts/review-response-proposal\.ts|packages/shared/src/contracts/__tests__/review-response-proposal\.test\.ts|packages/api/test/reputation/|packages/api/test/workers/google-reviews|packages/api/test/proposals/execution/review-response-handler|packages/api/test/contracts/review-response-proposal|docs/stories/phase-7-gap-stories\.md|docs/superpowers/contracts/p7-dispatch-addendum\.md)" | (! grep . )
```

**Pre-flight:**
- `git fetch origin && git rev-parse origin/main` succeeds.
- Working tree clean (`git status --porcelain` empty).
- Migration numbers 101, 102, 103 are not yet present in `packages/api/src/db/schema.ts`.
- `packages/api/src/webhooks/webhook-handler.ts` exists (P0-014 webhook base baseline).
- `packages/api/src/notifications/twilio-delivery-provider.ts` exists (P2-034 SMS delivery baseline).
- `packages/api/src/proposals/proposal-contracts.ts` exists (P2-002 proposal contracts baseline).
- A brand-voice module exists somewhere under `packages/api/src/ai/**` for the public-response draft to consume (P4-015 baseline). If the module is absent, the public-draft builder may fall back to a stub voice with a `TODO(P4-015)` marker AND surface that in the PR description — do not block the story.
- `packages/api/src/workers/worker-registry.ts` exists and exports a registration shape the new worker can plug into.

**Risk note:**
- **PII leakage in public responses.** The single highest-risk failure mode. The public draft is shown on a publicly indexed Google review page. It must NEVER include the customer's address, full name (last name), phone number, email, or any internal identifier — even if the AI prompt seems to suggest including them to "personalise" the response. The content-level PII redactor must run as a final pass over every generated public draft, and the test suite must include a poison-prompt case (LLM is asked to "include the customer's full address for clarity"; redactor strips it).
- **Cross-tenant data leak.** Reviews and credits are tenant-scoped. Every new table must include `tenant_id UUID NOT NULL REFERENCES tenants(id)`, every query must go through `withTenant()` per `repository-conventions.md`, and every new RLS policy must enforce the standard `tenant_id = current_setting('app.tenant_id')::uuid` predicate. Reviewer must check.
- **Credit cap bypass.** The 12-month $100/customer cap is a hard limit. Enforce in code (not just UI) before the credit tier is included in the draft, and again in the execution handler before issuance. Use a sum-over-`service_credits.amount_cents` query, parameterised by `customer_id` and `issued_at > now() - interval '12 months'`. Owner-approval is in addition to, not instead of, the code-level cap.
- **Google API quota / 429 backoff.** Polling is per-tenant on a 15-minute interval. A multi-tenant rollout could easily exceed Google Business Profile API per-account quotas. Use exponential backoff on 429 (1m → 5m → 15m → 1h, max 1h) with jitter, and emit telemetry on every backoff event so we can detect quota pressure early. Never tight-loop on 429.
- **Wrong-business classification.** A review tagged `wrong_business` should not generate a public response at all (silent skip + audit log). The proposal builder must short-circuit before drafting.
- **Customer matching false positives.** "John Smith on Tuesday" is not a high-confidence match. The matcher must be conservative: require BOTH name similarity (≥ Levenshtein threshold or equivalent) AND a recent visit within ±7 days, OR flag as `unverified` and omit the private draft. Better to surface "no match" than to send a private apology SMS to the wrong customer.
- **AI-gateway routing.** The classifier and draft generators must go through the LLM gateway per `CLAUDE.md`'s "All AI calls: route through LLM gateway" rule. Do not call provider SDKs directly.
- **Idempotency on review IDs.** Google review IDs are stable. Inserts into `google_reviews` must use `ON CONFLICT (tenant_id, google_review_id) DO NOTHING` so re-polls don't duplicate rows, and proposal generation must check for an existing proposal on the same review before drafting a second one.

**Implementation hints:**
1. **Commit plan — 3 commits on the worktree branch** (this story is "split into 3 PRs" per the spec; one agent does all three but commits them separately so the owner can split-or-merge at push time):
   - Commit 1 — `P7-026 (PR-a): poll + model` — migrations 101 + 102, `reputation/google-business-client.ts`, `reputation/classifier-stub.ts`, `workers/google-reviews.ts` with 429 backoff, plus tests.
   - Commit 2 — `P7-026 (PR-b): classifier + matching + PII redactor` — real `reputation/classifier.ts`, `reputation/customer-matcher.ts` (conservative), `reputation/pii-redactor.ts` (content-level, NOT logging redactor), plus tests including the poison-prompt case.
   - Commit 3 — `P7-026 (PR-c): proposal + credit + execution` — migration 103, `reputation/credit-tier.ts` (with 12-month cap query), `reputation/build-proposal.ts`, public/private draft builders, `proposals/execution/review-response-handler.ts`, `ProposalType` enum addition, shared contract Zod schemas, plus tests.
   - The verification gate runs only after Commit 3. If it fails, fix and re-commit; do not push.
2. **Migration content** — each of the three migrations is a single `CREATE TABLE` plus its RLS policies and indexes, following the pattern in surrounding entries (e.g. `094_add_held_appointment_fields`, `095_vertical_training_assets`). Look at the surrounding ~10 migrations before writing yours so the style matches.
3. **`google_business_connections`** holds the per-tenant OAuth token / location_id metadata. Token storage must reuse whatever pattern the existing OAuth-bearing tables use (search for `access_token TEXT` in `db/schema.ts`); do NOT invent a new encryption scheme.
4. **`google_reviews`** holds the polled review snapshot. Columns at minimum: `id`, `tenant_id`, `google_review_id` (unique with tenant_id), `reviewer_name`, `rating`, `comment_text`, `posted_at`, `classification`, `matched_customer_id` (nullable FK), `proposal_id` (nullable FK), `created_at`, `updated_at`. The `comment_text` is what gets PII-redacted before any public response is drafted from it.
5. **`service_credits`** holds the issuance ledger. Columns at minimum: `id`, `tenant_id`, `customer_id`, `amount_cents` (integer per CLAUDE.md money rule), `issued_at`, `issued_by_user_id`, `source_review_id` (nullable FK to `google_reviews`), `notes`, `created_at`. Add a partial index on `(tenant_id, customer_id, issued_at)` to make the 12-month cap query cheap.
6. **Worker registration** — read `packages/api/src/workers/worker-registry.ts` before modifying. The existing workers (e.g. `overdue-invoice-worker.ts`) show the registration shape and interval-config convention. Match that.
7. **Proposal handler registration** — read `packages/api/src/proposals/execution/handlers.ts` and any sibling handler (e.g. `cancellation-handler.ts`) to confirm the registration pattern. The new handler must support independent approve/edit/reject of the public, private, and credit sub-payloads — surface that via the proposal payload schema's discriminated structure, not via three separate proposals.
8. **Shared contract** — `packages/shared/src/contracts/review-response-proposal.ts` exports Zod schemas for the proposal payload and the three sub-payloads (public-response, private-message, service-credit). The dispatch addendum explicitly allows touching `packages/shared/**` only for this one file — every other file in `packages/shared/` is locked.
9. **Tests** — the story's required-tests list maps to vitest test names. Name every test with `P7-026` somewhere in its `describe()` or `it()` string so `npx vitest run -t "P7-026"` picks them up. Without this, the verification gate's test filter matches nothing and the gate passes trivially — that is a regression hazard the reviewer will catch.
10. **Brand-voice integration (P4-015)** — search `packages/api/src/ai/**` for an existing brand-voice module before writing one. If absent, stub the public-draft builder with a minimal voice template AND add a `TODO(P4-015)` comment + a short note in the PR description so the gap is visible.
11. **AI gateway** — the classifier and the two draft generators (public response, private apology) must route through the LLM gateway at `packages/api/src/ai/gateway` per CLAUDE.md. Use the existing typed-prompt pattern; do not import the Anthropic SDK directly.

---

## Universal pre-flight checks (run by `/dispatch-story` before launching any agent)

1. `git fetch origin && git rev-parse origin/main` — confirms fresh main.
2. Working tree clean (`git status --porcelain` empty) on the parent shell.
3. `npx tsc --project packages/api/tsconfig.build.json --noEmit` passes on the current branch.
4. Reserved migration number is not yet used in `packages/api/src/db/schema.ts`.

If any pre-flight fails, the dispatcher refuses to launch and surfaces the
failure. Don't auto-resolve — the human coordinator decides.
