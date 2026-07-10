# W3-3 — Estimate confidence / ambiguity in UI

**Thread ID:** W3-3  
**Parent:** [Wave 3 index](./README.md) · [umbrella](../2026-07-10-003-feat-wave3-product-day-in-the-life-followup-plan.md)  
**Status:** ready to pick up  
**Branch:** `feat/w3-3-estimate-confidence-ui`  
**PR title:** `feat(web): surface estimate confidence and ambiguity (W3-3)`  
**Estimate:** 1–1.5 days  
**Parallel with:** W3-1, W3-4

---

## Goal

Backend already grounds catalog prices and caps confidence; **Inbox / estimate review UI** must show confidence + ambiguity pickers so owners don’t approve blind.

## Why this thread exists

Workflow audit: Estimating **strong backend**, **🟡 confidence/ambiguity not fully surfaced in UI**. Inbox already has some AmbiguityPicker / meta types — finish the owner-visible loop on estimate proposals and estimate detail.

## In scope

- Show overall confidence + markers on estimate-related proposal cards
- Ambiguous catalog lines: picker that POSTs resolve-line (no auto-approve)
- Empty/missing meta: degrade gracefully (no crash, no fake “high”)
- Component tests for render + resolve wiring

## Out of scope

- Changing auto-approve thresholds in the gateway
- New proposal types
- Public customer estimate page confidence (owner-only)

## Done when

- [ ] Owner sees confidence on pending estimate proposals
- [ ] Ambiguity resolve path works end-to-end in tests
- [ ] PR links this thread

## Handoff prompt

```text
Implement W3-3 only: docs/plans/wave3/W3-3-estimate-confidence-ui.md
Branch: feat/w3-3-estimate-confidence-ui from main.
Surface confidence/ambiguity on estimate review UI; component tests.
Do not change billing engine thresholds.
```
