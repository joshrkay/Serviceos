# Phase 16 (Customer Unit Economics + Lifecycle Marketing) — Multi-Agent Dispatch Addendum

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 16A | P16-001 LTV view | single agent (foundational — VIEW + service + UI surface) | unlocks 16B (CAC writes into CustomerEconomics) |
| 16B | P16-002 marketing spend + CAC | single agent (modifies P16-001 service to populate cacCents — minor cross-touch) | unlocks 16C |
| 16C | P16-003 campaign engine | single agent (segment evaluator queries customer_economics_v1) | sprint complete |

All three are sequential because each builds on the previous. P16-002 is the only cross-story modifier — it edits one method on `customer-economics-service.ts`. P16-003 reads the view but doesn't modify any prior code.

## Migration ledger

- 077: P16-001 `customer_economics_v1` VIEW
- 078: P16-002 `marketing_spend` table
- 079: P16-003 `campaigns` + `campaign_dispatches` tables

---

## P16-001 — Customer LTV view + tenant-wide unit economics dashboard

**Wave:** 16A
**Migration number reserved:** 077
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/auth/rbac.ts`
- `packages/api/src/customers/customer.ts` (interface — do NOT modify)
- `packages/api/src/jobs/**`, `packages/api/src/invoices/**`, `packages/api/src/payments/**` (READ ONLY — query through existing repos OR via the VIEW)
- `packages/api/src/lookup-events/**` (READ ONLY)
- `packages/web/src/components/auth/**`

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "customer-economics|unit-economics|P16-001") && \
  (cd packages/web && npm test -- --run -t "CustomerEconomics|UnitEconomics|P16-001")
```

**Risk note:**
- **VIEW perf**: a Postgres VIEW recomputes on every read. For tenants with 10k+ customers, the dashboard query may need to switch to a MATERIALIZED VIEW with periodic refresh. Document the upgrade path; do NOT pre-optimize.
- **Schema discovery**: actual column names on `invoices`, `session_costs`, `message_dispatches` may differ from this story's draft. The agent MUST grep schema.ts at dispatch time and adjust the VIEW SQL.
- **`session_costs` table existence**: if the existing `SessionCostTracker` doesn't persist to a table (just in-memory or audit-log), this story needs to either skip `ai_cost_cents` (return 0) or add a small migration to persist costs. Discover at dispatch time. If skipped, document.
- **Health score formula**: write it as a pure TS function, not in SQL. Document the weights inline.
- **Owner-only**: inline guard, do NOT touch rbac.ts.

**Implementation hints:**
1. Read `packages/api/src/db/schema.ts` for actual table/column names BEFORE writing the VIEW.
2. Check if `session_costs` table exists — if not, the agent has to add a small migration as part of 077 to create it (with `tenant_id, session_id, customer_id, cost_cents, created_at`) and wire `SessionCostTracker` to insert into it.
3. Read `packages/api/src/dispatch/analytics.ts` for the existing analytics pattern.

---

## P16-002 — Marketing spend + CAC per channel

**Wave:** 16B (after 16A merges)
**Migration number reserved:** 078
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/auth/rbac.ts`
- `packages/api/src/leads/**` (READ ONLY — query for UTM/source matching)
- `packages/web/src/components/auth/**`

**Cross-story modification (allowed, scoped):**
- `packages/api/src/customer-economics/customer-economics-service.ts` — modify `getCustomerEconomics` to call `getCustomerAttributedCac` and populate `cacCents` + recompute `netCents`. NO other changes to that file.

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "marketing-spend|cac|P16-002") && \
  (cd packages/web && npm test -- --run -t "MarketingSpend|CacByChannel|P16-002")
```

**Risk note:**
- **Channel matching ambiguity**: a lead with `source='referral'` AND `utm_source='google'` should match which spend record? Decision: prefer `source` for direct channels (referral, walk_in, phone_call) and `utm_source/campaign` only for digital `source='web_form'`. Document.
- **Period overlap**: spend rows store `[period_start, period_end]`. A lead created on May 31 attributes to that month's spend (calendar month boundary).
- **Division by zero**: if a channel has spend but zero leads in period, CAC is undefined (return null, not Infinity).
- **LTV : CAC ratio**: industry rule is healthy if LTV ≥ 3× CAC. Color-code accordingly in UI.
- **Privacy**: marketing spend is sensitive financial data — owner-only.

**Implementation hints:**
1. The CAC math is: `SUM(spend WHERE period_overlaps_lead.created_at AND channel_matches) / COUNT(distinct leads in period in channel)`.
2. Customer-attributed CAC: find the originating lead, look up its channel + creation period, divide that period's spend by the period's lead count.

---

## P16-003 — Outbound re-engagement campaign engine

**Wave:** 16C (after 16B merges)
**Migration number reserved:** 079
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/auth/rbac.ts`
- `packages/api/src/notifications/**` (READ ONLY — call existing send-service)
- `packages/api/src/customers/**` (READ ONLY)
- `packages/api/src/jobs/**` (READ ONLY)
- `packages/api/src/customer-economics/**` (READ ONLY — query the VIEW directly)
- `packages/web/src/components/auth/**`

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "campaign|segment-evaluator|P16-003") && \
  (cd packages/web && npm test -- --run -t "Campaign|SegmentBuilder|P16-003")
```

**Risk note:**
- **DSL not raw SQL**: `segment_definition` is JSONB structured DSL. The evaluator translates to parameterized SQL. **Never** accept raw SQL strings — that's an injection risk.
- **SMS consent**: hard rule — `customer.sms_consent=false` → never dispatched (status='skipped_consent'). Owner override NOT allowed.
- **STOP keyword (P15-004)**: respected. If P15-004 not yet merged, fall back to a hardcoded STOP-list check via a new lightweight repo method.
- **Rate limit**: max 1 campaign SMS per customer per 7 days globally. Stored in a small in-memory bucket OR queried from `campaign_dispatches WHERE sent_at > now() - 7 days`.
- **Attribution window**: 14 days default; first job only counts. Document.
- **Click endpoint security**: `/c/:dispatchId` validates the dispatch exists, then 302 to `short_url_target`. Validate that `short_url_target` is HTTPS and from a tenant-saved allowlist (or simply tenant's review_url field, etc.).
- **Message template substitution**: rendered via a safe templater — `{{customer.first_name}}` ONLY pulls from the customer record; missing fields → empty string (don't crash, don't leak other tenants).
- **Idempotency**: UNIQUE (tenant_id, campaign_id, customer_id) on dispatches.

**Implementation hints:**
1. Read `packages/api/src/notifications/send-service.ts` for the dispatch path.
2. Read `packages/api/src/workers/recurring-agreements-worker.ts` for the worker pattern (P9-003 baseline).
3. The segment DSL is intentionally limited — only AND/OR, eq/gte/lte/contains ops, fields whitelisted to columns on `customer_economics_v1` + `customers.sms_consent`. Reject anything else.
4. UI segment builder: nested AND/OR groups with a tree of `Predicate | Group` nodes. Render flat for v1; allow nested in v2.
