# fix: Traffic, authz & config hygiene (T4-F02, T4-F05, T4-F04, T4-F06)

**Created:** 2026-07-18
**Depth:** Standard
**Status:** plan

## Summary
Closes four related hygiene gaps surfaced by the backend/API discovery audit
(`discovery/04-backend-apis-integrations.md`, findings T4-F02, T4-F05,
T4-F04, T4-F06): a per-IP rate limiter that starves legitimate shared-NAT
traffic while sitting in front of webhook signature verification, a
scheduling-proposal creation route with no permission check and no payload
schema validation, and two encryption-key env vars that are silently
optional in production despite being load-bearing for tenant credential and
transcript-at-rest encryption. All four are traffic/authz/config surface
fixes — no business logic, pricing, or money paths are touched.

## Problem Frame
- **T4-F02 (rate limits):** `packages/api/src/app.ts:839-848` caps `/api` at
  100 req/15min per IP in prod (≈0.11 req/s) — an office behind a shared NAT
  can exhaust this with normal multi-user traffic, and the per-tenant limiter
  (`app.ts:4365-4384`, env-configurable via `API_TENANT_RATE_LIMIT_MAX`,
  default 1000/min) is the intended fairness control, not the per-IP one.
  Separately, `app.ts:849-853` caps `/webhooks` at a flat 30/min with no
  per-provider carve-out, and this limiter is mounted (`:849`) AFTER the six
  provider raw-body parsers (`:760-790`) but BEFORE the signature-verifying
  webhook router (`:1114`) — so a burst of legitimate provider callbacks can
  429 before signature verification ever runs, and there is no dedicated
  headroom for real provider volume vs. unknown/junk `/webhooks/*` paths.
- **T4-F05 / T4-F04 (proposal authz + validation):** `POST /` in
  `packages/api/src/routes/proposals.ts:97-153` is reachable by any
  authenticated tenant member (`requireAuth` + `requireTenant` only) — every
  sibling mutating proposal route (`approve`, `reject`, `edit`, `undo`) is
  gated by `requirePermission`, but this one is not, so a `technician` role
  can create scheduling proposals despite `rbac.ts` intentionally scoping
  technicians to `proposals:view` only (`rbac.ts:181-202`). The route also
  passes `body.payload` straight through to `createSchedulingProposal`
  (`src/proposals/create-scheduling.ts:43`) with no Zod validation, even
  though per-type schemas already exist and are enforced everywhere else
  proposals are AI-emitted (`PROPOSAL_TYPE_SCHEMAS` +
  `assertValidProposalPayload`, `src/proposals/contracts.ts:610-724`).
- **T4-F06 (config hygiene):** `TENANT_ENCRYPTION_KEY` and
  `TRANSCRIPT_ENCRYPTION_KEY` are consumed by five call sites
  (`integrations/credentials.ts:111`, `calendar-integration.ts:98`,
  `accounting/token-crypto.ts:4`, `workers/provision-twilio.ts:115`,
  `transcription.ts:311`) but are validated ONLY at first use, deep inside
  `src/integrations/crypto.ts:6-9` (throws `TENANT_ENCRYPTION_KEY must be a
  64-char hex string`), and are not declared in either
  `validateProductionConfig` or `validateFeatureRequiredConfig`
  (`shared/config.ts:188-392`). A misconfigured or missing key surfaces as a
  runtime crash on first credential decrypt/encrypt in production instead of
  a boot-time failure, and `.env.production.example` documents both keys only
  as commented-out TIER 3 examples (`:163-166`), not as an enforced
  requirement.

## Requirements
- R1. `/api` per-IP limit is env-configurable and raised to a DoS-guard
  ceiling rather than a fairness ceiling; per-tenant limiter remains the
  fairness control.
- R2. Provider webhook callbacks (`/webhooks/stripe|clerk|vapi|twilio|
  wisetack|sendgrid`) get materially higher throughput than unknown
  `/webhooks/*` paths, and are never 429'd ahead of signature verification
  at realistic callback volume.
