# W3-1 — Auto-invoice on job complete (prove + default path)

**Thread ID:** W3-1  
**Parent:** [Wave 3 index](./README.md) · [umbrella](../2026-07-10-003-feat-wave3-product-day-in-the-life-followup-plan.md)  
**Status:** ready to pick up  
**Branch:** `feat/w3-1-auto-invoice-on-completion`  
**PR title:** `feat(invoices): auto-invoice on completion path + proof (W3-1)`  
**Estimate:** 1–2 days  
**Parity:** P20 / C1  
**Parallel with:** W3-3, W3-4

---

## Goal

When a job transitions to `completed`, optionally mint `draft_invoice` (+ optional `send_invoice`) **proposals** for owner one-tap — settings-driven, idempotent, digest-visible. Prove with integration test.

## Current code

`packages/api/src/invoices/auto-invoice-on-completion.ts` exists and is referenced from `routes/jobs.ts`, gated by `settings.autoInvoiceOnCompletion`. This thread **hardens, proves, and documents** the path (defaults, edge cases, digest line) — not a greenfield rewrite.

## In scope

- Verify completion hook always runs when setting is on; fix gaps
- Idempotency if job completed twice / retried
- Owner-facing: proposal in inbox + digest mention
- Settings UI or API already exposes flag — ensure discoverable
- Integration test: complete job → proposal created when enabled; no-op when disabled
- Align with W2-4 notes path (shared helper, no duplicate engines)

## Out of scope

- Auto-execute without approval
- Multi-step dunning (W3-2)
- Progress/milestone invoicing (P21)

## Done when

- [ ] Enabled setting → completion creates proposal(s); tested
- [ ] Disabled → no proposal
- [ ] Documented in settings / runbook one-liner
- [ ] PR links this thread

## Handoff prompt

```text
Implement W3-1 only: docs/plans/wave3/W3-1-auto-invoice-on-completion.md
Branch: feat/w3-1-auto-invoice-on-completion from main.
Harden/prove auto-invoice-on-completion; integration tests.
Do not implement dunning (W3-2) or other Wave 3 threads.
```
