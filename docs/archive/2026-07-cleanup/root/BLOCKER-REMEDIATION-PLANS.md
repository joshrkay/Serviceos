# ServiceOS — Blocker Remediation Plans

_Companion to `GO-LIVE-READINESS.md`. One plan per top-10 blocker: objective, root cause (verified file:line), approach, steps, tests, verification, risk, effort. Sequenced at the end._

Mandatory gate for every plan (per CLAUDE.md):
```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```
Run the relevant tests with the repo's vitest workspace before marking any plan done.

---

## Launch decisions (2026-05-24)

- **Topology:** Single Railway instance at launch → Blocker 5 reduced to graceful shutdown + advisory-lock guard (no WS cross-instance fan-out needed yet).
- **Dead stacks:** Keep AWS CDK + the Supabase/LangGraph prototype, document them as non-production → Blocker 9 reduced to documentation only.
- **Voice:** ON at launch → the TCPA/DNC consent gate and transcript KMS encryption are promoted from 🟠 to **Blockers 11 & 12** (below).
- **Execution:** Starting with Blocker 10 (green baseline).

---

## ✅ Blocker 10 — RESULTS (completed 2026-05-24)

Baseline established locally (deps installed via `npm ci`, 807 packages):

| Gate | Result |
|------|--------|
| API production build (`tsc -p tsconfig.build.json`) | ✅ **clean, 0 errors** |
| Web typecheck (`tsc --noEmit`) | ✅ **clean** |
| Web unit tests | ✅ **944 passed / 140 files** |
| Shared tests | ✅ **3 passed** |
| API unit tests | ✅ **5502 passed**, 3 "failures" (see below) |
| Integration tests (testcontainers) | ⏸️ not run — Docker unavailable locally; **must confirm in CI** |

**The 3 API "failures" are NOT logic bugs — they are timezone-fragile tests.** This machine is MST (UTC-7); CI runs UTC. Under `TZ=UTC` all 3 pass (24/24). Root cause: `new Date('2026-01-15')` parses as UTC midnight but `.getDate()`/working-hours checks read local time (`test/invoices/invoice.test.ts:162`, `test/dispatch/validation.test.ts:147,160`).
→ **New minor item:** pin these tests to a fixed TZ (`TZ=UTC` in vitest config or `vi.setSystemTime`) so the suite is deterministic across dev machines. Not a go-live blocker (CI is UTC and green).

**Migration story RESOLVED (supersedes the earlier "pruned migrations / migration 106" concern):** the schema is defined in `packages/api/src/db/schema.ts` as one idempotent `getMigrationSQL()` blob, applied by `migrate.ts` via Railway `preDeployCommand`. Verified present in schema.ts: `webhook_events` + `CREATE UNIQUE INDEX idx_webhook_idempotency ON webhook_events(source, idempotency_key)` (key `012`) — **so Blocker 1's durable-dedup dependency is already satisfied** — and `portal_sessions` + RLS (key `065`). The orphaned `db/migrations/*.sql` files are dead/redundant (delete — see GO-LIVE minor items). **`btree_gist` is NOT enabled** — Blocker 7 must add `CREATE EXTENSION IF NOT EXISTS btree_gist`.

**Remaining for Blocker 10:** confirm the integration (testcontainers) suite is green in CI; un-greenwash CI (`pr-checks.yml:62` `continue-on-error`); set `E2E_CLERK_SECRET_KEY`; align Node 20/22 drift.

---

## Blocker 1 — Durable webhook idempotency for Stripe & Clerk

**Objective:** Stripe (`checkout.session.completed`, `charge.refunded`) and Clerk (`user.created`) webhooks must dedupe across restarts and multiple instances, so retries can't double-credit payments or re-bootstrap tenants.

**Root cause (verified):** `webhooks/routes.ts:34` `const webhookRepo = new InMemoryWebhookRepository()` — a process-local Map. The durable `PgWebhookEventRepository` already implements the exact interface `deps.webhookEventRepo` (`routes.ts:87-89`) and is already used by Twilio (`routes.ts:1316-1324`) and SendGrid (`routes.ts:1420-1423`) with the `recordReceipt → (if inserted) handle → markProcessed` pattern. The Stripe/Clerk handlers were simply never migrated (`app.ts:1003-1010` defers it explicitly).

