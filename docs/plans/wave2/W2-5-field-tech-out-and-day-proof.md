# W2-5 — Field: tech-out + technician day proof

**Thread ID:** W2-5  
**Parent:** [Wave 2 index](./README.md) · [umbrella](../2026-07-10-002-feat-wave2-trust-and-field-gaps-followup-plan.md)  
**Status:** ready to pick up  
**Branch:** `feat/w2-5-field-tech-out-day-proof`  
**PR title:** `test/feat(field): tech-out + technician day proof (W2-5)`  
**Estimate:** 1–1.5 days  
**Parallel with:** W2-4

---

## Goal

Prove (and finish any wiring gaps for) the field tech loop:

1. Tech SMS **OUT** / “I’m out” → reschedule proposals for affected jobs (P6-028)  
2. Technician day view stays usable (no blank flash; appointments load) with hermetic or seeded E2E

## Why this thread exists

P6-028 tech-status code exists under `sms/tech-status/` and inbound dispatch — earlier audits called “I’m out” built-not-wired; verify **app bootstrap registration** and add **CI proof**. Technician day was a flicker/soft area for field trust.

## In scope

- Audit `registerTechStatus` / inbound-dispatch wiring in `app.ts`; fix if unwired
- Integration or SMS fixture test: OUT keyword → handled + reschedule proposal(s) or idempotent no-op
- Hermetic E2E for `/technician/day` (Clerk stub): seeded appointments render; soft refresh doesn’t wipe list
- Fix only blockers discovered while proving (keep product scope tight)

## Out of scope

- Full offline field PWA / multi-visit (parity P26)
- On-device voice
- Tap-to-pay
- Route optimization (W3-6)

## Key files

| Path | Role |
|------|------|
| `packages/api/src/sms/tech-status/*` | OUT handler |
| `packages/api/src/sms/inbound-dispatch.ts` | Registration |
| `packages/api/src/scheduling/reschedule/from-tech-out.ts` | Reschedule fan-out |
| `packages/web/src/pages/technician/TechnicianDayView.tsx` | Day UI |
| `e2e/technician-phone-mobile.spec.ts` or new hermetic spec | Proof |

## Done when

- [ ] Confirmed wired in composition root (or fixed)
- [ ] Automated test for OUT path
- [ ] Technician day hermetic/seeded proof green in CI
- [ ] PR links this thread

## Handoff prompt

```text
Implement W2-5 only: docs/plans/wave2/W2-5-field-tech-out-and-day-proof.md
Branch: feat/w2-5-field-tech-out-day-proof from main.
Verify/wire P6-028 tech-out; add tests + technician day proof.
Do not build full field PWA or route opt.
```
