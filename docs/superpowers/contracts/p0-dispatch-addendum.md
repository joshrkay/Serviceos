# P0 Gap Stories — Multi-Agent Dispatch Addendum

This addendum extends `docs/stories/phase-0-gap-stories.md` with the metadata needed to dispatch each story to a Claude agent running in an isolated worktree. The story file remains the canonical "what to build"; this file says "how to launch the agent and how to verify it succeeded".

For every story below, the agent prompt should include:
- The full body of the story from `phase-0-gap-stories.md`
- This addendum's per-story block
- `repository-conventions.md` and `freeze-list.md` from `docs/superpowers/contracts/`

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 1A | P0-019, P0-020, P0-021, P0-022, P0-027, P0-028 | parallel (6 agents, isolated worktrees) | Wave 1C |
| 1B | P0-026, P0-029, P0-032 | parallel (3 agents) | none |
| 1C | P0-023 | single agent, after 1A merges | P0-024 |
| 1D | P0-024, P0-025, P0-030, P0-031 | parallel (4 agents) after 1C merges | sprint complete |

Sprint 1 originally appeared sequential. With the wave plan and the contract freeze, **11 stories collapse to 4 wall-clock waves**.

---

## P0-019 — Postgres repositories — core entities

**Status correction (2026-04-27):** The story's "21 InMemory repositories" framing is stale. Customer, Location, Job, JobTimeline, Appointment, and Note **all already have** `pg-*.ts` implementations and are conditionally wired in `app.ts:251-280`. The remaining InMemory-only entity in the "core" domain is **Assignment** (`packages/api/src/appointments/assignment.ts:256`).

**Re-scoped scope:**
1. Verify each existing `pg-*.ts` (Customer, Location, Job, JobTimeline, Appointment, Note) satisfies its interface contract from `repository-conventions.md`. If yes, no work needed for that entity — record the verification in the PR description.
2. Add `PgAssignmentRepository` in `packages/api/src/appointments/pg-assignment.ts`.
3. Add migration `042_create_assignments` to `db/schema.ts`.

**Wave:** 1A
**Migration number reserved:** `042_*`
**Forbidden files:**
- `packages/api/src/app.ts` (Wave 1C only)
- any `pg-*.ts` outside the entities listed above
- `packages/shared/**` (Tier 1 locked)
- `packages/api/src/db/pg-base.ts` (Tier 1 locked)
- any test file outside `packages/api/test/<owned-entity>/**`

**Verification gate (single command):**
```bash
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P0-019|PgAssignment" && \
  git diff --name-only origin/main... | grep -vE "^(packages/api/src/appointments/pg-|packages/api/src/db/schema\.ts|packages/api/test/)" | (! grep . )
```

**Pre-flight:** `git fetch origin && git rev-parse origin/main` must succeed. No dependency stories block.

---

## P0-020 — Postgres repositories — financial entities

**Status correction:** Estimate, EstimateApproval, EstimateEditDelta, Invoice, and Payment **already have** `pg-*.ts` implementations. The remaining InMemory-only entity in the financial domain is the **webhook idempotency repository** (`webhooks/routes.ts:9` uses an InMemory map). That moves under this story since duplicate Stripe / Clerk webhooks could double-charge.

**Re-scoped scope:**
1. Verify Pg impls for Estimate, EstimateApproval, EstimateEditDelta, Invoice, Payment satisfy contract.
2. Add `PgWebhookEventRepository` (idempotency tracking by `event_id`) in `packages/api/src/webhooks/pg-webhook-event.ts`.
3. Add migration `043_create_webhook_events` with `UNIQUE (event_id)` constraint.

**Wave:** 1A
**Migration number reserved:** `043_*`
**Forbidden files:**
- `packages/api/src/app.ts`
- any `pg-*.ts` outside the entities listed above
- `packages/shared/**`, `db/pg-base.ts`
- `packages/api/src/webhooks/routes.ts` (do not change webhook handler logic; only the repo behind it)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P0-020|PgWebhookEvent" && \
  git diff --name-only origin/main... | grep -vE "^(packages/api/src/webhooks/pg-|packages/api/src/db/schema\.ts|packages/api/test/)" | (! grep . )
