# Voice CSR parity fixtures

Deterministic corpus backing the Feature 1–6 parity tests in
`packages/api/test/voice/`. No network, no LLM, no Twilio — every fixture is
plain data so the tests are reproducible and fast.

| File | Drives | Used by |
|------|--------|---------|
| `intents.en.json` | Intent + emergency-dial + critical-intent 0.7 handoff (EN) | `intent-escalation.test.ts`, `bilingual.test.ts` |
| `intents.es.json` | Same, Spanish | `intent-escalation.test.ts`, `bilingual.test.ts` |
| `customers.json` | Returning vs new greeting (EN + ES) | `customer-recognition.test.ts` |
| `booking.json` | Booking against the real scheduling engine (EN + ES) | `booking.test.ts` |

## Intent fixture schema
```jsonc
{
  "name": "string — unique, referenced in test output",
  "feature": "feature-2-intent-escalation",
  "language": "en | es",
  "utterance": "what the caller said (first turn)",
  "expectedIntent": "classifier intent string",
  "expectedEmergencyDial": true,   // shouldImmediatelyDialOnEmergency must be true
  "confidence": 0.0,               // simulated classifier confidence
  "expectedCriticalHandoff": true  // decideCriticalHandoff.offerHumanTransfer
}
```

## Booking fixture schema
Calendar instants are UTC ISO strings; the tenant timezone is `America/New_York`
(EDT, UTC-4) in June so local 08:00 = 12:00Z. `expectBookable=false` fixtures
assert the engine correctly *declines* (no availability / past window) rather
than booking.

These fixtures intentionally do not exercise the LLM classifier itself — that is
covered by the `voice-quality` corpus (`npm run voice-quality`). They exercise
the deterministic decision/scheduling logic that the parity bar measures.
