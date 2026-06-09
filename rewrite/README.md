# Rivet — First-Principles Rewrite

A ground-up rebuild of the Rivet AI back office, sized to the actual product: an
SMS-first AI back office for 1–3 truck home-service shops. See
`docs/PRD.md` (v2) and the rewrite design plan for rationale.

## The irreducible core

```
Inbound event (call / SMS / payment) → AI interpretation → typed Proposal
  → human approval (SMS-first) → deterministic execution → canonical state
  → append-only event → notification
```

Everything in this tree exists to serve that loop.

## Architecture invariants

- **Proposal gate** — AI never mutates canonical state. It creates typed,
  Zod-validated proposals. A human approves (SMS `YES n` / `NO n`, or web
  inbox), then a deterministic executor runs.
- **Command bus** — every canonical mutation is a command executed in one
  transaction that (a) updates state, (b) appends to the `events` table,
  (c) enqueues side effects via a transactional outbox. Audit and
  notifications are structural, not conventional.
- **Integer cents** — all money math goes through the shared billing engine
  (`packages/api/src/modules/money/billing-engine.ts`). Quantities are integer
  hundredths; tax rates are basis points. Property-tested with fast-check.
- **Postgres only** — canonical state, append-only events, transactional
  outbox, and the pg-boss job queue all live in one Postgres. No Redis, no
  SQS, no second schema.
- **FORCE ROW LEVEL SECURITY** — every tenant table forces RLS. The app
  connects as a non-superuser role (`rivet_app`); only the platform layer
  (webhook ingest, outbox drain, digest fan-out) uses the admin pool.
- **One LLM gateway** — all AI calls route through
  `packages/api/src/modules/ai/gateway.ts`: task routing, per-tenant daily
  quotas, `ai_runs` cost accounting.
- **Idempotency everywhere** — webhooks dedup via `webhook_events`,
  proposals execute via atomic claim, outbox dispatch uses singleton keys,
  payments dedup on external refs.

## Packages

- `packages/contracts` — Zod enums, money schemas, proposal payloads, and the
  ts-rest API contract. Single source of truth; server and client both derive
  from it.
- `packages/api` — Fastify modular monolith. Modules: `platform`, `crm`,
  `money`, `proposals`, `comms`, `ai`, `webhooks` over a small core
  (`db`, `commands`, `events`, `outbox`, `jobs`).
- `packages/web` — thin React SPA (TanStack Query + react-router): proposal
  inbox, money dashboard, customers, audit log, settings. The web app is an
  audit/config surface, not the daily driver — SMS is.

## Running locally

```bash
# Postgres 16+ with two roles: a superuser (migrations/admin) and a
# non-superuser app role (RLS-enforced):
#   CREATE ROLE rivet_app LOGIN PASSWORD 'rivet_app';

export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/rivet
export DATABASE_URL=postgres://rivet_app:rivet_app@localhost:5432/rivet

npm install
npm run migrate
npm run seed              # dev tenant + owner + sample data
npm run dev:api           # API on :3001 (serves built web in production)
npm run dev:web           # Vite dev server on :5173, proxies /api
```

Without `CLERK_JWKS_URL` the API runs in dev-auth mode: requests authenticate
with an `x-dev-user-id` header (the seed prints user ids). Without
`OPENAI_API_KEY` the LLM gateway uses a deterministic stub provider. Without
Twilio credentials outbound SMS logs to stdout (`ConsoleSmsProvider`).

## Tests

```bash
npm test                          # unit + property tests (fast-check)
npm run test:integration -w packages/api   # real Postgres: RLS, commands, proposals, webhooks
```
