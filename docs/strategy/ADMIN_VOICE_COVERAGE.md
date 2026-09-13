# Admin work via AI voice — coverage summary

**Product intent:** Cut tradesperson administration time so **≥90% of recurring
admin tasks** can be completed by **AI voice** (draft/lookup/speak), with the
owner **approving money/comms in seconds** — not full unattended money
execution.

| | |
|--|--|
| Inventory version | **1.0.0** |
| Source of tasks | `docs/strategy/day-in-the-life.md` (Mike + Jenna) |
| Speakable proof | Live `INTENT_TO_PROPOSAL_TYPE` + execution handlers + lookup skills |
| Gate | `npm run admin:voice-coverage --workspace=packages/api -- --gate` |
| Machine inventory | `packages/api/src/ai/voice-quality/admin-tasks/inventory.ts` |

## Coverage ratio

Run the gate for the live number (it is pinned by
`packages/api/test/voice/admin-voice-coverage.test.ts`):

```bash
npm run admin:voice-coverage --workspace=packages/api -- --markdown --gate
```

**Measured (inventory v1.0.0, live catalog):** voice-completable **92.5%**
(37/40 tasks) · human-only residual **7.5%** (3/40). Target was ≥90% / ≤10%.

Tasks that still need a human **tap after a voice draft** (money, comms,
irreversible) **count as voice-completable** when the speakable triple exists.
That matches the pitch: *“You approve what matters in 30 seconds a day.”*

## Residual human-only admin (≤10% budget)

These remain outside the voice on-ramp by design or white-space:

| Id | Why human / deferred |
|----|----------------------|
| `assign_closest_certified_tech` | Catalog white-space (parity P25) — needs new type + handler |
| `equipment_photo_to_asset` | Catalog white-space (parity P24) — equipment asset from photo |
| `tax_payroll_books` | Explicit **Never** in day-in-the-life (QuickBooks/Gusto) |

Everything else in the inventory is claimable as speakable (proposal, lookup, or
special router path such as negotiation hold / complaint / en-route).

## Critical admin paths (proven)

| Path | Inventory task(s) | Proof |
|------|-------------------|--------|
| Book | `book_appointment`, `inbound_csr_book` | Graph `book` + path-smoke + catalog triple |
| Draft estimate | `draft_estimate` | Graph `quote` + path-smoke + catalog triple |
| Draft invoice | `draft_invoice` | Graph `invoice` + path-smoke + operator-ops loop |
| Payment chase | `payment_chase` | Graph `payment_chase` + path-smoke + catalog triple |
| Lookup | `lookup_quote`, `lookup_schedule`, … | Graph `lookup` + path-smoke + lookup skills |

## Live telephony: customer protection + honest AI failures (2026-08)

- **Customer protection:** `complaint` and `negotiation` are enabled on **every**
  live telephony session (`customerProtectionIntents`), not only owner lines.
  Owner extended lookups (day/digest/pending) still require the tenant flag +
  owner session (`extendedIntents`).
- **Infra failures:** quota / breaker / provider errors on classify get a
  one-shot hold line ("we're a bit busy") then escalate with a technical-issue
  line — never "I didn't catch that."

## What this is not

- A field study of clock minutes saved (no production cohort required here).
- Unattended auto-execution of money without approval/undo.
- A replacement of the TypeScript voice FSM with a new graph runtime.

## Related

- `docs/reference/voice-action-catalog.md` — full speakable action list (code-pinned)
- `docs/runbooks/agent-graph-and-path-smoke.md` — path smoke + graph coverage
- `docs/strategy/day-in-the-life.md` — emotional/ops spine
