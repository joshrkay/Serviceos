# Phase 10 — CRM Tier 2: Portal, Dashboard, Reviews

> **3 stories** | Tier-2 CRM features after Phase 9 (leads / timeline / agreements) shipped

---

## Purpose

Phase 9 closed the largest service-CRM gaps (lead pipeline, unified comms, recurring agreements). Phase 10 adds the highest-leverage Tier-2 features: **customer self-service**, **owner visibility**, and **review-driven growth**.

## Exit Criteria

- A customer with a one-click portal link can view all their estimates, invoices, jobs, agreements, and tech ETA without logging in.
- Owners can open a single dashboard and see revenue trend, pipeline value, conversion rate, AR aging, and tech utilization for any date range.
- After job completion, the system auto-sends a review-request SMS/email at a configurable delay; clicks route to the tenant's Google review URL.

## Gap Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P10-001 | Customer self-service portal (single token, all entities) | M | Customer-facing | Medium | Heavy | P9-001..003 |
| P10-002 | Executive dashboard (revenue, pipeline, AR aging, tech utilization) | M | Analytics | High | Moderate | P9-001 (leads pipeline value) |
| P10-003 | Post-job review request automation | S | Marketing | High | Light | P0-009 (worker), existing notifications/send-service |

---

## Story Specifications

### P10-001 — Customer self-service portal (single token, all entities)

> **Size:** M | **Layer:** Customer-facing | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P9-001..003

**Allowed files:** `packages/api/src/portal/**, packages/api/src/routes/portal.ts, packages/api/src/routes/public-portal.ts, packages/api/src/db/schema.ts (migration 059 only), packages/api/src/app.ts (wiring only), packages/web/src/pages/portal/**, packages/web/src/components/portal/**, packages/api/src/portal/__tests__/**, packages/web/src/pages/portal/__tests__/**`

