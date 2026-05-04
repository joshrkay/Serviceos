# Phase 12 — Field Operations: Tech-on-the-Ground Essentials

> **5 stories** | What techs do every job — without this, Serviceos is "office only"

---

## Purpose

Service businesses live or die on tech-in-the-field experience. Phase 12 closes the field-ops gap: photos for documentation/upsell, time tracking for payroll/job-costing, geofence ETA for arrival communication, customer signature for close-out, plus a one-line cleanup of the LEAD_SOURCES enum.

## Exit Criteria

A tech opens a job on a phone, takes 3 before-photos, clocks in, completes the work, takes after-photos, captures customer signature, marks complete. The customer received an automatic SMS when the tech crossed the 10-mile radius ("Mike is arriving in ~12 minutes"). All artifacts are visible on the office UI. Voice agent skill `lookup_jobs` reports recent photos + signed-off jobs.

## Foundations already in place

- `packages/api/src/files/file-service.ts` + `pg-file-repository.ts` — file repo (P12-001 reuses for photo storage)
- `packages/api/src/files/storage-provider.ts` — S3 presigned URLs
- `packages/web/src/components/customer/EstimateApprovalPage.tsx` — signature canvas pattern (P12-004 mirrors)
- `packages/api/src/telemetry/technician-location-ping.ts` — geofence pings (P12-003 consumes)
- `packages/api/src/notifications/send-service.ts` — SMS dispatch (P12-003 reuses)

---

## Story Specifications

### P12-005 — LEAD_SOURCES enum extension (housekeeping)

> **Size:** XS | **Layer:** Shared | **AI Build:** High | **Human Review:** Light

**Dependencies:** none

**Allowed files:** `packages/api/src/leads/enums.ts, packages/api/src/leads/__tests__/enums.test.ts, packages/api/test/leads/enums.test.ts, packages/web/src/components/leads/LeadCard.tsx (icon mapping only), packages/web/src/components/leads/__tests__/LeadCard.test.tsx`

**Build prompt:** Add `'customer_portal'` to `LEAD_SOURCES` enum + Zod schema in `packages/api/src/leads/enums.ts`. Update `LeadSource` type + `leadSourceSchema`. Add a phone-icon mapping for the new source on the LeadCard. Update the public-portal request-service handler to use `source='customer_portal'` instead of the `'web_form' + sourceDetail='Customer Portal'` workaround (1-line change in `packages/api/src/routes/public-portal.ts`).

**Review prompt:** Verify enum array, type, and Zod schema all updated. Verify LeadCard renders the new source. Verify public-portal handler uses the new value.

**Required tests:** enum contains 'customer_portal'; Zod accepts it; LeadCard renders icon for customer_portal source.

---

### P12-001 — Job photos: per-job gallery, mobile upload, before/after categorization

> **Size:** M | **Layer:** Field Ops | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** none (file-service exists)

**Allowed files:** `packages/api/src/jobs/job-photo.ts, packages/api/src/jobs/pg-job-photo.ts, packages/api/src/jobs/job-photo-service.ts, packages/api/src/routes/job-photos.ts, packages/api/src/db/schema.ts (migration 064 only), packages/api/src/app.ts (wiring only), packages/api/src/jobs/__tests__/**, packages/api/test/jobs/job-photos.test.ts, packages/web/src/pages/jobs/JobPhotos.tsx, packages/web/src/components/jobs/JobPhotoGallery.tsx, packages/web/src/components/jobs/JobPhotoUploader.tsx, packages/web/src/components/jobs/__tests__/**, packages/web/src/api/job-photos.ts`

**Build prompt:** Add per-job photo storage. (1) Migration `064_create_job_photos`: `id, tenant_id, job_id (FK), uploaded_by_user_id, file_id (FK to files), category (enum: before, after, problem, completion, other), notes, taken_at (timestamptz), created_at`. RLS by tenant. Index on (tenant_id, job_id). (2) Repo + service following Phase 9 conventions. Service exposes `attachPhotoToJob(tenantId, jobId, fileId, category, notes?, takenAt?)` and `listJobPhotos(tenantId, jobId)`. (3) Routes: `POST /api/jobs/:id/photos` (multipart upload via existing files service, then attach), `GET /api/jobs/:id/photos`, `DELETE /api/jobs/:id/photos/:photoId`. (4) Web: `JobPhotoGallery` (grid view with category filter), `JobPhotoUploader` (drag-drop on desktop, camera on mobile via `<input capture="environment">`), mounted on existing JobDetail. Reuse the existing `S3StorageProvider.generateUploadUrl` for direct-to-S3 upload (presigned PUT).

**Review prompt:** Verify multipart upload doesn't proxy bytes through API (use presigned URL pattern). Verify RLS isolation. Verify category enum is exhaustive. Mobile camera capture works on iOS Safari + Android Chrome.

