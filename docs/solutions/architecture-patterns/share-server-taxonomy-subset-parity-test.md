---
title: "Share a server taxonomy's safety subset across packages via a source-parsing parity test"
date: 2026-06-24
track: knowledge
problem_type: architecture-patterns
module: packages/shared/src/contracts, packages/api/src/proposals
tags: ["cross-package", "shared", "parity-test", "taxonomy", "drift", "safety", "monorepo"]
related: ["docs/solutions/architecture-patterns/owner-notifications-adding-a-push-type.md"]
---

## Context

A client (the mobile inbox's "Approve all eligible") needed to know which
proposal types are **capture-class** — the auto-safe lane that may be
bulk-approved, as opposed to money/comms/irreversible types that must be
reviewed individually. The authoritative classifier is
`actionClassForProposalType` in `packages/api/src/proposals/proposal.ts`: an
**exhaustive `switch`** over the `ProposalType` union whose missing-case compile
error is a deliberate forcing function (add a type without classifying it → the
build breaks).

The naive options both fail:
- **Duplicate the capture list on the client** → silent drift. The worst kind of
  bug for a *safety* gate: a money type wrongly treated as capture would let one
  tap bulk-approve it with no review.
- **Move the whole switch into `shared` and have the API import it** → the API's
  `ProposalType` is a string-literal **union**; `shared`'s is a nominal **enum**.
  Rewiring forces enum/union friction across dozens of call sites and, to keep an
  exhaustive switch, you'd trade the compile-time forcing function for a runtime
  `default` throw — a downgrade of existing safety tooling.

## Guidance

Keep the exhaustive switch as the **single runtime authority**. Export only the
**safety-relevant subset** the consumer needs (here: `CAPTURE_PROPOSAL_TYPES` +
`isCaptureProposalType(type: string)`) from `@ai-service-os/shared`, typed as
plain strings so both the API (union) and the client (raw JSON strings) call it
identically. Then pin the two representations with a **parity test that parses
the API source** and asserts set-equality — exactly the pattern the repo already
uses for the `ProposalType` enum (`proposal-type.test.ts`).

```ts
// shared: the subset consumers use, in terms of the shared enum values
export const CAPTURE_PROPOSAL_TYPES: ReadonlySet<string> = new Set([
  ProposalType.DRAFT_INVOICE, /* …only the capture arm… */ ProposalType.VOICE_CLARIFICATION,
]);
export const isCaptureProposalType = (t: string) => CAPTURE_PROPOSAL_TYPES.has(t);
```

```ts
// shared test: parse the API switch and assert the shared subset == its 'capture' arm
function apiCaptureTypes(src: string): Set<string> {
  const body = src.match(/actionClassForProposalType\([\s\S]*?\)\s*:\s*ActionClass\s*\{([\s\S]*?)\n\}/)![1];
  const capture = new Set<string>(); let pending: string[] = [];
  for (const line of body.split('\n')) {
    const c = line.match(/case\s+'([^']+)'\s*:/); if (c) { pending.push(c[1]); continue; }
    const r = line.match(/return\s+'([^']+)'\s*;/); if (r) { if (r[1] === 'capture') pending.forEach((t) => capture.add(t)); pending = []; }
  }
  return capture;
}
// expect(symmetricDiff(CAPTURE_PROPOSAL_TYPES, apiCaptureTypes(src))).toEqual([])
```

## Why This Matters

The blast radius of a domain refactor collapses to "add one entry + the test
catches drift," and the existing compile-time exhaustiveness is preserved. For a
safety gate this is the difference between *provably* in-sync and *hopefully*
in-sync: if someone adds a capture type server-side but forgets the shared set
(or vice versa, or a non-capture type sneaks in), CI fails with the exact diff.
Tests stay green this way: shared 120, api build clean, mobile 352.

## When to Apply

- A monorepo where one package owns an authoritative taxonomy (exhaustive switch
  / discriminated union) and another package needs a **subset** of it, especially
  when getting the subset wrong is a safety or correctness risk.
- Prefer this over (a) duplicating the list or (b) a full cross-package type
  migration, when the authoritative side has a compile-time forcing function
  worth preserving and the type representations differ (union vs nominal enum).
- The parser is intentionally simple (regex over the `case`/`return` lines); it
  works because the switch is written in the conventional "cases then a single
  `return 'class';`" style. Keep the switch in that style, or the parser needs
  updating — which the parity test itself will flag.

## Examples

Implemented in `packages/shared/src/contracts/proposal-action-class.ts` (set +
predicate) and `proposal-action-class.test.ts` (parity guard). The consumer
composes the shared predicate with a local rule rather than re-deriving it:

```ts
// mobile: eligibility = shared safe-lane AND a local confidence bar
export const isBatchEligible = (p: PendingProposalSummary) =>
  isCaptureProposalType(p.proposalType) && confidenceBand(p.confidenceScore) === 'high';
```

Prior art in the same repo: `packages/shared/src/contracts/proposal-type.test.ts`
pins the shared `ProposalType` enum against the API's `VALID_PROPOSAL_TYPES`
array with the same source-reading technique.
