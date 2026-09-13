# Lane report — #1096: `PATCH /api/users/:id` answers 500 for a non-UUID id

Branch: `fix/route-id-validation`
Issue: [#1096](https://github.com/joshrkay/Serviceos/issues/1096)
Date: 2026-09-13

---

## 1. The defect

`PATCH /api/users/:id` passed `req.params.id` straight into
`updateUser() → PgUserRepository.update()`, whose
`WHERE tenant_id = $n AND id = $n` compares against a `uuid` column. A
malformed id reached Postgres, which raised
`invalid input syntax for type uuid`, and the route's catch-all
(`toErrorResponse`) surfaced it as a bare `500 INTERNAL_ERROR`.

A well-formed-but-unknown id already answered a clean
`404 {"error":"NOT_FOUND","message":"User not found"}`.

## 2. Chosen answer: 404 NOT_FOUND (not 400)

The issue allowed either. **404 is the right answer here**, for three reasons:

1. **It is already this codebase's convention.** `notFoundOnMalformedId`
   (`packages/api/src/middleware/validate-uuid-param.ts`, shipped for #882)
   answers 404 with the route's own not-found envelope, and nine sibling
   routers already use it: `agreements`, `conversations`, `estimates`,
   `invoices`, `jobs`, `leads`, `locations`, `maintenance-contracts`,
   `notes`.
2. **It makes the malformed and unknown cases indistinguishable**, so the
   endpoint cannot be used to probe the id format. The #882 header comment
   calls this out explicitly, citing the #871 customers precedent.
3. **It keeps the response body identical** to the existing unknown-id
   answer, so no client has a new shape to handle.

A shared seam already existed, so no new validation mechanism was written —
the fix is one import plus one middleware entry.

## 3. The fix

`packages/api/src/routes/users.ts`:

```ts
import { notFoundOnMalformedId } from '../middleware/validate-uuid-param';

router.patch(
  '/:id',
  requireAuth,
  requireTenant,
  requirePermission('users:edit_role'),
  // #1096 — after requirePermission so 401/403 still answer before any
  // existence signal; before the handler so a non-UUID id can never reach
  // PgUserRepository.update's uuid comparison as a bare 500.
  notFoundOnMalformedId('User not found'),
  async (req: AuthenticatedRequest, res: Response) => { ... },
);
```

Chain position matters and follows the seam's documented rule: **after**
`requirePermission` (so 401/403 still answer before any existence signal),
and never via `router.param` (which would run before the per-route stack and
leak 404s to unauthenticated callers who today correctly get 401).

## 4. RED → GREEN (raw output)

Two legs, both RED before the fix.

### 4a. Route test — `test/routes/users-malformed-id.route.test.ts`

`InMemoryUserRepository` is a plain Map and cannot reproduce the uuid cast,
so a `PgLikeUserRepository` subclass throws exactly what Postgres throws
(the pattern from `customers.route.test.ts` / `leads.route.test.ts`).

**RED** (`npx vitest run test/routes/users-malformed-id.route.test.ts --reporter=verbose`):

```
 RUN  v4.1.10 /home/user/Serviceos/packages/api

 × test/routes/users-malformed-id.route.test.ts > malformed :id never reaches Postgres as a raw uuid comparison (#1096) > PATCH /api/users/not-a-uuid returns 404 NOT_FOUND, never a 500 33ms
   → expected 500 not to be 500 // Object.is equality
 ✓ test/routes/users-malformed-id.route.test.ts > malformed :id never reaches Postgres as a raw uuid comparison (#1096) > a well-formed but unknown uuid still answers the ordinary 404 6ms
 ✓ test/routes/users-malformed-id.route.test.ts > malformed :id never reaches Postgres as a raw uuid comparison (#1096) > a valid id is unaffected — the patch still applies 5ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/routes/users-malformed-id.route.test.ts > malformed :id never reaches Postgres as a raw uuid comparison (#1096) > PATCH /api/users/not-a-uuid returns 404 NOT_FOUND, never a 500
AssertionError: expected 500 not to be 500 // Object.is equality
 ❯ test/routes/users-malformed-id.route.test.ts:95:28
     93|       .send({ role: 'dispatcher' });
     94|
     95|     expect(res.status).not.toBe(500);
       |                            ^
     96|     expect(res.status).toBe(404);
     97|     expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'User not …

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
```

**GREEN** (after the fix):

```
 RUN  v4.1.10 /home/user/Serviceos/packages/api

 ✓ test/routes/users-malformed-id.route.test.ts > malformed :id never reaches Postgres as a raw uuid comparison (#1096) > PATCH /api/users/not-a-uuid returns 404 NOT_FOUND, never a 500 30ms
 ✓ test/routes/users-malformed-id.route.test.ts > malformed :id never reaches Postgres as a raw uuid comparison (#1096) > a well-formed but unknown uuid still answers the ordinary 404 6ms
 ✓ test/routes/users-malformed-id.route.test.ts > malformed :id never reaches Postgres as a raw uuid comparison (#1096) > a valid id is unaffected — the patch still applies 4ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

### 4b. Integration leg at real Postgres — `test/integration/users-malformed-id.test.ts`

Drives the real `PgUserRepository` against the real `users` table, so the
uuid cast that actually throws is the one under test (CLAUDE.md: a mocked
Pool is never the only proof a query behaves).

**RED** (`RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose test/integration/users-malformed-id.test.ts`):

```
 RUN  v4.1.10 /home/user/Serviceos/packages/api

 × test/integration/users-malformed-id.test.ts > Postgres integration — PATCH /api/users/:id with a malformed id (#1096) > answers 404 NOT_FOUND for a malformed id — never a 500 from the uuid cast 37ms
   → expected 500 not to be 500 // Object.is equality
 ✓ test/integration/users-malformed-id.test.ts > Postgres integration — PATCH /api/users/:id with a malformed id (#1096) > answers the identical 404 for a well-formed id that does not exist 14ms
 ✓ test/integration/users-malformed-id.test.ts > Postgres integration — PATCH /api/users/:id with a malformed id (#1096) > still applies the patch for a real id (no behaviour change) 12ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/integration/users-malformed-id.test.ts > Postgres integration — PATCH /api/users/:id with a malformed id (#1096) > answers 404 NOT_FOUND for a malformed id — never a 500 from the uuid cast
AssertionError: expected 500 not to be 500 // Object.is equality
 ❯ test/integration/users-malformed-id.test.ts:70:28

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
   Duration  10.15s
```

**GREEN** (after the fix):

```
 RUN  v4.1.10 /home/user/Serviceos/packages/api

 ✓ test/integration/users-malformed-id.test.ts > Postgres integration — PATCH /api/users/:id with a malformed id (#1096) > answers 404 NOT_FOUND for a malformed id — never a 500 from the uuid cast 40ms
 ✓ test/integration/users-malformed-id.test.ts > Postgres integration — PATCH /api/users/:id with a malformed id (#1096) > answers the identical 404 for a well-formed id that does not exist 18ms
 ✓ test/integration/users-malformed-id.test.ts > Postgres integration — PATCH /api/users/:id with a malformed id (#1096) > still applies the patch for a real id (no behaviour change) 12ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  4.44s
```

Note that in both legs the *second and third* assertions passed before the
fix as well as after. That is the no-behaviour-change proof: the unknown-id
404 and the valid-id 200 are untouched; only the 500 changed.

## 5. Other checks run

```
$ npx tsc --project tsconfig.build.json --noEmit
(exit 0, no output)

$ npx vitest run test/routes/
 Test Files  94 passed (94)
      Tests  1109 passed (1109)

$ npx vitest run test/routes/users-malformed-id.route.test.ts test/routes/users.route.test.ts \
      test/routes/users-phone.route.test.ts test/validate-uuid-param.test.ts
 Test Files  4 passed (4)
      Tests  55 passed (55)
```

---

## 6. The sweep

### 6a. Method, and what it does and does not prove

Every `router.<verb>` in `packages/api/src/routes/*.ts` whose path carries an
`:id` or `:...Id` param was enumerated by script (151 handlers), then each was
read to find where the param lands.

One fact was established empirically rather than assumed. Against the real
test schema:

```sql
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema='public' AND column_name='id';
```

**All 118 tables have `id uuid`.** There is no table in this schema with a
text/slug primary key. So "does this param reach a Pg `id` comparison?" is the
only question that matters — if it does, a malformed value throws.

What this sweep does **not** prove is whether an unguarded route actually
answers 500 today, because a guard can live anywhere in the call chain: at the
route, in a service function, or inside the repository. That distinction turned
out to matter — see 6d.

### 6b. Already protected (no action needed)

Four different mechanisms are in use. This is itself a finding: the class has
been fixed three times, in three different shapes.

| Route file | Routes | Mechanism | Answer |
|---|---|---|---|
| `agreements.ts`, `conversations.ts`, `estimates.ts`, `invoices.ts`, `jobs.ts`, `leads.ts`, `locations.ts`, `maintenance-contracts.ts`, `notes.ts` | 50 | `notFoundOnMalformedId` middleware (#882) | 404 |
| `customers.ts` | 14 | `rejectMalformedId()` helper, `customers.ts:90` (#871) | 404 |
| `users.ts:188` `GET /:id/phone`, `users.ts:226` `PUT /:id/phone` | 2 | `resolvePhoneTarget()`, `users.ts:99` | 400 |
| `appointments.ts:332,352,406,422` | 4 | `isUuid` short-circuit in `PgAppointmentRepository`, `pg-appointment.ts:26` | 404 |
| `public-portal.ts:847,902` | 2 | same repo-level `isUuid` via `appointmentRepo.findById` | 404 |
| `interactions.ts:154` | 1 | inline `z.string().uuid()`, `interactions.ts:163` | 400 |
| `entity-aliases.ts:19` | 1 | inline `uuidSchema`, `entity-aliases.ts:33` | 400 |
| `vertical-training-assets.ts:97,110,123` | 3 | `parseAssetId()`, `vertical-training-assets.ts:38` | 400 |
| `admin-tenants.ts:32` | 1 | inline `UUID_REGEX`, `admin-tenants.ts:39` | 400 |
| `public-booking.ts:209,255` | 2 | inline `TENANT_UUID`, `public-booking.ts:212` | 400 |
| `public-intake.ts:140,193` | 2 | inline `TENANT_UUID`, `public-intake.ts:142` | 400 |
| `reports.ts:418` `GET /technician-profit/:technicianId` | 1 | inline uuid regex, `reports.ts:440` | 400 |

### 6c. Not vulnerable — the param never reaches a uuid comparison

| Route | file:line | Why |
|---|---|---|
| `POST /:packId/activate`, `DELETE /:packId` | `pack-activation.ts:36,77` | `:packId` is a **vertical-pack registry slug, not a uuid**. `verticalPackRegistry.getByPackId()` is an in-process lookup; a uuid guard here would be actively wrong. |
| `POST /:id/input`, `GET /:id/events`, `DELETE /:id` | `voice-sessions.ts:95,130,216` | `deps.store.peek()` — in-memory `VoiceSessionStore`, no SQL. |
| `GET /status/:invoiceId` | `public-payments.ts:158` | Lookup is by opaque view token; `invoiceId` is only compared in JS (`invoice.id !== invoiceId`). Never reaches SQL. |

### 6d. Candidates for follow-up — and why they are *not* in this PR

This is the part worth Josh's attention.

I wired `notFoundOnMalformedId` into all 20 remaining route files (≈60
handlers) and ran the full suite. **Four of the twenty collided with existing,
tested contracts:**

| File | What broke | Root cause |
|---|---|---|
| `proposals.ts` | `proposals.route.test.ts` — *"returns 400 for invalid UUID format"* went 400 → 404 | Already guarded, but **in the service layer** (`getProposalDetail`), which the route-level sweep cannot see. Not vulnerable; has a documented 400 contract. |
| `reports.ts` (`customer-profit`) | 3 tests, including `503 NOT_CONFIGURED` → 404, and two 200s → 404 | Middleware runs **before** the handler's capability check, so the guard pre-empted the 503. Also the route's own tests use non-UUID customer ids. |
| `voice.ts` (recordings) | 5 tests in `compliance/recording-purge-download.test.ts` (501/410/200 → 404) | Test fixtures use synthetic ids (`rec-1`). Production ids are uuid, so the route probably *is* vulnerable — but the fixtures must be migrated first. |
| `job-photos.ts` | 4 tests in `jobs/job-photos.test.ts` (201/400 → 404) | Same: synthetic `job-1`-style fixtures. |

**That is the finding, and it is why this PR fixes users only.** The issue
asked to "fix the class in one place if a shared seam exists." A shared seam
does exist — but it **cannot be applied as a single class-wide change**:

- The seam's own header forbids `router.param` wiring (it would run before the
  per-route stack and leak 404s to callers who today correctly get 401), so
  every route must be wired individually.
- Two of four collisions (`proposals`, `reports`) are routes that are **not
  vulnerable at all** — static route-level analysis produces false positives,
  because guards live at three different layers.
- The other two (`voice`, `job-photos`) need their test fixtures migrated to
  real uuids first, which is a change to tests this issue does not own.

Wiring the remaining ~60 handlers blind would have meant shipping a
behaviour change on routes I could not prove were broken. The table below is
the honest handoff instead.

**Follow-up candidates** (param reaches a Pg uuid comparison, no guard found
at any layer; each still needs a per-route RED test to confirm the 500):

| file:line | Route | Param | Suggested message |
|---|---|---|---|
| `attachments.ts:213` | `POST /:id/archive` | `id` | `Attachment not found` |
| `attachments.ts:224` | `POST /:id/visibility` | `id` | `Attachment not found` |
| `attachments.ts:241` | `POST /:id/pair` | `id` | `Attachment not found` |
| `bundles.ts:47` | `GET /:id` | `id` | `Bundle not found` |
| `bundles.ts:104` | `PUT /:id` | `id` | `Bundle not found` |
| `catalog-items.ts:94` | `PUT /:id` | `id` | `Catalog item not found` |
| `catalog-items.ts:123` | `DELETE /:id` | `id` | `Catalog item not found` |
| `customer-custom-fields.ts:59` | `POST /:fieldDefId/archive` | `fieldDefId` | `Custom field not found` |
| `customer-groups.ts:61` | `PATCH /:id` | `id` | `Customer group not found` |
| `customer-groups.ts:81` | `POST /:id/archive` | `id` | `Customer group not found` |
| `customer-groups.ts:103` | `GET /for-customer/:customerId` | `customerId` | `Customer not found` |
| `customer-groups.ts:113` | `GET /:id/members` | `id` | `Customer group not found` |
| `customer-groups.ts:123` | `PUT /:id/members/:customerId` | `id`, `customerId` | `Customer group not found` / `Customer not found` |
| `customer-groups.ts:141` | `DELETE /:id/members/:customerId` | `id`, `customerId` | `Customer group not found` / `Customer not found` |
| `files.ts:103` | `GET /:id` | `id` | `File not found` |
| `files.ts:124` | `POST /:id/verify` | `id` | `File not found` |
| `financing.ts:38` | `POST /invoices/:invoiceId/offer` | `invoiceId` | `Invoice not found` |
| `financing.ts:92` | `GET /invoices/:invoiceId` | `invoiceId` | `Invoice not found` |
| `financing.ts:103` | `GET /:id` | `id` | `Financing application not found` |
| `job-custom-fields.ts:62` | `POST /defs/:fieldDefId/archive` | `fieldDefId` | `Job custom field not found` |
| `job-custom-fields.ts:77` | `GET /jobs/:jobId` | `jobId` | `Job not found` |
| `job-custom-fields.ts:87` | `PUT /jobs/:jobId/values/:fieldDefId` | `jobId`, `fieldDefId` | `Job not found` / `Job custom field not found` |
| `job-files.ts:90` | `POST /:id/files/upload-url` | `id` | `Job not found` |
| `job-files.ts:98` | `POST /:id/files/upload` | `id` | `Job not found` |
| `job-files.ts:106` | `GET /:id/files` | `id` | `Job not found` |
| `job-files.ts:123` | `DELETE /:id/files/:fileId` | `id`, `fileId` | `Job not found` / `Job file not found` |
| `job-forms.ts:51` | `GET /templates/:id` | `id` | `Job form template not found` |
| `job-forms.ts:87` | `PATCH /templates/:id` | `id` | `Job form template not found` |
| `job-forms.ts:107` | `POST /templates/:id/archive` | `id` | `Job form template not found` |
| `job-forms.ts:131` | `GET /jobs/:jobId/submissions` | `jobId` | `Job not found` |
| `job-forms.ts:145` | `POST /jobs/:jobId/submissions` | `jobId` | `Job not found` |
| `job-forms.ts:174` | `GET /submissions/:id` | `id` | `Job form submission not found` |
| `job-forms.ts:189` | `PATCH /submissions/:id` | `id` | `Job form submission not found` |
| `marketing.ts:68` | `POST /campaigns/:id/send` | `id` | `Campaign not found` |
| `portal.ts:264` | `DELETE /:id` | `id` | `Portal session not found` |
| `recurring-jobs.ts:88` | `GET /:id` | `id` | `Recurring job not found` |
| `recurring-jobs.ts:103` | `GET /:id/occurrences` | `id` | `Recurring job not found` |
| `recurring-jobs.ts:126` | `PATCH /:id` | `id` | `Recurring job not found` |
| `recurring-jobs.ts:146` | `POST /:id/archive` | `id` | `Recurring job not found` |
| `recurring-jobs.ts:170` | `POST /:id/generate` | `id` | `Recurring job not found` |
| `standing-instructions.ts:63` | `PATCH /:id/deactivate` | `id` | `Standing instruction not found` |
| `templates.ts:53` | `GET /:id` | `id` | `Template not found` |
| `templates.ts:89` | `POST /:id/instantiate` | `id` | `Template not found` |
| `templates.ts:106` | `PUT /:id` | `id` | `Template not found` |

Plus the four collision files above, each needing its own decision:
`reports.ts:319` (`GET /job-profit/:jobId` — guard must go **inside** the
handler, after the `503 NOT_CONFIGURED` check), `voice.ts:515,536,621`, and
`job-photos.ts:66,146,204,220` (both need uuid test fixtures first).
`proposals.ts` needs nothing.

### 6e. Recommendations

1. **Pick one convention and converge.** Four mechanisms answering two
   different status codes (400 vs 404) for the same condition is the real
   defect behind #1096. The #882 header already notes that reconciling
   `interactions` / `users` / `entity-aliases` was out of scope — it is still
   open, and this sweep found five more inline variants.
2. **Add a coverage contract test.** A static test that enumerates
   `:id`/`:...Id` routes and asserts each is either guarded or on a documented
   exemption list would stop the class from regrowing. It cannot land until
   the follow-up table is worked, since it would be red today.
3. **Migrate synthetic-id test fixtures to real uuids** in
   `compliance/recording-purge-download.test.ts` and `jobs/job-photos.test.ts`.
   Those fixtures currently mask a real production 500.
