# Track C — code-side runtime truth (agent report, condensed verbatim)

Orchestrator meta-note: the agent's "prompt injection encountered" flag refers to the
orchestrator's own legitimate mid-run amendment of agent-brief.md (clarifying rung-6 probe
ownership) surfacing as a file-change reminder in its context. The agent correctly kept to its
original scope; recorded here as a run-log item, not a security incident.

## 1. Declared vs read
- `check:env-declared` DOES NOT EXIST; actual scripts: `check:env-coverage`(:strict) (`scripts/check-env-coverage.ts`).
- Ran `npm run check:env-coverage` → exit 0: "160 env vars read by packages/api/src; 77 declared in .env.production.example; 32 on the UNREVIEWED backlog … OK". Passes only because gaps are parked in `scripts/env-allowlist.json` (54 optional + 32 unreviewed).
- Independent union of 4 manifests (.env.example 59 ∪ .env.production.example 77 ∪ packages/api/.env.example 46 ∪ docs/prod-env-checklist.md 66 = 116 unique) vs 160 read → **67/160 undeclared in ANY manifest** (spot-checked: GOOGLE_MAPS_API_KEY, VAPI_API_KEY, QUICKBOOKS_CLIENT_ID, POSTHOG_API_KEY, TWILIO_MESSAGING_SERVICE_SID, ONE_TAP_APPROVE_SECRET). Seed said 61/115 → moved.
- Actually-SET per Railway service: UNKNOWN — no credential.

## 2. Config path violations
- Config module `shared/config.ts` `loadConfig()` (called `app.ts:813`); empty-string→undefined coercion at config.ts:180-184.
- **333 raw `process.env.` reads across 82 files** outside config (excl. tests); app.ts alone 163 (mixed with 46 `config.` uses).
- 20 distinct vars have a validated `config.X` but are read raw anyway, incl. STRIPE_SECRET_KEY/WEBHOOK_SECRET (~16 raw reads: app.ts:1077,1090,1148,1159,3006,3087,3128,3176,5754), `CLERK_SECRET_KEY` passed with NO guard at app.ts:5047, `TENANT_ENCRYPTION_KEY` raw at webhooks/integration-resolver.ts:36.

## 3. Danger flags
| Flag | Reality |
|---|---|
| DEV_AUTH_BYPASS | prod refusal exists (`config.ts:621-627`) but `validateEnvSchema` is NEVER called from boot (only from tests) — dead code. Runtime backstop: requires NODE_ENV=dev (`dev-auth-bypass.ts:114-118`) |
| CLERK_DEV_HMAC_TOKENS | same dead boot assertion; runtime backstop NODE_ENV!==production (`clerk.ts:387-391`) |
| ALLOW_CLERK_TEST_KEYS | prefix check (`config.ts:565-590`) called ONLY from dead `validateEnvSchema` — **no runtime backstop anywhere**; most exposed |
| ALLOW_MISSING_CRITICAL_CONSTRAINTS | `db/migrate.ts:127-134` skips double-booking constraint postcondition; no boot assertion it's unset; deliberate operator hatch |
| AUTO_DEPROVISION_ON_CANCEL | `webhooks/routes.ts:1981`; destructive, default-safe, no assertion |
| VOICE_QUALITY_*CASSETTE* | test-harness only, unreachable from app.ts — not a prod risk |

## 4. PROCESS_ROLE topology
- `config.ts:84` enum web|worker|voice|all default 'all'; `shouldRunWorkers` allowlist gate app.ts:2315-2316; 25 worker-gated call sites (SLO monitor 2460, execution sweep 2591, queue poll 2932, digest, dunning, review-request, thank-you, QBO sync, etc.). Media-streams excluded on worker (app.ts:3910,4123).
- railway{,.worker,.voice}.toml: [build]/[deploy] only — CONFIRMED not a declaration site.

## 5. Sentry
- `instrument()` call sites in src: exactly 3 (mediastream server :188, execution-worker :109, voice-action-router :1883). app.ts:745 claims four.
- **Stripe webhook handler (`webhooks/routes.ts:962`) has ZERO instrument()** — the P1 alert referencing it (docs/runbooks/alerting.md:68) can never fire from an uncaught exception. Seed CONFIRMED.

