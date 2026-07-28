# Part E verification — shared agent brief

You are one verification agent in a READ-ONLY measurement run over the Rivet repo
(`/home/user/Serviceos`). You verify build state; you fix NOTHING.

## Hard rules

1. **READ-ONLY.** Do not modify any file. You may run read-only commands, `npx tsc`, and
   `npx vitest run <specific-file>` (unit/contract tests only — do NOT run Docker-gated
   integration tests; the orchestrator runs those centrally). Never write to any database,
   never deploy, never call external services.
2. **Never ask a question.** Make every judgment call, note it in your output under
   "Judgment calls", and continue.
3. **Evidence or it didn't happen.** Every verdict cites a `file:line`, a test you ran and
   observed pass (include the command), or a command output. **Documentation is never
   evidence** — `docs/*`, code comments, and plan files are claims to be tested. Where code
   and docs disagree, code wins; record the disagreement as a delta.
4. **`UNKNOWN` is legal; blank is not.**

## The done ladder — score each requirement at exactly ONE rung (highest fully satisfied)

| Rung | Name | Test |
|---|---|---|
| 0 | Absent | No code implements this |
| 1 | Specced | Story/plan/contract exists; no implementation |
| 2 | Present | Implementation exists (module, handler, schema column, route) |
| 3 | Wired | Reachable from a production entry point — registered in `app.ts` / a router / worker registry / intent map, deps actually injected. Not merely exported. |
| 4 | Proven | Docker-gated integration test against real Postgres, with audit event asserted and a cross-tenant negative asserted. Mocked-DB coverage does NOT reach 4. |
| 5 | Reachable | Persona reaches it through a real surface; if tagged 🎙️, a spoken sentence traverses classifier → intent map → handler end to end |
| 6 | Live | (Not yours — Track C) |

Deciding rules:
- **Handler with no classifier intent = rung 2, not 3** (transcript silently skipped).
- **Execution handler with absent dependencies = rung 2, not 3**, even if it "succeeds".
- Wired-but-untested = 3, never "3.5".
- For rung 4 you may cite an integration test FILE and what it asserts, but mark it
  `[RUN-PENDING]` — the orchestrator confirms pass/fail from the central suite run. If the
  test exists but lacks the audit-event or cross-tenant assertion, say so; that caps at 3
  unless another test supplies it.
- Cap at 5 (Track C owns rung 6). A ⚙️/📱 requirement reaches 5 when the persona-facing
  surface (route + UI page / SMS flow / worker schedule) demonstrably invokes it.

## Repo anatomy (verified pointers, save your discovery time)

- Voice intent → proposal map (single source of truth): `packages/api/src/proposals/voice-intent-map.ts`
  (35 intents; re-exported from `packages/api/src/workers/voice-action-router.ts`).
- Classifier: `packages/api/src/ai/orchestration/intent-classifier.ts` (`SUPPORTED_INTENTS`).
- Execution handlers + registry: `packages/api/src/proposals/execution/` (see
  `wiring-assertions.ts` — `assertVoiceHandlersWired` called at boot in `app.ts`).
- Entity resolver: `packages/api/src/ai/resolution/` (kinds matter: check which exist).
- API composition root: `packages/api/src/app.ts`; route manifest `app-route-manifest.ts`;
  workers in `packages/api/src/workers/`; telephony in `src/telephony/`; voice in `src/voice/`.
- Web frontend: `packages/web/` (React Router pages = persona surfaces).
- Unit/contract tests: `packages/api/test/**` (safe to run individually);
  integration tests: `packages/api/test/integration/` (DO NOT RUN — cite + mark RUN-PENDING).
- The code-pinned catalog claim: `docs/reference/voice-action-catalog.md` +
  `packages/api/test/ai/voice-action-catalog.contract.test.ts` (you may RUN this contract test).

## Output format (your final message = raw report, no prose padding)

```
## Rows
| Req | Rung | Evidence | Missing link |
(one row per requirement ID assigned to you; Evidence = file:line and/or test+result;
Missing link = one specific sentence when rung < 5, or "—")

## Watchlist re-verification
(any seeded item in your scope: confirmed/moved, with independent citation)

## Deltas
(doc claims code doesn't support; AND reality ahead of documentation)

## Judgment calls
(each: the call, the reasoning, one line)
```

Be specific. "handler exists at `x.ts:120`, no entry in INTENT_TO_PROPOSAL_TYPE" — never
"incomplete". Aggregates/schema only — no tenant data (names, phones, addresses) in output.