- R3. `POST /api/proposals/` (scheduling-proposal creation) is denied to
  roles without a new `proposals:create` permission (owner + dispatcher
  only; technician excluded).
- R4. `POST /api/proposals/` payloads are Zod-validated per proposal type
  before reaching `createSchedulingProposal`, returning 400 on
  malformation instead of passing untyped data downstream.
- R5. `TENANT_ENCRYPTION_KEY` (and, if set, `TRANSCRIPT_ENCRYPTION_KEY`) is
  validated at boot in prod/staging — presence and 64-char-hex format — so
  a bad key fails fast instead of crashing on first decrypt.
- R6. `.env.production.example` reflects the new required/env-configurable
  knobs accurately (TIER 0 for the new rate-limit knobs, TIER 3 promoted to
  required for `TENANT_ENCRYPTION_KEY`).
- R7. All new/changed behavior has enumerated automated test coverage and
  passes `tsc --project tsconfig.build.json --noEmit` + lint before PR.

## Key Technical Decisions
- **Per-IP limiter becomes a DoS guard, not a fairness control** — raise
  default prod max from 100→2000 per 15min, expose as
  `API_IP_RATE_LIMIT_MAX` env var, keep dev at 10000 unchanged. Rationale:
  the audit finding (T4-F02) is that 100/15min ≈ 0.11 req/s starves a
  shared-NAT office; the per-tenant limiter (`API_TENANT_RATE_LIMIT_MAX`,
  already env-configurable) is the actual fairness/abuse control per the
  existing comment at `app.ts:4365-4384`. Alternative considered: raise the
  per-IP window instead of the max — rejected, changing the window shifts
  burst semantics unpredictably; changing the max is a single, well-understood
  knob.
- **Dedicated provider-webhook limiter mounted before the general one** —
  add a limiter matched to the six signature-verified provider prefixes with
  env `WEBHOOK_PROVIDER_RATE_LIMIT_MAX` (default 600/min), mounted before
  the existing `/webhooks` limiter; make the general `/webhooks` limiter
  skip those six prefixes so it only governs unknown/junk paths at the
  existing 30/min. Rationale: signature verification (mounted later, at
  `app.ts:1114`) is the real authenticity control; the rate limiter's job
  here is just to bound abuse without starving legitimate provider traffic.
  Alternative considered: raise the single general `/webhooks` limit for
  everyone — rejected, that would also loosen the limit for arbitrary
  unauthenticated junk paths under `/webhooks/*`.
- **New `proposals:create` permission, not reuse of `proposals:edit`** —
  keeps the permission model aligned with the sibling routes' one-verb-per-
  action convention (`approve`, `edit`, `view`) already in `rbac.ts:27-30`,
  and lets a future role matrix grant create without edit (or vice versa)
  without a breaking change. Alternative considered: gate on
  `proposals:edit` (already granted to owner+dispatcher, same practical
  effect today) — rejected, conflates two different actions and would be
  wrong the moment a role needs one but not the other.
  Requires a role-docs update if a permission reference table exists.
- **Validate via the existing `assertValidProposalPayload`, not a new
  scheduling-only schema** — the four supported types
  (`reschedule_appointment`, `reassign_appointment`, `add_crew_member`,
  `remove_crew_member`) already have Zod schemas in `PROPOSAL_TYPE_SCHEMAS`
  (`contracts.ts:610-724`); calling the existing assert function reuses the
  established AI-safety gate pattern (P2-002) instead of duplicating
  validation logic for a fourth time in this route.
- **Config validation added to `validateFeatureRequiredConfig`, not a third
  validator** — both existing validators (`validateProductionConfig`,
  `validateFeatureRequiredConfig`) already follow a "collect `missing[]`,
  throw one aggregated Error" pattern; `TENANT_ENCRYPTION_KEY` is feature-
  adjacent (credential/transcript encryption, not universally required like
  DB/Clerk), so it fits the feature-required validator's existing shape
  best. Reconciling the two validators into one is explicitly deferred (see
  Scope Boundaries) — out of scope for this fix.
