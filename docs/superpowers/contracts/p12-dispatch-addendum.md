# Phase 12 (Field Operations) — Multi-Agent Dispatch Addendum

This addendum extends `docs/stories/phase-12-gap-stories.md` with the metadata needed to dispatch each story to a Claude agent in an isolated worktree.

For every story, the agent prompt should include:
- The full body of the story from `phase-12-gap-stories.md`
- This addendum's per-story block
- `repository-conventions.md` and `freeze-list.md` from `docs/superpowers/contracts/`

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 12A | P12-005 | single agent (XS, lands in ~10 min) | unlocks 12B clean baseline |
| 12B | P12-001, P12-002 | parallel (different domains) | unlocks 12C |
| 12C | P12-003, P12-004 | parallel (different domains) | sprint complete |

P12-005 ships alone first because it touches the LEAD_SOURCES enum (Tier-1 frozen surface) and `routes/public-portal.ts`. Tiny story, high signal, low risk — gives the bigger stories a clean main.

## Migration ledger

- 064: P12-001 `job_photos`
- 065: P12-002 `time_entries`
- 066: P12-004 `job_signatures`
- P12-003: additive ALTER on tenant_settings (no migration number; in-place ALTER block)
- P12-005: no migration

---

## P12-005 — LEAD_SOURCES enum extension

**Wave:** 12A
**Migration number reserved:** none
**Forbidden files:**
- `packages/shared/src/enums.ts` (Tier-1 — additions allowed only in `packages/api/src/leads/enums.ts`)
- `packages/api/src/leads/lead.ts` (interface — do NOT add new fields)
- `packages/api/src/leads/lead-service.ts`

**Allowed files (concrete list):**
- `packages/api/src/leads/enums.ts` (modify)
- `packages/api/src/leads/__tests__/enums.test.ts` (new placeholder)
- `packages/api/test/leads/enums.test.ts` (real tests)
- `packages/api/src/routes/public-portal.ts` (modify — replace `'web_form' + sourceDetail='Customer Portal'` with `'customer_portal'`)
- `packages/web/src/components/leads/LeadCard.tsx` (modify — add icon mapping for new source)
- `packages/web/src/components/leads/__tests__/LeadCard.test.tsx` (modify — add render-test for customer_portal)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "lead source|enums|customer_portal|P12-005") && \
  (cd packages/web && npm test -- --run -t "LeadCard|P12-005")
```

**Risk note:** None — purely additive enum value + UI mapping.

---

## P12-001 — Job photos

**Wave:** 12B
**Migration number reserved:** 064_create_job_photos
**Forbidden files:**
- `packages/api/src/db/pg-base.ts` (frozen)
- `packages/shared/**`
- `packages/api/src/files/**` (READ ONLY — reuse existing file-service + storage-provider)
- `packages/api/src/jobs/job.ts` (interface — do NOT add new fields, photos are a separate entity)
- `packages/web/src/components/auth/**`

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "job-photo|P12-001") && \
  (cd packages/web && npm test -- --run -t "JobPhoto|P12-001")
```

**Risk note:**
- **Direct-to-S3 upload**: photos MUST NOT proxy through API. Use existing presigned-PUT pattern from S3StorageProvider.
- **EXIF stripping**: server should strip GPS/EXIF from server-side validation (don't trust client). Document if deferred.
- **Mobile camera**: `<input type="file" accept="image/*" capture="environment">` works on iOS Safari + Android Chrome. Verify in dev.
- **Image size cap**: enforce 10MB per file at presign-time.

**Implementation hints:**
1. Read `packages/api/src/files/file-service.ts` for the existing upload pattern.
2. Mirror `notes` repo shape — file is the "blob", job_photos row is the metadata join.
3. UI: gallery uses CSS grid; upload via FormData → presigned URL.

---

## P12-002 — Tech time tracking

**Wave:** 12B
**Migration number reserved:** 065_create_time_entries
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/auth/rbac.ts` (use existing role check inline)
- `packages/api/src/jobs/**` (READ ONLY — link by job_id)
- `packages/api/src/customers/**`
- `packages/web/src/components/auth/**`

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "time-entry|time-tracking|clock|P12-002") && \
  (cd packages/web && npm test -- --run -t "ClockInOut|WeeklyHours|P12-002")
```

**Risk note:**
- **Single-active-entry constraint**: enforce server-side by querying `WHERE clocked_out_at IS NULL AND user_id = $1` before insert; if found, auto-close before opening new.
- **Timezone handling**: weekly rollup uses tenant timezone, not UTC.
- **Role guard**: tech can only operate on own user_id; owner can operate on any.

---

## P12-003 — Geofence arrival ETA

**Wave:** 12C
**Migration number reserved:** none (additive ALTER on tenant_settings)
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/api/src/notifications/**` (READ ONLY — call existing send-service)
- `packages/api/src/telemetry/technician-location-ping.ts` (READ ONLY)
- `packages/api/src/appointments/**` (READ ONLY)
- `packages/shared/**`

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "arrival-eta|geofence|P12-003") && \
  (cd packages/web && npm test -- --run -t "ArrivalEta|P12-003")
```

**Risk note:**
- **Stale ping protection**: ignore pings older than 5 min. Don't fire if last ping age > threshold.
- **SMS rate-limit**: max 1 ETA SMS per appointment per 15 min (in-memory dedup at v1; document HA need).
- **Disabled tenant**: feature flag must short-circuit at the worker entry; no DB queries when disabled.
- **Worker pattern**: mirror `recurring-agreements-worker.ts` (P9-003) for the periodic loop.

---

## P12-004 — Customer signature on job completion

**Wave:** 12C
**Migration number reserved:** 066_create_job_signatures
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/estimates/**` (READ ONLY — mirror their signature pattern)
- `packages/api/src/jobs/job.ts` (interface — do NOT add fields)
- `packages/web/src/components/customer/EstimateApprovalPage.tsx` (READ ONLY — copy the signature canvas pattern; do NOT refactor it)

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "signature|job-signature|P12-004") && \
  (cd packages/web && npm test -- --run -t "Signature|JobCompletion|P12-004")
```

**Risk note:**
- **SVG sanitization**: signature_svg accepts only path data (`M L H V Z`-style), no `<script>` or external refs. Validate via Zod or a minimal allowlist regex.
- **Storage**: SVG path strings are typically <5kb; do NOT store as image blob.
- **Mobile drawing**: pointer events (not touch + mouse separately) — single event model.
