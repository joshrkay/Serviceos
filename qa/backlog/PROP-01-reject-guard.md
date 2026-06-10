# PROP-01 — Enforce approval-state guard on proposal reject

**Matrix row:** PROP-01 (Proposals · approval-state guard)
**Live verdict (2026-06-04):** fail
**Status 2026-06-04: code already guarded on main lineage — live fail is DEPLOY DRIFT.**
The dev service deploys from `cursor/qa-matrix-voice-gates-b78e`, which predates
main's proposal gate (PR #499). Local `transitionProposal` 409s draft→rejected;
regression tests added in `packages/api/test/proposals/actions.test.ts`
(PROP-01 describe block). Fix = redeploy dev from a main-lineage build
(e.g. merge `fix/qa-matrix-live-run-findings`), then re-run the row.
**Target verdict:** pass
**Effort:** S

## Problem

Rejecting a proposal that is still a **draft** succeeds. The matrix (and the
human-in-the-loop contract) expects 409: only proposals in
`awaiting_approval` should be acceptable/rejectable, and a draft must stay a
draft until it is promoted.

## Evidence from the live run

- `qa/reports/2026-06-04/artifacts/PROP-01/api/01-create-proposal.json` —
  `POST /api/proposals` (remove_crew_member) → 200, row persisted as draft
  (`db/01-proposal-row.json`).
- `qa/reports/2026-06-04/artifacts/PROP-01/api/01-reject-from-draft.json` —
  `POST /api/proposals/dc00896c-…/reject` → **200**, body shows
  `status: "rejected"`. Expected **409** with the row left in `draft`.

## Acceptance criteria

- [ ] `reject` (and `approve`) refuse non-`awaiting_approval` proposals with 409.
- [ ] The proposal row is unchanged after a refused transition.
- [ ] Audit event records the refused attempt.
- [ ] Unit test: reject-from-draft → 409, row still draft.
- [ ] QA matrix PROP-01 flips fail → pass.

## Allowed files

- `packages/api/src/routes/proposals.ts` (or the proposal service guard)
- matching tests

## Verify

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npm run e2e:qa-matrix -- --grep PROP-01
```
