# W2-4 — Job notes → draft invoice proposal

**Thread ID:** W2-4  
**Parent:** [Wave 2 index](./README.md) · [umbrella](../2026-07-10-002-feat-wave2-trust-and-field-gaps-followup-plan.md)  
**Status:** ready to pick up  
**Branch:** `feat/w2-4-notes-to-draft-invoice`  
**PR title:** `feat(jobs): notes → draft_invoice proposal path (W2-4)`  
**Estimate:** 1–2 days  
**Parallel with:** W2-5; prefer after W2-1/W2-2 if touching shared job completion

---

## Goal

When a tech/owner captures job notes (and optionally photos), the system can mint a **`draft_invoice` proposal** for owner one-tap approve — closing the “notes never become an invoice” field gap.

## Why this thread exists

Workflow audit marked Job Execution **partial**: photos work; **notes→invoice** was a gap. Voice already maps `create_invoice` → `draft_invoice` in places; the field/job-completion path needs a clear, tested owner-facing proposal.

## In scope

- Define trigger(s): explicit “Ready to invoice” action and/or job→completed hook that drafts from notes + time/materials (reuse catalog grounding)
- Must create a typed proposal (never auto-execute money)
- Thin UI: button on JobDetail and/or digest line — not a new invoicing console
- Tests: unit for draft builder; integration for proposal persistence + classification
- Align with existing `draft_invoice` handlers / `auto-invoice-on-completion` so we don’t fork two engines — **extend or call shared helper**

## Out of scope

- Full auto-send without approval (violates money gate)
- Multi-step dunning (W3-2)
- Turning on `autoInvoiceOnCompletion` tenant-wide defaults (W3-1)
- Checklists / form builder

## Key files

| Path | Role |
|------|------|
| `packages/api/src/invoices/auto-invoice-on-completion.ts` | Reuse patterns |
| `packages/api/src/routes/jobs.ts` | Completion hooks |
| Job notes APIs / JobDetail UI | Trigger surface |
| `proposals/*` + `shared` enums | Proposal ritual if new type needed |

## Done when

- [ ] Documented trigger produces `draft_invoice` (or approved existing type) proposal
- [ ] Owner can approve via inbox/SMS path already supported
- [ ] Tests cover happy path + “no notes / empty job” guard
- [ ] PR links this thread

## Handoff prompt

```text
Implement W2-4 only: docs/plans/wave2/W2-4-notes-to-draft-invoice.md
Branch: feat/w2-4-notes-to-draft-invoice from main.
Wire notes/completion → draft_invoice proposal; reuse existing invoice draft helpers.
Do not implement W3 auto-invoice defaults or dunning.
```