- **Format check via regex `/^[0-9a-f]{64}$/i`, not by calling into
  `crypto.ts`** — keeps `shared/config.ts` dependency-free of
  `integrations/crypto.ts` (config validation runs at boot before most
  modules are wired) while enforcing the exact same 64-hex-char/32-byte
  contract `parseKey` already enforces at first use. Alternative considered:
  import and call `parseKey` directly for validation — rejected to avoid a
  config→integrations import direction that doesn't otherwise exist.

## Scope Boundaries
**In scope:** `/api` and `/webhooks` rate-limit configurability and
provider-webhook carve-out; `proposals:create` permission + its enforcement
and payload validation on `POST /api/proposals/`; boot-time validation of
`TENANT_ENCRYPTION_KEY`/`TRANSCRIPT_ENCRYPTION_KEY` format in prod/staging;
`.env.production.example` updates reflecting the above; tests for all of the
above; a draft PR off `origin/main`.

**Non-goals:**
- Redis rate-limit store internals (`rate-limit-store.ts`) — unchanged.
- Adding Sentry/observability for rate-limit tuning — separate workstream.
- Changing the per-tenant rate limiter's default or mechanism
  (`API_TENANT_RATE_LIMIT_MAX`) — already env-configurable, left as-is.
- Reconciling `validateProductionConfig` and `validateFeatureRequiredConfig`
  into a single validator.
- Changing `settings/voice-approval-pin.ts`'s HMAC key expectation (accepts
  any non-empty string today, diverging from the 64-hex-char contract) —
  documented as a known divergence, not changed here.
- Any change to `/public` rate limiting (unrelated to the four findings).

### Deferred to follow-up work
- Dual config-validator reconciliation (`validateProductionConfig` +
  `validateFeatureRequiredConfig` → one path).
- `voice-approval-pin.ts` HMAC key format alignment with the 64-hex
  contract used elsewhere.
- Sentry/alerting on rate-limit 429 rates to detect real abuse vs.
  legitimate traffic growth post-tuning.

## Repository invariants touched
- **Audit events** — no change; proposal creation already emits audit
  events via existing `createSchedulingProposal`/`ProposalRepository` paths,
  untouched by this fix.
- **Human-approval gate** — untouched; this fix only tightens who may
  *create* a scheduling proposal and validates its shape, it does not change
  approval/execution semantics (proposals remain human-approved, D-004).
- **Zod-validated proposals** — this fix is the primary invariant advanced:
  closes a gap where one proposal-creation path bypassed per-type Zod
  validation that every other proposal-emitting path already enforces.
- **RLS / tenant_id** — untouched; `requireTenant` already scopes the route,
  no query shape changes.
- **Money (integer cents)** — not touched; none of the four findings involve
  a money path.
- **LLM gateway / catalog resolver / entity resolver** — not touched; the
  four supported scheduling-proposal types in scope here are
  operator-initiated (not AI-drafted line items or free-text entity
  references).

## Implementation Units

### U1. Rate limit configurability + provider webhook carve-out
- **Goal:** Make `/api` per-IP limiter env-configurable with a DoS-guard
  default; add a dedicated, higher-throughput limiter for the six
  signature-verified provider webhook prefixes, mounted before the general
  `/webhooks` limiter, with the general limiter skipping those prefixes.
- **Requirements:** R1, R2, R7
- **Dependencies:** none
- **Files:**
  - `packages/api/src/app.ts` (modify `:839-860` region)
  - `packages/api/test/app-rate-limits.test.ts` (new)
