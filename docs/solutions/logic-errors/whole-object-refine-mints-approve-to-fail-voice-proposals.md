---
title: "A whole-object Zod refine has no field path, so voice proposals minted with an empty missingFields gate and failed at approval"
date: 2026-09-09
track: bug
problem_type: logic-errors
module: "packages/api/src/proposals/voice-payload.ts, packages/api/src/ai/agents/customer-calling/inapp-adapter.ts, packages/api/src/ai/voice-turn/create-voice-turn-processor.ts"
tags: ["voice", "proposals", "contracts", "zod", "missingFields", "approve-to-fail", "inapp-50", "register"]
related: ["docs/solutions/test-failures/a-fixture-arranged-to-pass-proves-nothing.md", "docs/plans/2026-09-09-inapp-50-cases-plan.md"]
---

## Problem
Three in-app voice proposal types minted cards that looked complete (`missingFields: []`,
status `ready_for_review`) and then threw the moment an operator tapped approve:

| type | contract rule that failed | what the voice payload carried |
|---|---|---|
| `update_job` | "at least one of status / priority / title / description" | `{ jobId }` — the spoken "to in progress" was dropped |
| `send_estimate_nudge` | "estimateId or estimateReference is required" | `{ customerId }` — only the customer was named |
| `create_appointment` (D01, earlier) | "jobId (or linkedJobId), or a customerId" | free-text `customerName`, no id |

A fourth was a silent no-op rather than a throw: `update_customer` validated with only
`customerId` because the classifier's `updatedEmail` / `updatedPhone` / `updatedName` /
`updatedAddress` were never aliased onto the contract's `email` / `phone` / `name` / `address`,
so "update Khan's email" approved cleanly and changed nothing.

The hermetic in-app 50-case register (`fixtures/voice/inapp-50-cases.json`, cases `job-02`,
`est-06`, `cust-02`) is what surfaced all of them in one run; the live probes never could,
because they score "a proposal id came back" as PASS.

## Root cause
`buildVoiceProposalPayload` gates a draft by turning Zod issues into `missingFields` via
`fieldPathsFrom`, which keeps the first path segment of each issue. A **whole-object
`.refine()`** reports its issue with `path: []`, so it produces no field name, `missingFieldPaths`
comes back empty, and both live legs (in-app adapter, telephony turn processor) treat "invalid but
nothing nameable" as "persist unchanged" — i.e. an approve-to-fail card. Every proposal type
whose contract expresses "one of these must be present" as a refine is exposed the same way.

The `update_customer` case is the mirror image: a contract that is *too permissive* at the object
level (only the id is required) lets a payload with no change through with no gate at all.

## Fix
- `voice-payload.ts` now names these gaps proactively in a `namedContractGap` table instead of
  parsing Zod internals: `create_appointment` → `customerId`, `update_job` → `status`,
  `send_estimate_nudge` → `estimateId`, `update_customer` with no `updated*` value → `updatedField`
  (byte-identical to the task handler's sentinel). `missingFieldPaths` is reported independently of
  `ok`, so a contract-*valid* empty edit can still be gated.
- The spoken text reaches the payload builder (`context.lastUtterance` captured at
  `intent_classified`, threaded into `create_proposal` on both live legs) so `update_job` parses
  status/priority deterministically (`proposals/job-edit-phrases.ts`, shared with the memo task
  handler); nothing parsable → gated, never guessed.
- The customer-anchored resolver pass (`planCustomerAnchoredDocumentLookup`,
  `PgEntityResolver.resolveEstimateByCustomer` / `resolveInvoiceByCustomer`, columns pinned by
  `test/integration/customer-anchored-document.test.ts`) fills `estimateId` / `invoiceId` when the
  operator named only the customer and exactly one open document exists; two → the one-tap picker.
- `updated*` → contract-field aliases added next to the existing `displayName → name` one.

## How to catch the next one
- Add the case to the register and run `npx tsx scripts/run-inapp-50.ts --only <key> --json`
  (packages/api). A FAIL with root cause `proposal_generation` and the detail "failed
  validateProposalPayload with no missingFields gate" is exactly this bug.
- When adding a contract whose rule is "one of A/B must be present", add the gate name to
  `namedContractGap` in the same change; `test/proposals/voice-payload-record-edits.test.ts` is
  the place to pin it.
- The vitest gate `test/voice/inapp-50-register.test.ts` fails the build on any approve-to-fail
  card (contract violation with no gate) on every register case.
