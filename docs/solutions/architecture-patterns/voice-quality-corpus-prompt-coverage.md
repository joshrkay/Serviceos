---
title: "Voice-quality cassettes cover the intent classifier, not the appointment-task prompt"
date: 2026-06-15
track: knowledge
problem_type: architecture-patterns
module: "packages/api/src/ai/voice-quality, packages/api/src/ai/tasks/create-appointment-task.ts, packages/api/src/workers/voice-action-router.ts"
tags: ["voice", "voice-quality", "cassettes", "testing", "llm-prompts", "create_appointment"]
related: ["docs/solutions/logic-errors/escalation-per-user-phone-fallback-loop.md"]
---

## Context
Before editing an LLM prompt on the voice path, the natural worry is: "will this
break the voice-quality launch-gate cassettes?" The cassette replay
(`ai/voice-quality/cassette-gateway.ts`) keys each call by
`sha256({model, canonicalized messages, schema})` and THROWS "cassette stale,
refresh needed" on a request-hash miss — so a prompt edit that the corpus
actually drives fails the gate until the cassette is re-recorded (which needs
live-LLM access).

## Guidance
**The Layer-1 voice-quality corpus only exercises the intent CLASSIFIER call —
not the LLM appointment-task handler.** The corpus runner
(`voice-quality/text-mode-driver.ts` → the `voice-action-router` worker) builds
the `create_appointment` proposal from the classifier's `extractedEntities`
(via `entitiesForProposal`); it does NOT invoke `CreateAppointmentAITaskHandler`
(`ai/tasks/create-appointment-task.ts`). The create-appointment cassette's SECOND
entry (the task-extractor call) is VESTIGIAL — it still holds an old prompt that
no longer matches the code, and the gate stays green precisely because that entry
is never requested.

Therefore:
- Changing `APPOINTMENT_SYSTEM_PROMPT` (or any other AI-*task* prompt the corpus
  doesn't drive) does NOT require cassette regeneration and does NOT affect the
  launch gate.
- Changing the shared intent-classifier `SYSTEM_PROMPT` DOES change classifier
  cassette hashes for every scripted call — that is the cassette-sensitive prompt.

**Diagnostic (cheap, definitive)** — run the gate in replay before AND after the
change:
```
cd packages/api && npx vitest run -c vitest.voice-quality.config.ts
```
If it stays green (e.g. 58/58), the prompt you changed isn't on the corpus's hot
path and no regeneration is needed.

## Why This Matters
It removes a recurring false blocker — "I touched a voice prompt, so I must
re-record cassettes against a live LLM." For task-handler prompts that's simply
untrue, and the empirical check takes seconds instead of a regen round-trip.

## When to Apply
Any time you edit an LLM prompt under `packages/api/src/ai/` and need to know
whether the voice-quality launch gate
(`test/voice-quality/voice-quality.launch-gate.entry.test.ts`) is affected.

## Examples
PR #580 added an `appointmentType` field to `APPOINTMENT_SYSTEM_PROMPT`; the gate
stayed **58/58** in replay both before and after — confirming the appointment-task
prompt is not cassette-covered, so no regeneration was needed. (The operator path
that *does* call the task handler is proven separately by
`test/voice/operator-voice-golden-path.test.ts` with a scripted gateway.)
