# 00 — Repo Cartography (ServiceOS / "Rivet")

Date: 2026-07-18 · Branch: `claude/serviceos-discovery-planning-nzjmso` · HEAD: `a9d06aa`
Mode: read-only discovery. This map orients the six track investigations; every claim below was verified against the working tree unless marked otherwise.

## 1. What this repo actually is

**Product**: "Rivet" (README.md) — an AI back office for owner-operator home-service shops (HVAC/plumbing). Internal namespaces still use `serviceos`/`@serviceos`. It is **not** the stack the operator brief (§3) claims:

| Operator claim (§3) | Reality in repo |
|---|---|
| Next.js (App Router) | **No Next.js.** React 18 SPA, Vite, Tailwind v4, react-router 7 (`packages/web`) + Express API (`packages/api`). A Next.js prototype existed in `/experiments`, removed 2026-07 (docs/decisions.md D-016). |
| Supabase (Postgres + pgvector) | **Main app: raw Postgres on Railway** via `pg` Pool + PgBouncer (`deploy/pgbouncer`). Supabase appears only as a hosting option for the *training* pipeline (`serviceos_training/01_schema.sql`, `docs/supabase-host-setup.md`). |
| Vapi | Vapi integration exists (`packages/api/src/integrations/vapi/`) but the primary voice path is **Twilio** (Gather TwiML + Media Streams WebSocket) with **Deepgram** ASR (`packages/api/src/telephony/`, `src/voice/`). |
| ElevenLabs | Real: `packages/api/src/ai/tts/elevenlabs-stream.ts`, filler-audio cache. |
| Anthropic API | Present in the LLM gateway (`ai/gateway/model-pricing.ts`, `real-layer-two-factory.ts`); `openai` SDK is also a dependency. |
| "production `/goal` prompt suite" | **Not found.** No `/goal` directory, route, or prompt suite by that name anywhere in the repo. Prompts live inline in `ai/tasks/*` and `ai/agents/*`. |
| Chromatic/Storybook | **Not found** in package.json scripts/deps or CI workflows. Visual/e2e testing is Playwright (`e2e/`, `playwright.config.ts`). |

Deploy target: **Railway** — three services (`railway.toml` API, `railway.voice.toml`, `railway.worker.toml`) from one `Dockerfile`.

## 2. Monorepo layout

npm workspaces: `packages/api`, `packages/web`, `packages/shared`. Non-workspace packages: `packages/mobile` (Expo/React Native, calls same API), `packages/voice-eval` (eval harness, run via tsx).

Scale (find/wc, excludes node_modules): ~1,579 TS/TSX source files in packages/{api,web,shared}/src; ~1,145 test files under `packages/api/test`, 247 under `packages/web/src`, plus `e2e/` Playwright suites, `tests/chaos/`, `loadtest/`, `qa-runner/`.

```
packages/api/src        Express app. index.ts (graceful shutdown) → app.ts (wires ALL
                        routers, middleware, background intervals — "map of the system")
  routes/               ~70 route factories (jobs, estimates, invoices, telephony, voice, …)
  ai/                   gateway/ (tiered LLM router, breaker, failover, cache, tenant quota)
                        orchestration/ (intent-classifier, task-router, context-builder)
                        agents/customer-calling/ (channel-agnostic FSM: state-machine.ts)
                        agents/onboarding/  tasks/ (typed proposal-drafting tasks + prompts)
                        resolution/ (catalog-resolver = price grounding; entity resolver)
                        guardrails/ supervisor/ privacy/ vulnerability/ voice-quality/
                        tts/ (ElevenLabs stream)  voice-turn/  evaluation/  training/
  telephony/            Twilio adapter (Gather mode), media-streams/ (WS ↔ Deepgram),
                        voicemail fallback, whisper, recording, signature verification
  voice/                session state, triage, trial limits, glossary/terminology providers
  proposals/            proposal.ts, lifecycle.ts (5s undo), execution/ handlers, sms/ replies
  db/                   schema.ts (6,316 lines, 134 CREATE TABLE), migrate.ts,
                        rls-runtime-role.ts, tenant-transaction.ts, pool.ts (no per-change
                        migration files — schema is one canonical file; migrations dir empty)
  workers/              35 setInterval sweep workers in-process; PgQueue (SKIP LOCKED) +
                        pg advisory leader locks; PROCESS_ROLE=web|worker|all split
  billing/ payments/    Stripe; shared/billing-engine.ts = single totals-math source
  integrations/         twilio, sendgrid, vapi, accounting
  auth/ middleware/     Clerk RS256+JWKS (HMAC dev fallback); tenant-context middleware
                        opens one tx/request, SET LOCAL app.current_tenant_id (RLS boundary)
packages/web/src        React SPA: pages/ (~14 areas), components/ (~37 dirs), api/, hooks/
packages/shared/src     enums, contracts, billing engine types
packages/mobile         Expo owner app
packages/voice-eval     intent/slot eval harness (fixture + --live modes, --gate for CI)
```