**Build prompt:** Build a unified customer self-service portal accessed via a single signed token, scoped to one customer (not a single estimate/invoice). (1) **Schema:** migration `059_create_portal_sessions` — table `portal_sessions` with `id, tenant_id, customer_id (FK), token (text, unique, randomly-generated 32-byte hex), expires_at (timestamptz), revoked_at (timestamptz, nullable), last_accessed_at (timestamptz, nullable), created_by, created_at`. RLS by tenant. Add `idx_portal_token` (UNIQUE) for token lookups. (2) **Service:** `portal/portal-service.ts` — `createPortalSession(tenantId, customerId, ttlDays = 30)`, `resolvePortalToken(token) → { tenantId, customerId } | null` (system-level via `withClient()`, validates expiry + revocation), `revokePortalSession(tenantId, sessionId)`. (3) **Routes (authed — owner sends portal link):** `POST /api/customers/:id/portal-session` returns `{ url: string, token: string, expiresAt: ISO }`. URL format: `https://<host>/portal/<token>`. (4) **Public routes** (no Clerk auth — token-gated middleware that calls `resolvePortalToken` and sets `tenantId + customerId` on the request): `GET /api/public/portal/:token/customer` (customer fields, archived omitted), `GET /api/public/portal/:token/estimates` (list of customer's estimates), `GET /api/public/portal/:token/invoices` (list with `payNowUrl`), `GET /api/public/portal/:token/jobs` (list, status + next appointment), `GET /api/public/portal/:token/agreements` (active recurring services), `GET /api/public/portal/:token/appointments?upcoming=true` (with tech ETA when available), `POST /api/public/portal/:token/request-service` (creates a lead under the existing tenant with `source='customer_portal'`, body validated by Zod). (5) **Web** (no auth — routed at `/portal/:token`): `PortalShell.tsx` (loads customer + nav), `PortalDashboard.tsx` (cards: open invoices, upcoming appointments, active agreements, "Request service" button), `PortalEstimateList.tsx`, `PortalInvoiceList.tsx`, `PortalJobList.tsx`, `PortalRequestService.tsx` (form). All public pages tenant-branded via the existing tenant settings (logo, name) — read once at portal load. (6) **Wire** in `app.ts` next to existing public routes.

**Review prompt:** Verify token is cryptographically random (`crypto.randomBytes(32).toString('hex')`), stored ONLY hashed (compare via constant-time). Verify the public middleware enforces tenant scoping for every downstream query — there is no Clerk auth, the token IS the auth. Verify the `request-service` endpoint creates a lead in the *correct* tenant (the one bound to the token, not user-supplied). Verify revoked or expired tokens return 401, never partial data. Verify rate limiting on the public endpoints (the existing `rateLimitMiddleware` if present, else a simple per-token bucket). Check that the portal does NOT expose archived/cancelled records. Money: amounts displayed in dollars but stored in cents.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- -t "portal|P10-001"
cd packages/web && npm test -- --run -t "Portal|P10-001"
```

**Required tests:**
- [ ] Create portal session returns URL with token; second call creates a NEW session (no implicit reuse)
- [ ] Resolve token returns tenantId+customerId for valid; null for expired, revoked, or unknown
- [ ] Public middleware rejects requests without/with bad token (401)
- [ ] Tenant isolation — a token from tenant A can NEVER access tenant B's records (test by hand-crafting a request with a B-customerId)
- [ ] `request-service` creates a lead in the bound tenant with `source='customer_portal'`
- [ ] Rate limiting — burst of 100 requests in 10s gets throttled
- [ ] Portal pages render correctly with tenant branding
- [ ] Token hashed at rest (the raw token is never queryable from the DB after creation)

---

### P10-002 — Executive dashboard (revenue, pipeline, AR aging, tech utilization)

> **Size:** M | **Layer:** Analytics | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P9-001 (leads.estimated_value_cents drives pipeline value)

**Allowed files:** `packages/api/src/dashboard/**, packages/api/src/routes/dashboard.ts, packages/api/src/app.ts (mount route only), packages/api/src/dashboard/__tests__/**, packages/web/src/pages/dashboard/**, packages/web/src/components/dashboard/**, packages/web/src/pages/dashboard/__tests__/**`

**Build prompt:** Build the owner-facing executive dashboard. No schema changes — query-time aggregation across existing entities. (1) **Service:** `dashboard/dashboard-service.ts` exposes `getDashboard(tenantId, range: { from: Date; to: Date }, tz: string) → DashboardSnapshot`. The `DashboardSnapshot` includes: `revenue: { totalCents, byDay: { date, cents }[], comparedToPrevious: { changePct } }`, `pipeline: { stageCounts: Record<LeadStage, number>, totalEstimatedCents }`, `conversion: { leadsCreated, leadsConverted, conversionRatePct }`, `arAging: { current, days30, days60, days90Plus, all in cents, count + sum }`, `techUtilization: { userId, name, totalAppointments, completedAppointments, hoursScheduled, utilizationPct }[]`, `agreements: { active, upcoming30d, mrrCents }`. All queries fan out via `Promise.all`; reuse existing repo methods (do NOT touch source repos). (2) **Route:** `GET /api/dashboard?from=ISO&to=ISO&tz=America/Los_Angeles`. Owner-only (use `requirePermission('reports:view')` if exists, else add an `owner` role check via `req.auth.role === 'owner'`; do NOT modify rbac.ts). Cap `to-from <= 365 days`. Cache headers `Cache-Control: private, max-age=300`. (3) **Web:** `DashboardPage.tsx` mounts the cards. Card components in `components/dashboard/`: `RevenueCard.tsx` (sparkline + delta vs prior period), `PipelineCard.tsx` (stage funnel + total $$$), `ConversionCard.tsx` (rate + count), `AgingCard.tsx` (4-bucket bar), `UtilizationCard.tsx` (table sorted by utilization desc), `AgreementsCard.tsx` (MRR + counts). Date-range picker at top (presets: today/7d/30d/90d/QTD/YTD; default 30d). All money rendered via `formatCents`. (4) **Wire** in `app.ts` mount only; do NOT add it to the customer or job routers.

**Review prompt:** Verify all queries fan out in parallel. Verify the date range cap is enforced (>365 days returns 400). Verify tz is honored — "today" in PST is different from UTC. Verify revenue counts paid invoices only (status='paid'); verify AR aging counts unpaid only (status in 'sent','overdue'). Verify pipeline value sums `leads.estimated_value_cents` across non-terminal stages (excludes won + lost). Verify tech utilization divides by working hours (8h default per active day). Check performance — full dashboard for a 90-day range with 10k records should render in <2s. Owner-only: a dispatcher token gets 403.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- -t "dashboard|P10-002"
cd packages/web && npm test -- --run -t "Dashboard|P10-002"
```

**Required tests:**
- [ ] Returns merged snapshot with all 6 sections
- [ ] Date range cap enforced (>365 days → 400)
- [ ] Tz boundary — "today" in PST returns different events than "today" in UTC
- [ ] Revenue counts paid invoices only
- [ ] AR aging buckets by `dueDate`
- [ ] Pipeline value excludes won + lost stages
- [ ] Conversion rate = converted / created in range
- [ ] Tech utilization sorted desc by utilizationPct
- [ ] Owner-only — dispatcher gets 403
- [ ] Tenant isolation across all six sections

---

### P10-003 — Post-job review request automation

> **Size:** S | **Layer:** Marketing | **AI Build:** High | **Human Review:** Light

**Dependencies:** P0-009 (worker pattern), existing `notifications/send-service`

**Allowed files:** `packages/api/src/reviews/**, packages/api/src/routes/reviews.ts, packages/api/src/db/schema.ts (migration 060 only), packages/api/src/app.ts (wiring + worker registration), packages/api/src/workers/review-request-worker.ts, packages/api/src/reviews/__tests__/**, packages/web/src/pages/settings/ReviewSettings.tsx, packages/web/src/pages/settings/__tests__/ReviewSettings.test.tsx, packages/web/src/components/reviews/**, packages/web/src/components/reviews/__tests__/**`

**Build prompt:** Auto-send a review-request message after a job completes. (1) **Schema:** migration `060_create_review_requests` — table `review_requests` with `id, tenant_id, customer_id (FK), job_id (FK), channel (enum: sms, email), status (enum: scheduled, sent, clicked, failed, skipped), scheduled_for (timestamptz), sent_at (timestamptz, nullable), clicked_at (timestamptz, nullable), message_dispatch_id (uuid, nullable, FK to message_dispatches), error_message (text, nullable), created_at`. RLS. Plus add `review_url` (text, nullable) and `review_request_delay_hours` (int, default 4) and `review_request_enabled` (bool, default false) to the existing `tenant_settings` table — additive ALTER, no breakage. (2) **Service:** `reviews/review-service.ts` — `scheduleReviewRequest(tenantId, jobId)` is called from job completion (subscribe to existing `job.completed` event in jobsService — discover the hook by reading `jobs/job-lifecycle.ts`; if no event bus exists, expose the function as a callback that the job completion path invokes). Uses existing `notifications/send-service` to format message ("How was your service today? <name> from <tenant> would love a review: <reviewUrl>?rid=<requestId>"). Idempotent — calling twice for the same job no-ops. (3) **Worker:** `workers/review-request-worker.ts` runs every 5 min, finds rows with `status='scheduled' AND scheduled_for <= now()`, dispatches via `send-service`, sets `status='sent'`, records `message_dispatch_id`. On failure: `status='failed'` + `error_message`. (4) **Route:** `GET /r/:requestId` (public, NO auth) — sets `clicked_at = now()` (idempotent), 302 redirects to the tenant's `review_url`. If no `review_url` configured, 302 to a fallback "thank you" page. (5) **Settings UI:** `ReviewSettings.tsx` (in tenant settings page) — toggle enabled, delay-hours numeric input, review URL text input with validation (must be a Google/Yelp/Facebook review URL — soft validation, not hard), preview of the SMS body.

**Review prompt:** Verify idempotency at schedule time (UNIQUE constraint on `(job_id, status='scheduled')` OR app-level check). Verify the redirect endpoint records `clicked_at` exactly once even if the URL is opened 100 times (subsequent calls don't update). Verify SMS consent — do NOT send if `customer.smsConsent === false`. Verify email path is gated by a separate consent flag (or the existing email_consent if present). Verify the `?rid=` link is short enough to fit in SMS (160 char budget). Tenant isolation across all routes. The redirect endpoint must validate that the requestId exists; do not 302 unauthenticated traffic to arbitrary URLs.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- -t "review|P10-003"
cd packages/web && npm test -- --run -t "Review|P10-003"
```

**Required tests:**
- [ ] Schedule on job completion → row created with status='scheduled' + scheduled_for = now + delay
- [ ] Schedule is idempotent (calling twice for same job → one row)
- [ ] Worker picks up due rows, dispatches, sets status='sent'
- [ ] Worker on send failure: status='failed' + error_message
- [ ] SMS skipped when customer.smsConsent=false (status='skipped')
- [ ] /r/:requestId records clicked_at, redirects to tenant.review_url
- [ ] /r/:requestId with unknown id → 404 (not 302)
- [ ] Settings UI saves review_url + delay + enabled
- [ ] Tenant isolation — review request for tenant A invisible to tenant B
