# Launch-Readiness Pass — PROGRESS

Branch: `claude/vibrant-pascal-eeyK1`. Adapted from a generic launch-readiness
directive to this repo's real shape (npm workspaces, voice in `packages/api`,
Twilio not Vapi, in-code migrations). See `/root/.claude/plans/joyful-wiggling-lynx.md`.

Baseline (before this pass): `typecheck` ✓, `lint` ✓, unit tests 5943 passed /
3 skipped / 43 todo across 611 files.

Status legend: SHIPPED | DEFERRED | BLOCKED

---

## Feature 1 — Inbound call handling
Defects / gaps:
- Intent classifier (`ai/orchestration/intent-classifier.ts`) exists with a 0.6
  confidence threshold and human-fallback (`unknown` + `operator_request`), but
  **no test drives the classifier from the `fixtures/ai` transcripts** and maps
  results to the launch intents (schedule_appt / request_estimate / check_status
  / reach_human / unknown).
- `/api/voice/*` carries no signature middleware. Investigated: routes are
  already behind global Clerk `requireAuth` (`app.ts:2303,2329`) + per-route
  guards; the external Twilio webhook (`/api/telephony`) is signature-verified.
  Gap is only the **lack of a pinned test** asserting that posture.
Status: SHIPPED

## Feature 2 — Voice → structured slot extraction
Defects / gaps:
- Extraction + FSM re-ask (max 2) exist, but extracted slots are validated by
  ad-hoc type guards, **not a Zod schema** — no single source of truth for the
  caller_name/phone/address/service_type/preferred_time_window/problem_description
  slot shape, and no fixture-driven test.
Status: SHIPPED

## Feature 3 — Appointment scheduling
Defects / gaps:
- Availability + 2-slot proposal exist (`availability-finder.ts`,
  `scheduling/booking-availability.ts`); no external calendar (Postgres is the
  calendar). Missing a named conflict-free assignment test tying intent → event.
Status: SHIPPED

## Feature 4 — Estimate generation
Defects / gaps:
- Transcript→estimate flow complete, draft status + view token present. Missing a
  named test asserting total == sum(line items) via the shared billing engine.
Status: SHIPPED

## Feature 5 — Estimate → Job conversion
Defects / gaps:
- **No `POST /api/jobs/from-estimate/:id` endpoint.** Product is job-first;
  estimates carry a mandatory `jobId`. Net-new: schedule + assign the estimate's
  existing job, flip estimate → accepted. (No new table; appointments +
  appointment_assignments model scheduling.)
Status: SHIPPED

## Feature 6 — Job → Invoice generation
Defects / gaps:
- Auto-invoice on completion exists but bills estimate line items verbatim; **no
  recalculation of labor from actual logged time entries.** Net-new + a gated
  `tenant_settings.bill_labor_from_time_entries` column.
Status: SHIPPED

## Feature 7 — SMS confirmations
Defects / gaps:
- Per-tenant Twilio resolver (`getTenantTwilioCreds`) exists and the telephony
  path uses it, but the **notification SMS provider is built once from global
  env** and ignores `SmsMessage.tenantId`. Net-new: per-tenant delivery provider
  that fails closed when a tenant has no creds.
Status: SHIPPED

## Feature 8 — Multi-tenant RLS verification
Defects / gaps:
- Strong already: 79 tables ENABLE+FORCE RLS, isolation integration test + pinned
  schema invariant. Action: keep invariant green for any new column; expose a
  `test:rls` script alias. Security stop honored.
- This pass added NO new tenant table (only an additive column on the
  already-RLS-protected `tenant_settings`). Static RLS guards pass
  (`schema.test.ts`, 17 tests). The LIVE `test:rls` integration test could not run
  in this sandbox (Docker registry 403 — see BLOCKED.md); it is unaffected by this
  pass and expected to pass on a runner with registry access.
Status: SHIPPED (static-verified; live integration env-blocked)

---

## Verifier status (real, npm-based — see LAUNCH_REPORT.md)
- `npm run typecheck` — PASS
- `npm run lint` — PASS
- `npm run test` — PASS (api 5991 + web 1050 + shared 49)
- `npm run test:voice-fixtures` — PASS (13)
- `npm run build` — PASS
- `npm run test:rls` / `npm run test:integration` — BLOCKED by env (Docker
  registry 403); static RLS/schema invariants PASS. See BLOCKED.md.
- `git diff` vs branch base — changes only in in-scope dirs (packages/api,
  fixtures/ai, package.json aliases, PROGRESS/DECISIONS).