**Required tests:** photo attached to job; list returns ordered desc by taken_at; tenant isolation; category filter narrows result; uploader accepts image/* only.

---

### P12-002 — Tech time tracking: clock-in/out per job + payroll rollup

> **Size:** M | **Layer:** Field Ops | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** none

**Allowed files:** `packages/api/src/time-tracking/**, packages/api/src/routes/time-entries.ts, packages/api/src/db/schema.ts (migration 065 only), packages/api/src/app.ts (wiring only), packages/api/test/time-tracking/**, packages/web/src/pages/jobs/JobTimeEntry.tsx, packages/web/src/components/jobs/ClockInOutButton.tsx, packages/web/src/pages/technician/WeeklyHours.tsx, packages/web/src/components/technician/__tests__/**, packages/web/src/api/time-entries.ts`

**Build prompt:** (1) Migration `065_create_time_entries`: `id, tenant_id, user_id (tech), job_id (nullable — non-billable hours allowed), entry_type (enum: job, drive, break, admin), clocked_in_at, clocked_out_at (nullable while running), duration_minutes (computed on close), notes, created_at, updated_at`. RLS. Index on (tenant_id, user_id, clocked_in_at desc). (2) Service: `clockIn(tenantId, userId, opts)`, `clockOut(tenantId, userId, opts)`, `findActiveEntry(tenantId, userId)`, `weeklyHoursByUser(tenantId, weekStart)`. Single-active-entry constraint: clocking in while already clocked-in auto-closes the prior entry. (3) Routes: `POST /api/time-entries/clock-in`, `POST /api/time-entries/clock-out`, `GET /api/time-entries?userId=&weekOf=`. (4) Web: ClockInOutButton on JobDetail (enforces single-active), WeeklyHours page on TechnicianDayView showing per-day totals.

**Review prompt:** Verify single-active-entry constraint enforced server-side (don't trust client). Verify duration computed accurately at close. Verify week boundary respects user's tenant timezone. Verify role guard — tech can only clock self; owner can clock anyone.

**Required tests:** clock in/out happy path; clock-in-while-active auto-closes prior; weekly rollup sums correctly across DST; tenant isolation.

---

### P12-003 — Geofence arrival ETA SMS

> **Size:** S | **Layer:** Field Ops | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P12-002 not required; uses `technician_location_pings` + `notifications/send-service`

**Allowed files:** `packages/api/src/notifications/arrival-eta.ts, packages/api/src/workers/arrival-eta-worker.ts, packages/api/src/db/schema.ts (additive ALTER on tenant_settings only — add arrival_eta_enabled BOOL DEFAULT false, arrival_eta_radius_km INT DEFAULT 16, arrival_eta_min_lead_minutes INT DEFAULT 5, arrival_eta_max_lead_minutes INT DEFAULT 30 — wrap in a small migration if tenant_settings doesn't already exist as a table), packages/api/src/app.ts (wiring only), packages/api/test/notifications/arrival-eta.test.ts, packages/api/test/workers/arrival-eta-worker.test.ts, packages/web/src/pages/settings/ArrivalEtaSettings.tsx, packages/web/src/components/settings/__tests__/ArrivalEtaSettings.test.tsx`

**Build prompt:** Worker every 60s scans active appointments today + recent location pings per assigned tech. Computes haversine distance from latest ping to appointment site_location. If distance ≤ radius_km AND ETA ∈ [min_lead, max_lead] minutes AND no prior ETA SMS sent for this appointment in last 15 min, send "Hi <name>, <techName> is arriving in about <X> minutes." via existing send-service. Idempotency: track in `arrival_eta_dispatches` (SET-based dedup, in-memory ok at v1, document HA limitation). Settings UI lets tenant toggle + tune.

**Review prompt:** Verify rate-limit (max 1 SMS per appointment per 15 min). Verify SMS consent honored. Verify ETA only fires when realistic (don't fire if tech is 50km away because location ping was stale). Verify settings UI saves all 4 fields.

**Required tests:** ETA computed within tolerance; rate-limit prevents duplicate; tech without consent doesn't trigger SMS; tenant isolation; disabled tenant never fires.

---

### P12-004 — Customer signature on job completion

> **Size:** S | **Layer:** Field Ops | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** none

**Allowed files:** `packages/api/src/jobs/job-signature.ts, packages/api/src/jobs/pg-job-signature.ts, packages/api/src/jobs/job-signature-service.ts, packages/api/src/routes/job-signatures.ts, packages/api/src/db/schema.ts (migration 066 only), packages/api/src/app.ts (wiring only), packages/api/test/jobs/job-signatures.test.ts, packages/web/src/pages/jobs/JobCompletion.tsx, packages/web/src/components/jobs/SignatureCanvas.tsx, packages/web/src/components/jobs/__tests__/SignatureCanvas.test.tsx`

**Build prompt:** (1) Migration `066_create_job_signatures`: `id, tenant_id, job_id (FK), signed_by_name, signature_svg (TEXT — vector path data, NOT raster — keeps payload small), signed_at, ip_address (text), user_agent (text), notes, created_at`. RLS. (2) Service: `captureJobSignature(tenantId, jobId, input)`. (3) Route: `POST /api/jobs/:id/signature`. (4) Web: `SignatureCanvas` (mirror estimate-approval signature canvas — extract to shared if convenient, but keep this story scoped — duplicate is OK at v1). `JobCompletion` page mounts when tech taps "Mark complete" — presents canvas + name field + submit.

**Review prompt:** Verify SVG path data is sanitized (no inline scripts). Verify can be rendered later without JS. Verify mobile pinch-zoom doesn't break canvas drawing. Verify ip_address + user_agent captured for audit trail.

**Required tests:** signature saved + retrievable; rendering produces stable SVG; tenant isolation; missing name field is rejected.