## 6. FORCE RLS
- Ran `test/db/schema.test.ts` → 17/17 green (every tenant_id table FORCEs RLS; exemption allowlist pinned to oauth_states + platform_deprovision_log, documented, migration 218).
- Seed's "one table missing FORCE RLS": **does not hold today** — migration 130_force_rls_missing_tables closed it; reality ahead of seed.
- Adjacent: FORCE RLS only bites under `rls_app_runtime` role — `RLS_RUNTIME_ROLE=true` IS boot-required in prod/staging (`config.ts:399-411` via validateFeatureRequiredConfig, which IS called) + `verifyRlsRuntimeRole` probe (app.ts:935). Strongest boot assertion found.

## 7. VAPI_* / WISETACK_*
- VAPI: client off-by-default (`integrations/vapi/client.ts:96,112` raw env reads, null without key); reachable from provisioning worker (:369) + onboarding route (:1017); always-mounted webhook `POST /webhooks/vapi/:tenantId` (`webhooks/routes.ts:2578-2632`, per-tenant HMAC). Undeclared in all manifests. Wired, uncredentialed.
- **D-014 code-truth answer: Twilio Media Streams is canonical** — `POST /api/telephony/voice` (`routes/telephony.ts:337`) always mounted, drives `attachMediaStreamServer` (app.ts:4373); VAPI is parallel/optional, never gates the Twilio path. Live-traffic confirmation (where Twilio numbers' webhooks point) requires dashboard access — unavailable.
- WISETACK: provider factory unconditional (app.ts:1191, no-op ManualFinancingProvider without key); routes mounted unconditionally `/api/financing` (app.ts:4723-4736); webhook secret boot-required if enabled (config.ts:387-392). Raw env reads (financing-provider.ts:159-160) = C8.2b violation. PRD-v3 non-goal, PRD-v4 silent → Part F item.

## 8. Third-party liveness (code column only; runtime = UNKNOWN — no credential unless noted)
| Dependency | Code-side | web | worker | voice |
|---|---|---|---|---|
| Twilio voice | boot-required unless TELEPHONY_ENABLED=false; webhook routes/telephony.ts:337 | UNKNOWN | N/A | UNKNOWN |
| Twilio SMS | TwilioDeliveryProvider; STOP/DNC code + tenant_dnc_list | UNKNOWN | N/A | N/A |
| Voice stack STT→gw→TTS | wired unconditionally when mediaStreamsEnabled && role!==worker | UNKNOWN | N/A | UNKNOWN |
| LLM gateway + ai_runs | AI_PROVIDER_API_KEY boot-required prod; PgAiRunRepository injected whenever pool (app.ts:1442,1458) | UNKNOWN | UNKNOWN | UNKNOWN |
| Stripe platform | keys boot-required (SEC-43); sig verification webhooks/routes.ts:988; NOT instrumented; no live/test prefix check for Stripe | see orchestrator probes: livemode webhooks exist → partially LIVE | N/A | N/A |
| Stripe Connect | constructed when pool && STRIPE_SECRET_KEY (app.ts:1087-1092) | orchestrator probe: 0 connected accounts → NOT-ONBOARDED | N/A | N/A |
| Clerk | keys boot-required; dev paths NODE_ENV-gated; test-key check dead | UNKNOWN | UNKNOWN | UNKNOWN |
| Sentry | initSentry app.ts:747 no-op if unset; 3/4 paths | UNKNOWN | UNKNOWN | UNKNOWN |
| QuickBooks | OAuth creds undeclared in every manifest | not-configured | not-configured | N/A |
| SendGrid | required unless EMAIL_ENABLED=false; Twilio-email alt per docs | UNKNOWN | N/A | N/A |
| PostHog | POSTHOG_API_KEY undeclared; no-op wrapper app.ts:1096-1100 | orchestrator probe: server events LIVE through 2026-07-28 | same | N/A |
| Storage R2 | required unless STORAGE_ENABLED=false; R2_BUCKET/PUBLIC_URL undeclared in prod manifest | UNKNOWN | UNKNOWN | UNKNOWN |
| Push/EAS | EXPO_ACCESS_TOKEN undeclared; provider constructed unconditionally app.ts:5339 | not-configured/UNKNOWN | N/A | N/A |

## Judgment calls (agent, condensed)
- Union-of-4-manifests used for "declared" (why 67/160 ≠ script's 0-hard-fail ≠ seed's 61/115); discrepancy reported, not reconciled.
- oauth_states/platform_deprovision_log = documented exemptions, not the seed's gap.
- D-014 answered from code structure, explicitly caveated as not live-traffic proof.
