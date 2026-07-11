# Rivet

AI back office for owner-operator home-service shops. The production
system is a TypeScript monorepo deployed on **Railway**.

> Repository directories and npm package names still use the
> `serviceos` / `@serviceos` namespace internally. Renaming those is a
> separate, deliberate refactor (see `docs/launch/2026-06-03-rivet-gtm-brief.md`).

## Repository map

**Canonical product (this is what ships — npm workspaces):**

- `packages/api` — backend API (Express, TypeScript). All mutations,
  AI calls, and proposals flow through here.
- `packages/web` — frontend (React, Vite, Tailwind).
- `packages/shared` — shared types, contracts, constants.

**Other packages in the monorepo (not independent deploy targets):**

- `packages/mobile` — owner-operator mobile app (Expo + React Native).
  Calls the same `packages/api`.
- `packages/voice-eval` — intent-classification/slot-extraction eval
  harness for the voice agent. Not an npm workspace member; run directly
  with `npx tsx`.

**Deployment / ops:**

- `railway.toml`, `Dockerfile` — the live Railway deployment.
- `docs/deployment.md` — deployment runbook.
- `deploy/` — deploy-time scripts/config consumed by the Railway build.

**Testing / QA:**

- `e2e/` — Playwright mobile/viewport specs (e.g. tap-target and
  no-horizontal-overflow contract tests).
- `tests/` — cross-cutting test suites outside the `packages/*` workspaces.
- `qa/` — QA runbook, backlog, gate exceptions, and QA scripts/reports.
- `qa-runner/` — scenario-driven QA agent runner (config, prompts, scripts).
- `loadtest/` — load-test scenarios.
- `fixtures/` — shared test fixtures.

**Docs, tooling, data:**

- `docs/` — architecture, decisions, runbooks, plans; see
  `docs/architecture.md` for a new-developer orientation and
  `docs/decisions.md` for the founding-decisions log.
- `scripts/` — one-off and CI-invoked operational scripts (QA token
  minting, schema probes, data pipeline, etc).
- `tools/` — repo-maintenance utilities.
- `corpus/`, `serviceos_training/`, `data/`, `eval-results/`,
  `fixtures/` — training/eval corpora and their outputs; see
  `CORPUS_MANIFEST.md`.
- `figma-export/` — exported design assets for the design system.
- `projects/` — point-in-time audit/analysis run artifacts (not
  application code).

**Prototypes removed 2026-07:** `/experiments` (AWS CDK infra, a Next.js
prototype that bypassed the proposal/audit gate, a Python LangGraph
prototype with known defects, and its standalone Supabase schema) and
`/rewrite` (a parallel ground-up rebuild) were quarantined, never-deployed
code with zero live references from the shipping app. Both are gone from
the working tree but recoverable from git history — see
[`docs/decisions.md`](docs/decisions.md) D-016.

**Historical docs:** superseded launch notes, plans, stories, and old PRD reconciliation documents are archived under [`docs/archive/2026-07-cleanup/`](docs/archive/2026-07-cleanup/README.md). Treat active docs outside `docs/archive/` as current-state guidance.

## Deployment

- Deployment docs: [`docs/deployment.md`](docs/deployment.md)
- Architecture overview: [`docs/architecture.md`](docs/architecture.md)
