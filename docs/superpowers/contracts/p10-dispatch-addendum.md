# Phase 10 (CRM Tier 2) — Multi-Agent Dispatch Addendum

This addendum extends `docs/stories/phase-10-gap-stories.md` with the metadata needed to dispatch each story to a Claude agent running in an isolated worktree.

For every story, the agent prompt should include:
- The full body of the story from `phase-10-gap-stories.md`
- This addendum's per-story block
- `repository-conventions.md` and `freeze-list.md` from `docs/superpowers/contracts/`

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 10A | P10-001 (portal) | single agent — touches db/schema.ts (059) + app.ts | unlocks 10B + 10C parallel |
| 10B | P10-002 (dashboard) | parallel-eligible after 10A merges | none |
| 10C | P10-003 (reviews) | parallel-eligible after 10A merges | none |

P10-001 ships first because it adds the migration cadence for this phase (059) and edits app.ts. P10-002 (dashboard, no schema) and P10-003 (migration 060) can then run in parallel.

---

## P10-001 — Customer self-service portal

**Wave:** 10A
**Migration number reserved:** 059_create_portal_sessions
**Forbidden files:**
- `packages/api/src/db/pg-base.ts` (frozen)
- `packages/shared/src/enums.ts` (Tier-1 — put portal-specific enums in `packages/api/src/portal/enums.ts`)
- `packages/api/src/customers/**`, `packages/api/src/estimates/**`, `packages/api/src/invoices/**`, `packages/api/src/jobs/**`, `packages/api/src/agreements/**`, `packages/api/src/appointments/**`, `packages/api/src/leads/**` (READ ONLY — query through existing repo methods; do NOT modify)
- `packages/api/src/auth/rbac.ts`
- `packages/api/src/middleware/**` (do not edit existing middleware; add `portalTokenMiddleware` as a NEW file under `packages/api/src/portal/`)
- `packages/web/src/components/auth/**`

