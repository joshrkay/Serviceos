# QA Matrix — Live Run Runbook

**Goal:** produce the first **real** QA report instead of predicted verdicts.

The 4-agent QA matrix harness (`e2e/qa-matrix/`) has been written and reviewed
but never fired against a live environment. Every verdict in
`qa/backlog/README.md` is a **prediction** based on code inspection. This
runbook walks you through producing the first real, evidence-backed
`QA-REPORT.md` against Railway dev in roughly 15 minutes of dashboard work.

You will end with a directory like:

```
qa/reports/2026-05-11/QA-REPORT.md       <- the real verdicts
qa/reports/2026-05-11/artifacts/<ROW>/   <- API + UI + DB evidence per row
```

---

## 1. What you need before starting

Have the following tabs / tools open. Each one is unblockable on its own.

| # | Source | What you grab from it | Time |
|---|--------|-----------------------|------|
| 1 | **Railway dashboard** — `serviceosweb-development` service | Public URL → `E2E_BASE_URL` | 30s |
| 2 | **Railway dashboard** — `serviceosapi-development` service | Public URL → `E2E_API_URL` | 30s |
| 3 | **Railway dashboard** — Postgres service for dev | Two connection strings: a read-only role (Agent C) and a service-role / read-write role (seeder) | 2m |
| 4 | **Railway dashboard** — `serviceosapi-development` → Variables tab | `CLERK_SECRET_KEY` value → `E2E_CLERK_HMAC_SECRET` (they must match exactly) | 30s |
| 5 | **Local shell** | Stripe CLI installed (only for the INV-05 webhook row; optional) | 2m |
| 6 | **Local shell** | Node 20+, `npm install` already run in the repo root | 1m |

> The QA matrix mints its own HMAC-signed JWTs using `E2E_CLERK_HMAC_SECRET` —
> **no Clerk signin flow is needed**. The only thing that matters is that the
> secret matches what the deployed API reads as `CLERK_SECRET_KEY`. If those
> drift, every API call returns 401.

---

## 2. Step-by-step env setup

Run these from the repo root. The exact var names are what `scripts/qa-matrix-doctor.ts`
checks, so any typo will fail loudly.

### 2.1 — Web and API URLs

```bash
# From Railway → serviceosweb-development → Settings → Public Networking
export E2E_BASE_URL='https://serviceosweb-development.up.railway.app'

# From Railway → serviceosapi-development → Settings → Public Networking
export E2E_API_URL='https://serviceosapi-development.up.railway.app'
```

**Verify:** both should look like `https://<something>.up.railway.app` with no
trailing slash and no `<placeholder>` brackets.

```bash
curl -s -o /dev/null -w "web: %{http_code}\n" "$E2E_BASE_URL"
curl -s -o /dev/null -w "api: %{http_code}\n" "$E2E_API_URL/health"
# expected: web 200, api 200
```

### 2.2 — Postgres connections

You need **two** Postgres URLs. They can be the same connection string in dev,
but production hygiene calls for two roles.

```bash
# READ-ONLY — Agent C uses this to verify row state without RLS bypass.
# In Railway → Postgres → Connect → copy the "Public Network" URL.
# If you have a `readonly` Postgres role, use it. Otherwise use the default
# user — RLS still applies to it via app.current_tenant_id in tests.
export E2E_DB_URL_READONLY='postgres://USER:PASS@HOST:PORT/DB?sslmode=require'

# READ-WRITE — seeder uses this to insert tenant/customer/job fixtures.
# Must be a role that can INSERT into tenants/customers/service_locations/jobs.
# In Railway → Postgres → Connect → use the default (service-role) user.
export E2E_DB_URL_READWRITE='postgres://USER:PASS@HOST:PORT/DB?sslmode=require'
```

**Verify:**

```bash
psql "$E2E_DB_URL_READONLY" -c "SELECT 1;"
psql "$E2E_DB_URL_READWRITE" -c "SELECT 1;"
# both should print: ?column?  / -----  / 1
```

### 2.3 — Clerk HMAC secret

```bash
# In Railway → serviceosapi-development → Variables → search "CLERK_SECRET_KEY"
# Copy the exact value (starts with sk_test_… in dev).
export E2E_CLERK_HMAC_SECRET='sk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
```

**Verify:** value starts with `sk_test_` (dev) or `sk_live_` (never — don't run
the matrix against prod). Length should be ~50+ characters.

### 2.4 — Seed Tenant A and Tenant B

The seeder is idempotent. Run it once, then copy the **6** `export` lines it
prints into your shell.

```bash
npx tsx e2e/qa-matrix/fixtures/seed.ts
# It prints something like:
#   export E2E_TENANT_A_ID=<uuid>
#   export E2E_TENANT_A_CUSTOMER_ID=<uuid>
#   export E2E_TENANT_A_JOB_ID=<uuid>
#   export E2E_TENANT_B_ID=<uuid>
#   export E2E_TENANT_B_CUSTOMER_ID=<uuid>
#   export E2E_TENANT_B_JOB_ID=<uuid>
```

Paste those 6 lines into the same shell.

**Verify:** every var is a UUID — `echo $E2E_TENANT_A_ID | wc -c` should print
`37` (36 chars + newline).

### 2.5 — Optional: Stripe CLI for INV-05 webhook row

```bash
brew install stripe/stripe-cli/stripe   # mac
# or see https://stripe.com/docs/stripe-cli
stripe login
# In a SEPARATE terminal (leave it running while the matrix runs):
stripe listen --forward-to "$E2E_API_URL/webhooks/stripe"
```

**Verify:** `stripe listen` prints a webhook signing secret and "Ready! You're
using Stripe API Version …".