- **Approach:** Read `API_IP_RATE_LIMIT_MAX` (default `2000` in prod,
  unchanged `10000` in dev) into the existing `/api` `rateLimit({...})` call
  at `app.ts:839-848`, replacing the hardcoded `isDev ? 10000 : 100`. Add a
  new `rateLimit({...})` mounted on an array/regex path matcher for
  `/webhooks/stripe`, `/webhooks/clerk`, `/webhooks/vapi`,
  `/webhooks/twilio`, `/webhooks/wisetack`, `/webhooks/sendgrid` BEFORE the
  existing `app.use('/webhooks', rateLimit(...))` at `:849-853`, using env
  `WEBHOOK_PROVIDER_RATE_LIMIT_MAX` (default `600` per minute) and its own
  Redis store keyspace (e.g. `'webhooks-provider:'`, following the existing
  `createRateLimitStore(redisUrl, 'webhooks:')` pattern at `:852`). Give the
  existing general `/webhooks` limiter a `skip` predicate that returns true
  when `req.path` starts with one of the six provider prefixes (so it only
  ever governs unmatched/junk `/webhooks/*` paths), leaving its 30/min
  default untouched. Read both new env vars once near the existing
  `redisUrl`/`isDev` reads (`:837-838`) so parsing stays colocated.
- **Patterns to follow:** Existing `rateLimit({...})` + `createRateLimitStore`
  calls at `app.ts:839-860`; existing env-var-with-default pattern used for
  `API_TENANT_RATE_LIMIT_MAX` at `app.ts:4365-4384`.
- **Test scenarios** (`packages/api/test/app-rate-limits.test.ts`, supertest
  against the built app with small env overrides so limits trip inside a
  test run):
  - Happy path: with `API_IP_RATE_LIMIT_MAX=5`, the 6th `/api/*` request
    from one IP within the window returns 429; requests 1-5 return their
    normal (non-429) status.
  - Happy path: with `WEBHOOK_PROVIDER_RATE_LIMIT_MAX=5`, 5 requests to a
    provider prefix (e.g. `/webhooks/stripe`) in the window all pass the
    rate-limit layer (do not 429), while a 6th does.
  - Edge case: an unknown path under `/webhooks/` (e.g. `/webhooks/unknown`)
    still 429s at the pre-existing general limit (31st request in a
    default-max-30 window) — confirms the `skip` predicate only exempts the
    six named prefixes.
  - Default-preserving: with no env override, dev `NODE_ENV` still yields
    the 10000 ceiling (existing behavior unchanged).
- **Verification:** Provider webhook paths tolerate materially more than 30
  req/min while unknown `/webhooks/*` paths still 429 at the pre-existing
  threshold; `/api` per-IP ceiling is controlled by `API_IP_RATE_LIMIT_MAX`
  and defaults to 2000/15min in prod.

### U2. `proposals:create` permission + enforcement
- **Goal:** Add a `proposals:create` permission to the RBAC model, grant it
  to `owner` and `dispatcher` only, and enforce it on
  `POST /api/proposals/`.
- **Requirements:** R3, R7
- **Dependencies:** none (independent of U1, U3)
- **Files:**
  - `packages/api/src/auth/rbac.ts` (modify `Permission` union `:3-72` and
    `ROLE_PERMISSIONS` for `owner`/`dispatcher` `:74-180`)
  - `packages/api/src/routes/proposals.ts` (modify `:97-101`, add
    `requirePermission('proposals:create')` to the middleware chain)
  - `packages/api/test/routes/proposals.route.test.ts` (extend)
  - Any RBAC/permission reference doc under `docs/` that enumerates
    permissions by role, if one exists (grep before editing; update only if
    found — do not create one).
- **Approach:** Add `'proposals:create'` to the `Permission` union (next to
  the existing `proposals:approve` / `proposals:edit` / `proposals:view`
  entries) and to `ROLE_PERMISSIONS.owner` and `ROLE_PERMISSIONS.dispatcher`
  arrays (not `technician`, consistent with the existing comment at
  `rbac.ts:192-196` that technicians are deliberately excluded from
  office/dispatch-adjacent surfaces). In `proposals.ts`, insert
  `requirePermission('proposals:create')` into the middleware chain for the
  `POST /` route (currently `requireAuth, requireTenant,` at `:99-100`),
  mirroring the exact pattern used by the sibling `GET /` route at
  `:157-159`.
