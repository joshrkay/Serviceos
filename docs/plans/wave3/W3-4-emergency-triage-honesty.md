# W3-4 — Emergency triage honesty

**Thread ID:** W3-4  
**Parent:** [Wave 3 index](./README.md) · [umbrella](../2026-07-10-003-feat-wave3-product-day-in-the-life-followup-plan.md)  
**Status:** ready to pick up  
**Branch:** `feat/w3-4-emergency-triage-honesty`  
**PR title:** `fix(voice): emergency triage honesty — no overclaim (W3-4)`  
**Estimate:** ~1 day  
**Parallel with:** W3-3

---

## Goal

Emergency **fast-path escalate** stays; aspirational vulnerability/weather triage that is dead code or hardcoded-off must not be marketed or silently half-run. Either wire a minimal honest path or clearly disable + document.

## Why this thread exists

Workflow audit: Emergencies **🟡 Partial** — fast-path ✅; vulnerability/weather triage largely aspirational. Trust differentiator fails if the system pretends to triage what it doesn’t.

## In scope

- Inventory emergency-related code paths; label WORKING vs DEAD vs OFF
- Remove or gate dead triage that returns fake success
- Ensure medical/emergency escalate still patches to owner with context preface
- Update any user-facing copy that overclaims weather/vulnerability scoring
- Tests for escalate happy path; tests that disabled triage does not no-op-success

## Out of scope

- Building a full weather/vulnerability ML product
- TCPA (W2-1)
- New vertical packs

## Done when

- [ ] No code path reports triage success without doing work
- [ ] Escalate path tested
- [ ] Short note in PR: what is supported vs not for emergencies
- [ ] PR links this thread

## Handoff prompt

```text
Implement W3-4 only: docs/plans/wave3/W3-4-emergency-triage-honesty.md
Branch: feat/w3-4-emergency-triage-honesty from main.
Audit emergency triage; wire or honestly disable; tests for escalate.
Do not build new weather ML.
```
