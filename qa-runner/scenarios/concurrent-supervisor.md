# P12-006 — Concurrent Supervisor + Mode-Switch Harness

**Wave:** 12D
**Type:** Soak / launch-gate scenario
**Cost:** Real LLM calls — gated by `ENABLE_REAL_LLM_HARNESS=1`
**CI:** Off by default. Opt-in only.

This is the heavy companion to the lean integration test
(`packages/api/test/integration/mode-switch-no-bleed.test.ts`). The
lean test is the per-PR gate; this one is the launch-gate soak run
the founder kicks off before cutting `v1.0.0`.

---

## What it exercises

1. Spins up 4 concurrent customer "sessions" against a deployed API
   (Twilio inbound webhooks simulated via `BASE_URL`).
2. Each session is driven by a distinct intent script:
   - emergency_plumbing
   - non_urgent_estimate
   - payment_question
   - agreement_question
3. While the 4 sessions run, flips a single operator's mode
   `supervisor → tech → both → supervisor → tech` 50 times.
4. After every flip, asserts:
   - Each `voice_session.supervisor_mode_at_start` matches the mode
     that was active when the session started (no retroactive change).
   - Each proposal references only its own session_id (no foreign
     session_id appears in any proposal payload).
   - Auto-approve threshold for each new proposal matches the mode at
     decision time (read from `proposals.metadata.supervisor_mode`).
   - `audit_events` has one `mode_switched` row per flip with the
     active session count snapshot.

## Pass criteria

- **Cross-session bleed:** zero proposals reference a foreign session_id.
- **p95 turn latency:** < 3 seconds.
- **Total LLM cost:** < $0.50 across all 4 sessions for a 2-minute
  scripted call each.
- **No stuck proposals:** every proposal in `ready_for_review` after
  the flips has either a downstream execution or an explicit
  `unsupervised_proposal_routed` audit.

## Required env vars

```bash
export ENABLE_REAL_LLM_HARNESS=1     # opt-in switch
export BASE_URL=https://serviceosapi-development.up.railway.app
export AUTH_BEARER_TOKEN=...         # owner JWT
export TENANT_ID=...                 # target tenant (test fixture, not prod)
export OPERATOR_USER_ID=...          # the user whose mode we flip
export ANTHROPIC_API_KEY=...         # real LLM (read for cost ceiling)
export LLM_BUDGET_USD_CEIL=2.00      # hard stop if cumulative cost exceeds this
```

## Run

```bash
npm run qa:doctor                    # validate env + reachability
node qa-runner/src/orchestrator.mjs run --stage concurrent-supervisor
```

## Implementation notes (for the harness author)

- **Budget guard.** Track cumulative LLM cost across all 4 sessions in
  the orchestrator. Tail off cleanly if `LLM_BUDGET_USD_CEIL` is hit
  rather than letting the run keep burning.
- **Determinism.** Use seeded fake customer phone numbers + fixed
  intent scripts. The non-determinism is in LLM responses; treat
  pass/fail on the *invariants* (no bleed, threshold matches) rather
  than exact transcripts.
- **Concurrency.** Use `Promise.all` for the 4 inbound webhooks; do
  NOT serialize.
- **Mode flips.** Flip via `POST /api/me/mode` with the operator JWT;
  these are authenticated mutations, not internal DB writes. Wait
  ~50–250ms between flips so each one falls within a session turn.
- **Audit reconciliation.** After the run, fetch
  `audit_events WHERE event_type IN ('mode_switched',
  'unsupervised_proposal_routed', 'emergency_immediate_dial')` and
  emit a CSV in `qa-runner/reports/` so the founder can eyeball the
  sequence.

## What this scenario does NOT test

- **Twilio Media Streams** live audio path. The harness simulates
  text-based proposal generation; the audio adapter is exercised by
  P8-012's own integration tests.
- **The unsupervised SMS-firing worker.** That's a P12-004 follow-up
  story; until it lands, the harness asserts only that proposals
  surface in `ready_for_review` (the queue path), not that an SMS
  fires.
- **Cross-tenant isolation.** Single-tenant scenario; multi-tenant
  RLS bleed is a separate harness.

## Status

**SCAFFOLD ONLY** as of 2026-05-03. The narrative + invariants above
are locked. The actual `qa-runner/scenarios/concurrent-supervisor.ts`
script should be authored by whoever owns the launch gate; the lean
integration test in `packages/api/test/integration/` is the per-PR
gate that runs in CI.