- **Patterns to follow:** `GET /` route's `requirePermission('proposals:
  view')` usage (`proposals.ts:157-159`); `requirePermission` 403
  `FORBIDDEN` behavior (`middleware/auth.ts:300,319-326`).
- **Test scenarios** (`packages/api/test/routes/proposals.route.test.ts`,
  extending the existing `describe` blocks using the `buildAppWithRole`
  helper at `:31`):
  - Error path: `technician` role → `POST /api/proposals/` with a valid
    `reschedule_appointment` body → 403 `FORBIDDEN` (mirrors the existing
    `GET /api/proposals` 403 test pattern at `:98-104`, but here also
    asserting the proposal was NOT created).
  - Happy path: `dispatcher` role → `POST /` with valid
    `reassign_appointment` payload and a valid `If-Match`/appointment
    version → 200 with the created proposal (existing `created` branch,
    `:137`).
  - Happy path: `owner` role → same as above → 200.
- **Verification:** A technician-role request to `POST /api/proposals/` is
  rejected with 403 before reaching `createSchedulingProposal`; owner and
  dispatcher requests are unaffected.

### U3. Payload Zod validation on scheduling-proposal creation
- **Goal:** Validate `body.payload` against the matching per-type Zod
  schema before calling `createSchedulingProposal`, returning 400 on
  failure.
- **Requirements:** R4, R7
- **Dependencies:** U2 (same route/middleware chain; land together or U2
  first to avoid churn in the same test block)
- **Files:**
  - `packages/api/src/routes/proposals.ts` (modify the handler body inside
    `:101-134`)
  - `packages/api/test/routes/proposals.route.test.ts` (extend)
- **Approach:** After the existing `SUPPORTED_TYPES` whitelist check
  (`:110-113`) and before calling `createSchedulingProposal` (`:124`), call
  `assertValidProposalPayload(body.proposalType, body.payload)` (imported
  from `../proposals/contracts`) inside a try/catch (or check its thrown
  `ValidationError` type), mapping a caught `ValidationError` to
  `res.status(400).json({ error: 'VALIDATION_ERROR', message: err.message })`
  — following the existing `ValidationError` → 400 mapping convention used
  elsewhere in the codebase (grep `ValidationError` usage in other routes
  for the exact shape/import path before implementing). Leave the existing
  `UNSUPPORTED_PROPOSAL_TYPE` 400 branch (`:110-113`) and all
  `createSchedulingProposal` result-kind branches (`:136-151`) unchanged.
- **Patterns to follow:** `assertValidProposalPayload` /
  `PROPOSAL_TYPE_SCHEMAS` (`proposals/contracts.ts:610-724`); existing
  `toErrorResponse` / `ValidationError` handling pattern already imported in
  this file (`proposals.ts:6`) — confirm exact usage before wiring the
  catch branch.
- **Test scenarios** (`packages/api/test/routes/proposals.route.test.ts`):
  - Error path: `dispatcher` role → `POST /` with `proposalType:
    'reassign_appointment'` and a payload missing the required
    `toTechnicianId` field → 400 `VALIDATION_ERROR` naming the missing
    field; proposal not created.
  - Happy path (regression): `dispatcher` role → well-formed
    `reschedule_appointment` payload → 200 (unchanged from pre-fix
    behavior, now additionally passing through the new validation step).
  - Error path (existing, preserved): unsupported `proposalType` (e.g.
    `'draft_estimate'`) → 400 `UNSUPPORTED_PROPOSAL_TYPE` (existing
    behavior at `:110-113`, unchanged — assert it still holds after the new
    validation step is added later in the handler).