**Approach:** Reuse the existing durable pattern; do not invent a new one. Mirror the Twilio block.

**Steps:**
1. Confirm a stable idempotency key per provider: Stripe `event.id`; Clerk `svix-id` header (already verified upstream). Use `event.type` as the event-type arg.
2. In the Stripe handler (around `routes.ts:634`) wrap the side-effecting work:
   ```ts
   const rec = await deps.webhookEventRepo.recordReceipt('stripe', event.id, event.type, event.data ?? {});
   if (!rec.inserted) return res.status(200).json({ received: true, deduped: true });
   // ... existing handler body ...
   await deps.webhookEventRepo.markProcessed('stripe', event.id);
   ```
3. Do the same in the Clerk handler (around `routes.ts:166`) keyed on `svix-id`.
4. Make `deps.webhookEventRepo` **required for these two paths in production**: if `NODE_ENV==='production'` and it's absent, throw at router construction (fail-fast) rather than silently falling back to the in-memory Map.
5. Delete the module-level `webhookRepo` (`routes.ts:34`) and the now-dead `InMemoryWebhookRepository` import once no longer referenced (keep it exported from `webhook-handler` for tests only).
6. Remove the `void`/deferral comment at `app.ts:1003-1010` and wire `webhookEventRepo: new PgWebhookEventRepository(pool)` into the Stripe/Clerk deps.

**Tests:**
- Integration (testcontainers Postgres): fire the same Stripe `charge.refunded` event id twice → exactly one refund applied; assert `webhook_events` has one row.
- Restart simulation: new repo instance, replay event id → deduped (proves durability, the whole point).
- Clerk `user.created` replay → one tenant/user.
- Production fail-fast: construct router with `NODE_ENV=production` and no `webhookEventRepo` → throws.

**Verification:** the durable test must pass with a *fresh repo instance* between the two deliveries (in-memory would fail this).

**Risk:** Low. The `recordReceipt` path already verified atomic via `ON CONFLICT (source, idempotency_key)` (`pg-webhook-event.ts`). **Dependency:** requires the `webhook_events` unique index migration applied (see Blocker 10).

**Effort:** ~0.5 day.

---

## Blocker 2 — Roll back request transactions on error responses

**Objective:** A request that returns ≥400 must ROLLBACK its transaction, so a multi-write route that fails partway commits nothing.

**Root cause (verified):** `middleware/tenant-context.ts:138-140` calls `cleanup(true)` (COMMIT) on every `res.finish`, regardless of status. `middleware/async-route.ts:12-19` catches handler exceptions and sends a 4xx/5xx response → `finish` fires → COMMIT. Only a client disconnect before finish (`:141-143`) rolls back.

**Approach:** Decide commit-vs-rollback by HTTP status at `finish` time. `res.statusCode` is populated before `finish`.

**Steps:**
1. In `tenant-context.ts`, change the `finish` handler:
   ```ts
   res.once('finish', () => {
     const ok = res.statusCode < 400;
     void cleanup(ok);
   });
   ```
2. Keep the `close` handler as rollback.
3. Edge cases to handle deliberately:
   - Routes that intentionally return 4xx as a *valid persisted outcome* (rare — e.g., recording a 402/409 while still writing an audit row). Audit the codebase for any handler that both writes and returns ≥400 on purpose; if any exist, give them an explicit "commit anyway" escape hatch (e.g., `res.locals.forceCommit = true`) rather than weakening the default.
   - Streaming/SSE responses (escalations `events-route.ts`) — these are on public/separate routes without this middleware; confirm.
4. Consider also making `async-route.ts` set a flag on caught errors as a belt-and-suspenders signal, but status-based is sufficient and simpler.

**Tests:**
- Update `test/middleware/tenant-context.test.ts:160-166` (currently asserts COMMIT on error) to assert ROLLBACK on ≥400.
- Two-write route where the 2nd write throws → assert the 1st write is absent after the request.
- Happy path (2xx) still commits.
- 404 from a read-only route → rollback is a no-op (nothing written), no error.

**Risk:** Medium — changes commit semantics for every authenticated route. The codebase audit in step 3 is the key safety task. Run the full API suite.

