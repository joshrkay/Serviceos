---
title: "Voice-quality: which LLM prompts the cassettes cover, and why drift no longer fails the gate"
date: 2026-06-15
last_updated: 2026-06-19
track: knowledge
problem_type: architecture-patterns
module: "packages/api/src/ai/voice-quality, packages/api/src/ai/tasks/create-appointment-task.ts, packages/api/src/workers/voice-action-router.ts"
tags: ["voice", "voice-quality", "cassettes", "drift", "testing", "llm-prompts", "create_appointment"]
related: ["docs/solutions/logic-errors/escalation-per-user-phone-fallback-loop.md", "docs/solutions/test-failures/voice-quality-cassette-drift-serves-stale-response.md"]
---

## Context
Before editing an LLM prompt on the voice path, the natural worry is: "will this
break the voice-quality launch-gate cassettes?" The cassette replay
(`ai/voice-quality/cassette-gateway.ts`) keys each call by
`sha256({model, canonicalized messages, schema})`. On a request-hash miss it no
longer throws: since `a6a480cb` it falls back to a `(schema, system-prompt
first-sentence, last user message)` match and serves the recorded response
(emitting a `cassette drift` warning). A prompt edit the corpus drives therefore
keeps the gate green as long as the recorded *content* is still correct — but a
changed response contract silently serves a stale, wrong response (see the
cross-referenced test-failures doc). Re-recording is **offline** via the in-repo
`ScriptAwareMockGateway` (`voice-quality:refresh`); it does **not** need
live-LLM access.

> **Update (2026-07-17):** the loose drift fallback is now **strict-by-default**
> — a hash miss THROWS unless `VOICE_QUALITY_ALLOW_CASSETTE_FALLBACK=1` is set
> (see the cross-referenced test-failures doc). So a green gate again proves the
> cassettes match the current prompts. The guidance below (which prompts are
> cassette-covered, and re-recording on edit) still holds; the difference is that
> an un-recorded prompt edit the corpus drives will now surface as a red gate
> ("cassette drift" throw) instead of silently serving the old recording.

## Guidance
**Two LLM prompts on the create-appointment path are cassette-covered, not one.**
The corpus runner (`voice-quality/text-mode-driver.ts` → the `voice-action-router`
worker) dispatches each classified intent to its `TaskHandler`
(`voice-action-router.ts:1180`, `handler.handle(context)`). For
`create_appointment` that handler IS `CreateAppointmentAITaskHandler` (constructed
at `voice-action-router.ts:440`), and its `handle()` makes a SECOND LLM call as
its first step — `gateway.complete({ taskType: 'create_appointment', system:
APPOINTMENT_SYSTEM_PROMPT })` at `ai/tasks/create-appointment-task.ts:321` — to
extract the verbatim date/time phrase before `resolveDateTime` pins it
deterministically. So `create-appointment-known-customer.json` has TWO *live*
entries (intent classifier + appointment extractor), and **both** the classifier
`SYSTEM_PROMPT` and `APPOINTMENT_SYSTEM_PROMPT` are hashed into a recorded request.

`reschedule_appointment` is the genuine deterministic case — and the reason it is
easy to confuse with the above. `RescheduleAppointmentTaskHandler`
(`ai/tasks/voice-extended-tasks.ts`) ignores its `gateway` arg and resolves the
classifier's `newDateTimeDescription` straight through `resolveDateTime`: **no
second LLM call**, so its cassette has a single classifier entry and there is no
reschedule-task prompt to cover.

**Why a green gate no longer answers "do I need to re-record?"** Since `a6a480cb`
a request-hash miss does not fail — `findFallbackEntry` matches on `(schema,
system-prompt FIRST SENTENCE, last user message)` and serves the recorded
response. Editing either covered prompt usually changes only text AFTER the first
sentence (a new intent line; an `appointmentType` field), so the fingerprint is
unchanged and the fallback keeps serving the OLD recording. The gate stays green
whether or not you re-recorded — it is masking drift, not proving non-coverage.
The failure only surfaces if the stale recorded *content* becomes semantically
wrong for the new contract (see the cross-referenced test-failures doc:
reschedule's stale `"the requested new time"` placeholder).

Therefore:
- If you edit a prompt the corpus drives — the shared intent-classifier
  `SYSTEM_PROMPT` **or** `APPOINTMENT_SYSTEM_PROMPT` — **re-record the cassettes**
  (`npm run voice-quality:refresh`, offline via the in-repo `ScriptAwareMockGateway`;
  no live-LLM / `AI_PROVIDER_API_KEY`). Do not rely on the gate to flag the drift.
- A purely deterministic task path (reschedule) has no task prompt to re-record;
  only its classifier entry matters.

**Diagnostic (cheap, definitive)** — a green replay is NOT the signal; the
`cassette drift` warning is. Run the gate and watch stderr:
```
cd packages/api && npm run voice-quality
```
A `cassette drift: scriptId=…` line for a script your edit drives means that
cassette no longer matches by hash and is being served from the fallback —
re-record. Zero drift lines means every request still hits by hash.

## Why This Matters
The intuitive check — "I edited a voice prompt, did the launch gate go red?" — is
unreliable after `a6a480cb`: the drift fallback keeps the gate green across an
un-recorded prompt change, so a stale cassette can quietly test the OLD prompt
(and, if the response contract moved, silently serve a wrong response). Knowing
exactly which prompts are cassette-covered, and re-recording them on edit, keeps
the corpus testing the code that actually ships.

## When to Apply
Any time you edit an LLM prompt under `packages/api/src/ai/` (notably the intent
classifier `SYSTEM_PROMPT` or `APPOINTMENT_SYSTEM_PROMPT`) and want to know
whether the voice-quality cassettes still reflect it. The operator path that also
calls the appointment task handler is proven separately by
`test/voice/operator-voice-golden-path.test.ts` with a scripted gateway.

## Examples
PR #580 added an `appointmentType` field to `APPOINTMENT_SYSTEM_PROMPT`. The gate
stayed **58/58** in replay before and after — but that was the drift fallback
matching the extractor entry on its unchanged first sentence ("You extract
appointment details from a field service voice transcript.") and serving the
pre-#580 recording, NOT evidence the prompt is uncovered. The correct response is
to re-record the create-appointment cassette so its extractor entry reflects the
new prompt; the 2026-06-19 corpus re-record did exactly that (every Layer-1
cassette now hits by hash, zero drift).
