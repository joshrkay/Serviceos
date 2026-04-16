# AI Service OS — Claude Code Context

## Project Structure
- /infra — AWS CDK stacks (TypeScript)
- /packages/api — Backend API (TypeScript, Node, Express)
- /packages/web — Frontend (React, TypeScript, Tailwind)
- /packages/shared — Shared types, contracts, constants

## Core Patterns
- All money: integer cents, never floating point
- All times: stored UTC, rendered in tenant timezone
- All entities: tenant_id column + RLS
- All mutations: emit audit events
- All AI calls: route through LLM gateway (packages/api/src/ai/gateway)
- All proposals: typed payloads validated by Zod contracts

## Story Execution Rules
- Only modify files listed in "Allowed files/modules"
- Run automated checks before requesting review
- Never auto-execute proposals — all require human approval
- Use the shared billing engine for all financial calculations
- Use the async worker pattern (P0-009) for background jobs
- Use the webhook base (P0-014) for all external webhook handlers

## gstack
- Use the `/browse` skill from gstack for all web browsing
- Never use `mcp__claude-in-chrome__*` tools
- Available skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /design-shotgun, /design-html, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse, /connect-chrome, /qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /retro, /investigate, /document-release, /codex, /cso, /autoplan, /plan-devex-review, /devex-review, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade, /learn

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