If you skip this, the INV-05 row will report as `fail` with a "no stripe
listener" detail — that's expected and harmless.

---

## 3. Run command (single line)

After all 11 env vars are exported in the current shell:

```bash
./scripts/qa-matrix-run.sh
```

That script runs, in order:

1. `npm run qa:doctor` — every var set, every URL reachable, both DBs respond
2. `npm run qa:smoke-tools` — Playwright, tsx, Stripe CLI, pg client present
3. The seeder again (no-op if 2.4 already ran)
4. `npm run e2e:qa-matrix` — the 18 matrix rows
5. Prints the path of the freshly written `QA-REPORT.md`

Total wall time: 3–7 minutes for the matrix run plus a few seconds for setup
checks.

---

## 4. Reading the report

The teardown writes:

```
qa/reports/YYYY-MM-DD/
├── QA-REPORT.md            <- start here
└── artifacts/
    ├── EST-01/
    │   ├── api/01-create.json    <- Agent A: request + response
    │   ├── ui/01-list-before.png  \
    │   ├── ui/01-list-after.png   /  Agent B: before/after screenshots
    │   ├── db/01-row.json        <- Agent C: row state
    │   ├── db/01-row.sql         <- the literal SQL Agent C ran
    │   └── manifest.json
    ├── EST-02/…
    └── …
```

**Verdict meanings** (from `e2e/qa-matrix/README.md`):

| Verdict | Meaning | What to do |
|---------|---------|------------|
| `pass` | API + UI + DB all aligned with the row's Pass Criteria | Nothing — keep moving |
| `partial` | Substantially met with a documented deviation | Promote the deviation to a story or accept it explicitly |
| `fail` | Pass Criteria not met; evidence shows what broke | Open / re-open the matching story in `qa/backlog/` |
| `n/a` | Harness couldn't execute the row (dependency failed) | Look up the chain — fix the predecessor row first |

Compare the live verdicts to the predicted ones in `qa/backlog/README.md` to
see which gaps still hold and which have already closed in the meantime.

---

## Appendix — common failures + fixes

### A. HMAC mismatch — every API row returns 401

Symptom: `qa:doctor` passes, but `estimates.spec.ts` rows show
`response.status: 401` and `response.body.error: "invalid token"`.

Cause: `E2E_CLERK_HMAC_SECRET` doesn't match the deployed API's
`CLERK_SECRET_KEY` (drift can happen if a teammate rotated the key in Railway
since you last copied it).

Fix:

```bash
# In Railway dashboard → serviceosapi-development → Variables, either:
#   (a) re-copy the current CLERK_SECRET_KEY value and re-export it locally; or
#   (b) rotate the key and re-deploy, then re-export the new value:
export E2E_CLERK_HMAC_SECRET='<new value>'
npm run qa:doctor   # should still pass
./scripts/qa-matrix-run.sh
```

### B. Tenant IDs are stale — rows fail with "tenant_id not found"

Symptom: rows report `db/<row>.json` shows zero rows, or `404 customer not
found`.

Cause: the dev database was reset/migrated since you last seeded, so the
tenant/customer/job UUIDs in your env vars no longer exist.

Fix:

```bash
# Re-run the seeder (idempotent on owner_id, so it inserts or returns existing):
npx tsx e2e/qa-matrix/fixtures/seed.ts
# Copy the 6 fresh `export …` lines it prints into your shell. Then:
npm run qa:doctor
./scripts/qa-matrix-run.sh
```

### C. RLS denial — DB verifier sees 0 rows even though API returned 200

Symptom: `api/<row>.json` shows `status: 200` and a real created object, but
`db/<row>.json` is empty `[]`.

Cause: `E2E_DB_URL_READONLY` is connecting as a role that hits RLS without the
`app.current_tenant_id` GUC set, **or** the read-only role lacks SELECT
permission on `tenants/customers/estimates/invoices`.

Fix:

- Confirm the URL is the **service-role / read-write** Postgres user (or any
  role with bypass-RLS — in Railway dev that's the default user), **not** an
  anon / public role.
- If you really want to keep a least-priv read-only role: grant it
  `BYPASSRLS` in PG, or grant explicit `SELECT` on `tenants, customers,
  service_locations, jobs, estimates, invoices, webhook_events`.

```bash
# Quick fix: point READONLY at the same string as READWRITE for the first run.
export E2E_DB_URL_READONLY="$E2E_DB_URL_READWRITE"
npm run qa:doctor
./scripts/qa-matrix-run.sh
```

### D. Doctor says `E2E_API_URL` returns 502 / connection refused

Cause: Railway dev API is asleep, mid-deploy, or crashed.

Fix: open Railway dashboard → `serviceosapi-development` → Deployments. Wait
for the latest deploy to go green, then re-run `npm run qa:doctor`.

### E. Stripe webhook row fails with `forwarding URL not reachable`

Cause: `stripe listen --forward-to "$E2E_API_URL/webhooks/stripe"` was not
running, or was running in a shell with a different `E2E_API_URL`.

Fix: open a new terminal, export `E2E_API_URL` there too, and start
`stripe listen` BEFORE re-running `./scripts/qa-matrix-run.sh`.

---

## Once the first real run is done

1. Open `qa/reports/<today>/QA-REPORT.md` and compare against the predicted
   verdicts in `qa/backlog/README.md`.
2. For each row whose live verdict is worse than predicted, open the matching
   story in `qa/backlog/` (or create a new one) and link the artifact path.
3. Update the "Observed verdicts (live)" section of `qa/backlog/README.md`
   with the real numbers and the date. From then on, every PR that touches a
   matrix-relevant code path should re-run the matrix and either keep or
   improve each row's verdict.
