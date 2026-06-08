# VOICE — voice proposals silently dropped (fabricated ai_run_id FK violation)

**Matrix rows:** CUST-02, SCH-02, SCH-03 (+ precheck voice gate)
**Live verdict (2026-06-04):** fail ("no proposal produced")
**Status: FIXED on branch `fix/qa-matrix-live-run-findings` (2026-06-04) — needs deploy + re-run**
**Effort:** S (done)

## Actual root cause (supersedes the first draft of this story)

The conversation engine works end-to-end: the LLM classified
`create_customer` at 0.9 confidence, resolved entities, reached
`proposal_draft`, and emitted a `create_proposal` side effect. The drop
happened in `inapp-adapter.ts#handleCreateProposal`:

1. It fabricated `aiRunId: uuidv4()`. `proposals.ai_run_id` carries a
   foreign key to `ai_runs(id)`, so the insert **always** violates the FK
   on Postgres-backed environments. Verified live against dev: insert with
   a random `ai_run_id` → FK violation; with NULL → succeeds.
2. The `catch` swallowed the error and returned `undefined`, so
   `proposalIds` came back `[]` with no trace. In-memory repos don't
   enforce the FK — which is why unit tests never caught it.

The earlier hypothesis (harness missing an `intent_confirm` turn) was
wrong; no confirm turn gates persistence. The report's "AI key unset"
hypothesis was also wrong.

## Fix (this branch)

- `handleCreateProposal` no longer fabricates a run id: uses
  `payload.aiRunId` when the engine provides a real one, else omits it
  (column is nullable).
- The catch now emits an `agent.calling.proposal_persist_failed` audit
  event with the error message — dropped proposals can never be silent
  again.
- `precheck.spec.ts` voice gate now posts to the real route
  (`/api/voice/sessions/:id/input`); the old `/utterances` path 404'd
  everywhere.

## Verify (after deploy)

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npm run e2e:qa-matrix -- --grep "CUST-02|SCH-02|SCH-03"
```

Expect proposals to persist; rows then depend only on the execution worker
running on dev (see PAY-04 for the worker-liveness caveat).

## Follow-up (out of scope here)

Plumb the REAL LLM run id from the classifier through the
`create_proposal` side-effect payload so the audit chain
(`ai_runs` → `proposals`) is complete instead of null.
