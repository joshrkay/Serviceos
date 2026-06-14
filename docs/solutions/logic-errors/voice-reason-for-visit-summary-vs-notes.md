---
title: "Voice reason-for-visit silently dropped: payload.summary vs payload.notes"
date: 2026-06-14
track: bug
problem_type: logic-errors
module: "packages/api/src/proposals/execution, packages/api/src/ai/tasks"
tags: ["voice", "appointments", "proposals", "contracts", "create_appointment"]
related: ["docs/solutions/architecture-patterns/voice-appointment-paths-vapi-vs-twilio-gather.md"]
---

## Problem
A caller stating why they need a visit ("my water heater is leaking") had that
reason dropped: the booked `appointments` row's `notes` came back empty for
cold inbound calls.

## Symptoms
- `appointments.notes` empty after a voice booking, even though the caller gave a
  clear reason.
- Confusingly, the **held-slot** path preserved it — only the plain
  `create_appointment` path lost it — so it looked intermittent.

## What Didn't Work
Looking only at the held-slot path (`CreateAppointmentAITaskHandler`, the
`createAppointment(...)` hold) was misleading: that path maps `summary`→`notes`
correctly, so it hid the gap.

## Solution
The LLM extracts the work description into `payload.summary` (`buildPayload` in
`packages/api/src/ai/tasks/create-appointment-task.ts`), but
`CreateAppointmentExecutionHandler.execute`
(`packages/api/src/proposals/execution/handlers.ts`) persisted only
`payload.notes`. A cold inbound call has no `jobId`, so it skips the held-slot
path (which maps `summary`→`notes`) and emits a plain `create_appointment` whose
payload carries `summary` but not `notes` → dropped.

```ts
// before
notes: typeof payload.notes === 'string' ? payload.notes : undefined,
// after
notes:
  typeof payload.notes === 'string'
    ? payload.notes
    : typeof payload.summary === 'string'
      ? payload.summary
      : undefined,
```

## Why This Works
One canonical column (`appointments.notes`) — no migration. Programmatic callers
that set `notes` keep precedence; voice proposals that only carry `summary` now
persist the reason. All `create_appointment` producers share this one executor,
so the fix is complete at a single seam.

## Prevention
- The appointment contract has **both** `summary` and `notes` optional, which
  makes "which field does the writer read?" a recurring trap. When a producer and
  a consumer are written by different code paths, pin the column with a real test.
- Docker-gated integration test asserts `appointments.notes` from a `summary`-only
  proposal through the real `PgAppointmentRepository`:
  `packages/api/test/integration/voice-inbound-appointment.test.ts`.
- Unit precedence (`notes` wins; `summary` fallback):
  `packages/api/test/proposals/execution/create-appointment-handler.test.ts`.
