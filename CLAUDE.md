# AI Service OS — Claude Code Context

ServiceOS is a multi-tenant SaaS for home-service businesses (HVAC, plumbing,
etc.): lead intake, scheduling/dispatch, estimates, invoices, payments, an AI
voice agent for inbound calls, and a customer portal. TypeScript monorepo
(npm workspaces) with an AI gateway at its core.

## Repository Layout

### Shipped product (npm workspaces — `package.json` → `workspaces`)
- `/packages/api` — Backend API. TypeScript, Node 20, Express, Postgres (`pg`),
  Redis (`ioredis`), OpenAI, Twilio, SendGrid. Package name `@serviceos/api`.
- `/packages/web` — Frontend. React 18, Vite, TypeScript, Tailwind v4, Clerk
  (auth), Stripe, react-router 7. Package name `@serviceos/web`.
- `/packages/shared` — Shared Zod contracts, types, enums, legal copy.
  Package name `@ai-service-os/shared` (note the different scope — imports use
  `@ai-service-os/shared`, not `@serviceos/shared`).
- `/infra` — AWS CDK stacks (`@serviceos/infra`) for cloud resources only:
  storage (S3), queues (SQS), data, secrets, platform. The **app itself
  deploys on Railway** (see Deploy section), not via CDK. CDK manages
  supporting AWS infra.

### Supporting code (NOT in the workspace build)
- `/service-os-agent` — Python agent + MCP servers (`main.py`, `requirements.txt`).
- `/service-os-app` — A separate Next.js app (experimental/secondary surface).
- `/serviceos_training` — Python ML/data pipeline (corpus classification, schema).
- `/qa-runner` — Multi-agent QA orchestrator (`node qa-runner/src/orchestrator.mjs`).
- `/e2e` — Playwright end-to-end tests, journeys, fixtures, QA matrix.
- `/qa`, `/tests/chaos`, `/corpus`, `/fixtures` — QA artifacts, chaos tests,
  voice/AI corpus data, test fixtures.
- `/figma-export` — Exported Figma design assets.
- `/docs` — PRD, deployment, runbooks, decisions, stories, testing strategy.
- `/scripts` — Repo-level QA/smoke scripts (TS via `tsx`, plus shell).

## Tech Stack & Key Dependencies
- **Auth**: Clerk (`@clerk/clerk-react` web, `auth/clerk.ts` API). Local dev can
  use `auth/dev-auth-bypass.ts`. RBAC in `auth/rbac.ts`, tenant resolution in
  `auth/pg-tenant.ts`.
- **DB**: Postgres (hosted on Supabase/Railway). Access via `pg` pool in
  `packages/api/src/db/`. Row-Level Security enforced per tenant.
- **Queues/Workers**: Postgres-backed queue (`src/queues/pg-queue.ts`) and a
  worker registry (`src/workers/worker-registry.ts`). No external broker.
- **Webhooks**: base handler in `src/webhooks/` (signature verification, event
  persistence). Use this base for all external webhook handlers.
- **AI**: All LLM calls route through the gateway in `packages/api/src/ai/gateway/`
  (routing, failover, circuit breaker, caching, tenant quotas).
- **Telephony/Voice**: Twilio media streams, TTS, voice triage/recovery in
  `src/voice/`, `src/telephony/`, `src/ai/voice-*`.

## Core Patterns (enforced conventions)
- **Money**: integer cents, never floating point. Use the shared billing engine
  (`src/billing/`) for all financial calculations.
- **Time**: stored UTC, rendered in tenant timezone.
- **Tenancy**: every entity has a `tenant_id` column + RLS.
- **Audit**: every mutation emits an audit event (`src/audit/`).
- **AI calls**: ALWAYS route through `LLMGateway.complete()` in
  `packages/api/src/ai/gateway`. Direct `new OpenAI()` / `.chat.completions.create`
  calls outside `ai/gateway` and `ai/providers` are **blocked by CI**
  (`npm run check:ai-gateway-guard`).
- **Proposals**: AI-generated actions are typed payloads validated by Zod
  contracts (`src/proposals/contracts/`, `packages/shared/src/contracts/`).
  **Never auto-execute proposals — all require human approval.**
- **Background jobs**: use the async worker pattern (`src/workers/`,
  `src/queues/`).
- **Logging**: PII redaction enforced (`src/logging/redaction/`); `npm run
  lint:log-safety` runs in `lint`.

## Development Workflow

```bash
npm ci                         # install (root, hoists workspaces)
npm run typecheck              # API production type check (see Build Verification)
npm run lint                   # lint all workspaces
npm test                       # unit tests (vitest, all workspaces)

# API (cd packages/api)
npm run dev                    # ts-node dev server on PORT (default 3000)
npm run test:integration       # vitest + testcontainers Postgres
npm run migrate:apply          # apply DB migrations (src/db/migrations/*.sql)
npm run migrate:dryrun
npm run seed                   # seed dev data

# Web (cd packages/web)
npm run dev                    # vite dev server (default :5173)
npm run build                  # tsc --noEmit && vite build

# E2E / QA (root)
npm run e2e                    # playwright
npm run e2e:smoke
npm run qa:run:now             # qa-runner doctor + smoke + run + report
```

Copy `.env.example` → `.env` for local config (Clerk keys, DATABASE_URL or
individual DB vars, Stripe, CORS, feature flags like `VITE_ONBOARDING_V2_ENABLED`).

Install the pre-push hook to catch build breaks early:
`git config core.hooksPath .githooks` (runs the production type check on push).

## Build Verification (mandatory)
Before marking any story complete or pushing code, run:
```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```
(also available as `npm run typecheck` from the repo root)

This uses the same tsconfig as the Railway deploy. Fix all errors before
committing. The default `tsconfig.json` includes test files and vitest types —
it is NOT sufficient to verify the production build. Always use
`tsconfig.build.json`.

## CI (`.github/workflows/pr-checks.yml`, required on PRs to `main`)
1. API type check (`tsconfig.build.json`) + Web type check
2. Lint (includes log-safety)
3. Infra CDK tests
4. AI gateway guard (`check:ai-gateway-guard`)
5. Unit tests, integration tests (testcontainers), coverage thresholds
6. Voice-quality corpus suite (`voice-quality` job; required check — override
   procedure in `docs/superpowers/runbooks/voice-quality-launch-gate.md`)

Other workflows: `deploy.yml`, `e2e.yml`, and several `voice-*` quality jobs.

## Deploy (Railway)
- `railway.toml` + `Dockerfile` (multi-stage: `shared-build` → `web-build`/
  `api-build` → `web` (nginx) / `api` (node)). Railway builds the `api` target.
- `preDeployCommand` runs `db/migrate.js`; `startCommand` serves the API on
  port 3000; healthcheck is `/health` (not `/ready`).
- API entry: `packages/api/src/index.ts` → `createApp()` in `app.ts`.
- See `docs/deployment.md`.

## Story Execution Rules
- Only modify files listed in a story's "Allowed files/modules".
- Run automated checks (typecheck, lint, tests) before requesting review.
- Never auto-execute proposals — all require human approval.
- Use the shared billing engine for all financial calculations.
- Use the async worker pattern for background jobs.
- Use the webhook base for all external webhook handlers.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the
Skill tool as your FIRST action. Do NOT answer directly, do NOT use other tools
first. The skill has specialized workflows that produce better results than
ad-hoc answers.

Key routing rules:

- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
- Run/execute a gap story by ID (e.g. `/dispatch-story P0-019`) → invoke dispatch-story
