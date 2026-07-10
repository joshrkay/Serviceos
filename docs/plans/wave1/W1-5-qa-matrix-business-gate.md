# W1-5 — One green QA matrix run (Business-Critical)

**Thread ID:** W1-5  
**Parent:** [Wave 1 index](./README.md) · [umbrella plan](../2026-07-10-001-feat-wave1-prove-money-loop-followup-plan.md)  
**Status:** ready to pick up  
**Branch:** `chore/w1-5-qa-matrix-green`  
**PR title:** `chore(qa): Wave 1 business-critical matrix green report (W1-5)`  
**Estimate:** 0.5–1 day (mostly operator/secrets)  
**Parallel with:** Prefer after W1-1…W1-4 hermetic specs exist; can start env bootstrap anytime

---

## Goal

Produce **one documented green** QA matrix run against Railway dev:

- Business-Critical gate: **≥27/30** pass (≤3 documented waivers in `qa/gate-exceptions.json`)
- Voice-Critical 20/20 only if voice is in **this** launch scope; otherwise explicit deferral note

## Why this thread exists

Last comprehensive matrix attempt (2026-06-04) was **0 pass / 74 fail** due to missing `CLERK_DEV_HMAC_TOKENS` / HMAC secret — infra, not product. Hermetic E2E does not replace a live matrix proof.

## In scope

- Follow `docs/runbooks/qa-full-matrix-unblock.md` exactly
- Set Railway API `CLERK_DEV_HMAC_TOKENS=true` + redeploy
- Fill `.env.qa`, run `npm run qa:setup` → `npm run qa:matrix:run` → `npm run qa:matrix:gate`
- Commit or attach `qa/reports/<date>/QA-REPORT.md`
- Document any waivers with rationale

## Out of scope

- Rewriting matrix row logic / swarm harness
- Fixing every non-business-critical failure unless it blocks the gate
- Nightly CI matrix enablement (optional follow-up; not required for Wave 1 exit)
- Wave 2/3 product fixes unless a business-critical row is a true product bug — then file a separate fix PR and reference it here

## Approach

1. Read `docs/runbooks/qa-full-matrix-unblock.md` + `docs/plans/2026-06-25-003-feat-qa-full-matrix-unblock-plan.md`.
2. Confirm Railway vars; redeploy API.
3. `cp .env.qa.example .env.qa` → fill DB + HMAC → `npm run qa:setup`.
4. `npm run qa:matrix:run` then `npm run qa:matrix:gate`.
5. If &lt;27/30: triage failures into (a) env, (b) flake, (c) product bug → separate PRs; waivers only with evidence.
6. Open PR that adds the report + updates Progress on the umbrella plan / this thread.

## Expected files

| Path | Action |
|------|--------|
| `qa/reports/<YYYY-MM-DD>/QA-REPORT.md` (and artifacts as needed) | Add |
| `qa/gate-exceptions.json` | Update only if waiving |
| This thread + umbrella Progress | Mark done |

## Done when

- [ ] `npm run qa:matrix:gate` exits 0 for business-critical (or ≤3 documented exceptions)
- [ ] Report path linked in PR body
- [ ] Voice gate either green or explicitly deferred with reason
- [ ] PR links this thread doc

## Handoff prompt (paste into new agent thread)

```text
Implement W1-5 only: docs/plans/wave1/W1-5-qa-matrix-business-gate.md
Branch: chore/w1-5-qa-matrix-green from main.
Operator task: unblock QA matrix per docs/runbooks/qa-full-matrix-unblock.md,
run business-critical gate green, commit/link the report.
Do not implement W1-1..W1-4 hermetic specs in this thread.
```

## Env checklist (copy)

| Var / flag | Where |
|------------|--------|
| `E2E_BASE_URL` | Railway web |
| `E2E_API_URL` | Railway API |
| `E2E_DB_URL_READWRITE` | Railway Postgres |
| `E2E_CLERK_HMAC_SECRET` | Same value as API `CLERK_SECRET_KEY` |
| `CLERK_DEV_HMAC_TOKENS=true` | Railway API Variables (redeploy) |