## 3. Core architectural spines (from docs/architecture.md, verified 2026-07-11 against code)

1. **Request path**: Clerk auth → tenant-context middleware (per-request Postgres tx, `SET LOCAL app.current_tenant_id`, AsyncLocalStorage) → RLS-enforced DB (role verified non-superuser at boot) → DI'd route factories → `Pg*`/`InMemory*` repos.
2. **Voice path**: two entries sharing one FSM (`ai/agents/customer-calling/state-machine.ts`): Twilio Gather webhooks (default) and Media Streams WS → Deepgram realtime (per-tenant rollout, P8-012). FSM → intent classification (gateway) → entity resolution → typed Proposal.
3. **Proposal lifecycle**: draft (catalog-grounded prices) → approval via web/one-tap link/SMS reply → 5s undo window → per-type ExecutionHandler (only code allowed to mutate money/schedule from a proposal) → audit event. Auto-approve only for a narrow low-risk class (D-015).
4. **Money**: integer cents; `shared/billing-engine.ts` only.
5. **Workers**: no separate process by default; `registerInterval()` sweeps + PgQueue + advisory locks; `PROCESS_ROLE` allows web/worker split across Railway services.

## 4. AI/voice training & eval assets (claimed vs. found)

- `data/corpus/` — **3,617 labeled examples** per CORPUS_MANIFEST.md (1,820 en + 1,400 es utterances, 157 edge cases, 62 negatives, 178 slot fixtures). Operator claimed ~305 utterances / ~60 transcripts — repo has far more.
- `corpus/data/` — lay→technical vocabulary, triage rules.
- `serviceos_training/` — Python Reddit ingestion pipeline (schema.sql w/ pgvector, processor, PII scrub, embeddings) — the claimed "Reddit processor".
- `packages/api/src/ai/voice-quality/corpus/golden/` — ~40 golden conversation fixtures driving a live agent eval with cassettes (record/refresh modes, staleness reports).
- CI: 12 GitHub workflows incl. `voice-quality-nightly`, `voice-quality-pre-deploy`, `voice-eval-live`, `qa-matrix-gate`, `e2e`.
- `eval-results/` — dated eval outputs (2026-06-08/09).

## 5. Config / env surface

`.env.example`, `.env.production.example` (12.7 KB — large env surface), `.env.qa.example`; `packages/api/src/shared/config.ts` with `validateEnvSchema`. Ops docs: `docs/deployment.md`, `docs/runbooks/`, `docs/prod-env-checklist.md`, `docs/voice-production-readiness.md`.

## 6. Things I could not locate (for tracks to confirm or close)

- Any `/goal` prompt suite (§3 claim) — not found.
- Chromatic/Storybook config — not found.
- Per-change SQL migration files — `db/migrations/` is empty; how schema evolution is applied in prod needs Track 5 attention (`migrate.ts`, `docs/decisions.md`).
- An "agent-behavior model" as a trained artifact — `data/corpus/behaviors.yaml` (35 behaviors) may be what the claim refers to; Track 6 to verify.

## 7. Prior self-audits (context for tracks — do not trust blindly, but mine them)

`docs/audits/`, `docs/competitive-analysis.md`, `docs/competitive-gap-analysis.md`, `docs/competitive-review-rivet-vs-jobber-2026-07-02.md`, `docs/decisions.md` (founding decisions D-001…D-016+), `docs/solutions/` (categorized prior fixes), `projects/serviceos-audit/run-1` (point-in-time audit artifacts), `qa/reports/`.
