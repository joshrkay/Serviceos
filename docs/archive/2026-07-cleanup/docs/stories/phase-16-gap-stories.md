# Phase 16 — Customer Unit Economics + Lifecycle Marketing

> **3 stories** | The "is this customer profitable, and how do we keep them?" layer

---

## Purpose

Serviceos has the raw data for unit-economics analysis but no view that pulls it together. Owners cannot answer:
- "Is this customer profitable?" (lifetime revenue minus cost-to-serve)
- "Which marketing channel is paying off?" (CAC per source vs revenue per source)
- "Which customers should I win back?" (haven't called in N days, prior LTV > $threshold)

Phase 16 closes the loop with three stories:
- **P16-001** — Customer LTV view per customer + tenant-wide top-N table
- **P16-002** — Marketing spend tracking and CAC computation per lead source
- **P16-003** — Outbound re-engagement campaign engine (segment + schedule + send + attribute)

## Exit Criteria

- Owner opens a customer detail page and sees: lifetime revenue, job count, avg ticket, total cost-to-serve (AI sessions + SMS dispatches + lookup calls), days since last job, lead source, attributed CAC.
- Owner enters monthly marketing spend per channel (Google Ads $500, Yelp $150, etc.); dashboard shows leads-per-source, CAC, and revenue-per-source ratio.
- Owner creates a segment ("customers where last_job_at < 90 days ago AND lifetime_revenue_cents > 50000") and schedules an SMS campaign; system sends, tracks open/reply, and attributes any new bookings to the campaign.

## Foundations already in place

- `JobRepository.findByCustomer` (P11-001) — already exists on main
- `originating_lead_id` FK chain on customers/jobs/invoices (PR #228)
- `leads.utm_source/medium/campaign` + `attribution` JSONB (PR #228)
- `lookup_events` table (P11-001) — per-call AI cost surrogate
- `SessionCostTracker` (`packages/api/src/ai/skills/session-cost-tracker.ts`) — per-voice-session token + cost
- `RevenueBySourcePage` — already slices revenue by lead source
- `notifications/send-service` — for outbound SMS
- `customer_credits` (P15-003 designed) — referral rewards apply here

---

## Story Specifications

### P16-001 — Customer LTV view + tenant-wide unit economics dashboard

> **Size:** L | **Layer:** Analytics + UI | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** none functional (read-only aggregator over existing entities)

**Allowed files:** `packages/api/src/customer-economics/**, packages/api/src/routes/customer-economics.ts, packages/api/src/db/schema.ts (migration 077 only — view + indexes), packages/api/src/app.ts (wiring only), packages/api/src/customer-economics/__tests__/**, packages/api/test/customer-economics/**, packages/web/src/pages/customers/CustomerEconomics.tsx, packages/web/src/components/customers/CustomerEconomicsCard.tsx, packages/web/src/components/customers/__tests__/CustomerEconomicsCard.test.tsx, packages/web/src/pages/reports/UnitEconomicsDashboard.tsx, packages/web/src/components/reports/UnitEconomicsDashboard.test.tsx, packages/web/src/pages/customers/CustomerDetail.tsx (add Economics section only), packages/web/src/api/customer-economics.ts, packages/web/src/routes.ts (add /reports/unit-economics only)`

**Build prompt:** Build per-customer + tenant-wide unit-economics views.

(1) **Migration `077_create_customer_economics_view`** — a Postgres VIEW (not table) that aggregates per customer:
   ```sql
   CREATE OR REPLACE VIEW customer_economics_v1 AS
   SELECT
     c.tenant_id, c.id AS customer_id, c.display_name,
     c.originating_lead_id,
     (SELECT COUNT(*) FROM jobs j WHERE j.tenant_id=c.tenant_id AND j.customer_id=c.id) AS job_count,
     (SELECT COALESCE(SUM(i.totals_total_cents), 0)
        FROM invoices i WHERE i.tenant_id=c.tenant_id AND i.customer_id=c.id AND i.status='paid') AS lifetime_revenue_cents,
     (SELECT MAX(j.created_at) FROM jobs j WHERE j.tenant_id=c.tenant_id AND j.customer_id=c.id) AS last_job_at,
     (SELECT COUNT(*) FROM lookup_events e WHERE e.tenant_id=c.tenant_id AND e.customer_id=c.id) AS ai_lookup_count,
     (SELECT COALESCE(SUM(s.cost_cents), 0) FROM session_costs s WHERE s.tenant_id=c.tenant_id AND s.customer_id=c.id) AS ai_cost_cents,
     (SELECT COUNT(*) FROM message_dispatches m WHERE m.tenant_id=c.tenant_id AND m.customer_id=c.id) AS sms_count
   FROM customers c WHERE c.is_archived = false;
   ```
   (Names may need fixup per actual columns — discover at dispatch time.) Plus indexes to support the underlying SUMs/COUNTs (most likely already present).

(2) **Service:** `customer-economics-service.ts` exposes `getCustomerEconomics(tenantId, customerId)` returning `CustomerEconomics` with derived fields:
   - `lifetimeRevenueCents`
   - `jobCount`
   - `avgTicketCents` (revenue / count)
   - `lastJobAt` (Date | null)
   - `daysSinceLastJob` (number | null)
   - `aiLookupCount`
   - `aiCostCents`
   - `smsCount`
   - `costToServeCents` (aiCostCents + estimated SMS cost — start with $0.01/SMS; tenant-configurable later)
   - `netCents` (lifetimeRevenueCents − costToServeCents − attributedCacCents — see P16-002)
   - `leadSource` (from originating lead) + `leadSourceDetail`
   - `cacCents` (filled in by P16-002 when present; null otherwise)
   - `healthScore` (composite 0-100 — frequency last 90d + recency + monetary tier; document the formula in code)

   Also exposes `getTenantTopCustomers(tenantId, opts: { sortBy: 'ltv'|'recent'|'health', limit })` returning the top N from the view.

(3) **Routes:**
   - `GET /api/customers/:id/economics` — owner-only
   - `GET /api/reports/unit-economics?sortBy=&limit=` — owner-only, returns top customers

(4) **Web:**
   - `CustomerEconomicsCard.tsx` — card with revenue/cost/net + 6 sub-metrics, mounted in a new "Economics" section on CustomerDetail
   - `UnitEconomicsDashboard.tsx` — table of top N customers, sortable; route at `/reports/unit-economics`
   - All money via `formatCents`; days as relative ("23 days ago")

**Review prompt:** Verify the VIEW is a Postgres view (not materialized) so reads are always current; if perf bites, document MV upgrade path. Verify owner-only authorization (inline guard, do NOT modify rbac.ts). Verify health-score formula is reproducible in tests. Verify tenant isolation via existing RLS. Verify customer with zero activity returns zeros (not null/undefined).

**Required tests:**
- Customer with 5 paid jobs → revenue = sum of totalCents
- Customer with no jobs → all zeros, daysSinceLastJob=null
- AI cost aggregates from session_costs scoped to customer
- Tenant isolation across all routes
- Health score: known input → known output (lock the formula)
- Top-N sort by LTV vs recency vs health
- Owner-only — dispatcher gets 403

---

### P16-002 — Marketing spend + CAC per channel

> **Size:** M | **Layer:** Analytics | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P16-001 (CustomerEconomics receives `cacCents` from this story)

**Allowed files:** `packages/api/src/marketing-spend/**, packages/api/src/routes/marketing-spend.ts, packages/api/src/db/schema.ts (migration 078 only), packages/api/src/app.ts (wiring only), packages/api/src/customer-economics/customer-economics-service.ts (modify — populate cacCents), packages/api/src/marketing-spend/__tests__/**, packages/api/test/marketing-spend/**, packages/web/src/pages/settings/MarketingSpendSettings.tsx, packages/web/src/components/reports/CacByChannelCard.tsx, packages/web/src/components/reports/__tests__/CacByChannelCard.test.tsx, packages/web/src/pages/reports/UnitEconomicsDashboard.tsx (add CAC card only), packages/web/src/api/marketing-spend.ts`

**Build prompt:**

(1) **Migration `078_create_marketing_spend`:**
   ```sql
   CREATE TABLE IF NOT EXISTS marketing_spend (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id UUID NOT NULL REFERENCES tenants(id),
     period_start DATE NOT NULL,    -- typically month-start
     period_end DATE NOT NULL,      -- typically month-end
     channel TEXT NOT NULL,         -- e.g. 'google_ads', 'yelp', 'facebook', 'referral_program', 'other'
     utm_source TEXT,               -- optional fine-grain (matches leads.utm_source)
     utm_campaign TEXT,             -- optional
     amount_cents BIGINT NOT NULL,
     notes TEXT,
     created_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (tenant_id, period_start, channel, utm_source, utm_campaign)
   );
   CREATE INDEX IF NOT EXISTS idx_marketing_spend_tenant_period
     ON marketing_spend (tenant_id, period_start);
   ALTER TABLE marketing_spend ENABLE ROW LEVEL SECURITY;
   ALTER TABLE marketing_spend FORCE ROW LEVEL SECURITY;
   DROP POLICY IF EXISTS tenant_isolation_marketing_spend ON marketing_spend;
   CREATE POLICY tenant_isolation_marketing_spend ON marketing_spend
     USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
   ```

(2) **Service `marketing-spend-service.ts`:**
   - CRUD: `recordSpend`, `updateSpend`, `deleteSpend`, `listSpend(tenantId, periodFrom, periodTo)`
   - `getCacByChannel(tenantId, periodFrom, periodTo)` — for each channel: `cac = sum(amount_cents) / count(distinct leads.id WHERE leads.created_at IN [period] AND matches channel)`. Returns `{ channel, spendCents, leadCount, cacCents, customerCount, ltv90Cents }[]`. Match channel via `leads.source` for direct channels (referral, walk_in) and `leads.utm_source/campaign` for digital.
   - `getCustomerAttributedCac(tenantId, customerId)` — finds the lead that originated this customer, looks up the spend record covering the lead's creation period and matching channel, divides spend by leads-in-period to get CAC. Returns null if no matching spend record.

(3) **Routes:**
   - `POST/GET/PATCH/DELETE /api/marketing-spend` — owner-only
   - `GET /api/reports/cac-by-channel?from=&to=` — owner-only

(4) **CustomerEconomics integration** — `customer-economics-service.ts` calls `getCustomerAttributedCac` and populates `cacCents` and updates `netCents` accordingly. **This is the only allowed cross-story modification.** Document.

(5) **Web:**
   - `MarketingSpendSettings.tsx` — table with monthly spend rows; add/edit/delete; sum at bottom
   - `CacByChannelCard.tsx` — bar/table on UnitEconomicsDashboard showing CAC + LTV ratio per channel

**Review prompt:** Verify channel matching logic handles missing UTMs gracefully (channel='other' bucket). Verify period-overlap math for monthly spend (calendar month). Verify tenant isolation. Verify CAC = spend / leads, NOT spend / customers (subtle but matters: not every lead converts). Verify ratio rendering (LTV : CAC) — flag with red if LTV < 3× CAC (industry rule of thumb).

**Required tests:**
- Record spend, retrieve, update, delete
- CAC computation: $500 spend / 25 leads = $20 CAC
- Channel matching: utm_source='google' lead matches `channel='google_ads'`
- Period boundary: spend in May, lead in April → not attributed
- Customer with no UTM/source mapping returns null cac
- Tenant isolation
- LTV:CAC ratio rendering with color coding

---

### P16-003 — Outbound re-engagement campaign engine

> **Size:** L | **Layer:** Marketing | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P16-001 (uses customer_economics_view for segment queries), P15-004 (SMS auto-reply — same send-service path)

**Allowed files:** `packages/api/src/campaigns/**, packages/api/src/routes/campaigns.ts, packages/api/src/db/schema.ts (migration 079 only), packages/api/src/app.ts (wiring + worker registration), packages/api/src/workers/campaign-worker.ts, packages/api/src/campaigns/__tests__/**, packages/api/test/campaigns/**, packages/api/test/workers/campaign-worker.test.ts, packages/web/src/pages/campaigns/**, packages/web/src/components/campaigns/**, packages/web/src/api/campaigns.ts, packages/web/src/routes.ts (add /campaigns + /campaigns/:id only)`

**Build prompt:**

(1) **Migration `079_create_campaigns`** — TWO tables.
   ```sql
   CREATE TABLE IF NOT EXISTS campaigns (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id UUID NOT NULL REFERENCES tenants(id),
     name TEXT NOT NULL,
     channel TEXT NOT NULL CHECK (channel IN ('sms','email')),
     -- Segment definition: subset of SQL-WHERE-style predicates over customer_economics_v1.
     -- Stored as a structured JSON object, not raw SQL (security).
     segment_definition JSONB NOT NULL,
     message_template TEXT NOT NULL,  -- supports {{first_name}}, {{days_since_last_job}}, {{tenant_name}}
     short_url_target TEXT,           -- optional; click-tracked via /c/:requestId redirect
     status TEXT NOT NULL CHECK (status IN ('draft','scheduled','running','completed','cancelled')),
     scheduled_for TIMESTAMPTZ,
     sent_at TIMESTAMPTZ,
     created_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );
   CREATE TABLE IF NOT EXISTS campaign_dispatches (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id UUID NOT NULL REFERENCES tenants(id),
     campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
     customer_id UUID NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending','sent','clicked','replied','failed','skipped_consent')),
     message_dispatch_id UUID,        -- FK to message_dispatches (existing) when sent
     sent_at TIMESTAMPTZ,
     clicked_at TIMESTAMPTZ,
     replied_at TIMESTAMPTZ,
     attributed_job_id UUID,          -- if a job is created within attribution_window_days, link here
     attributed_revenue_cents BIGINT,
     error_message TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (tenant_id, campaign_id, customer_id)
   );
   ```
   RLS on both. Indexes per usual pattern.

(2) **Segment language** — small structured DSL stored in `segment_definition` JSONB:
   ```ts
   {
     and: [
       { field: 'days_since_last_job', op: 'gte', value: 90 },
       { field: 'lifetime_revenue_cents', op: 'gte', value: 50000 },
       { field: 'sms_consent', op: 'eq', value: true }
     ]
   }
   ```
   Service `segment-evaluator.ts` translates the DSL to a parameterized SQL WHERE clause against `customer_economics_v1` (joined to customers for `sms_consent`). **NEVER** accept raw SQL strings — only the DSL.

(3) **Service `campaign-service.ts`:**
   - `createCampaign(tenantId, input)` — validates DSL via `segment-evaluator.validate`, persists draft
   - `previewSegment(tenantId, segmentDefinition, opts: { limit })` — runs the query, returns a sample (max 50 rows) so the owner can sanity-check before sending
   - `scheduleCampaign(tenantId, campaignId, when)` — sets status='scheduled', scheduled_for=when
   - `cancelCampaign(tenantId, campaignId)` — sets status='cancelled', stops worker pickup
   - `runCampaign(tenantId, campaignId)` — called by worker: query segment, for each customer (skipping those without `sms_consent` → status='skipped_consent'), insert `campaign_dispatches` row + dispatch via send-service. Idempotent via UNIQUE constraint.
   - `recordClick(tenantId, dispatchId)` — called by `/c/:dispatchId` redirect endpoint
   - `attributeBookings(tenantId)` — periodic job that finds campaign_dispatches sent in last `attribution_window_days` (default 14) where customer subsequently created a job; updates `attributed_job_id` and `attributed_revenue_cents`

(4) **Worker `campaign-worker.ts`** — every 5 min, finds campaigns where `status='scheduled' AND scheduled_for <= now()`, sets status='running', calls `runCampaign`, sets status='completed'. Also runs `attributeBookings` once per hour.

(5) **Routes:**
   - `POST /api/campaigns` — create draft
   - `GET /api/campaigns` — list with filters
   - `GET /api/campaigns/:id` — detail with dispatch counts (sent/clicked/replied/attributed)
   - `PATCH /api/campaigns/:id` — edit while in draft
   - `POST /api/campaigns/:id/preview` — preview segment match
   - `POST /api/campaigns/:id/schedule` — body: `{ when: ISO }`
   - `POST /api/campaigns/:id/cancel`
   - `GET /c/:dispatchId` — public, no auth, redirects to `short_url_target`, records click

(6) **Web:**
   - `CampaignList.tsx` (table)
   - `CampaignCreate.tsx` (form: name + channel + message + segment builder UI + preview button + schedule)
   - `CampaignDetail.tsx` (status + dispatch table + attribution metrics: sent count, click rate, reply rate, attributed-revenue-cents)
   - `SegmentBuilder.tsx` (DSL UI — field dropdown, op dropdown, value input; AND-group; OR-group)

**Review prompt:** Verify SMS consent honored (status='skipped_consent', no SMS sent). Verify STOP-list honored (P15-004 keyword opt-out). Verify rate-limit (max 1 campaign SMS per customer per 7 days globally; tenant-overridable). Verify segment DSL rejects raw SQL. Verify attribution window correct (job created BETWEEN sent_at AND sent_at + 14 days; first job only). Verify `/c/:dispatchId` redirect validates host (HTTPS + tenant-allowed list). Verify message template variable substitution doesn't leak tenant data on missing customer.

**Required tests:**
- Create campaign with DSL segment; preview returns matching customers
- DSL with AND group narrows correctly
- DSL rejects unknown field/op (validation error)
- Schedule + worker run sends dispatches
- Customer without sms_consent → status='skipped_consent', no SMS dispatched
- Idempotency: re-running same campaign for same customer no-ops
- Click endpoint records clicked_at, redirects 302
- Attribution: customer creates job 7 days after dispatch → attributed_job_id set
- Attribution window respected: job after window → not attributed
- Tenant isolation across all routes