```

**Pre-flight:** none. (P0-019 in story body listed as dependency; in practice the two stories are independent — both touch different files. Coordinator may launch in parallel.)

---

## P0-021 — Postgres repositories — AI & conversation entities

**Status correction:** Conversation, Voice, Proposal **already have** Pg impls. Remaining InMemory-only AI entities are:
- `DocumentRevisionRepository` (`ai/document-revision.ts:350`)
- `DiffAnalysisRepository` (`ai/diff-analysis.ts:351`)

These store immutable AI artifacts (revisions of generated content + their diff scoring). Both are append-only and tenant-scoped.

**Re-scoped scope:**
1. Add `PgDocumentRevisionRepository` in `packages/api/src/ai/pg-document-revision.ts`.
2. Add `PgDiffAnalysisRepository` in `packages/api/src/ai/pg-diff-analysis.ts`.
3. Add migration `044_create_ai_artifacts` with both tables + RLS policies.

**Wave:** 1A
**Migration number reserved:** `044_*`
**Forbidden files:**
- `packages/api/src/app.ts`
- any `pg-*.ts` outside `packages/api/src/ai/`
- `packages/shared/**`, `db/pg-base.ts`

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P0-021|PgDocumentRevision|PgDiffAnalysis" && \
  git diff --name-only origin/main... | grep -vE "^(packages/api/src/ai/pg-|packages/api/src/db/schema\.ts|packages/api/test/)" | (! grep . )
```

---

## P0-022 — Postgres repositories — config & operational entities

**Status correction:** Settings, PackActivation, ServiceBundle, EstimateTemplate, QualityMetrics, Audit **all already have** Pg impls. Remaining InMemory-only operational entities are:
- `DispatchAnalyticsRepository` (`dispatch/analytics.ts:388`)
- `DelayNoticeStateRepository` (`notifications/delay-notifications.ts:401`)

**Re-scoped scope:**
1. Add `PgDispatchAnalyticsRepository` in `packages/api/src/dispatch/pg-analytics.ts`.
2. Add `PgDelayNoticeStateRepository` in `packages/api/src/notifications/pg-delay-notice-state.ts`.
3. Add migration `045_create_operational_metrics`.

**Wave:** 1A
**Migration number reserved:** `045_*`
**Forbidden files:**
- `packages/api/src/app.ts`
- any `pg-*.ts` outside `dispatch/` and `notifications/`
- `packages/shared/**`, `db/pg-base.ts`

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P0-022|PgDispatchAnalytics|PgDelayNoticeState" && \
  git diff --name-only origin/main... | grep -vE "^(packages/api/src/(dispatch|notifications)/pg-|packages/api/src/db/schema\.ts|packages/api/test/)" | (! grep . )
```

---

## P0-023 — Wire Postgres pool and replace InMemory instantiations

**Status correction:** The story says "lines 101–122" — actual location is `app.ts:251-280` for the conditional ternary block. 17 entities are already wired through that ternary. P0-023 extends it to the entities created by P0-019..P0-022 + P0-028 (Queue).

**Re-scoped scope:**
1. Add `PgAssignmentRepository`, `PgWebhookEventRepository`, `PgDocumentRevisionRepository`, `PgDiffAnalysisRepository`, `PgDispatchAnalyticsRepository`, `PgDelayNoticeStateRepository`, `SqsQueue` to the existing `pool ? Pg* : InMemory*` ternary.
2. Add a graceful shutdown handler that calls `pool.end()` on SIGTERM/SIGINT.
3. Verify `app.ts` references zero InMemory repos when `pool` is set, except where Tier 3 freeze docs explicitly allow.

**Wave:** 1C — runs alone after every Wave 1A story's PR has merged to main.
**Migration number reserved:** none.
**Forbidden files:**
- any file outside `packages/api/src/app.ts` and `packages/api/src/db/pool.ts`
- new `pg-*.ts` files (those belong to Wave 1A stories)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P0-023" && \
  ! grep -nE "new InMemory(Assignment|WebhookEvent|DocumentRevision|DiffAnalysis|DispatchAnalytics|DelayNoticeState|Queue)" packages/api/src/app.ts
```

**Pre-flight:** all six Wave 1A PRs must show as merged on origin/main. Run `git log origin/main --oneline | grep -E "P0-019|P0-020|P0-021|P0-022|P0-027|P0-028"` to confirm.

---

## P0-024 — RLS tenant context middleware

**Status correction:** `setTenantContext()` exists in `db/schema.ts:999-1004` and is called from `pg-base.ts:withTenant()` per-query. The audit's "no RLS middleware" claim is half-right: there's no Express middleware that sets it once per request, but the per-query wrapper means RLS does fire. P0-024's value is moving the SET into a request-scoped transaction so it doesn't fire on every query.

**Re-scoped scope:**
1. Add `withTenantTransaction()` middleware in `packages/api/src/middleware/tenant-context.ts` that begins a transaction, calls `SET LOCAL app.current_tenant_id`, attaches the client to `req`, and commits/releases on response.
2. Update `PgBaseRepository.withTenant()` to prefer `req.client` when present (single-transaction-per-request mode), fall back to the existing per-query connect when not.
3. Skip the middleware on public routes (health, estimate approval, payment).

**Wave:** 1D
**Forbidden files:**
- `packages/api/src/db/schema.ts` (the SET LOCAL SQL is here; do not duplicate)
- `packages/api/src/app.ts` (only register the middleware; do not refactor)
- any `pg-*.ts` (handled by the base class change)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P0-024|tenant-context"
```

**Pre-flight:** P0-023 merged.

---

## P0-025 — Implement bootstrapTenant() on Clerk user.created webhook

**Wave:** 1D
**Forbidden files:**
- `packages/api/src/db/schema.ts`
- `packages/api/src/auth/clerk.ts` (Tier 1 unless explicitly evolving auth)
- `packages/api/src/webhooks/pg-webhook-event.ts` (built by P0-020; do not modify here, just consume)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P0-025|bootstrapTenant"
```

**Pre-flight:** P0-020 merged (depends on idempotency repo) and P0-024 merged (RLS context).

---

## P0-026 — Startup env validation + remove dev-secret fallback

**Status correction:** The `'dev-secret-key'` literal is **already removed** from `app.ts` per the security review. It only survives in `packages/api/test/routes/pack-activation.route.test.ts`. The remaining work is the env validation Zod schema and the `validateProductionConfig` extension.

**Re-scoped scope:**
1. Verify (don't re-remove) that `app.ts` has no `'dev-secret-key'` literal. If present, fail loudly.
2. Extend `packages/api/src/shared/config.ts:validateProductionConfig` to assert all required prod vars (`DATABASE_URL`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CORS_ORIGIN !== true`, `STRIPE_SECRET_KEY` if invoicing enabled).
3. Add a `npm run validate-env` script that runs validation without starting the server.

**Wave:** 1B
**Forbidden files:**
- `packages/api/src/auth/clerk.ts`
- `packages/api/src/db/**`
- `packages/api/test/routes/pack-activation.route.test.ts` (test fixture; needs separate refactor)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P0-026|validateProductionConfig" && \
  ! grep -n "'dev-secret-key'" packages/api/src/**/*.ts
