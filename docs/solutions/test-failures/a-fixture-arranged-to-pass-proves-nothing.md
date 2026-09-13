---
title: "A fixture arranged until it passes proves nothing — three false greens in one run"
date: 2026-07-29
track: bug
problem_type: test-failures
module: "packages/api/test"
tags: ["testing", "fixtures", "false-green", "voice", "entity-resolution", "mutation-testing", "integration-tests"]
related:
  - "docs/solutions/test-failures/voice-quality-cassette-drift-serves-stale-response.md"
  - "docs/solutions/workflow-issues/adding-a-voice-intent-requires-four-coordinated-updates.md"
---

## Problem

The rivet-voice-19 run produced **three** passing tests that proved nothing about
the code. They look unrelated. They are one habit.

**1. `reassign-appointment-known-technician` (Layer-1 rubric).** A fixture put a
customer on an inbound call reassigning a technician. It passed. But
`reassign_appointment` is deliberately absent from `S1_ALLOWED_PROPOSAL_TYPES`
(`packages/api/src/proposals/surface.ts`) — on the caller surface production
coerces it to `voice_clarification`. The fixture passed only because the Layer-1
driver never applies the surface gate. Making it "pass properly" would have meant
widening the caller surface: a security regression dressed as a green test.

**2. `send-estimate-nudge-known-customer` (Layer-1 rubric).** Identical shape,
caught only after #1 had already been written up.

**3. `estimate-nudge.test.ts` (integration, real Postgres).** This one shipped.
The seed data contained:

```ts
// customerMessage carries "Khan" so the SAME estimate_number/customer_message
// ILIKE search ... finds it
customerMessage: 'Khan residence — water heater estimate',
```

The comment states the arrangement plainly. `PgEstimateRepository.findByTenant`
implements `search` as `(estimate_number ILIKE $n OR customer_message ILIKE $n)` —
display text only — and `send_estimate_nudge` was absent from
`CUSTOMER_REF_INTENTS`, so the router never resolved a spoken customer name for
that intent. In production, "Nudge the Khan estimate" resolves **only** when the
estimate's optional customer message happens to contain the customer's name. The
test was green against real Postgres and the feature did not work.

## Root cause

One habit, three times: **the fixture was adjusted until the assertion passed,
instead of the fixture being held fixed and the code made to satisfy it.**

The adjustment is never obviously wrong in the moment. It looks like "setting up
the scenario". In #1 and #2 the arrangement was a caller surface the product
refuses; in #3 it was planting the customer's name in a free-text column the
query happened to search. Each felt like test setup. Each removed the only thing
the test existed to check.

A related trap makes this easy to miss: a test harness is often *weaker* than
production. The Layer-1 driver has no surface gate; a mocked `Pool` has no
columns. So the fixture can satisfy the harness while production still refuses.

## Solution

**Rule 1 — a fixture may only contain what a real user would produce.** Seed a
customer named Khan, a job, an estimate. Do not also arrange for the string
"Khan" to appear in a column that only exists because it is what the weak query
searches. If a test needs a value planted somewhere unnatural to go green, that
planting *is* the finding: the resolution path is too weak and the fixture is
hiding it.

**Rule 2 — mutation-test every new proof.** Break the code path the test claims
to exercise; confirm the test fails; restore. Record the failure message in the
commit or PR body. This is cheap and it is the only direct evidence that a green
result is about the code rather than the harness.

```
# the discipline, concretely
$ <break the line under test>
$ npx vitest run <the test>
  AssertionError: expected undefined to be 'each'   # <- good: it was load-bearing
$ <restore>
```

**Rule 3 — assert the property, not the plumbing.** Prefer an assertion whose
value the test could not have handed to the code. In the B4.7 create-leg proof
the scripted drafting reply deliberately carries a *hallucinated* `customerId`,
so the assertion "payload carries the resolver's id" can only pass if resolution
actually beat the model. Contrast a hand-built payload literal, which can only
ever show that the handler works *given* resolved ids — never that the spoken
sentence produces them.

**Rule 4 — a green test is evidence about the harness until you show otherwise.**
Nothing about #3 was visible from the test result. It took reading the query the
fixture was feeding.

## Prevention

- When a test needs setup you would not find in a real tenant, stop and ask what
  the setup is compensating for.
- Never let a test's own comment explain why the data was shaped to match the
  query. That comment is a defect report.
- Mocked-DB tests are never the only proof a query works (already repo policy in
  CLAUDE.md; #3 shows the integration-test version of the same failure — real
  Postgres is necessary, not sufficient).
- Check new voice fixtures against `S1_ALLOWED_PROPOSAL_TYPES` before trusting a
  pass: operator-only intents are not caller-reachable, and a rubric fixture that
  says otherwise is asserting a capability the product refuses.
