---
title: "Voice-quality cassette drift can silently serve a stale, wrong response"
date: 2026-06-19
track: bug
problem_type: test-failures
module: "packages/api/src/ai/voice-quality"
tags: ["voice-quality", "cassettes", "drift", "testing", "llm-prompts", "reschedule"]
related: ["docs/solutions/architecture-patterns/voice-quality-corpus-prompt-coverage.md"]
---

## Problem
A Layer-1 voice-quality script (`reschedule-appointment-known-customer`) was the
sole corpus failure (disposition criterion 10). The root cause was **not** the
reschedule handler or the date math — it was a **stale cassette whose wrong
recorded response was served silently by the drift-tolerance fallback**. The
same staleness applied to ~57/58 cassettes; only this one's stale response was
also *semantically wrong*, so only it failed.

## Symptoms
- CI signal `structured=[10]`; the proposal payload had a correct `appointmentId`
  but carried `newDateTimeDescription: "the requested new time"` and **no**
  `newScheduledStart` / `newScheduledEnd`.
- `runScript(...).errors === []` — **no thrown error**. Instead a `stderr` line:
  `cassette drift: scriptId=… — falling back to user-content match. Refresh with
  VOICE_QUALITY_CASSETTE_MODE=refresh when convenient.`
- Disposition grader: `failedCriteria: [10]`, reason
  `hard-slot mismatches: newScheduledStart, newScheduledEnd`.

## What Didn't Work
- **"The cassette is stale so replay THROWS and the turn aborts."** Outdated.
  Since `a6a480cb` (`cassette-gateway.ts` `replay()` → `findFallbackEntry()`), a
  request-hash miss no longer throws — it falls back to a `(schema, system-prompt
  first-sentence, last user message)` match and returns the recorded response.
  The turn completed normally; the *recorded content* was just stale.
- **"Re-recording needs `AI_PROVIDER_API_KEY` / a live LLM."** False. The
  voice-quality record/refresh path (`buildCassetteGatewayForScript`) wraps
  `CassetteLLMGateway` around the **deterministic in-repo `ScriptAwareMockGateway`**
  (`test/voice-quality/voice-quality-driver-factory.ts`), not a network LLM. The
  whole corpus regenerates offline in the sandbox.
- **Reasoning about the slot-extractor cassette entry.** The cassette held a
  `"You are an appointment scheduling assistant…"` entry with the *correct* ISO
  datetimes — a red herring. The current `RescheduleAppointmentTaskHandler`
  resolves dates **deterministically** (`resolve-datetime.ts`); it never makes
  that second LLM call, so the entry was vestigial.

## Solution
Re-record the cassette(s) from the current deterministic mock so each request
matches its recording **by hash** (fallback goes dormant) and the recorded
classifier response carries the current contract.

The mock's `classifierJsonForTurn` was upgraded to a *hybrid* date contract: it
emits an **absolute, tz-correct** `newDateTimeDescription` derived from the
golden via `absolutePhraseFromIso` (e.g. `"May 13 2026 2:00 PM"`) so the
deterministic `resolveDateTime` owns the timezone math. The stale cassette
predated that and held the placeholder `"the requested new time"`, which
`chrono` cannot parse → resolver returns `unparseable` → slots dropped.

Before / after the recorded classify response:
```diff
- "extractedEntities":{"appointmentReference":"the appointment",
-   "newDateTimeDescription":"the requested new time"}
+ "extractedEntities":{"appointmentReference":"the appointment",
+   "newDateTimeDescription":"May 13 2026 2:00 PM"}
```

Clean re-record (drops accumulated dead entries; `rm` of a corpus file is
blocked, so record into a temp dir and install over the file):
1. Build a `CassetteLLMGateway({ mode: 'record', cassettesDir: <tmp>,
   realGateway: new ScriptAwareMockGateway(script, mock) })` and `runScript`.
2. Replay from the temp dir and assert a **green Layer-1 verdict**
   (`gradeLayer1Script`: floor + disposition + judge) before installing.
3. `fs.copyFileSync(tmp/<id>.json, corpus/<id>.json)`.

Verify the whole corpus:
```
cd packages/api && npm run voice-quality   # expect 58/58, launchGate.pass=true, ZERO "cassette drift" lines
npm run voice-quality:check-cassettes      # every Layer-1 cassette has ≥1 entry
```

## Why This Works
After re-record, the live request hashes to the recorded entry directly, so the
drift fallback is never consulted, and the recorded classify response is the
phrase the current resolver can parse into the golden slots
(`2026-05-13T21:00:00Z` / `23:00:00Z`). No production code changes; the fix is
test-fixture data brought back in sync with the mock contract.

## Update (2026-07-17) — the drift fallback is now STRICT-BY-DEFAULT
The silent-fallback hazard described below is now closed at the source. Since
this change, `CassetteLLMGateway.replay()` **throws on a hash miss by default**
with an actionable message ("cassette drift … run `npm run
voice-quality:refresh`"). The loose `(schema, system-prompt first-sentence,
last-user-message)` fallback is **opt-in**: set
`VOICE_QUALITY_ALLOW_CASSETTE_FALLBACK=1` (or pass `allowFallback: true` to the
gateway) to restore the old behavior for local iteration. A green Layer-1 gate
therefore once again PROVES cassettes match the current prompts — drift can no
longer hide behind the fallback. The full 58/40-script corpus re-verified
**green under strict mode with zero drift** at the time of this change, so no
re-record was needed. If a future prompt edit turns the gate red with a
`cassette drift` throw, the fix is unchanged: re-record offline via
`voice-quality:refresh` (deterministic mock, no API key).

## Prevention
- **Treat the drift fallback as a safety net, not a baseline.** It returns a
  recorded response by user-content match even when the system prompt changed.
  That's fine while the stale response is still *semantically correct*, but it
  will silently serve a *wrong* response if the mock/response contract changed
  (placeholder → absolute phrase here). The disposition grader is the backstop
  that catches the wrong-but-served case — a `cassette drift` warning with a
  passing script is benign; one with a grading failure means the recorded
  *content* is stale, not just the prompt hash.
- After editing the intent-classifier `SYSTEM_PROMPT` or the mock's
  `classifierJsonForTurn` contract, **re-record** (`voice-quality:refresh`, or a
  clean per-script temp-record) rather than leaning on the fallback; a periodic
  full re-record resets the baseline so the fallback stays dormant.
- Re-recording is **offline** (deterministic mock) — no API key, runnable in CI
  sandboxes. Don't defer it as "needs live-LLM access."
- Verify a re-record by replay-grading each script to a **green Layer-1 verdict**
  before installing — never install a cassette you haven't replayed.
