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

## Build Verification (mandatory)
Before marking any story complete or pushing code, run:
```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```
This uses the same tsconfig as the Railway deploy. Fix all errors before committing.
The default `tsconfig.json` includes test files and vitest types — it is NOT
sufficient to verify the production build. Always use `tsconfig.build.json`.
