# Architecture (new-developer orientation)

One page, dense, verified against code as of 2026-07-11. For the repo
layout see the [README repository map](../README.md#repository-map); for
the founding-decisions log see [`docs/decisions.md`](decisions.md).

## Request path (authenticated `/api` routes)

1. **Clerk auth** — `packages/api/src/auth/clerk.ts`. `verifyClerkSession`
   tries RS256+JWKS verification first (real Clerk session tokens); falls
   back to legacy HMAC only when `isHmacDevModeEnabled()` (dev/test). On
   success it sets `req.auth = { userId, sessionId, tenantId, role }`.
   Frontend tokens come from the Clerk JWT template named `serviceos`
   (claims `tenant_id` + `role` from `user.public_metadata`). Setup for
   both environments: [`docs/runbooks/clerk-setup.md`](runbooks/clerk-setup.md).
2. **Tenant-context middleware** — `middleware/tenant-context.ts`. Opens
   one Postgres transaction per request, runs `SET LOCAL app.current_tenant_id`
   (never a plain `SET` — that would leak across a pooled connection to
   the next request), and threads the transaction's `PoolClient` through
   an `AsyncLocalStorage` (`tenantContextStore`). Commits on `res.finish`
   when status `< 400`, otherwise rolls back so partial writes from a
   failed request never persist. **Public routes** (health, `/e/:viewToken`,
   `/pay/:viewToken`) must not be mounted behind this middleware — they
   have no tenant.
3. **RLS GUC** — `db/rls-runtime-role.ts` (`applyTenantContext`). The
   `SET LOCAL` value is what every table's row-level-security policy
   checks; the DB — not application code — is the tenant-isolation
   boundary. `verifyRlsRuntimeRole()` in `app.ts` boot enforces the DB
   role is RLS-restricted in prod/staging (no superuser bypass).
4. **Routes → repos** — route factories in `routes/*.ts` (e.g.
   `routes/jobs.ts`, `routes/estimates.ts`) are dependency-injected with
   repository interfaces (`JobRepository`, `EstimateRepository`, ...) with
   `Pg*` (real) and `InMemory*` (test) implementations. Repos call
   `PgBaseRepository.withTenant()`, which reads `tenantContextStore` and
   reuses the request's transaction client if present, falling back to a
   pooled connection for background workers/public routes.

**Start reading:** `packages/api/src/app.ts` wires every router,
middleware, and background worker; it is the map of the whole system.

## Voice path (Twilio)

Two entry points, sharing one channel-agnostic FSM
(`ai/agents/customer-calling/state-machine.ts`):

- **Gather mode** (default) — `routes/telephony.ts` mounts
  `POST /api/telephony/voice` (inbound call) and
  `POST /api/telephony/gather` (each `<Gather speech>` result).
  `telephony/twilio-adapter.ts` (`TwilioGatherAdapter`) is the Twilio
  `<Gather>` adapter: each webhook is a single FSM "tick" — pull session,
  run the FSM, translate `SideEffect[]` into a TwiML response.
- **Media Streams mode** (`P8-012`, per-tenant rollout) —
  `telephony/media-streams/` bridges a Twilio `<Connect><Stream>`
  WebSocket to Deepgram realtime transcription; on a final transcript it
  runs a "speech turn" against the same FSM. `mediastream-adapter.ts`
  stays free of FSM/skill knowledge — it only translates.
- **FSM → intent → proposal**: the FSM dispatches transcript turns
  through intent classification (`ai/gateway` `classify_intent` /
  `intent_classification` task types, see Money rules below for how
  tiers are chosen), resolves free-text entities via the **entity
  resolver** (`ai/resolution/`) — ambiguity becomes a one-tap
  `voice_clarification`, never a silent guess — and
  `ai/agents/customer-calling/inapp-adapter.ts` turns the resolved
  intent into a typed `Proposal`.

## Proposal lifecycle

`proposals/proposal.ts` (shape/types) + `proposals/lifecycle.ts` (status
machine) + `proposals/execution/` (execution handlers).

1. **Draft** — created by a task handler (`ai/tasks/*`) or the voice FSM,
   `status: 'draft'`. AI-drafted line-item prices are grounded against the
   tenant catalog by `ai/resolution/catalog-resolver.ts` *before* the
   proposal is shown — an LLM-invented price is never trusted; an
   uncatalogued line caps confidence below the auto-approve threshold.
2. **Approval** — three channels converge on the same lifecycle actions
   (`proposals/actions.ts`): web (`routes/proposals.ts`), one-tap SMS/voice
   links (`routes/one-tap-approve.ts`), and inbound SMS replies
   (`proposals/sms/reply-handler.ts`, e.g. "YES"/"APPROVE ALL"). A narrow
   autonomous-booking exception (D-015) allows specific low-risk proposal
   types to auto-approve under a strict confidence floor; money/comms/
   irreversible-class proposals are structurally excluded
   (`actionClassForProposalType`).
3. **5-second undo window** — `UNDO_WINDOW_MS = 5000` in `lifecycle.ts`.
   `isInUndoWindow()` gates the executor (`proposals/execution/executor.ts`
   checks `UNDO_WINDOW_OPEN` and refuses to run); `undoProposal` in
   `proposals/actions.ts` transitions an approved-but-not-yet-executed
   proposal to the terminal `'undone'` status.
4. **Execution handlers** — after the window closes, the executor looks
   up a per-`proposalType` `ExecutionHandler` from the registry built in
   `proposals/execution/handlers.ts` (e.g. `IssueInvoiceExecutionHandler`,
   `CreateInvoiceExecutionHandler`, `RescheduleAppointmentExecutionHandler`).
   Handlers are the only code paths allowed to mutate money/schedule state
   from a proposal.
5. **Audit** — every mutation emits an audit event
   (`audit/audit.ts`, `createAuditEvent`). Handlers emit audit failure-soft
   (a logging failure never unwinds a successful execution).

Proposals are never auto-executed outside the D-015 exception above —
human approval (or the 5s-undo-gated auto-approve lane) is required.

## Worker model

No separate worker process in this codebase snapshot: background jobs run
as `setInterval` sweeps inside the same `api` process that serves HTTP,
registered via `registerInterval()` in `app.ts` so graceful shutdown can
clear them. Two coordination primitives:

- **PgQueue** (`queues/pg-queue.ts`, `P0-009`) — `FOR UPDATE SKIP LOCKED`
  work queue backed by Postgres, implementing the shared `Queue` interface
  in `queues/queue.ts`. `queues/queue.ts` also defines `InMemoryQueue` (the
  dev/test fallback) and, with `workers/worker-registry.ts`, the
  `WorkerHandler`/dispatch pattern every queue consumer implements.
- **Leader locks** — sweep loops that must run on exactly one replica
  (digest sends, dunning, one-tap-link expiry, ...) take a session-scoped
  Postgres advisory lock (`pg_try_advisory_lock` / `pg_advisory_unlock`)
  before doing work, so horizontal scale-out doesn't double-fire a cron.

- **`PROCESS_ROLE` split** (`shared/config.ts`) — `web` | `worker` | `all`
  (default `all`). `web` skips every background interval so the HTTP/voice
  surface can deploy independently of the workers; leader locks keep an
  accidental double-`all` safe. See docs/deployment.md "Two-service split".
- **Outbound SMS consent gate** — every SMS passes through one
  `GatedMessageDelivery` decorator (`notifications/gated-message-delivery.ts`):
  owner/operator sends bypass, customer sends require `sms_consent` + a clean
  tenant DNC check per `TCPA_CONSENT_ENFORCEMENT` (defaults to `block` in
  prod/staging). Suppressions are audited as `sms.suppressed`. Voice consent
  is separate: `voice/outbound-consent.ts`.

## Money rules

- **Integer cents everywhere** — never floating point. `shared/billing-engine.ts`
  (`calculateDocumentTotals`, `buildLineItem`) is the single source of
  totals math; use it, don't reimplement.
- **Catalog grounding** — see Proposal lifecycle step 1;
  `ai/resolution/catalog-resolver.ts` is pure/deterministic (no I/O, no
  LLM) and is the only place an AI-drafted price becomes authoritative.
- **AI gateway** — all LLM calls route through `ai/gateway/` (`gateway.ts`
  + `router.ts` for tier-based model routing, `factory.ts` for
  provider/config wiring, `breaker.ts`/`retry.ts`/`failover.ts` for
  resilience). Task types and their tier (`lightweight` / `standard` /
  `complex`) are declared in `config/ai-routing.ts` — every task type must
  have an explicit tier mapping (compiler-enforced).

## Where to start reading

1. `packages/api/src/app.ts` — every router, middleware, and worker is
   wired here; skim top-to-bottom once.
2. `packages/api/src/proposals/` — the approval-gated mutation model that
   every AI-initiated write goes through.
3. `packages/api/src/ai/gateway/` — the one chokepoint for LLM calls
   (tiering, resilience, cost).
4. `packages/api/src/ai/agents/customer-calling/state-machine.ts` — the
   voice FSM, if working on the calling agent.
5. `CLAUDE.md` (repo root) — core patterns and mandatory hygiene rules
   referenced throughout this doc.
