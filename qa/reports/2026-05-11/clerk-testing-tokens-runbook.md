# Clerk testing tokens — operator runbook (2026-05-11)

**Goal**: turn on the Playwright journey tests that drive real Clerk signup /
sign-in flows in CI. Today they `test.skip()` because the harness has no
credentials. This runbook is the one-time setup that flips them on.

After you finish this runbook, every PR will run a real-browser signup against
a real Clerk dev instance — that's what catches the kind of bug that 4,083
unit tests miss.

Estimated time: **10 minutes** (5 in the Clerk dashboard, 5 in GitHub
Settings → Secrets).

---

## What this changes

Before:
- `e2e/journeys/signup-to-first-estimate.spec.ts` → `test.skip()` (no real flow).
- CI runs API smoke only; UI tests skip because no `VITE_CLERK_PUBLISHABLE_KEY`.

After:
- Journey 1 runs end-to-end in CI: open `/signup`, fill the form with a
  `+clerk_test` address, Clerk bypasses CAPTCHA via the testing token,
  the API recognizes the new tenant.
- Smoke UI tests also run (same `pk_test_` powers both).

---

## 1. Clerk dashboard (5 min)

You need a **Clerk development instance** with testing mode enabled. We do
*not* use the production instance — testing tokens only work on dev.

1. Open https://dashboard.clerk.com and select your **dev** instance for
   ServiceOS / Fieldly. (If you don't have one, click "Add application" and
   pick "Development".)

2. Confirm testing mode is on:
   - Left sidebar → **Configure** → **Testing**.
   - Toggle **Testing mode** ON. This is what enables the
     `+clerk_test` email subaddress shortcut and the testing-token endpoint.
   - On newer Clerk dashboards this may be labelled "Bot protection bypass
     for testing" or shown as automatic for development instances — if you
     don't see a toggle, the feature is on by default for dev instances.
     Just confirm the warning banner about "Testing mode active" appears
     somewhere on the page.

3. Grab the API keys:
   - Left sidebar → **Configure** → **API keys**.
   - Copy **Publishable key** — starts with `pk_test_...`. Call this
     `CLERK_PUBLISHABLE_KEY_VALUE`.
   - Reveal & copy **Secret key** — starts with `sk_test_...`. Call this
     `CLERK_SECRET_KEY_VALUE`.

4. (Optional but recommended) Configure allowed origins so the dev instance
   accepts requests from `http://localhost:5173`:
   - Configure → **Paths** → allow `http://localhost:5173` and the
     deployed Railway dev URL if you also point E2E at it.

---

## 2. GitHub repo secrets (3 min)

These power CI. Repo → **Settings** → **Secrets and variables** → **Actions**
→ **New repository secret**. Add both:

| Secret name                  | Value                                |
| ---------------------------- | ------------------------------------ |
| `E2E_CLERK_PUBLISHABLE_KEY`  | `CLERK_PUBLISHABLE_KEY_VALUE` (pk_test_...) |
| `E2E_CLERK_SECRET_KEY`       | `CLERK_SECRET_KEY_VALUE`    (sk_test_...) |

The `.github/workflows/e2e.yml` already references both names — once they
exist, the next CI run will pick them up. No workflow edits required.

If you also want production-grade webhooks for the tenant-bootstrap step,
you'll need a `CLERK_WEBHOOK_SECRET` too, but that's a separate dependency
owned by the ephemeral-DB agent.

---

## 3. Local `.env` (2 min, optional)

Only needed if you want to run the journey locally. Add to your repo-root
`.env` (gitignored):

```bash
# Same value, two names — the React dev server needs the VITE_ prefix at
# build time; Playwright's globalSetup reads the E2E_CLERK_* prefix.
VITE_CLERK_PUBLISHABLE_KEY=pk_test_xxx
E2E_CLERK_PUBLISHABLE_KEY=pk_test_xxx
E2E_CLERK_SECRET_KEY=sk_test_xxx
```

Or one-shot for a single test run:

```bash
export E2E_CLERK_PUBLISHABLE_KEY=pk_test_xxx
export E2E_CLERK_SECRET_KEY=sk_test_xxx
export VITE_CLERK_PUBLISHABLE_KEY=$E2E_CLERK_PUBLISHABLE_KEY
```

---

## 4. Verify it works

From the repo root with the env vars set above:

```bash
npx playwright test e2e/journeys/signup-to-first-estimate.spec.ts --reporter=list
```

Expected output (success):

```
Running 2 tests using 1 worker
  ✓  1 [chromium] › e2e/journeys/signup-to-first-estimate.spec.ts:XX › Journey 1 — signup to first estimate › new user can sign up and the API recognizes their tenant (Xs)
  -  2 [chromium] › Journey 1 — signup to first estimate › new user can draft their first estimate
  1 passed, 1 skipped
```

The second test is intentionally skipped — it needs the ephemeral test PG
that the parallel agent is wiring up. Once that lands, the second test
flips on.

### Common failure modes

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `ClerkAPIResponseError: Forbidden` at globalSetup | `sk_test_` invalid / belongs to a production instance | Re-copy from Clerk dashboard, confirm dev instance |
| `CLERK_FAPI is unset` in helper | globalSetup didn't run or env vars missing | Confirm both `E2E_CLERK_*` are exported in the same shell |
| Test passes locally but `/api/me` returns 403 | Tenant bootstrap webhook not configured | Out of scope here — see DB-fixtures agent's runbook |
| "main.tsx: VITE_CLERK_PUBLISHABLE_KEY is required" | Vite dev server didn't see the env var | Export `VITE_CLERK_PUBLISHABLE_KEY` in the same shell as `npm run dev` |

---

## 5. What's wired (file by file)

For reviewers — here's the moving parts so you can audit:

| File | What it does |
| ---- | ------------ |
| `e2e/helpers/clerk-testing.ts` | Thin wrapper exposing `setupClerkTestingToken(page)` + `hasClerkTestingCreds()`. Documents the env contract. |
| `e2e/global-setup.ts` | Calls `clerkSetup()` from `@clerk/testing/playwright` once, before any test, to mint the testing token. No-op if env vars unset. |
| `playwright.config.ts` | Registers `globalSetup: './e2e/global-setup.ts'`. |
| `e2e/journeys/signup-to-first-estimate.spec.ts` | Signup test now runs (was `test.skip`). Estimate-draft half still skipped pending DB. |
| `.github/workflows/e2e.yml` | Passes `E2E_CLERK_*` + `VITE_CLERK_PUBLISHABLE_KEY` from GH secrets. |
| `package.json` (root) | `@clerk/testing` added to `devDependencies`. |
| `.env.example`, `.env.qa.example`, `packages/web/.env.example` | Document the new env vars. |

---

## 6. Out of scope (other agents own these)

- **Ephemeral test PG** — required to unskip the estimate-draft half of
  Journey 1, all of Journey 2 (proposal approval), and all of Journey 3
  (invoice → Stripe). Tracked in parallel. Look for `E2E_USE_TEST_DB`
  blocks in `e2e/global-setup.ts`.
- **AI provider creds for Journey 2** — separate story.
- **Stripe test keys for Journey 3** — separate story.

This runbook only solves the auth half of the equation.
