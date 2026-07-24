---
name: money-extract
description: Read-only discovery across the Rivet money surface — money-storage type end to end, invoice/estimate/payment state machines, Stripe webhook idempotency, refund path, tax computation, and whether a ledger or double-entry layer exists. Dispatches five parallel tracks, synthesizes one findings doc. Precedes /goal money; fixes nothing.
allowed-tools: Read, Grep, Glob
argument-hint: "[track-name|all]"
---

# /money-extract — Money surface extraction pass

Read-only inventory. No gates, no iteration, no fixes mid-sweep. This pass
precedes `/goal money` and grounds its gates in what the code actually does
instead of what the spec intends — writing gates from spec intent is what put
comms through four rewrites.

Dispatch the five track subagents in parallel. Each reports
**EXISTS / PARTIAL / ABSENT** per item with `file:line`, never a fix.
Synthesize into `RIVET_MONEY_EXTRACTION_FINDINGS.md` using the output contract
below.

**Any float or floating-point type anywhere in a money path is an automatic
P0**, flagged first regardless of what else is found — the same standing RLS
gaps have in the comms extraction.

No `Bash` in `allowed-tools`: this pass needs zero execution to stay honest
about read-only.

## Why money needs its own extraction

Payments correctness fails silently in a way comms defects don't. A float leak,
a rounding drift, or a webhook double-apply passes every functional test and
surfaces days later as a reconciliation discrepancy, not a red test. The
extraction has to find the shape of the money path — storage type end to end,
idempotency mechanism, state-machine enforcement — before any gate can assert
against it.

Scope is wide: invoicing, payments, webhooks, plus estimate→invoice conversion,
refunds, and tax. **Whether a ledger exists is a question this pass answers, not
an assumption it makes.**

## Tracks

| Track | Agent | Model | Focus |
|-------|-------|-------|-------|
| 1 | `track1-money-type` | opus | Money-storage type end to end |
| 2 | `track2-state-machines` | opus | Invoice/estimate/payment transitions + cross-entity invariants |
| 3 | `track3-webhooks-idempotency` | opus | Stripe webhook handling + idempotency |
| 4 | `track4-refunds-tax` | sonnet | Refund path + tax computation |
| 5 | `track5-ledger-and-infra` | sonnet | Ledger existence, money-table RLS, test convention |

Argument selects a single track by name, or `all` (default) for the full
parallel sweep.

## Synthesis

Synthesize only — no re-tracing. The orchestrator does not re-open files the
tracks already reported on; it merges their verdicts into the contract below.

## Output contract — `RIVET_MONEY_EXTRACTION_FINDINGS.md`

```
# Money Extraction Findings

## P0 — silent money bugs (surfaced first, unconditionally)
[Any float in a money path (Track 1). Any state invariant unenforced (Track 2).
 Any webhook double-apply path (Track 3). Ranked, each with file:line.]

## Track 1 — Money type end to end
Storage type per table · domain type · Stripe-boundary type · API-response type
Float leaks: [file:line each, or NONE — the single most important line in this doc]

## Track 2 — State machines
State: EXISTS/PARTIAL/ABSENT per (invoice, estimate, payment) enforcement
Void→link invalidation: [holds / broken] · paid-invoice reject: [holds / broken]
Estimate→invoice: [idempotent / double-convertible]

## Track 3 — Webhooks & idempotency
Idempotency mechanism: [DB constraint / app-code / none] · redelivery behavior
Signature verification: [present, fail-closed / gap] · partial-commit risk: [yes/no]

## Track 4 — Refunds & tax
Refund: EXISTS/PARTIAL/ABSENT · over-refund guard: [yes/no] · partial: [yes/no]
Tax: stored/recomputed · rounding point · flat vs nexus-assuming

## Track 5 — Ledger & infra
Ledger: EXISTS/PARTIAL/ABSENT — [if absent, /goal money asserts row correctness, not reconciliation]
Money-table RLS: [clean / gaps at file:line]
Test convention: [confirmed pattern] · existing money test files

## What /goal money can and cannot assert
[The load-bearing conclusion: does a reconciliation invariant exist to sweep, or
 does the loop verify row-level correctness only. This decides the loop's spine.]

## Open decisions surfaced
[Tax jurisdiction handling, refund policy, ledger adoption — flag, don't decide]
```

## After this runs

The findings decide the one thing the spec can't guess: whether `/goal money`'s
invariant sweep is a **reconciliation check** or **row-level correctness**.

- **Ledger exists** → the sweep asserts balances reconcile every iteration, the
  money equivalent of comms's RLS sweep.
- **No ledger** → the sweep asserts sum-of-line-items equals invoice total to the
  cent and no payment survives a void. Weaker, but still catches the silent class.

Either way the gate is grounded in what's there. Do not write `/goal money`
until this comes back.
