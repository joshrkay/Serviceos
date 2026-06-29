# Beta Verification Run — 2026-06-25

**Method:** Every workflow in `docs/beta-verification-runbook.md` was driven against the
**real API + real Postgres** (not mocks, not unit tests). The API was run locally
(`NODE_ENV=dev`, HMAC dev tokens) against a Postgres cluster with the full migration set
applied, and exercised over HTTP with per-tenant/role JWTs. RLS is genuinely in force
(`withTenantTransaction` sets `app.current_tenant_id` from the token). External providers
(Stripe charge, Twilio telephony/SMS, real Clerk UI, LLM/STT) are mocked in dev and are
marked **MOCK** where their leg could not be exercised; the API contract up to that boundary
was driven and asserted.

**Tester:** Claude (automated, 6 parallel section-cluster agents + cross-cutting checks)
**Environment:** local (real Postgres, dev providers)
**Verdict:** **CONDITIONAL GO** — no cross-tenant data leak; lead-to-cash, scheduling,
public pages, settings, RBAC all verified. **4 real code bugs were found; the 3 clear-cut
workflow-breaking ones are fixed + regression-tested in this same change.** Two items
(RLS defense-in-depth, runbook staleness) remain as documented follow-ups.

---

## Sign-off matrix

| Section | Verdict | Notes |
|---|---|---|
| 1 — Auth & tenant bootstrap | ✅ PASS | Auth boundary verified: no-token / malformed / wrong-sig / expired / invalid-role all → **401**; valid → 200. `/health` + `/ready` 200. |
| 2 — Customer profile & locations | ✅ PASS | CRUD + 2 service locations + notes + edit + search + archive (read-only retention via `includeArchived`). |
| 3 — Lead pipeline & conversion | ✅ PASS | Create, note, convert→customer (contact carried over), lead becomes `won`+`convertedCustomerId` (not deleted). |
| 4 — Jobs | ✅ PASS | Create (customer+primary loc), lifecycle new→scheduled→in_progress→completed, time entries (150m/30m), notes. |
| 5 — Estimates | ✅ PASS (AI MOCK) | Line item exact **9500 cents** (no float); send (SMS dispatch recorded, delivery MOCK); approve via public token → `accepted`. AI suggestions: endpoint works, content MOCK. |
| 6 — Invoices & payment | ✅ PASS (Stripe MOCK) | Invoice from estimate inherits items + **totals match exactly**; same customer/job/loc; paid via recordPayment, `amountPaid==total`. Stripe **webhook** leg BLOCKED (no `STRIPE_WEBHOOK_SECRET` in dev). |
| 7 — Appointments & scheduling | ⚠️ PARTIAL | Create/overlap **conflict detected 3 ways** (DB EXCLUDE constraint, check-feasibility, proposal 422), reschedule clears conflict, edit/reassign persist. **Bug: delay-notification SMS silently broken (#3, FIXED).** |
| 8 — Dispatch board | ✅ PASS | `GET /api/dispatch/board` correct shape; tech location ping stored. Analytics read endpoint absent (write-only table). |
| 9 — Notifications & idempotency | ✅ PASS | Estimate SMS / invoice email recorded as dispatches; same-minute resend deduped at the DB unique constraint (no duplicate). |
| 10 — Public pages & portal | ✅ PASS | Public estimate approval + invoice payment views render correct data; no double-approve / double-feedback; portal scoped; **tampered tokens → 404**. |
| 11 — AI assistant | ✅ PASS (LLM MOCK) | Chat endpoint persists conversation + messages, history survives reload. LLM answers are `degraded/fallback` (no key) — content MOCK. |
| 12 — Technician mobile | ✅ PASS (STT MOCK) | Day-view returns today's job w/ address; status update persists; voice note attaches (transcript placeholder = MOCK). |
| 13 — Maintenance contracts | ✅ PASS | `/api/agreements` create/list/detail/scoped-to-customer; integer cents. |
| 14 — Vertical packs & settings | ✅ PASS | Settings persist (PUT); pack activate/deactivate; templates + price book edits persist (int cents). §14D = voice-language (UI i18n is UI-only, BLOCKED at API). |
| 15 — Calling agent | ⛔ BLOCKED | Twilio voice webhook fails closed without `TWILIO_AUTH_TOKEN` (can't forge signature in dev). **Bug: `GET /api/interactions` 500 (#2, FIXED).** |
| 16 — Account provisioning | ⚠️ PARTIAL | `GET /api/me` returns tenantId; settings seeded. Twilio subaccount + Clerk webhook idempotency are external/webhook paths (unit-tested; not drivable here). |
| 17 — Tenant data isolation | ⚠️ PARTIAL | **No data leak** — every cross-tenant read/write blocked (404/403), public tokens isolated, RBAC enforced. **Defense-in-depth gap: app DB role bypasses RLS (#5, documented).** Runbook RBAC expectations are stale vs code. |

---

## Cross-cutting invariants (independently verified)

- **Auth boundary** — with `DEV_AUTH_BYPASS` off, every malformed/expired/wrong-signature/invalid-role
  token returns **401**; only a correctly-signed HMAC token authenticates. (Earlier 200s were the
  documented dev bypass, which is hard-gated off in production.)
- **Proposals never auto-execute** — creating a reschedule proposal leaves it `draft` and the
  appointment **unchanged**; only after explicit approve + the ~5s undo window does the executor
  apply it (observed: appointment moved 10:00→14:00). The full safety gate works end-to-end.
- **Money is integer cents** — estimate 9500 → invoice 9500 → paid 9500, no float drift; price-book
  and deposit values round-trip as integers.
- **Tenant isolation** — verified at the API for reads, writes, public tokens, and RBAC roles.

---

## Bugs found (all are the "mocked-Pool hid a real schema mismatch" pattern CLAUDE.md warns about)

### #1 — CRITICAL — proposals never executed (`proposals.claimed_by` UUID vs string label) — ✅ FIXED
`claimForExecution` writes the worker label `'execution-worker'` into `claimed_by`, but the column
was `UUID` (while sibling `executed_by`/`created_by` are `TEXT`). Every claim threw
`invalid input syntax for type uuid: "execution-worker"`, so **no approved proposal ever reached
`executing`/`executed`** — the product's core "approve → it happens" promise was broken in prod
(the worker uses the same default label there). Existing executor tests passed a `randomUUID()`
worker id, which accidentally satisfied the UUID column and masked it.
**Fix:** migration `215_proposals_claimed_by_text` (`claimed_by` → `TEXT`). **Proven:** integration
test claims with the real `'execution-worker'` label; live e2e — approved proposal executed and moved
the appointment.

### #2 — HIGH — `GET /api/interactions` always 500 (nonexistent table + column) — ✅ FIXED
The route joined `locations.address_line1`; the table is `service_locations` and the column is
`street1`. Both `/api/interactions` and `/api/interactions/:id` 500'd for **every** tenant
(§15.8 transcript review unusable). A masked secondary bug: the count query selected `COUNT(*)`
but the handler read `rows[0].total`, so `total` was always 0.
**Fix:** `routes/interactions.ts` → `service_locations` + `street1` + `COUNT(*) AS total`.
**Proven:** integration test drives the real route → 200 with the joined address; live curl → 200.

### #3 — HIGH — running-late SMS silently dropped (missing `delay_notice_state` table) — ✅ FIXED
`PgDelayNoticeStateRepository` (wired in prod via the pool) INSERTs into `delay_notice_state`, a
table that **was never created**. `upsert()` threw, the appointments route swallowed the error and
returned `{queued:true}`, so the next customer's "tech is running late" SMS was never enqueued and
the idempotency guard could never engage.
**Fix:** migration `216_create_delay_notice_state` (table + RLS, matching the repo's columns).
**Proven:** integration test upserts + round-trips + idempotent re-upsert against the real table.

### #4 — MEDIUM — technician-location authz may reject owner/dispatcher (`clerk_user_id = <uuid>`) — ⚠️ NOT CHANGED
`PgTechnicianLocationAuthorizer` matches `clerk_user_id = $2` where `$2` is `technicianId`. The
self-path compares `auth.userId` (a Clerk id) and `technician_id` is a TEXT column — so the code is
self-consistent **if** `technicianId` is canonically the Clerk id. The §7 agent passed a `users.id`
UUID and got 403. **Ambiguous** — changing the query could break the correct Clerk-id path. Needs a
product decision on the canonical id before any change; **not modified** here.

### #5 — MEDIUM (prod-config dependent) — RLS provides no runtime defense-in-depth — 📝 DOCUMENTED
The app connects as a Postgres **superuser** (`rolbypassrls`), and there is no `SET ROLE` anywhere,
so RLS is effectively a no-op at runtime — isolation rests **entirely** on the app-layer
`tenant_id =` filters (which held in every test). The RLS policies themselves are correctly authored
and fail-closed when exercised as a non-superuser (`rls_app_runtime`, already provisioned).
**Recommendation:** have the app connect/`SET ROLE` as `rls_app_runtime` so a single forgotten
tenant filter can't leak across tenants. (Infra change — depends on the prod DB role; not made here.)

### #6 — LOW — dispatch board shows raw technician UUID instead of name — 📝 DOCUMENTED
Board query doesn't join `users` for display names.

### Runbook staleness (docs, not code)
- §17.18/17.19 assert technicians have `estimates:view`/`invoices:view` (expect 200); the code
  intentionally withholds both (→ 403, the safer behavior). The runbook is stale.
- §17.23/17.24 assume `PATCH`/`DELETE /api/jobs/:id` routes that don't exist (jobs use
  `PUT` + `POST /:id/transition`). Intents hold; the literal verbs/codes don't.

---

## What this run could NOT exercise (honest boundaries)
- Real Stripe charge + `checkout.session.completed` webhook (no secret in dev) — §6 paid state
  reached via `recordPayment` instead.
- Twilio telephony (inbound voice/Gather TwiML, SMS delivery, subaccount provisioning) — §15, §16B.
- Real Clerk signup UI + `user.created`/`user.deleted` webhooks — §1 UI, §16A idempotency,
  §16C invites, §16D deprovision (idempotency is unit-tested).
- LLM/STT content (assistant answers, transcription) — plumbing verified, content placeholder.
- UI-only concerns (browser rendering, i18n labels, drag-drop dispatch board).

## Recommendation
**Fix-forward complete for the 3 blocking code bugs (#1–#3).** Before onboarding a paying beta
customer, also: (a) adopt the `rls_app_runtime` DB role (#5), (b) resolve the technician-id
canonicalization (#4), (c) reconcile the runbook RBAC/route expectations with the code, and
(d) run the external-provider legs (Stripe/Twilio/Clerk) against staging, which this run could not reach.
