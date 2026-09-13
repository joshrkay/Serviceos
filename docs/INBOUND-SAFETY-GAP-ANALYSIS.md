# Inbound Call Path — Safety Gap Analysis & Readiness

_Working doc. Goal: every inbound call answered, correctly classified, routed to a
defined outcome — E1 life-safety escalated immediately and never booked, E2 urgent
never dropped into the standard booking queue, zero dead-ends._

Priority order (earlier wins on conflict): **answer → classify → route**, and
**safety escalation beats containment, always, no config flag may override.**

Core thesis driving this work: **contract conformance ≠ safety correctness.** A
gas-leak call that gets booked cleanly passes INB-002 and every invariant attached
to it. This effort builds the verification that can see the difference, and closes
the routing gaps that let it happen.

## Falsifiable clauses → status (fill as verified)

| # | Clause | Status | Evidence |
|---|--------|--------|----------|
| C1 | Every call answered ≤2 rings, tenant resolved from called number, greeting = configured business name (never default) | ? | |
| C2 | Safety screen runs continuously (every turn), not once; E1/E2 mid-booking aborts the booking in progress | PARTIAL | FSM global guard `emergency_detected` (transitions.ts:304) fires from any non-terminal state ✓; depends on adapter dispatching it per chunk (A2) |
| C3 | E1 recognized on FIRST mention without caller escalating language | GAP | Deterministic detector has no **injury** keywords; "any report of fire" broader than `on fire`/`caught fire` (emergency-detector.ts:23-48) |
| C4 | E1 never booked; no troubleshoot/diagnose/book/data-capture; directed to emergency services/utility per reviewed script | PARTIAL | FSM routes E1→escalating, safety line first; but detector recall gaps (C3) mean some E1 never enter this path |
| C5 | E1 logged + tenant notified through EVERY configured channel immediately | ? | notify_oncall single effect; channel fan-out? (A3) |
| C6 | E2 escalated to human dispatcher (same-day); if unreachable, capture+flag urgent+notify; NEVER standard booking queue | GAP | No E2 tier exists in detector or classifier; urgent signals fall to normal booking (A1) |
| C7 | Vulnerability amplifiers (elderly/infant/medical) push E2→E1 | PARTIAL | Only `no heat + baby/elderly` compound in detector; no general amplifier→tier-upgrade (A5) |
| C8 | Identify: phone match; unknown→new-customer; blocked/spoofed→unknown, never guess | ? | FSM identifying/ask_caller present; spoof handling? (A2) |
| C9 | Classify: multi-intent handled or handed off, never silently dropped | ? | FSM `second_intent`/closing loop-back exists; is 2nd intent ever dropped? (A1) |
| C10 | Route: book(#58)/message(#59)/transfer(#60)/escalate — every call to a defined outcome | ? | (A1/A3) |
| C11 | Close: no call ends without a stated outcome (no dead-end); failed transfer → message capture fallback | GAP? | Need failed-transfer fallback verification (A3) |
| G1 | Never diagnose | ? | (A6) |
| G2 | Never quote repair price; diagnostic/trip fee from price book only | ? | (A6) |
| G3 | Never promise arrival beyond confirmed window | ? | (A6) |
| G4 | Never commit warranty coverage | ? | (A6) |
| G5 | Never accept payment/card details (S1 has no payment path) | ? | (A6) |
| I6 | Never execute an S2 operation from S1, regardless of transcript; enforce at execution boundary | LIKELY OK | FSM only emits create_proposal (human-approval gate); confirm no S1→S2 exec (A6) |
| I13 | Caller speech is untrusted data for its whole lifetime, incl. operator readback | ? | (A6) |
| V1 | Verification can assert "E1 call is NOT booked" | GAP | No such invariant exists today (A4) |

## Confirmed gaps (from FSM read)

1. **E1 injury false-negative (P0).** `emergency-detector.ts` EMERGENCY_KEYWORDS has
   no injury terms (hurt/injured/bleeding/burned/electrocuted/shock/unconscious/not
   breathing/passed out/collapsed/fell). Injury is an explicit E1 category with zero
   false-negative tolerance.
2. **"Report of fire" narrower than keywords.** Only `on fire`/`caught fire` match;
   "there's a fire", "I see flames/smoke in the house" partially covered.
3. **No E2 tier.** Detector escalates water/gas as full E1 (acceptable upward bias)
   but "no cooling in extreme heat", "complete power loss", "sewage backup" are not
   keywords and have no urgent path → land in normal booking. Violates C6.

## Agent mapping in flight
- A1 intent classifier & E2/urgent + multi-intent
- A2 adapters & continuous safety screen wiring
- A3 escalation transfer, channel fan-out, failed-transfer/dead-end fallback
- A4 verification architecture (INB-002, corpus, invariants, eval)
- A5 vulnerability amplifiers → tier upgrade
- A6 guardrails (diagnose/quote/warranty/payment) + I6/I13