```

---

## P0-027 — Integrate real STT provider (OpenAI Whisper)

**Status correction:** The provider seam exists at `packages/api/src/voice/transcription-providers.ts` with a `DevNoopTranscriptionProvider`. The audit's "hardcoded mock at app.ts:124-131" is stale — it now lives behind the seam.

**Re-scoped scope:**
1. Add `WhisperTranscriptionProvider` implementing `TranscriptionProvider` in `transcription-providers.ts`.
2. Wire selection in `app.ts` based on `OPENAI_API_KEY` presence. Production must throw if missing; dev falls back to noop with a warning.
3. Add Whisper-specific tests with mocked `fetch`.

**Wave:** 1A (independent of repo work)
**Forbidden files:**
- any file outside `packages/api/src/voice/` and `packages/api/src/workers/transcription.ts`
- `packages/api/src/app.ts` is touched only for the provider selection ternary; do not modify other parts

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P0-027|Whisper"
```

---

## P0-028 — Replace InMemory queue with SQS worker

**Re-scoped scope:** `PgQueue` already exists at `packages/api/src/queues/pg-queue.ts`. The audit conflates "Pg queue" with "SQS queue". Decide:
- **Option A (recommended):** keep `PgQueue` as the prod default (Postgres-backed work queue with `FOR UPDATE SKIP LOCKED`); skip SQS until scale demands it. Story collapses to a docs/decision-record update.
- **Option B:** add `SqsQueue` per the original audit. Bigger change, requires CDK QueueStack output wiring.

