# Beta Verification — Run Instructions

> Hand-off prompt for completing the beta verification run on
> `docs/verification-runs/beta-verification-2026-05-09.md`.
>
> The expanded `qa-runner` harness (16 stages / 65 tests) and the dated
> runbook scaffold are already on this branch — your job is to run the
> harness against a reachable environment, triage the failures into the
> scaffold, and commit the result.

## 1. Check out the branch

```bash
git fetch origin claude/setup-qa-testing-LAAJw
git checkout claude/setup-qa-testing-LAAJw
```

## 2. Get Clerk JWTs and Tenant IDs

You need two test Clerk accounts (Tenant A, Tenant B). For EACH:

1. Sign in at https://serviceosweb-development.up.railway.app
2. Open DevTools console, run: `await window.Clerk.session.getToken()`
3. Copy the JWT string

For Tenant A's UUID: open the Network tab while signed in, find any
`/api/...` call, look at the response — `tenantId` is in the payload (or
call `/api/me` directly).

JWTs expire ~1 hour. Don't paste them into chat or commit them anywhere.

## 3. Set env and run the automated harness

```bash
export BASE_URL=https://serviceosweb-development.up.railway.app
export API_URL=https://serviceosapi-development.up.railway.app
export AUTH_BEARER_TOKEN=<Tenant A JWT>
export TENANT_B_TOKEN=<Tenant B JWT>
export TENANT_ID=<Tenant A UUID>

npm run qa:doctor          # confirms env is wired
npm run qa:smoke-tools     # 3-check sanity. Hard stop if this fails.
npm run qa:run             # runs all 65 cases (~5-10 min)
npm run qa:report          # writes qa-runner/reports/summary.md
```

Then run Playwright smoke against staging:

```bash
E2E_BASE_URL=$BASE_URL E2E_API_URL=$API_URL npm run e2e:smoke
```

## 4. (Recommended) Unblock the cross-tenant isolation cases

Cases ISO-009 through ISO-013 verify Tenant B can't read Tenant A data.
Without IDs they show as `blocked`. To actually exercise them:

1. As Tenant A, create one customer, one estimate, one invoice, one job
   via the UI. Grab each ID from the URL bar (e.g., `/customers/<UUID>`).
2. Re-export and re-run:

```bash
export TENANT_A_CUSTOMER_ID=<uuid>
export TENANT_A_ESTIMATE_ID=<uuid>
export TENANT_A_INVOICE_ID=<uuid>
export TENANT_A_JOB_ID=<uuid>
npm run qa:run -- --stage tenant-isolation
npm run qa:report
```

These are HARD STOP cases. If any returns 200 instead of 403/404, that's a
critical security bug and the deploy must not ship.

### 4a. (Optional) Unblock other gated cases

Two more positive checks skip without their env var. Set them if you want
full coverage on this run:

- `TECHNICIAN_ID=<uuid>` — required by `TECH-001` to verify jobs list
  honors `technicianId` filter. Find it under `/settings → Team` or in
  `/api/users`.
- `TENANT_A_ESTIMATE_PUBLIC_TOKEN=<token>` — required by `PORTAL-005` to
  verify a real public estimate token loads. Send an estimate to a
  customer first; the token is the path segment in the `/e/<token>`
  approval link.

## 5. Triage failures into the runbook

Open `docs/verification-runs/beta-verification-2026-05-09.md`.

For each test in `qa-runner/reports/test_results.json` where
`final_status === "fail"`:

1. Find the matching section in the runbook (test_id maps roughly:
   `JOB-*` → §4, `APPT-*` → §7, `PORTAL-*` → §10, `ISO-*` → §17, etc.).
2. Mark the relevant checkboxes `[✗]` with a short note.
3. Add a row to the appropriate Bug List bucket near the bottom:
   - **Blocking:** §1, §16, §17 failures (auth, provisioning, isolation)
   - **High:** §2–§7, §10 failures (lead-to-cash flows)
   - **Non-blocking:** §11, §13–§15 (assistant, contracts, packs, voice agent)

Fill the Sign-Off Summary table (counts per section). Set the overall
verdict (GO / NO-GO).

## 6. Walk the residual human-only checklist

The sections at the bottom of the dated runbook marked "Residual
Human-Only Checklist" cover things automation can't see — LLM chat
quality, voice agent, dispatch UI, vertical pack visual switching, real
SMS receipt. Walk these by hand against the same deploy and check off the
results. Skip anything Twilio-related (no test number this run) and mark
it "Skipped — Twilio not configured."

## 7. Commit and push

```bash
git add docs/verification-runs/beta-verification-2026-05-09.md
git commit -m "qa: complete beta verification run 2026-05-09 (<X> blocking, <Y> high)"
git push
```

## 8. Share back

Reply with:

- The Sign-Off Summary table (final counts)
- The Blocking + High bug list (so we know what ships before any beta)
- Anything weird the harness can't capture (slow page loads, console
  errors, etc.)

## Reference docs

- Source runbook: `docs/beta-verification-runbook.md`
- Test plan: `qa-runner/config/test-plan.json`
- Harness code: `qa-runner/src/orchestrator.mjs`
- Strategy: `docs/testing-strategy.md`
- Edge case map: `docs/quality/crm-deep-state-and-edges.md`

## Gotchas

- The harness skips tests with missing env vars rather than failing them —
  read `blocked` rows in `test_results.json` and decide if they should be
  run with extra env (typical: `TENANT_A_*_ID` for ISO cases).
- Stripe test keys are not configured this run, so payment-success paths
  are intentionally not exercised. Don't chase those failures.
- If `qa:smoke-tools` fails, stop and check the deploy itself — feature
  testing is meaningless if `/login` won't render. Note: from sandboxed
  CI/dev environments, Railway dev may return `403 Host not in allowlist`
  — run from a machine that's allowlisted.
- The harness scans for secrets before writing reports
  (`qa-runner/src/redaction.mjs`). If it errors on "non-redacted secrets
  detected" the run aborted and the report wasn't written — fix the
  offending field and re-run; do not bypass the check.