**Allowed files (concrete list):**
- `packages/api/src/portal/portal-session.ts` (new — interface, InMemory repo)
- `packages/api/src/portal/pg-portal-session.ts` (new — Postgres repo)
- `packages/api/src/portal/portal-service.ts` (new — create/resolve/revoke + token hashing helpers)
- `packages/api/src/portal/portal-token-middleware.ts` (new — Express middleware that resolves tokens and sets req.portal = { tenantId, customerId })
- `packages/api/src/portal/__tests__/portal-service.test.ts` (placeholder if needed)
- `packages/api/test/portal/portal-service.test.ts` (real tests)
- `packages/api/test/portal/portal-routes.test.ts` (real tests)
- `packages/api/src/routes/portal.ts` (new — authed routes: create/revoke session)
- `packages/api/src/routes/public-portal.ts` (new — token-gated read endpoints + request-service POST)
- `packages/api/src/db/schema.ts` (modify — add `059_create_portal_sessions` migration only)
- `packages/api/src/app.ts` (modify — wire PortalSessionRepository ternary, mount /api/customers/:id/portal-session under existing customers router via composition (or as /api/portal-sessions to avoid editing customers router) and /api/public/portal/* router)
- `packages/web/src/pages/portal/PortalShell.tsx` (new — token-routed layout)
- `packages/web/src/pages/portal/PortalDashboard.tsx` (new)
- `packages/web/src/pages/portal/PortalEstimateList.tsx` (new)
- `packages/web/src/pages/portal/PortalInvoiceList.tsx` (new)
- `packages/web/src/pages/portal/PortalJobList.tsx` (new)
- `packages/web/src/pages/portal/PortalRequestService.tsx` (new)
- `packages/web/src/pages/portal/__tests__/PortalDashboard.test.tsx` (new)
- `packages/web/src/pages/portal/__tests__/PortalRequestService.test.tsx` (new)
- `packages/web/src/components/portal/PortalCard.tsx` (new — shared layout primitive)
- `packages/web/src/api/portal.ts` (new — typed API client for public portal endpoints)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "portal|P10-001") && \
  (cd packages/web && npm test -- --run -t "Portal|P10-001")
```

**Pre-flight:**
- `git fetch origin && git rev-parse origin/main` succeeds.
- Migration number `059_create_portal_sessions` is not yet present in `packages/api/src/db/schema.ts`.
- P9-001/P9-002/P9-003 all merged on origin/main (already true).

**Risk note:**
- **Token storage.** Generate via `crypto.randomBytes(32).toString('hex')`. Store the **hash** (`crypto.createHash('sha256').update(token).digest('hex')`) in the DB. Compare via constant-time check. The plaintext token is returned ONCE at creation and never queryable.
- **Public-route authz.** The token IS the auth. Every public route MUST go through `portalTokenMiddleware` which sets `req.portal = { tenantId, customerId }`. Downstream queries use `req.portal.tenantId` (NEVER user-supplied). Trying to read a different tenant's data with a token from tenant A is impossible because the customer-scoped queries are scoped to `req.portal.customerId`.
- **request-service safety.** The Zod schema rejects user-supplied tenantId/customerId fields. Lead is created with `tenantId = req.portal.tenantId`, `source = 'customer_portal'`, `notes = sanitized request body`.
- **Rate limiting.** If a `rateLimitMiddleware` exists in the codebase, mount it on the public router. If not, implement a simple in-memory token-bucket (per-token, 60 requests/minute) — do NOT add a new dependency. Document the in-memory limitation (works for single-process; needs Redis for HA).
- **Money safety.** Display in dollars but `formatCents` on read; never store/transmit floats.
- **Branding.** Tenant name + logo URL come from existing `tenant_settings` — read once at portal load, cache in component state for the session.

**Implementation hints:**
1. Read `packages/api/src/routes/public-estimates.ts` and `public-invoices.ts` first — they're the closest existing pattern (token-gated public routes). Mirror the structure.
2. Read `packages/api/src/leads/lead-service.ts` for the `createLead` shape — call it from the `request-service` endpoint.
3. The `LEAD_SOURCES` enum currently has `'web_form','phone_call','referral','walk_in','marketplace','other'`. Adding `'customer_portal'` requires touching `packages/api/src/leads/enums.ts` which is forbidden in this story. Workaround: store as `source='web_form'` with `sourceDetail='Customer Portal'` for now; file a follow-up to extend the enum.
4. Public web routes mount at `/portal/:token` in the React router. The component reads token from URL, calls `portalApi.getCustomer(token)` once, then nested routes use the same token.
5. Portal session creation returns a complete URL using the request's host header so dev/staging/prod all work without config: `${req.protocol}://${req.get('host')}/portal/${token}`.

---

## P10-002 — Executive dashboard

**Wave:** 10B (after 10A merges)
**Migration number reserved:** none (read-only aggregator)
**Forbidden files:**
- `packages/api/src/db/pg-base.ts` (frozen)
- `packages/api/src/db/schema.ts` (no schema changes)
- `packages/shared/**`
- `packages/api/src/customers/**`, `packages/api/src/leads/**`, `packages/api/src/estimates/**`, `packages/api/src/invoices/**`, `packages/api/src/jobs/**`, `packages/api/src/agreements/**`, `packages/api/src/appointments/**` (READ ONLY)
- `packages/api/src/auth/rbac.ts`
- `packages/web/src/components/auth/**`

**Allowed files (concrete list):**
- `packages/api/src/dashboard/dashboard-types.ts` (new — `DashboardSnapshot` discriminated types + Zod query schema)
- `packages/api/src/dashboard/dashboard-service.ts` (new — orchestrator + per-section aggregators)
- `packages/api/src/dashboard/__tests__/dashboard-service.test.ts` (placeholder)
- `packages/api/test/dashboard/dashboard-service.test.ts` (real tests)
- `packages/api/test/dashboard/dashboard-routes.test.ts` (real tests)
- `packages/api/src/routes/dashboard.ts` (new — Express router)
- `packages/api/src/app.ts` (modify — mount /api/dashboard router only; do NOT add new repos)
- `packages/web/src/pages/dashboard/DashboardPage.tsx` (new)
- `packages/web/src/pages/dashboard/__tests__/DashboardPage.test.tsx` (new)
- `packages/web/src/components/dashboard/RevenueCard.tsx` (new)
- `packages/web/src/components/dashboard/PipelineCard.tsx` (new)
- `packages/web/src/components/dashboard/ConversionCard.tsx` (new)
- `packages/web/src/components/dashboard/AgingCard.tsx` (new)
- `packages/web/src/components/dashboard/UtilizationCard.tsx` (new)
- `packages/web/src/components/dashboard/AgreementsCard.tsx` (new)
- `packages/web/src/components/dashboard/DateRangePicker.tsx` (new)
- `packages/web/src/components/dashboard/__tests__/RevenueCard.test.tsx` (new)
- `packages/web/src/components/dashboard/__tests__/AgingCard.test.tsx` (new)
- `packages/web/src/api/dashboard.ts` (new — typed API client)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "dashboard|P10-002") && \
  (cd packages/web && npm test -- --run -t "Dashboard|P10-002")
```

**Pre-flight:**
- `git fetch origin && git rev-parse origin/main` succeeds.
- P10-001 merged on origin/main (so app.ts editing surface is clean).

**Risk note:**
- **No N+1.** Each aggregator gets ONE query. `getDashboard` fans out via `Promise.all`. Test with 1k records and assert query count is reasonable.
- **Date math.** All ranges are inclusive of `from`, exclusive of `to+1day` after tz normalization. Use the tz from the query param. Default tz to UTC if not provided.
- **Owner-only.** If `requirePermission('reports:view')` exists, use it. Otherwise use a custom guard: `if (req.auth.role !== 'owner') return res.status(403)`. Do NOT modify rbac.ts.
- **Money:** every cents value rendered via `formatCents`; never floats.
- **Cache headers.** `Cache-Control: private, max-age=300` is fine for a 5-minute owner-only view.

**Implementation hints:**
1. Read `packages/api/src/dispatch/analytics.ts` for the existing analytics pattern (DispatchAnalyticsRepository). Mirror the aggregation style.
2. For revenue: query invoices where `status='paid' AND paidAt BETWEEN from AND to`. Sum `totals.totalCents`. For byDay, group by `date_trunc('day', paid_at AT TIME ZONE $tz)`.
3. For pipeline: query leads where `stage NOT IN ('won','lost')`. Sum `estimatedValueCents`. Group by stage for stageCounts.
4. For conversion: count leads created in range, count leads with `convertedCustomerId IS NOT NULL AND updated_at IN range`. Rate = converted / created.
5. For AR aging: query invoices where `status IN ('sent','overdue')`. Bucket by `(now - dueDate)`: 0-30, 31-60, 61-90, 90+.
6. For tech utilization: query appointments by tech in range. `hoursScheduled = sum(durationMinutes)/60`. Default working hours = 8h * activeDays. utilizationPct = hoursScheduled / (8 * activeDays).
7. For agreements: count active, count with `nextRunAt within 30 days`. MRR = sum of `priceCents` normalized to monthly cadence by recurrence.

---

## P10-003 — Post-job review request automation

**Wave:** 10C (after 10A merges)
**Migration number reserved:** 060_create_review_requests
**Forbidden files:**
- `packages/api/src/db/pg-base.ts` (frozen)
- `packages/shared/src/enums.ts`
- `packages/api/src/jobs/**`, `packages/api/src/customers/**` (READ ONLY — call existing services)
- `packages/api/src/notifications/**` (READ ONLY — use existing send-service)
- `packages/api/src/auth/rbac.ts`
- `packages/web/src/components/auth/**`

**Allowed files (concrete list):**
- `packages/api/src/reviews/review-request.ts` (new — interface, InMemory repo)
- `packages/api/src/reviews/pg-review-request.ts` (new — Postgres repo)
- `packages/api/src/reviews/review-service.ts` (new — schedule, dispatch, click tracking)
- `packages/api/src/reviews/enums.ts` (new — channel + status enums + Zod)
- `packages/api/src/reviews/__tests__/review-service.test.ts` (placeholder)
- `packages/api/test/reviews/review-service.test.ts` (real tests)
- `packages/api/test/reviews/review-routes.test.ts` (real tests)
- `packages/api/src/routes/reviews.ts` (new — public /r/:requestId redirect + authed settings PATCH)
- `packages/api/src/workers/review-request-worker.ts` (new — follows P0-009 pattern)
- `packages/api/src/workers/__tests__/review-request-worker.test.ts` (new)
- `packages/api/src/db/schema.ts` (modify — add `060_create_review_requests` migration only; ALSO additive ALTER on tenant_settings if that table is in schema.ts — read first)
- `packages/api/src/app.ts` (modify — wire ReviewRequestRepository, mount router, register worker, register the job-completion hook that calls scheduleReviewRequest)
- `packages/web/src/pages/settings/ReviewSettings.tsx` (new — assumes a SettingsPage host exists; if not, just create the standalone component the user will mount later)
- `packages/web/src/pages/settings/__tests__/ReviewSettings.test.tsx` (new)
- `packages/web/src/components/reviews/ReviewLinkPreview.tsx` (new — renders the SMS body preview)
- `packages/web/src/components/reviews/__tests__/ReviewLinkPreview.test.tsx` (new)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "review|P10-003") && \
  (cd packages/web && npm test -- --run -t "Review|P10-003")
```

**Pre-flight:**
- `git fetch origin && git rev-parse origin/main` succeeds.
- P10-001 merged on origin/main.
- P0-009 (worker pattern) merged.

**Risk note:**
- **Idempotency.** UNIQUE constraint on `(job_id)` for status='scheduled' — only one scheduled request per job. The service `scheduleReviewRequest` does an upsert: if a row exists for the job, no-op.
- **SMS consent.** Check `customer.smsConsent` BEFORE inserting the row with `channel='sms'`. If false and only sms is configured, insert with `status='skipped'` and a clear `error_message`.
- **Click tracking.** `clicked_at` is only set ON FIRST CLICK (`UPDATE ... WHERE clicked_at IS NULL`). Subsequent clicks redirect but don't update.
- **Open redirect risk.** The `/r/:requestId` endpoint MUST validate the request id exists; never 302 to a URL not stored in the DB. The `tenant.review_url` should be validated at save time (must be HTTPS, must be a known review host: google.com, yelp.com, facebook.com, bbb.org).
- **SMS body length.** Budget 160 chars. Format: "Thanks from <tenant>! How was your service? <shortUrl>" where `<shortUrl>` is the request-id route. If tenant name + base URL > 100 chars, truncate tenant name.
- **Job-completion hook.** Read `packages/api/src/jobs/job-lifecycle.ts` to find the existing event hook (or completion path). If there is no event bus, register the call inline in the existing `transitionJobStatus` path — but since `jobs/**` is forbidden, instead expose `scheduleReviewRequest` as a callback parameter on the job service and wire it from `app.ts`. Document the wiring in app.ts.

**Implementation hints:**
1. Read `packages/api/src/notifications/send-service.ts` first to understand the dispatch flow.
2. Read `packages/api/src/jobs/job-lifecycle.ts` to find the completion path.
3. Read an existing worker (e.g. `packages/api/src/workers/execution-worker.ts` or whatever P0-009 produced) to mirror the pattern.
4. The `r/:requestId` redirect lives at the API root, NOT under `/api`, so SMS links are short. Mount at `app.get('/r/:requestId', ...)` directly.
5. Settings UI is standalone — provide a simple form that POSTs to a new `PATCH /api/settings/review` endpoint... ACTUALLY do NOT add a new settings endpoint, since `routes/settings.ts` is owned by another module. Workaround: expose a new `PATCH /api/reviews/settings` endpoint under the reviews router. Document.

---

## Universal pre-flight checks

Same as `p0-dispatch-addendum.md`. Apply to every Phase 10 story before launching the dispatch agent.