**Coordinator decision required before dispatch.** Default to A unless the team has explicit need for SQS.

**Wave (Option A):** 1A — collapses to a 1-hour decision record + `app.ts` switch from InMemory to PgQueue (which is the Wave 1C job anyway).
**Wave (Option B):** 1A — full SqsQueue impl + IaC wiring.

**Forbidden files (either option):**
- `packages/api/src/db/schema.ts` (PgQueue table already exists)
- `infra/**` for Option A
- `packages/api/src/app.ts` (Wave 1C wires the selection)

**Verification gate (Option A):**
```bash
cd /home/user/Serviceos && \
  test -f docs/decisions/p0-028-queue-choice.md && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit
```

---

## P0-029 — Frontend Clerk SDK integration

**Wave:** 1B
**Forbidden files:**
- `packages/web/src/hooks/**` (P0-030 owns this)
- `packages/web/src/data/mock-data.ts` (separate cleanup story)
- any backend file

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npm run typecheck && \
  npm test --workspace=packages/web -- --run --grep "P0-029|ClerkProvider" && \
  ! grep -rn "setTimeout" packages/web/src/components/auth/LoginPage.tsx && \
  ! grep -rn "Mike Ortega" packages/web/src/
```

---

## P0-030 — Auth headers in frontend API client hooks

**Wave:** 1D
**Forbidden files:**
- `packages/web/src/components/**` (only hooks + lib)
- backend

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npm run typecheck && \
  npm test --workspace=packages/web -- --run --grep "P0-030|Authorization"
```

**Pre-flight:** P0-029 merged.

---

## P0-031 — Protected route guards

**Wave:** 1D
**Forbidden files:**
- `packages/web/src/hooks/**` (P0-030 owns)
- `packages/web/src/components/auth/LoginPage.tsx` (P0-029 owns)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npm run typecheck && \
  npm test --workspace=packages/web -- --run --grep "P0-031|ProtectedRoute"
```

**Pre-flight:** P0-029 merged.

---

## P0-032 — Global error boundary + Sonner toast provider

**Wave:** 1B
**Forbidden files:**
- `packages/web/src/hooks/useListQuery.ts` (do not refactor; only `useMutation` adds toast hooks)
- backend
- any file under `packages/web/src/types/**`

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npm run typecheck && \
  npm test --workspace=packages/web -- --run --grep "P0-032|ErrorBoundary|Toaster"
```

---

## Universal pre-flight checks (run by `/dispatch-story` before launching any agent)

1. `git fetch origin && git rev-parse origin/main` — confirms fresh main.
2. Working tree clean (`git status --porcelain` empty) on the parent shell.
3. `npx tsc --project packages/api/tsconfig.build.json --noEmit` passes on the current branch.
4. All `Pre-flight` dependencies for the story have merged to main (grep `git log origin/main --oneline`).

If any pre-flight fails, the dispatcher refuses to launch and surfaces the failure. Don't auto-resolve — the human coordinator decides.
