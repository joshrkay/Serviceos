# 05 — Track 5: Data Layer & Multi-Tenancy

Date: 2026-07-18 · Read-only discovery · Evidence verified against HEAD `a9d06aa`
See `discovery/00-cartography.md` for orientation. This track was run adversarially — highest blast radius.

## Summary

Tenant isolation in this codebase is genuinely strong — the strongest I have seen at this company stage, and the audit looked hard for holes. The design is defense-in-depth: 116 of ~124 distinct tables have `ENABLE` + `FORCE ROW LEVEL SECURITY` with a `tenant_isolation` policy; the app is *required* (boot-fails otherwise, `shared/config.ts:352`) to drop to a non-BYPASSRLS `rls_app_runtime` role in prod/staging; the GUC is set via `set_config(..., true)` (transaction-local) inside an explicit `BEGIN`, which is the correct and only pooling-safe shape under PgBouncer `pool_mode = transaction` (`deploy/pgbouncer/pgbouncer.ini:46`); and the whole property is pinned by four distinct Docker-gated integration suites (static text parse, live pg_catalog scan, GUC-reset behavior, fixture leak tests) that run unconditionally in PR CI (`pr-checks.yml:62-66`). The 8 tables without RLS are each individually justifiable and the two that carry `tenant_id` are pinned as documented exemptions by a schema-invariant test that fails CI if a new unprotected tenant table appears.

The real risk in this lane is not isolation — it is **schema evolution and data growth at scale**. Prod schema changes ship by re-executing the entire 6,316-line idempotent SQL corpus (`getMigrationSQL()`) as a single implicit transaction on every deploy, with regex-based rewriting that turns all 46 named constraints into `DROP CONSTRAINT IF EXISTS` + re-`ADD` — i.e., every deploy re-takes ACCESS EXCLUSIVE locks on ~116 tables and re-validates constraints with full-table scans, under a 25s statement timeout, while the old replica is still serving (overlapSeconds=35). That converges fine at today's row counts and will start failing deploys, unrecoverably by retry, as hot tables reach millions of rows. Second: the highest-velocity tables (`ai_runs` with full JSONB input/output snapshots, `audit_events`, `call_transcript_turns`) have no retention, no partitioning, and no archival path. Third: outside the LLM/SSE allowlist, the per-request transaction is held across *all* handler awaits — including slow non-LLM upstreams (Stripe, Twilio, Google) — against a 25-backend PgBouncer budget. No Critical isolation findings; the top findings are scale-event Highs.

## What exists (inventory)