**Effort:** ~0.5–1 day (most of it the audit + suite run).

---

## Blocker 3 — FORCE row-level security on all tenant-scoped tables

**Objective:** RLS must apply even when the app connects as the table owner (the single-role Railway/Supabase deploy), closing silent cross-tenant exposure on 29 tables.

**Root cause (verified):** `db/schema.ts` has 74 `ENABLE ROW LEVEL SECURITY` vs 45 `FORCE ROW LEVEL SECURITY`. Owner roles bypass non-FORCEd RLS; the app runs as the `DATABASE_URL` role which also owns the tables.

**Approach:** Add `FORCE` to every tenant-scoped table, delivered as a new forward migration (not by editing historical migrations).

**Steps:**
1. Generate the authoritative list: diff tables that have `ENABLE` but not `FORCE` in `schema.ts`. Reviewer named: `users, conversations, messages, proposals, audit_events, files, expenses, portal_sessions, voice_recordings, voice_sessions` + 19 more.
2. For each, confirm it actually carries `tenant_id` and a tenant policy (a few may be intentionally global — e.g., `_queue_messages`, platform tables. Do NOT force RLS on genuinely global tables; instead document why they're exempt).
3. Write a new migration `ALTER TABLE <t> FORCE ROW LEVEL SECURITY;` for each tenant table. Add the same lines to `schema.ts` so fresh DBs match.
4. **Critical pre-flight:** verify the migration/runtime role is the table owner. If `FORCE` is on and the connecting role is *also* the owner, RLS now applies to it — make sure every legitimate cross-tenant operation (migrations, platform-admin, background sweeps, the `withClient` portal RLS-bypass path) either runs as a `BYPASSRLS` role or sets the tenant GUC. This is the step most likely to break things.
5. Decide the long-term posture: ideally introduce a dedicated non-owner app role with `BYPASSRLS` reserved for a separate admin role. Forcing RLS without this can lock the app out of its own admin paths.

**Tests:**
- Integration: as the app role with tenant A's GUC set, attempt to read tenant B's row in each newly-forced table → 0 rows.
- Platform-admin / sweep paths still function (they must set GUC or use a bypass role).
- Portal token-lookup RLS path (`pg-portal-session.ts:64`) still resolves.

**Risk:** **High** — this is the highest-risk plan. FORCE RLS can lock out admin/migration/sweep paths if role separation isn't right. Stage on a copy of prod data first. Roll out table-by-table behind verification, not all at once.

**Effort:** ~1–2 days incl. role-separation design and staging validation.

---

## Blocker 4 — Authenticate the web AI proposal-approval action

**Objective:** The "Approve" action in the assistant UI must send the Clerk bearer token and surface failures; it's the core human-approval gate.

**Root cause (verified by reviewer):** `packages/web/src/components/assistant/AssistantPage.tsx:257` uses bare `fetch('/api/proposals/:id/approve', {POST})` with no `Authorization` header → backend 401; only `console.error` handling (`:262-265`). The same file's upload path (`:396`) correctly uses `apiFetch`.

**Approach:** Route the call through the authenticated client (`useApiClient` from `lib/apiClient.ts`, which adds the token + 401-retry), and add real success/error UX.

**Steps:**
1. Replace the bare `fetch` with `useApiClient`/`apiFetch` (prefer `useApiClient` per the frontend reviewer's consolidation recommendation).
2. Do the same for reject/undo/edit actions in the same component if they share the bug.
3. Add loading + error + success states: disable the button while pending, show a toast/error on failure, optimistic or refetch on success.
4. Confirm the backend route expects `proposals:approve` permission and the token carries it.

**Tests:**
- Component test: approve sends `Authorization` header; on 401 it retries via the client and surfaces an error (not just console).
- E2E (if Clerk secret configured): authenticated user approves a proposal → status flips → executor runs after undo window.

**Risk:** Low. Self-contained frontend fix.

**Effort:** ~0.5 day. **Also fold in** the frontend Important item: migrate the other money pages off the weaker `apiFetch` path while here.

---

## Blocker 5 — Single-runner scheduled sweeps + graceful shutdown

**Objective:** Tenant-wide sweeps must run on exactly one instance, and SIGTERM must drain cleanly, so scaling past one dyno doesn't duplicate invoices/reminders/review replies or kill in-flight work.

**Root cause (verified by reviewer):** Sweeps are `setInterval` in-process — recurring-agreements `app.ts:2804`, overdue-invoice `:2835`, appointment-reminder `:2862`, estimate-reminder `:2890`, google-reviews `:2956`. Shutdown `app.ts:3102-3124` closes the pool but never clears intervals, stops the HTTP server, or drains the queue poll loop (`:1530`).

**Approach (two parts):**

_Part A — leader election (pick one):_
- **A1 (recommended, minimal):** wrap each sweep tick in a Postgres advisory lock (`pg_try_advisory_lock(<sweep-id>)`); skip the tick if not acquired. No new infra. Each sweep gets a distinct lock key.
- **A2 (cleaner long-term):** move sweeps into a dedicated worker process/dyno (Railway service) that runs exactly one replica; the API process stops scheduling them. Requires a deploy-topology change.

_Part B — graceful shutdown:_
1. On SIGTERM/SIGINT: stop the HTTP server from accepting new connections (`server.close()`), then
2. `clearInterval` every sweep handle and stop the 250ms queue poll loop (`:1530`),
3. wait for in-flight queue jobs to drain (bounded timeout),
4. then close the pg pool,
5. exit. Add a hard-timeout fallback so a stuck drain still exits.

**Steps:** Capture each `setInterval` handle in an array; add the advisory-lock guard inside each tick; implement the shutdown sequence above; gate the queue poll loop on a `shuttingDown` flag.

**Tests:**
- Unit: two simulated instances racing one sweep tick → only the lock holder runs it.
- Shutdown: SIGTERM during an in-flight job → job completes, no new jobs picked up, process exits within timeout.

**Risk:** Medium. Advisory-lock approach (A1) is low-risk and ships fast. **Decision needed:** if launching on a single instance, A1 + Part B is sufficient; A2 only if you'll scale soon.

**Effort:** A1 + shutdown ~1 day; A2 ~2–3 days (new service + deploy config).

---

## Blocker 6 — Emit audit events on payment recording

**Objective:** Every payment recorded and every invoice status flip must emit an audit event (CLAUDE.md mandate; today none do).

**Root cause (verified):** `recordPayment` (`invoices/payment.ts:144-225`) writes the payment + updates the invoice but emits no audit event. The audit-emitting wrapper `payments/invoice-payment-reconciler.ts:36-68` (`reconcilePayment`) exists but is called from nowhere; all real callers (`webhooks/routes.ts:775,798`, `routes/payments.ts:50`, `routes/invoices.ts:360`, `voice/.../voice-extended-handlers.ts:171`) call `recordPayment` directly.

**Approach (pick one):**
- **6A (recommended):** Add an optional `auditRepo?: AuditRepository` (+ actor/correlation) param to `recordPayment` and emit `payment.recorded` and, when status changes, `invoice.status_changed` inside it — so every caller is covered automatically. Emit *after* the invoice update succeeds, inside the same request transaction (the tenant-context client) so it commits/rolls back atomically with the write (synergizes with Blocker 2).
- **6B:** Route every caller through the existing `reconcilePayment` wrapper. More call-site churn; risk of missing one.

Prefer 6A because it's centralized and can't be bypassed.

**Steps:**
1. Add the audit emission in `recordPayment` after the `invoiceRepo.update` succeeds.
2. Thread `actor` (the `processedBy` already on input) and a `correlationId` (pass through from caller; default to a generated one but prefer the webhook event id / request id for traceability).
3. Update the 4 call sites to pass `auditRepo`.
4. Confirm refunds already audit (`payment-service.ts:131` emits `payment.refunded`) — leave as-is.

**Tests:**
- Unit: `recordPayment` emits `payment.recorded` with correct amount/actor/tenant.
- Status flip open→paid emits `invoice.status_changed`.
- Webhook-driven payment produces an audit row correlated to the Stripe event id.

**Risk:** Low. Additive. **Sequence with Blocker 2** so the audit write participates in the same transaction.

**Effort:** ~0.5 day.

---

## Blocker 7 — Data-layer double-booking protection + assignment audit

**Objective:** Prevent overlapping appointments/assignments under concurrency, and audit technician assignment mutations.

**Root cause (verified by reviewer):** Conflict detection (`scheduling/feasibility.ts`, `dispatch/validation.ts`) is advisory; `createAppointment` (`appointments/appointment.ts:156-211`) and `POST /api/appointments` (`routes/appointments.ts:51-82`) never call it; the proposal path checks feasibility and assigns in separate steps (TOCTOU); `schema.ts:417-514` has no exclusion constraint. Assignment mutations (`appointments/assignment.ts:44-79`) emit no audit events.

**Approach (defense in depth):**
1. **DB backstop (authoritative):** enable `btree_gist` and add an `EXCLUDE USING gist` constraint on `appointment_assignments` preventing the same technician from having overlapping `[start,end)` ranges for active statuses. This makes double-booking impossible regardless of app-layer races. This is the real fix.
2. **App-layer UX:** call feasibility on the direct create/update routes too, so users get a clean 409 instead of a constraint violation.
3. **Transaction:** in the proposal reassignment handler, run feasibility-check + assign in one transaction (or rely on the DB constraint + catch the violation).
4. **Audit:** emit `appointment.technician_assigned` / `_unassigned` in `assignTechnician`/`unassignTechnician` and in the reassignment/crew proposal handlers.
5. Fix the non-atomic demote-then-create primary-assignment race (`assignment.ts:54-70`) — do it in one statement/transaction so two `is_primary=true` rows can't coexist.

**Tests:**
- Integration: two concurrent assignments of the same tech to overlapping windows → exactly one succeeds (constraint rejects the other).
- Direct `POST /api/appointments` with an overlap → 409, not silent success.
- Assignment emits the audit event.

**Risk:** Medium. The exclusion constraint needs the overlap semantics (status filter, half-open interval) exactly right, and `btree_gist` extension must be enabled in prod Postgres (Supabase supports it). Validate against existing data for pre-existing overlaps before adding the constraint (it will fail to create if dirty data exists — plan a cleanup query).

**Effort:** ~1.5–2 days.

---

## Blocker 8 — Remove mock-data fallback from public estimate page

**Objective:** A public estimate URL must never render another tenant's fixture data; on error it shows an error state.

**Root cause (verified by reviewer):** `packages/web/src/components/customer/EstimateApprovalPage.tsx:531-592` falls back to `mock-data` `estimates[0]` on a network error (not 404), leaking that fixture customer's name/address/line-items/total on a public page.

**Approach:** Delete the mock fallback; render a proper error/retry state.

**Steps:**
1. Remove the `import ... from 'data/mock-data'` and the fallback branch in `EstimateApprovalPage.tsx` (also check `JobSheets.tsx:7` which imports mock-data).
2. Add a dedicated error state component (retry button + support message) for network errors, distinct from the existing 404/expired states.
3. Extend `production-mock-data-guard.test.ts` to cover `EstimateApprovalPage.tsx` and `JobSheets.tsx` (reviewer noted the guard currently misses both) — make the guard fail the build if any shipped component imports `data/mock-data`.
4. Fix the money-rendering bug in the same file's totals (`:715-716,730,243`) while here (cents→float drops cents) — use the canonical cents formatter.

**Tests:**
- Component: network error → error state, no fixture data rendered.
- Guard test: importing mock-data into a shipped component fails CI.

**Risk:** Low.

**Effort:** ~0.5 day.

---

## Blocker 9 — Collapse to one deployment target

**Objective:** Eliminate the risk that an operator deploys/migrates the wrong stack. Railway is the live, coherent target.

**Root cause (verified by reviewer):** Three architectures coexist — Railway (live), AWS CDK in `infra/` (built, deployed by nothing, ECR `latest` never pushed), and the `service-os-app` + `service-os-agent` Supabase/LangGraph prototype (no deploy target, writes directly to Supabase bypassing the proposal/audit gate, unauthenticated `/process`, and a guaranteed `NameError` at `service-os-agent/clients/service_os_api.py:146`). `supabase_migration.sql` is an orphaned second schema.

**Approach:** Declare Railway canonical; quarantine or delete the rest.

**Steps:**
1. **Decision (needs your input):** Is AWS CDK the intended future target, or dead? If dead → move `infra/` to `archive/` or delete. If future → wire `cdk synth` into CI to prevent drift and document it as not-yet-live.
2. **Prototype:** move `service-os-app` + `service-os-agent` to an `experiments/` directory with a README stating "not production, not deployed," OR delete them. They contradict the canonical architecture (direct Supabase writes bypass proposal/audit).
3. **Orphaned schema:** move `supabase_migration.sql` next to the prototype (it's the prototype's schema), or delete — it must not sit at repo root looking like the prod migration.
4. Update `CLAUDE.md` (currently lists only `/infra`, `/packages/*`) and `docs/deployment.md` to describe the actual single Railway path, and remove the `railway run` vs `preDeployCommand` doc drift.
5. If the Python agent is *not* dead: fix the `NameError` (`import json`), add auth to `/process` (`main.py:39-59`), and set a real CORS allowlist — but only if it ships.

**Tests:** N/A (structural). Add a CI check that fails if `service-os-app`/`service-os-agent` reappear in deploy configs unintentionally (optional).

**Risk:** Low (deleting/moving dead code) — but **requires your decision** on CDK's fate.

**Effort:** ~0.5 day once the decision is made.

---

## Blocker 10 — Verify build, tests, and migrations in CI/prod

**Objective:** Prove the mandatory build gate and test suite pass, and that the migrations the code depends on are actually applied in prod.

**Root cause:** Couldn't be executed in the review environment (`node_modules` absent). The migrations directory in this checkout is pruned (5 SQL files; code references 012–108), so durable-webhook (Blocker 1) and portal RLS (token-lookup) depend on migrations that may or may not be applied.

**Approach:** Make CI the source of truth and confirm prod schema.

**Steps:**
1. Run locally/CI: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit` (the production build config) — fix any errors.
2. Run the full vitest workspace (`vitest.workspace.ts`) and the integration (testcontainers) suite. Confirm green.
3. **Fix the CI green-washing:** remove `continue-on-error: true` from the per-module coverage gate (`pr-checks.yml:62`) so it can actually fail; ensure `E2E_CLERK_SECRET_KEY` is set in the prod-bound CI so E2E journeys don't self-skip (`e2e.yml`, `smoke.spec.ts:30`); align Node versions (pr-checks 20 vs deploy/e2e 22 vs Dockerfile 20).
4. **Confirm prod migrations:** verify `webhook_events` unique index on `(source, idempotency_key)` and migration 106 (portal token-lookup RLS policy reading `app.portal_token_lookup`) are applied in the prod DB. List `migrate.ts` against the prod `schema_migrations` table.
5. Add the new migrations from Blockers 1, 3, 7 to the migration runner and confirm they apply cleanly on a prod-data copy.

**Tests:** the suite itself is the test. Add a CI job that asserts pending migrations == 0 before deploy.

**Risk:** Low to run; may surface latent failures the review couldn't see (that's the point — do it early).

**Effort:** ~0.5 day, but **do this first** — it de-risks everything else.

---

## ✅ Blockers 2 + 6 — DONE (branch `fix/blockers-2-6-txn-rollback-payment-audit`, 2026-05-24)

Implemented together so the audit write lands inside the corrected transaction.

**Blocker 2 (txn rollback):** `middleware/tenant-context.ts` now commits on `res.finish` only when `res.statusCode < 400`; `>=400` rolls back. Added `res.locals.forceCommit` escape hatch for intentional write-then-4xx routes (none currently need it). Header comment updated. 3 new tests (throw→500 rollback, 4xx rollback, forceCommit→commit).

**Blocker 6 (payment audit):** `recordPayment` (`invoices/payment.ts`) takes optional `auditRepo` + `RecordPaymentAuditContext` and emits `payment.recorded` (always) and `invoice.status_changed` (on status flip), inside the caller's transaction. Wired all live call sites: `routes/payments.ts`, `routes/invoices.ts` (actorRole from `req.auth.role`), both Stripe webhook paths in `webhooks/routes.ts` (actorRole `system`, correlationId = payment_intent), and the voice `RecordPaymentExecutionHandler` (correlationId = proposal id) via the handler registry. Dead `reconcilePayment`/`processStripePaymentEvent` left as-is (they pass no auditRepo, so no double-emit). 3 new tests.

**Verification:** `tsc -p tsconfig.build.json` clean; full API suite **5511 passed / 0 failed** under `TZ=UTC` (no regression from the rollback change → no route depended on commit-on-error). 9 files, +237/-5.

**Caveat:** in the Stripe webhook path the payment + audit writes are NOT in one transaction (webhooks run without the tenant-context middleware), so audit there is emitted but not atomic — that atomicity is part of Blocker 1's webhook work, tracked separately.

---

## Blocker 11 — TCPA/consent + DNC opt-out gate on outbound calls (voice-on launch)

**Objective:** No AI-initiated outbound call places without a prior-consent check and a DNC/opt-out list check.

**Root cause (verified by reviewer):** `voice/outbound-allowlist.ts` only blocks malformed/non-NANP/premium (900/976) numbers — no consent or opt-out gate. A DNC repo + STOP-keyword handling already exist in `compliance/` (used for inbound SMS) and can be reused.

**Steps:**
1. Add a pre-dial gate in the outbound-call path that checks the existing compliance DNC repo and a per-contact consent flag before dialing; refuse + log if absent.
2. Honor STOP/opt-out across channels (the SMS STOP handler already writes opt-outs — read the same store for voice).
3. Record consent provenance (when/how obtained) on the customer record; surface it in the UI.
4. Add quiet-hours enforcement (TCPA: no calls 9pm–8am local) using tenant/customer timezone.

**Tests:** outbound to a DNC number → blocked + audited; no consent → blocked; quiet-hours → deferred.

**Risk:** Medium — legal requirement. Coordinate with whoever owns compliance policy.

**Effort:** ~1–1.5 days (reuses existing DNC infra).

---

## Blocker 12 — Encrypt stored voice transcripts at rest (voice-on launch)

**Objective:** Raw call transcripts (PII) must be encrypted at rest, not base64.

**Root cause (verified by reviewer):** `workers/transcription.ts:59,212` stores transcripts in JSONB `metadata` base64-encoded, self-labeled `encryption: 'pending-kms-integration'`.

**Steps:**
1. Complete the KMS integration the code already anticipates: encrypt the transcript blob with a KMS-managed key (envelope encryption) before persisting; decrypt on read in the authorized path.
2. Reuse the AES-256-GCM helper already in `integrations/crypto.ts` for the data key if a full cloud-KMS isn't wired yet (interim), with the key from a secret — but prefer real KMS for launch.
3. Add a retention/TTL policy for raw transcripts.

**Tests:** stored blob is ciphertext (not decodable base64 plaintext); authorized read round-trips; key rotation path.

**Risk:** Medium. **Dependency:** KMS key provisioning (note: AWS KMS lives in the CDK stack which isn't deployed — on Railway, use an env-provided key + the existing GCM helper, or a managed KMS API).

**Effort:** ~1–2 days depending on KMS choice.

---

## Recommended sequencing

| Order | Blockers | Why | Effort |
|-------|----------|-----|--------|
| **0** | **10** ✅ baseline done; finish CI items | Build + unit tests green; remaining: confirm integration suite in CI, un-greenwash CI | 0.25d left |
| **1** | **2** (txn rollback), **6** (payment audit) | Do together — audit write should live inside the now-correct transaction | 1–1.5d |
| **2** | **1** (webhook durability), **4** (web approval auth), **8** (estimate leak) | Surgical, independent, high-value; #1's schema dep already in place | 1.5d |
| **3** | **7** (double-booking + `btree_gist`), **9** (document dead stacks — reduced) | Schema work + doc-only cleanup | 1.5–2d |
| **4** | **5** (graceful shutdown + advisory-lock sweeps — reduced to single-instance scope) | Single-instance launch → no fan-out; advisory lock + drain only | ~1d |
| **5 (voice-on)** | **11** (TCPA/DNC gate), **12** (transcript KMS) | Promoted to blockers because voice is on at launch | 2–3.5d |
| **6 (highest risk, stage first)** | **3** (FORCE RLS) | Needs app/admin role-separation design + staging on prod-data copy | 1–2d |

**Total: roughly 8.5–12 engineer-days** with the launch decisions applied. All gating decisions are now made.
