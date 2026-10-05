# Known-flaky tests

Tests on this list have been observed to fail intermittently when run as
part of the full, parallel `npx vitest run` suite (CI, or a local full run)
but pass reliably **run alone**. If one of these fails:

1. Re-run it in isolation with the command listed below.
2. If it passes alone, the failure was the known flake — do not start
   debugging the production code from that run.
3. If it ALSO fails alone, that is a real regression, not this flake —
   file/update the issue with the isolated failure output.

Each entry is also linked from its test file's header comment, so the
designation is visible from the file itself, not only from this doc.

## `test/ai/gateway-ci-guard.test.ts`

**Cause (confirmed):** two of its three tests shell out via `execSync` to
`scripts/check-ai-gateway-guard.sh`, which greps the entire `src/` tree.
Each invocation takes ~8-9s on an otherwise idle machine (measured
2026-10-04). Under CI/full-suite CPU contention, that triples to a subprocess
spawn + full-tree grep competing with every other parallel vitest worker,
which is enough to trip default test/step timeouts.

**Rerun alone:**
```
npx vitest run test/ai/gateway-ci-guard.test.ts
```

## `test/app/repository-instance-sharing.test.ts`

**Cause (confirmed):** this test boots the *real* `createApp()` (not a
lightweight test harness) multiple times — once per assertion case — to
count repository constructions via `vi.mock`. Each boot starts the full set
of background workers (transcription worker, Google-reviews worker,
notifications delivery, the E1 script-readiness gate, etc.) — observed
emitting ~6 boot-time log lines per construction, repeated ~10x in a single
run. Under full-suite parallelism this repeated heavy boot is both slow and
sensitive to process-wide state (env vars, timers) that sibling test files
running concurrently in the same worker can perturb.

**Rerun alone:**
```
npx vitest run test/app/repository-instance-sharing.test.ts
```

## `test/routes/estimates-member-pricing.route.test.ts`

**Status:** named flaky in #1589 (2026-09-03 / 2026-10-04 reviews); passes
reliably in isolation (verified 2026-10-04, 3/3). Unlike the two tests
above, it uses the lightweight hand-wired `buildTestApp()` harness
(`test/routes/test-app.ts`), not the full `createApp()` boot, and its
membership-effective-date check (`resolveMemberDiscountBps` /
`isEffective` in `src/agreements/member-pricing.ts`) is a pure, deterministic
string comparison against `new Date().toISOString().slice(0, 10)` — not an
obvious source of nondeterminism on its own.

**Cause (unconfirmed — treat as load-sensitive like the above until
reproduced with a captured failure):** no isolated repro captured yet. Most
likely explanation given the evidence is the same class as the two tests
above: full-suite CPU/scheduler contention perturbing an `async`
request/response race in the shared `supertest` + in-memory-repo harness,
rather than something specific to member-pricing math.

**Rerun alone:**
```
npx vitest run test/routes/estimates-member-pricing.route.test.ts
```

## `test/routes/conversations.route.test.ts`

**Status:** named flaky in #1589; passes reliably in isolation (verified
2026-10-04). Uses its own hand-wired Express app + `createMockLLMGateway`,
not the full `createApp()` boot.

**Cause (unconfirmed — treat as load-sensitive until reproduced with a
captured failure):** no isolated repro captured yet. No module-level mutable
singleton or timer was found in its direct dependencies
(`conversation-service.ts`, `ai/gateway/factory.ts`'s mock path) during
investigation for this doc; suspected full-suite scheduling contention
rather than a bug specific to this file.

**Rerun alone:**
```
npx vitest run test/routes/conversations.route.test.ts
```

## `test/telephony/ask-caller-e1-before-carry-forward-1540.test.ts`

**Status:** named flaky in #1589; passes reliably in isolation (verified
2026-10-04).

**Cause (unconfirmed, but with a concrete suspect):** this test explicitly
passes `{ startInterval: false }` to `VoiceSessionStore` to disable its
background sweep `setInterval` (default `startInterval: true` —
`src/ai/agents/customer-calling/voice-session-store.ts:536`). Other
telephony test files that construct a `VoiceSessionStore` WITHOUT that
override leave a live sweep interval running for the life of the vitest
worker process. In a full-suite run, several such stores can be ticking in
the same worker at once; this file's own mitigation protects it from its
*own* store but not from event-loop turns stolen by a sibling test's
leaked interval. No isolated repro captured yet — if this recurs, check
whether the failure correlates with which other telephony tests shared its
worker.

**Rerun alone:**
```
npx vitest run test/telephony/ask-caller-e1-before-carry-forward-1540.test.ts
```