| Area | Maturity | Evidence |
|---|---|---|
| **RLS policy coverage** | **High.** 116/~124 distinct tables `ENABLE` + `FORCE` RLS + `tenant_isolation_*` policy (`USING (tenant_id = current_setting('app.current_tenant_id')::UUID)`). Exceptions (8): `tenants`, `vertical_packs`, `prompt_versions`, `provider_health`, `weather_cache`, `webhook_events` (no `tenant_id` column — genuinely global/ops), plus `oauth_states` and `platform_deprovision_log` (carry `tenant_id`, documented exemptions). | `schema.ts` (119 FORCE stmts); exemption rationale at `schema.ts:5330-5340`; invariant test `test/integration/rls-tenant-isolation.test.ts:239-264` pins exactly `{platform_deprovision_log, oauth_states}` |
| **Runtime enforcement** | **High.** `RLS_RUNTIME_ROLE=true` is a hard prod/staging boot requirement with no opt-out (`shared/config.ts:340-357`); boot probe `verifyRlsRuntimeRole` refuses to start if `rls_app_runtime` isn't assumable (`db/rls-runtime-role.ts:194-234`). Migration 219 dynamically revokes the runtime role's grants on any `tenant_id`-without-RLS table (`schema.ts:5341-5361`). Cross-tenant sweeps use a named `rls_cross_tenant` BYPASSRLS role for attributability (`pg-base.ts:115`). | cited |
| **GUC mechanism / PgBouncer safety** | **High.** Request path: `BEGIN` → `set_config('app.current_tenant_id', $1, true)` + `SET LOCAL ROLE` → per-request `statement_timeout` 30s / `idle_in_transaction_session_timeout` 60s (`middleware/tenant-context.ts:170-179`). Standalone repo path converged onto the same SET LOCAL transaction (`pg-base.ts:29-38`, "U2b-2"). Session-scoped state (advisory leader locks, idempotency locks, LISTEN/NOTIFY) split onto a **direct DSN** bypassing PgBouncer (`db/pool.ts:44-72`, `pgbouncer.ini:10-17`). Transaction-scoping pinned by `pgbouncer-tenant-isolation.test.ts`. | cited |
| **CI gating** | **High.** `pr-checks.yml` runs `npm run test:integration` with `TEST_DB: testcontainers` against `pgvector/pgvector:pg16` **unconditionally** on every PR (lines 59-66) — the RLS suites are not skippable-if-no-docker. Plus `check:fk-paths` guard (line 44). ~180 integration test files including race/concurrency suites (`payment-concurrent-race`, `technician-double-booking-race`). | cited |
| **Schema evolution** | **Medium-Low.** No migrations dir, no `schema_migrations` version table. `MIGRATIONS` object (keys `001`…`247+`) re-applied in full every deploy via `preDeployCommand` (`railway.toml`), one `client.query(getMigrationSQL())` on the direct DSN, under a global advisory lock (DATA-04, `migrate.ts:24-64`), `lock_timeout=5s` / `statement_timeout=25s` (`migrate.ts:71-73`). Idempotency achieved by regex rewriting (`schema.ts:6252-6268`). `migrate:dryrun` is compile-only — never touches a DB (`scripts/migrate-dryrun.ts`). | cited |
| **PII / retention** | **Medium.** Real: recording purge worker honoring per-tenant `recording_retention_days` + `legal_hold` (`workers/recording-retention-worker.ts`), Presidio PII scrubbing for RAG (`ai/privacy/presidio-adapter.ts`, `content_scrubbed` column), key/URL/tiered log redaction (`logging/redact.ts`), DLQ payload redaction (`pg-queue.ts:169`), dynamic all-tenant-tables purge on deprovision with `platform_deprovision_log` (`tenants/deprovision.ts`). Aspirational/missing: transcript text and `ai_runs` snapshots are **kept forever** — the recording purge explicitly keeps "the row, its transcript, and every audit event" (`recording-retention-worker.ts:12`). | cited |
| **pgvector** | Present in **prod** schema, not just training: `knowledge_chunks` `vector(1536)` + ivfflat, FORCE RLS with tenant-or-global policy (`schema.ts:1652-1694`); read path `ai/orchestration/retrieve-adapter.ts` → `retrieveContext` behind `RAG_RETRIEVAL_ENABLED`. `serviceos_training/01_schema.sql` is a separate Supabase pipeline — no prod code references it. | cited |
| **Queue** | `PgQueue` (`queues/pg-queue.ts`): `FOR UPDATE SKIP LOCKED` claim, exponential visibility backoff, orphan reaper, redacted DLQ. Tables `_queue_messages`/`_queue_dlq` created lazily at runtime, not in schema.ts. Leader-elected sweeps via session advisory locks on the direct pool (`app.ts:2258-2299`). | cited |
| **Money** | Integer cents throughout; `idx_invoices_number UNIQUE (tenant_id, invoice_number)` (`schema.ts:644`); execution idempotency unique index (`schema.ts:1553-1560`); newer money tables have `CHECK (amount_cents > 0)` (`schema.ts:2590,2736,5603`). No ledger/double-entry; `payments.amount_cents` unconstrained (see T5-F05). | cited |

## Findings

---

