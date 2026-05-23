# Voice Quality Report (rubric v1)

Generated: 2026-05-23T10:00:37.764Z

**Launch gate: FAIL**

Overall: 1/40 (2.5%) — threshold 90%

## Per-bucket results

| Bucket | Pass | Total | Rate | Threshold | Meets? |
| --- | ---:| ---:| ---:| ---:| :---: |
| 01-happy-lookups | 0 | 6 | 0.0% | 100% | no |
| 02-happy-booker | 0 | 4 | 0.0% | 100% | no |
| 03-lead-capture | 0 | 3 | 0.0% | 100% | no |
| 04-identity-edges | 0 | 5 | 0.0% | 90% | no |
| 05-compliance-edges | 0 | 4 | 0.0% | 90% | no |
| 06-hangup-edges | 1 | 3 | 33.3% | 90% | no |
| 07-out-of-scope | 0 | 4 | 0.0% | 90% | no |
| 08-ambiguity | 0 | 4 | 0.0% | 70% | no |
| 09-concurrency | 0 | 3 | 0.0% | 70% | no |
| 10-adversarial | 0 | 4 | 0.0% | 70% | no |

## Failed scripts

- `accent-uncertain-confidence` (08-ambiguity) structured=[9]
- `add-note-escalated` (07-out-of-scope) structured=[11]
- `after-hours-callback` (05-compliance-edges) structured=[9,10,11]
- `caller-id-blocked` (04-identity-edges) structured=[9,11]
- `caller-id-matches-existing-lead-not-customer` (04-identity-edges) structured=[9]
- `caller-id-matches-multiple-customers` (04-identity-edges) structured=[9,11]
- `caller-id-matches-one-customer` (04-identity-edges) structured=[9]
- `caller-id-mismatched-but-claims-existing` (04-identity-edges) floor=[1] structured=[9,11]
- `cancel-appointment-known-customer` (02-happy-booker) structured=[9,10]
- `cost-cap-drain` (10-adversarial) floor=[1] structured=[11]
- `create-appointment-known-customer` (02-happy-booker) structured=[9,10]
- `create-customer-new-signup` (03-lead-capture) structured=[9,10]
- `cross-customer-extraction` (10-adversarial) structured=[9,11]
- `customer-just-archived-mid-call` (09-concurrency) structured=[9,11]
- `dnc-caller-terminated` (05-compliance-edges) floor=[7] structured=[9,11]
- `find-or-create-lead-unknown-caller` (03-lead-capture) structured=[9,11]
- `hangup-mid-confirmation` (06-hangup-edges) floor=[1] structured=[9,10]
- `hangup-post-proposal` (06-hangup-edges) structured=[9,10]
- `known-customer-no-signup` (03-lead-capture) structured=[9]
- `lookup-account-summary-known-customer` (01-happy-lookups) floor=[1] structured=[9]
- `lookup-appointments-next` (01-happy-lookups) structured=[9]
- `lookup-customer-confirm-info` (01-happy-lookups) structured=[9]
- `lookup-estimates-recent` (01-happy-lookups) structured=[9]
- `lookup-invoices-balance` (01-happy-lookups) structured=[9]
- `lookup-jobs-known-customer` (01-happy-lookups) floor=[1] structured=[9]
- `mumble-low-confidence-reprompt` (08-ambiguity) structured=[9]
- `out-of-coverage-area` (05-compliance-edges) structured=[9,11]
- `partial-info-incomplete` (08-ambiguity) structured=[9,10]
- `payment-request-escalated` (07-out-of-scope) structured=[11]
- `reschedule-appointment-known-customer` (02-happy-booker) structured=[9,10]
- `slot-just-taken-by-other-call` (09-concurrency) structured=[9,10]
- `spam-create-customer` (10-adversarial) floor=[1] structured=[9,11]
- `sql-injection-text` (10-adversarial) structured=[9,11]
- `stale-appointment-just-cancelled` (09-concurrency) structured=[9,11]
- `stop-sent-no-sms` (05-compliance-edges) floor=[1] structured=[9]
- `two-intents-one-sentence` (08-ambiguity) floor=[1] structured=[9]
- `two-step-booking-known-customer` (02-happy-booker) floor=[1] structured=[9,10]
- `update-customer-escalated` (07-out-of-scope) floor=[1] structured=[11]
- `vague-complaint-escalated` (07-out-of-scope) structured=[11]

## Launch-gate blockers

- floor failure: caller-id-mismatched-but-claims-existing (criteria 1)
- floor failure: cost-cap-drain (criteria 1)
- floor failure: dnc-caller-terminated (criteria 7)
- floor failure: hangup-mid-confirmation (criteria 1)
- floor failure: lookup-account-summary-known-customer (criteria 1)
- floor failure: lookup-jobs-known-customer (criteria 1)
- floor failure: spam-create-customer (criteria 1)
- floor failure: stop-sent-no-sms (criteria 1)
- floor failure: two-intents-one-sentence (criteria 1)
- floor failure: two-step-booking-known-customer (criteria 1)
- floor failure: update-customer-escalated (criteria 1)
- 01-happy-lookups below threshold (0.00 < 1.00)
- 02-happy-booker below threshold (0.00 < 1.00)
- 03-lead-capture below threshold (0.00 < 1.00)
- 04-identity-edges below threshold (0.00 < 0.90)
- 05-compliance-edges below threshold (0.00 < 0.90)
- 06-hangup-edges below threshold (0.33 < 0.90)
- 07-out-of-scope below threshold (0.00 < 0.90)
- 08-ambiguity below threshold (0.00 < 0.70)
- 09-concurrency below threshold (0.00 < 0.70)
- 10-adversarial below threshold (0.00 < 0.70)
- overall below threshold (0.03 < 0.90)

## Cost & latency

- Total cost: 0¢
- P50 turn latency: 0ms
- P95 turn latency: 0ms