- **Verification:** A malformed payload for a supported proposal type is
  rejected with 400 before any proposal is persisted; well-formed payloads
  are unaffected.

### U4. Boot-time validation for encryption-key config
- **Goal:** Require `TENANT_ENCRYPTION_KEY` (format-checked) in prod/staging
  boot config, and format-check `TRANSCRIPT_ENCRYPTION_KEY` when set; update
  `.env.production.example` to match.
- **Requirements:** R5, R6, R7
- **Dependencies:** none (independent of U1-U3)
- **Files:**
  - `packages/api/src/shared/config.ts` (modify
    `validateFeatureRequiredConfig`, `:248-392`)
  - `packages/api/test/shared/config.test.ts` (extend)
  - `.env.production.example` (modify TIER 0 section for the two new
    rate-limit knobs from U1; modify TIER 3 section `:163-166` to promote
    `TENANT_ENCRYPTION_KEY` from commented-out example to a required,
    uncommented entry with inline rationale; keep
    `TRANSCRIPT_ENCRYPTION_KEY` commented/optional but document its format
    requirement and fallback in the adjacent comment)
- **Approach:** Add a block to `validateFeatureRequiredConfig` (after the
  existing RLS/Redis checks, `:341-384`, following the same
  `missing.push(...)` accumulation style) that: (1) in prod/staging, checks
  `env.TENANT_ENCRYPTION_KEY` is present and matches `/^[0-9a-f]{64}$/i`,
  pushing a message naming the exact format requirement (64-char hex) if
  either check fails; (2) if `env.TRANSCRIPT_ENCRYPTION_KEY` is set
  (non-empty), validates it against the same regex, independent of whether
  `TENANT_ENCRYPTION_KEY` validation passed — do NOT require
  `TRANSCRIPT_ENCRYPTION_KEY` to be set (fallback to `TENANT_ENCRYPTION_KEY`
  per `app.ts:1685-1686` is intentional and preserved). Use a local regex
  constant rather than importing `integrations/crypto.ts` (keeps the config
  module's dependency direction unchanged — see Key Technical Decisions).
  Update `.env.production.example`: add `API_IP_RATE_LIMIT_MAX` and
  `WEBHOOK_PROVIDER_RATE_LIMIT_MAX` next to `API_TENANT_RATE_LIMIT_MAX` in
  the TIER 0 section (`:61-64`) with a one-line rationale each; uncomment
  and require `TENANT_ENCRYPTION_KEY=` in TIER 3 (`:163-166`) with a comment
  explaining the 64-hex-char format and what breaks without it (credential/
  calendar-token/accounting-token decrypt failures); keep
  `TRANSCRIPT_ENCRYPTION_KEY=` commented with its existing fallback note,
  amended to mention the format is validated when set.
- **Patterns to follow:** Existing `missing.push(...)` blocks in
  `validateFeatureRequiredConfig` (e.g. the RLS block `:341-358`, the Redis
  block `:360-384`) for message style and aggregation; `test/shared/
  config.test.ts` pattern of `expect(() => loadConfig({...})).toThrow(/VAR_NAME/)`
  with `RLS_RUNTIME_ROLE: 'true'` set in the base fixture (seen throughout
  the file, e.g. `:45,154,184,223`).
- **Test scenarios** (`packages/api/test/shared/config.test.ts`):
  - Error path: `loadConfig({ NODE_ENV: 'prod', RLS_RUNTIME_ROLE: 'true',
    ...other-required-fields, /* TENANT_ENCRYPTION_KEY omitted */ })` →
    throws matching `/TENANT_ENCRYPTION_KEY/`.
  - Error path: same base config with `TENANT_ENCRYPTION_KEY: 'x'.repeat(63)`
    (wrong length) → throws matching `/TENANT_ENCRYPTION_KEY/`.
  - Error path: `TENANT_ENCRYPTION_KEY: 'z'.repeat(64)` (right length,
    non-hex chars) → throws matching `/TENANT_ENCRYPTION_KEY/`.
  - Happy path: `TENANT_ENCRYPTION_KEY: 'a'.repeat(64)` with all other
    required prod fields set → does not throw.
  - Edge case: `TRANSCRIPT_ENCRYPTION_KEY` unset, `TENANT_ENCRYPTION_KEY`
    valid → does not throw (fallback path preserved, transcript key stays
    optional).
  - Error path: `TRANSCRIPT_ENCRYPTION_KEY: 'short'` set alongside a valid
    `TENANT_ENCRYPTION_KEY` → throws matching `/TRANSCRIPT_ENCRYPTION_KEY/`
    (format-checked when present, even though optional).
  - Non-goal check: `NODE_ENV: 'dev'` with no encryption keys set → does not
    throw (dev boot unaffected, matching the existing dev-mode carve-outs
    elsewhere in this validator).
- **Verification:** Booting with `NODE_ENV=prod`/`staging` and a missing or
  malformed `TENANT_ENCRYPTION_KEY` fails at config load with a message
  naming the variable and required format, before any request-handling code
  runs; a valid 64-hex key boots cleanly and `TRANSCRIPT_ENCRYPTION_KEY`
  remains optional but is format-checked when present.

### U5. Branch, quality gates, draft PR
- **Goal:** Land U1-U4 on a dedicated branch with green quality gates and a
  draft PR ready for review.
- **Requirements:** R7
- **Dependencies:** U1, U2, U3, U4
- **Files:** none (process unit)
- **Approach:** Create branch `claude/fix-traffic-authz-hygiene` off
  `origin/main`. Run the vitest suites touched by U1-U4
  (`app-rate-limits.test.ts`, `proposals.route.test.ts`, `config.test.ts`,
  plus the existing `rate-limit-store.test.ts` for regression), then
  `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
  (mandatory per repo build-verification rule — this is the same tsconfig
  as the Railway deploy and is NOT satisfied by the default `tsconfig.json`),
  then `npm run lint` in `packages/api`. Open a draft PR summarizing the
  four findings closed and linking `discovery/04-backend-apis-integrations.md`.
- **Test scenarios:** `Test expectation: none — process/sequencing unit, no
  new logic of its own.`
- **Verification:** All four targeted vitest files pass, `tsc --project
  tsconfig.build.json --noEmit` reports zero errors, lint is clean, and a
  draft PR exists referencing T4-F02/T4-F05/T4-F04/T4-F06.

## Risks & Dependencies
- **Rate-limit tuning could mask real abuse.** Raising the per-IP ceiling
  and adding provider-specific headroom widens the window before a 429
  signals trouble. Mitigation: both new ceilings are env-configurable
  (`API_IP_RATE_LIMIT_MAX`, `WEBHOOK_PROVIDER_RATE_LIMIT_MAX`) so they can be
  tightened without a code change if abuse patterns emerge; the per-tenant
  limiter (unchanged) remains the primary fairness/abuse control; Sentry/
  monitoring on 429 rates is explicitly deferred (see Scope Boundaries) as
  the natural follow-up to detect drift.
- **New permission requires role-docs consistency.** If a permission
  reference table exists outside `rbac.ts` (grep `docs/` before
  implementing U2), it must be updated in the same commit or the docs will
  understate what dispatcher/owner can do.
- **U2 and U3 touch the same handler.** Sequencing U2 before U3 (or landing
  together) avoids two passes over the same middleware chain and test
  block; both are independent of U1 and U4 and could be parallelized with
  those.
- **Webhook prefix matching must stay in sync with the six provider raw-body
  parsers** (`app.ts:760-790`). If a seventh provider is added later without
  updating the new provider-webhook limiter's prefix list, it silently falls
  back to the general 30/min `/webhooks` limiter rather than erroring —
  acceptable (fails safe, not open) but worth a comment cross-referencing
  the raw-body-parser block so the two lists don't drift unnoticed.
