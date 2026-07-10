# W2-1 — Wire TCPA/DNC outbound consent

**Thread ID:** W2-1  
**Parent:** [Wave 2 index](./README.md) · [umbrella](../2026-07-10-002-feat-wave2-trust-and-field-gaps-followup-plan.md)  
**Status:** ready to pick up  
**Branch:** `feat/w2-1-tcpa-dnc-outbound-consent`  
**PR title:** `fix(voice): wire TCPA/DNC outbound consent gate (W2-1)`  
**Estimate:** ~1 day  
**Parallel with:** W2-2, W2-3

---

## Goal

Every outbound AI/customer dial path must call `checkOutboundConsent` **before** placing the call. Blocked attempts emit `voice.outbound_blocked` audit and never dial.

## Why this thread exists

`packages/api/src/voice/outbound-consent.ts` is **built** (DNC list + consent_status + format checks) but **nothing imports/calls it** (Blocker 11). `isOutboundAllowed` alone only rejects malformed/premium numbers.

## In scope

- Find all outbound dial entry points (voice proposal execution, callback handlers, outbound campaign paths)
- Call `checkOutboundConsent` fail-closed before Twilio/place-call
- Integration tests: DNC / consent_revoked / not_granted → no dial + audit event
- Quiet-hours check if already sketched in consent module; otherwise minimal TCPA window (document if deferred to W2-1b)
- If outbound AI is not launch-scoped: hard-disable outbound dial behind a flag **and** still wire the gate so enabling later is safe

## Out of scope

- Full TCPA counsel policy engine / state-by-state matrix
- Inbound voice changes
- Wave 3 product features

## Key files

| Path | Role |
|------|------|
| `packages/api/src/voice/outbound-consent.ts` | Gate to wire |
| `packages/api/src/voice/outbound-allowlist.ts` | Format-only (keep as first step) |
| Outbound dial callers under `voice/`, `proposals/execution/`, workers | Call sites |
| New/extended `*.int.test.ts` | Proof |

## Done when

- [ ] `checkOutboundConsent` has ≥1 production caller on every outbound dial path
- [ ] Integration test proves block + audit; allow path still dials when consent granted
- [ ] Grep shows no outbound place-call bypassing the gate
- [ ] PR links this thread

## Handoff prompt

```text
Implement W2-1 only: docs/plans/wave2/W2-1-tcpa-dnc-outbound-consent.md
Branch: feat/w2-1-tcpa-dnc-outbound-consent from main.
Wire checkOutboundConsent into all outbound dial paths; add integration proof.
Do not implement W2-2..W2-5 or Wave 3.
```
