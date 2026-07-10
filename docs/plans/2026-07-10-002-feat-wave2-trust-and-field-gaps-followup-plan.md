# feat: Wave 2 — Trust, legal & field gaps (umbrella)

**Created:** 2026-07-10  
**Depth:** Standard  
**Status:** plan (split into separate threads)  
**Depends on:** Wave 1 money-loop proof preferred (not hard-blocked)  
**Out of scope:** Wave 3 product expansion (dunning cadence productization, QBO enablement, route/ETA)

> **Naming:** Quality-assessment Wave 2 — **not** parity-roadmap “Wave 2 / truck is the office.”

---

## Separate threads (pick up independently)

| Thread | Doc | Branch |
|--------|-----|--------|
| **Index** | [`wave2/README.md`](./wave2/README.md) | — |
| **W2-1** TCPA/DNC outbound consent | [`wave2/W2-1-tcpa-dnc-outbound-consent.md`](./wave2/W2-1-tcpa-dnc-outbound-consent.md) | `feat/w2-1-tcpa-dnc-outbound-consent` |
| **W2-2** Appointment feasibility gate | [`wave2/W2-2-appointment-feasibility-gate.md`](./wave2/W2-2-appointment-feasibility-gate.md) | `feat/w2-2-appointment-feasibility-gate` |
| **W2-3** Estimate tier cents display | [`wave2/W2-3-estimate-tier-cents-display.md`](./wave2/W2-3-estimate-tier-cents-display.md) | `feat/w2-3-estimate-tier-cents-display` |
| **W2-4** Notes → draft invoice | [`wave2/W2-4-notes-to-draft-invoice.md`](./wave2/W2-4-notes-to-draft-invoice.md) | `feat/w2-4-notes-to-draft-invoice` |
| **W2-5** Tech-out + technician day proof | [`wave2/W2-5-field-tech-out-and-day-proof.md`](./wave2/W2-5-field-tech-out-and-day-proof.md) | `feat/w2-5-field-tech-out-day-proof` |

Each thread includes a paste-ready **handoff prompt**.

---

## Summary

Close remaining **trust / legal / field** gaps:

- Outbound AI dials only with consent (wire existing `checkOutboundConsent`)
- Direct appointment create respects feasibility
- Public estimate tier money shows cents
- Job notes can become a `draft_invoice` proposal
- Tech-out + technician day are wired and proven

## Kickoff order

```text
W2-1 TCPA ──┐
W2-2 feas. ─┼─► W2-4 notes→invoice
W2-3 cents ─┘         │
                      └─► W2-5 field proof
```

## Progress

| Thread | Status |
|--------|--------|
| W2-1 TCPA/DNC | ☐ Not started |
| W2-2 Feasibility | ☐ Not started |
| W2-3 Tier cents | ☐ Not started |
| W2-4 Notes→invoice | ☐ Not started |
| W2-5 Field proof | ☐ Not started |

## Success statement

> Outbound AI cannot dial without consent; scheduling create cannot ignore feasibility; estimate money renders correctly; field tech out/day paths are proven in CI.