**T5-F01 | Every deploy re-runs the full DDL corpus: 46 constraint re-validations + ~116-table policy churn in one transaction | Fix (scale-event/availability) | HIGH**
**Evidence:** `schema.ts:6252-6268` — `getMigrationSQL()` unconditionally rewrites every `ADD CONSTRAINT` to `DROP CONSTRAINT IF EXISTS <name>; ... ADD CONSTRAINT <name> ...` (46 occurrences) and every `CREATE POLICY` to `DROP POLICY IF EXISTS; CREATE POLICY` (~132). `migrate.ts:67-74` executes the whole corpus as **one** `client.query()` — a single multi-statement simple-query message, i.e., one implicit transaction — with session `statement_timeout='25s'`, `lock_timeout='5s'`. `railway.toml`: `overlapSeconds = 35` keeps the old replica serving during this.
**What & Why:** On every deploy: (a) 46 constraints (CHECK/FK/UNIQUE) are dropped and re-added — re-`ADD` of a CHECK or FK **re-validates with a full table scan** under ACCESS EXCLUSIVE; (b) `DROP/CREATE POLICY` takes ACCESS EXCLUSIVE on ~116 tables; (c) all locks are held until the single implicit transaction commits, queuing behind (and ahead of) live traffic from the still-serving replica. As hot tables grow, revalidation scans push total time past 25s and deploys fail **deterministically** (`restartPolicyMaxRetries: 3` retries the same doomed work). Separately, plain `CREATE INDEX` (0 uses of `CONCURRENTLY`, correctly, since it can't run in a transaction) means any *new* index on a large table blocks writes for its whole build or blows the timeout. This is the single biggest scale-event landmine in the data layer.
**Effort:** L. **Plan:** Introduce a `schema_migrations` tracking table so already-applied keys are skipped (the `MIGRATIONS` object's ordered keys are already migration IDs — the hard part is done); run only new migrations, each in its own transaction; add an out-of-band path for `CREATE INDEX CONCURRENTLY`. Keep the full-corpus mode for fresh databases/testcontainers.
**Confidence:** High (behavior read directly from code; the exact row-count at which 25s is breached could not be verified — no live DB).

---

**T5-F02 | No retention/partitioning for the three highest-velocity tables (`ai_runs`, `audit_events`, `call_transcript_turns`) | Fix (scale/cost/privacy) | HIGH**
**Evidence:** `ai_runs.input_snapshot/output_snapshot JSONB NOT NULL` (`schema.ts:181-182`); `audit_events` append-only, unpartitioned, 4+ indexes (`schema.ts:61-75`, `6043`); `call_transcript_turns` (`schema.ts:1519-1537`). Grep for `DELETE FROM ai_runs|audit_events|call_transcript_turns` in `src/`: **zero hits** outside per-tenant deprovision. `recording-retention-worker.ts:11-12`: purge deletes only the audio object; "the row, its transcript, and every audit event are KEPT."
**What & Why:** At 1,000 concurrent sessions (~15K calls/hr sustained, ~40-60 turns/call): `call_transcript_turns` ≈ 6-20M rows/day; `ai_runs` (multiple runs/call, each carrying full prompt+output JSONB) plausibly the dominant storage line at GBs/day; `audit_events` one row per mutation → millions/day with `metadata JSONB`. Within months: index bloat on 5-index tables, autovacuum falling behind, backup/restore windows ballooning — and a privacy posture where the recording-retention promise is hollow, because verbatim transcript text and full LLM I/O outlive the audio forever. (Cross-references T1-F09.)
**Effort:** L. **Plan:** Time-based partitioning (native, monthly) for the three tables + a retention sweep extending the existing recording-retention pattern to transcript turns and `ai_runs` snapshots (snapshot columns can be nulled after N days while keeping the run row); decide audit archival policy explicitly.
**Confidence:** High on absence of retention; Medium on volume estimates (no prod metrics).

---

**T5-F03 | Request transaction held across ALL non-LLM slow upstream awaits vs. a 25-backend PgBouncer budget | Fix (scale/pool exhaustion) | HIGH**
**Evidence:** `middleware/tenant-context.ts:112-118` — the long-call exemption list is exactly one route (`POST /assistant/chat`) plus 3 SSE routes (lines 71-75). Every other authenticated `/api` route holds `BEGIN`…GUC…handler…`COMMIT on res.finish` for its entire life. `pgbouncer.ini:52-57`: `default_pool_size = 25`, `reserve_pool_size = 5`. Comment at `pgbouncer.ini:44-45` claims "it never awaits LLM/HTTP inside the RLS txn" — true for LLM but **not** for Stripe (`billing/subscription.ts`, `stripe-connect.ts`), Twilio provisioning, Google Calendar (`integrations/calendar-integration.ts`) calls made inside ordinary request handlers.
**What & Why:** An open transaction pins a PgBouncer *server backend* even while idle-in-transaction. ~30 concurrent requests each awaiting a 300-800ms Stripe round-trip consume the entire server-side budget and every other `/api` request queues. The 60s `idle_in_transaction_session_timeout` backstop *aborts* the victim request rather than freeing capacity gracefully. (Same mechanism as T4-F09.)
**Effort:** M. **Plan:** Audit handlers that await external HTTP inside the request tx; either add them to the exemption list (machinery exists per the `/assistant/chat` precedent) or restructure to call upstreams before/after the tx. Add a p95 "tx hold time" metric to the existing pool metrics sampler (`app.ts:2256`).
**Confidence:** High on mechanism; Medium on which routes are worst.

---

**T5-F04 | Migration failure can be silently swallowed → app boots against stale schema | Fix | MEDIUM**
**Evidence:** `migrate.ts:106-112` — `isDuplicatePolicyError` (code 42710, routine `CreatePolicy`) logs a warning and **continues startup with exit code 0**. Because the corpus is one implicit transaction, that error means *everything rolled back* — yet the deploy proceeds and the new code runs against the previous schema (missing columns → runtime 42703s on scattered endpoints).
**What & Why:** The 42710 path exists because the regex-based idempotency rewriting is format-sensitive: a `CREATE POLICY` written with a layout the regex misses, or an `ADD CONSTRAINT` on the same line as `ALTER TABLE` (the rewrite requires a newline between them, `schema.ts:6263`), silently loses its DROP-guard. The escape hatch converts a total rollback into a green deploy. Note also `makePoliciesIdempotent` (`schema.ts:6244`) is a dead duplicate of the inline rewrite — evidence this area has drifted.
**Effort:** S. **Plan:** Make 42710 fatal (with version tracking from T5-F01 it becomes unreachable); until then at minimum `process.exitCode = 1` on it. Delete `makePoliciesIdempotent`.
**Confidence:** High.

---

**T5-F05 | `payments.amount_cents` has no sign/zero constraint; invoice money columns have no DB-level reconciliation; no ledger | Fix (money integrity backstop) | MEDIUM**
**Evidence:** `schema.ts:679` — `amount_cents INTEGER NOT NULL` (contrast: `2590`, `2736`, `5603` all carry `CHECK (amount_cents > 0)`). `invoices` (`schema.ts:620-641`): `subtotal_cents/tax_cents/total_cents/amount_paid_cents/amount_due_cents` are mutable denormalized columns with no reconciliation CHECKs nor non-negativity. Refunds are a `status` flip, not a compensating entry — no double-entry/event-sourced money anywhere in the prod schema.
**What & Why:** Integer-cents discipline is genuinely enforced and concurrency races are well-tested (`payment-concurrent-credit`, `payment-reversal-concurrent`, `deposit-concurrent-credit` integration tests), so this is a missing *backstop*, not a live bug: one buggy code path can persist a negative payment or a paid-more-than-total invoice with the DB's blessing, and reconciliation against Stripe becomes archaeology.
**Effort:** S (constraints) / XL (ledger — not warranted yet). **Plan:** Add the CHECK constraints in a new migration; defer any ledger conversation.
**Confidence:** High.

---

**T5-F06 | `webhook_events` and `tenants` remain fully readable/writable by the tenant-scoped runtime role | Fix (isolation hardening) | MEDIUM**
**Evidence:** Migration 217 grants `rls_app_runtime` DML on **ALL** tables (`schema.ts:5301`); migration 219 revokes only tables that *carry a `tenant_id` column* without RLS (`schema.ts:5345-5353`). `webhook_events` has **no** `tenant_id` column (`schema.ts:264-274`) yet stores raw inbound webhook `payload JSONB` (Twilio/Stripe — cross-tenant phone numbers, amounts, PII); `tenants` exposes every tenant's `name`/`owner_email` (`schema.ts:29-36`). Runtime-created `_queue_messages`/`_queue_dlq` (`pg-queue.ts:38-60`) are in the same class.
**What & Why:** The whole point of the runtime role is that a forgotten filter cannot cross tenants. On these tables it still can: any request-path query (or SQLi through the role) reads the full cross-tenant webhook payload history and the tenant directory. The revoke machinery of 219 exists and is self-maintaining — it just keys on the wrong predicate for no-tenant-column tables.
**Effort:** S. **Plan:** Extend 219 (or add a new migration) to explicitly `REVOKE` `rls_app_runtime` on `webhook_events`, `tenants` (or grant column-limited SELECT if request paths need `tenants.name`), `_queue_messages`, `_queue_dlq` — all are only ever accessed via the privileged/sweep paths.
**Confidence:** High on grants-as-written; Medium on exploitability (requires a forgotten-filter bug or injection to matter — it is the backstop that's missing, same class as the RLS work itself).

---

**T5-F07 | `_queue_messages` has no claim-path index; 250ms poll cadence; unbounded DLQ | Fix (scale) | MEDIUM**
**Evidence:** `pg-queue.ts:37-49` — only PK + `UNIQUE (idempotency_key)`; the claim query filters `visible_at <= NOW() AND attempts < max_attempts ORDER BY created_at` (`pg-queue.ts:120-127`) → sequential scan every tick. `app.ts:2644`: execution-worker polls every 250ms. Every claim is an UPDATE → dead tuples on the hottest rows. `listDeadLetter()` is an unbounded `SELECT *` (`pg-queue.ts:255-259`); nothing prunes `_queue_dlq`.
**What & Why:** Fine at today's throughput (the file honestly says "low-to-medium throughput… consider pg-boss"). At 1,000-concurrent the queue carries voice-action, MMS-ingest, and timer traffic: seq-scan-per-250ms over a bloating heap becomes a CPU/IO tax, and SKIP LOCKED's usefulness degrades when the scan itself is slow.
**Effort:** S. **Plan:** Add partial index `(visible_at, created_at) WHERE attempts < max_attempts` (must go through the migration corpus, not `ensureTable` — see T5-F01); cap/prune DLQ; plan the pg-boss migration when depth SLO metrics trend up.
**Confidence:** High.

---

**T5-F08 | TLS to Postgres with `rejectUnauthorized: false` everywhere | Fix | MEDIUM**
**Evidence:** `db/pool.ts:13`, `:27`, `:62` — all three pool constructors; also `pgbouncer.ini:99` `server_tls_sslmode = prefer` (falls back to plaintext upstream).
**What & Why:** Encrypted but unauthenticated — a MITM between app↔PgBouncer↔Postgres can present any cert. On Railway's private network this is a common accepted posture, but the DB carries all tenants' PII and the config offers no env override to enable verification. (Same as T4-F13.)
**Effort:** S. **Plan:** Support `DB_SSL_CA`/`sslmode=verify-full` via env; set `server_tls_sslmode = verify-full` per the ini's own comment.
**Confidence:** High.

---

**T5-F09 | Hot-table index shapes: good on voice/proposals, weaker on `ai_runs`/`audit_events`; redundant single-column tenant indexes | Refactor | LOW-MEDIUM**
**Evidence:** Good: `voice_sessions(tenant_id, started_at DESC)` + partial active index (`schema.ts:1813-1814`), `call_transcript_turns UNIQUE (voice_recording_id, turn_index)` + `(tenant_id, created_at DESC)` (`schema.ts:1531-1534`), `proposals(tenant_id, status, created_at DESC)` (`schema.ts:5400`), `audit_events(tenant_id, created_at)` (`schema.ts:6043`). Weaker: `idx_ai_runs_task ON ai_runs(task_type)` is global/low-selectivity with no `(tenant_id, created_at)` composite (`schema.ts:193-195`); `idx_audit_entity(entity_type, entity_id)` not tenant-prefixed (`schema.ts:74`); superseded single-column indexes (`idx_audit_tenant`, `idx_proposals_tenant`, `idx_diff_tenant`…) survive alongside their composites → pure write amplification on the highest-insert tables.
**Effort:** S. **Plan:** Drop superseded single-column tenant indexes; add `ai_runs(tenant_id, created_at DESC)` if any dashboard lists runs. Do it under T5-F01's index machinery.
**Confidence:** Medium-High (usage inferred from schema + repo names, not EXPLAIN).

---

**T5-F10 | `knowledge_chunks` policy lets a tenant-scoped session write global-scope rows | Fix (RAG corpus integrity) | LOW-MEDIUM**
**Evidence:** `schema.ts:1693-1694` — single FOR-ALL policy `USING (tenant_id IS NULL OR tenant_id = current_setting(...))` with no separate `WITH CHECK`; Postgres reuses USING as the write check, so an INSERT with `tenant_id NULL, scope 'global'` passes from *any* tenant context under `rls_app_runtime`.
**What & Why:** A bug (or injection) on a tenant write path could poison the shared global retrieval corpus that every tenant's AI reads. Reads of global rows by all tenants are intentional; writes are not. Also: ivfflat with fixed `lists` degrades in recall as the corpus grows — revisit when chunk count 10×es.
**Effort:** S. **Plan:** Split policies: `FOR SELECT USING (tenant_id IS NULL OR ...)`; `FOR INSERT/UPDATE/DELETE WITH CHECK (tenant_id = current_setting(...))`, keeping global writes on the privileged ingestion path only.
**Confidence:** High on policy semantics; Low on an actual exposed write path existing today (ingestion appears worker-side).

---

**T5-F11 | Drift between `schema.ts` and prod is undetectable by tooling | Fix (operability) | MEDIUM**
**Evidence:** `scripts/migrate-dryrun.ts` compiles and prints lengths — never connects (`migrate-dryrun.ts:9-24`). No `schema_migrations` table, no schema-diff check anywhere in CI.
**What & Why:** The re-run-everything model *converges* prod toward `schema.ts` for objects the corpus creates — better than classic drift — but it cannot detect: manually created prod objects (the ini itself instructs operators to hand-create `pgbouncer_get_auth` via psql, `pgbouncer.ini:70-82`), hand-applied hotfix indexes, or a swallowed-rollback deploy (T5-F04). "What version is prod on?" is currently answered by faith.
**Effort:** M (falls out of T5-F01's version table almost for free). **Plan:** Version tracking + a read-only `migrate:status` command diffing applied keys and dumping `pg_catalog` fingerprints; wire into the deploy workflow as an informational step.
**Confidence:** High.

---

**T5-F12 | Dead code in the DB layer: `PgDatabaseClient`/`connection.ts`, `makePoliciesIdempotent` | Refactor | LOW**
**Evidence:** `db/client.ts` (`PgDatabaseClient`, `getDbClient`) referenced by no file outside itself; `db/connection.ts` imported only by `client.ts`; `makePoliciesIdempotent` (`schema.ts:6244`) shadowed by the inline rewrite in `getMigrationSQL`.
**Effort:** S. **Plan:** Delete all three per the CLAUDE.md dead-code rule.
**Confidence:** High.

---

## Explicitly verified solid (no finding warranted)

- **SET LOCAL vs PgBouncer transaction pooling:** correct and *tested* — `set_config(..., true)` inside explicit `BEGIN` on the pooled DSN; session-dependent primitives (leader locks `app.ts:2299`, idempotency locks, LISTEN/NOTIFY) isolated on `DATABASE_DIRECT_URL` (`pool.ts:44-72`), including the migrator itself (`migrate.ts:91-98`). Pinned by `pgbouncer-tenant-isolation.test.ts` and `direct-pool-session-locks.test.ts`.
- **RLS test depth:** read isolation, write invisibility, INSERT forgery rejection, provisioning-secret isolation, unknown-tenant enumeration, *plus* a live-catalog FORCE sweep and a static text-parse guard — all PR-gated.
- **Commit/rollback lifecycle:** commit-only-on-<400, rollback on client disconnect, idempotent cleanup, after-commit hooks (`tenant-context.ts:200-254`), savepoints for partial-failure recovery — unusually careful.
- **Deprovision:** dynamic discovery of all `tenant_id` tables, identifier-regex guarded, `rows_deleted` audit into the RLS-exempt `platform_deprovision_log`, Twilio release ordering with `force` escape hatch.

## Could not verify

- **Actual prod row counts, table sizes, index usage, autovacuum behavior** — no live DB access; all scale estimates derived from the 1,000-concurrent design target.
- **Whether the deployed Railway environment actually sets `RLS_RUNTIME_ROLE=true` and `DATABASE_DIRECT_URL`** — the code *requires* the former at boot in prod/staging, but Railway env vars aren't visible; if `NODE_ENV` were mis-set, RLS enforcement would silently rest on app-layer filters.
- **Whether PgBouncer is actually deployed in front of prod Postgres today** — `railway.toml` comments describe it as the multi-replica scaling step (`numReplicas = 1` currently); `deploy/docker-compose.prod.yml` topology is stated to be operator-validated, not CI-validated (`docs/deployment.md:274-276`).
- **Simple-protocol `statement_timeout` semantics for the multi-statement corpus** (whole-message vs per-statement) — affects only *when* T5-F01 bites, not whether.
- **Exact per-route upstream-await inventory for T5-F03** — exemption list and representative Stripe/Google call sites confirmed; not all ~400 handler paths traced.
- **`serviceos_training` Supabase pipeline's data flow** (whether prod PII reaches it pre-scrub) — see Track 6; `scrub_pii.py` exists but its deployment was not audited here.
