# CRM Parity — Consolidated Dispatch Order

> Source: Jobber / ServiceTitan / ServiceNow CRM gap analysis (2026-05-25).
> Ranks every **unbuilt** CRM-parity story across Phases 10, 13, 14, 15, 16, 20
> by impact on the product's north star (**owner hours returned** + **time-to-cash**),
> then competitor parity, then build cost. Built and intentionally-skipped items
> are listed at the bottom so the backlog stays honest.

This file is the *order of operations*. Per-story specs live in the
`docs/stories/phase-NN-gap-stories.md` files; dispatch constraints live in the
`docs/superpowers/contracts/pNN-dispatch-addendum.md` files.

---

## Build-status reality check (verified against `main`, 2026-05-25)

Several "gaps" are already shipped — do **not** re-dispatch these:

| Capability | Story | Status |
|---|---|---|
| Refunds + partial store-credit tracking | P15-003 | ✅ **Built** (`payments/payment-service.ts`, over-refund guard + tax export) |
| Calendar two-way sync | P15-002 | ✅ **Built** (`integrations/calendar-sync.ts`, Pg repo) |
| Lead pipeline + UTM attribution | P9-001 | ✅ Built |
| Unified customer timeline | P9-002 | ✅ Built |
| Service agreements (recurring) | P9-003 | ✅ Built |
| Portal token sessions | P10-001 (core) | ✅ Built (full dashboard UI partial) |
| Job photos / time tracking / voice modes | P12-* | ✅ Built |
| Google review monitoring + AI reply | reputation/ | ✅ Built |
| Money dashboard + revenue-by-source | reports/ | ✅ Built |

QuickBooks has a **UI stub only** (`web/.../settings/QuickBooksModal.tsx`) — the
backend sync (P15-001) is **not built**.

---

## Dispatch order (unbuilt → build in this sequence)

### Tier 0 — ship first (directly serves the pitch; low regret)

| Rank | Story | Title | Why first | Size |
|---|---|---|---|---|
| 1 | **P15-004** | Two-way SMS + STOP enforcement | SMS is the *primary interface* (PRD decision #1). STOP is currently only logged, not enforced — a live compliance risk. Inbound replies aren't auto-routed. | M |
| 2 | **P15-001** | QuickBooks sync (backend) | #1 adoption-killer for the ICP — eliminates double data entry. UI stub already exists; only the backend is missing. Pure hours-returned. | M |
| 3 | **P13-001** | Multiple contacts per customer | B2B account recognition is PRD locked-decision #9 but was sequenced too late. Pull forward. | M |

### Tier 1 — high value, fits the product

| Rank | Story | Title | Why | Size |
|---|---|---|---|---|
| 4 | **P13-002** | Equipment / asset registry | HVAC equipment history is explicitly *in scope for V1* (PRD §6) yet unbuilt. | M |
| 5 | **P20-001** | Membership plans (tiered benefits) | Net-new. Highest recurring-revenue lever; ServiceTitan's top retention feature. Discount stays approval-gated. | M |
| 6 | **P15-005** | Referral program | Cheapest CAC channel for owner-operators. Lead-source plumbing already exists. | M |
| 7 | **P20-002** | Live online booking | Net-new. Real-slot self-scheduling that stays a *request* the owner confirms (no portal, no auto-commit). | L |

### Tier 2 — valuable, watch scope against PRD non-goals

| Rank | Story | Title | Why / caveat | Size |
|---|---|---|---|---|
| 8 | **P13-003** | Tags + custom fields | Enables segmentation; prerequisite for #10–11. | M |
| 9 | **P10-002** | Executive dashboard (AR aging, pipeline, conversion) | Keep lightweight — PRD says "the digest is the dashboard," not a daily-driver UI. | M |
| 10 | **P10-003** | Post-job review-request automation | Closes the loop with the built review-monitoring. | S |
| 11 | **P16-001/002** | Customer LTV + CAC unit economics | Read-only aggregators; high tenant-isolation test bar. | L |
| 12 | **P16-003** | Re-engagement campaigns | **Bounded** lifecycle only. Do NOT build a marketing-automation platform (explicit PRD non-goal). | M |

### Tier 3 — defer unless ICP expands

| Rank | Story | Title | Why deferred | Size |
|---|---|---|---|---|
| 13 | **P14-001/002/003** | Inventory / parts / pricebook + voice lookup | Low priority for solo HVAC/plumbing ICP; revisit when expanding verticals. | L |
| 14 | **P10-001 (UI)** | Full customer-portal dashboard | Borders the PRD "no self-service portal" non-goal. Keep token-scoped + transactional. | M |

---

## Deliberately NOT on this backlog (competitor features that don't fit)

- ServiceNow **case/ticket management, SLAs, CMDB, workflow-builder** — enterprise ITSM, wrong market (anti-persona).
- **Full marketing-automation suite** (ServiceTitan Marketing Pro) — PRD non-goal; bounded re-engagement (#12) only.
- **Self-service portal as a daily destination** — PRD non-goal; keep token-scoped.
- **Multi-location aggregation, route optimization, payroll** — PRD out-of-scope (V1 / ever).

---

## Suggested wave grouping for `/dispatch-story`

- **Wave A (parallel):** P15-004, P15-001, P13-001 — disjoint domains (sms / integrations / customers-contacts).
- **Wave B (parallel, after A):** P13-002, P20-001, P15-005, P20-002 — greenfield modules, non-overlapping migrations.
- **Wave C:** P13-003 (touches Customer/Lead/Job additively — run before #11–12 which consume tags), then P10-002, P10-003.
- **Wave D:** P16-001/002 then P16-003 (campaigns consume LTV segments).
- **Defer:** P14-*, P10-001 UI.
