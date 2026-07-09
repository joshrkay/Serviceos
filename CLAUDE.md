# AI Service OS — Claude Code Context

## Project Structure
Canonical product (deployed on Railway):
- /packages/api — Backend API (TypeScript, Node, Express)
- /packages/web — Frontend (React, TypeScript, Tailwind)
- /packages/shared — Shared types, contracts, constants

Deployment: /railway.toml + /Dockerfile (Railway is the deploy target).
See /docs/deployment.md.

NOT deployed / experimental — quarantined under /experiments (see
/experiments/README.md); do not mistake for production (each has a
README explaining why):
- /infra — AWS CDK stacks; built but deployed by nothing.
- /service-os-app — Next.js prototype that bypasses the proposal/audit gate.
- /service-os-agent — Python LangGraph prototype with known defects.
- /supabase_migration.sql — schema for the service-os-app prototype only;
  unrelated to the canonical in-code migrations (packages/api/src/db/schema.ts).
- /rewrite — parallel ground-up rebuild (first-principles, command bus).
  NOT the deploy target; never apply story/feature work there unless the
  task says so explicitly. Canonical work goes in /packages.

## Product behavior
- **Interaction model:** `docs/interaction-model-v3.md` is the behavioral reference between PRD,
  screens, and stories. If a screen or story contradicts it on *behavior*, the interaction model
  wins. Code alignment: `docs/interaction-model-v3-code-alignment.md`.

## Core Patterns
- All money: integer cents, never floating point
- All times: stored UTC, rendered in tenant timezone
- All entities: tenant_id column + RLS
- All mutations: emit audit events
- All AI calls: route through LLM gateway (packages/api/src/ai/gateway)
- All proposals: typed payloads validated by Zod contracts
- All AI-drafted line-item prices: grounded in the tenant catalog via
  packages/api/src/ai/resolution/catalog-resolver.ts — never trust an
  LLM-emitted price without resolution (uncatalogued lines must cap
  confidence below the auto-approve threshold)
- All free-text entity references on voice paths: resolved via the
  entity resolver (packages/api/src/ai/resolution); ambiguity becomes a
  one-tap voice_clarification, never a silent guess

## Code Hygiene & Testing (mandatory)
- Remove dead code as part of every change: unused exports, imports,
  interfaces, fixtures, and "built but never wired" modules. When wiring
  a dormant module, delete its null/stub stand-ins (re-grep usage first).
- New or changed pure logic requires unit tests in the same commit.
  Voice/AI behavior changes need handler-level tests with a mocked
  gateway/repos; DB-touching changes need a Docker-gated integration
  test (packages/api/test/integration/, runs in PR CI).
- Tests that mock the DB are never the only proof a query works — the
  entity resolver shipped with nonexistent column names because its Pool
  was mocked. Pin real columns with an integration test.
- Mobile/public UI changes: ≥44px tap targets (min-h-11), no horizontal
  overflow at 320px. Pin with a jsdom class-contract test + a Playwright
  viewport test (pattern: e2e/estimate-approval-mobile.spec.ts).
- Prior learnings live in `docs/solutions/` (categorized; frontmatter
  `module`/`tags`/`problem_type`) — relevant to grep before debugging or
  implementing in a documented area, so fixes compound instead of repeating.

## Story Execution Rules
- Only modify files listed in "Allowed files/modules"
- Run automated checks before requesting review
- Never auto-execute proposals — all require human approval
- Use the shared billing engine for all financial calculations
- Use the async worker pattern (P0-009) for background jobs
- Use the webhook base (P0-014) for all external webhook handlers

## Build Verification (mandatory)
Before marking any story complete or pushing code, run:
```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```
This uses the same tsconfig as the Railway deploy. Fix all errors before committing.
The default `tsconfig.json` includes test files and vitest types — it is NOT
sufficient to verify the production build. Always use `tsconfig.build.json`.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

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

## Local Orchestration (Gemma 4 26B)
- **Role**: Fable 5 (Orchestrator/Reviewer), Gemma 4 26B (Executor).
- **Execution**: When a coding task is assigned, use the `Bash` tool to delegate to the local model via the command line.
- **Verification**: All code generated by the local Gemma model must be reviewed by Fable 5 for alignment with "Core Patterns" and "Code Hygiene" before being committed.
- **Local Endpoint**: `http://localhost:1234` (LM Studio).

