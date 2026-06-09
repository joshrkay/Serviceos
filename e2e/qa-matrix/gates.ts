/**
 * Production readiness gate row lists for the QA matrix harness.
 *
 * Voice-Critical (hard gate): 20/20 must be `pass`; partial/fail/na/missing
 * all count as fail. No waivers without dated executive sign-off.
 *
 * Business-Critical (soft gate): ≥27/30 must pass; up to 3 documented
 * exceptions (see qa/gate-exceptions.json) may count toward the threshold.
 */

export const VOICE_CRITICAL_IDS = [
  'CUST-02', // voice create_customer proposal + persist
  'SCH-02', // voice schedule appointment proposal + create
  'SCH-03', // voice cancel appointment proposal + cancel
  'VOX-01', // emergency escalation
  'VOX-02', // Spanish response
  'VOX-03', // DNC SMS suppression
  'SMS-02', // SMS consent suppression
  'VOX-11', // voice-created proposal in inbox
  'PROP-01', // proposal approval guardrails
  'PROP-02', // proposal inbox endpoint
  'INV-02', // invalid invoice transition guard
  'VOX-05', // voice estimate draft
  'VOX-06', // voice estimate send
  'VOX-07', // voice invoice create
  'VOX-08', // voice invoice issue
  'INV-06', // idempotent payment webhook
  'VOX-09', // interactions timeline
  'ISO-01', // cross-tenant denial
  'PROP-03', // cross-tenant proposal denial
  'VOX-10', // voice session DB linkage
] as const;

export type VoiceCriticalId = (typeof VOICE_CRITICAL_IDS)[number];

export const BUSINESS_CRITICAL_IDS = [
  'PROV-01',
  'PROV-02',
  'CUST-01',
  'CUST-03',
  'EST-01',
  'EST-02',
  'EST-03',
  'EST-R1',
  'JRN-01',
  'JRN-02',
  'JRN-03',
  'SCH-01',
  'SCH-04',
  'SCH-05',
  'SMS-01',
  'SMS-02',
  'PAY-01',
  'PAY-02',
  'PAY-03',
  'PAY-04',
  'INV-01',
  'INV-02',
  'PORT-01',
  'PORT-02',
  'RPT-01',
  'RPT-02',
  'RPT-03',
  'JOB-01',
  'LEAD-01',
  'ME-01',
] as const;

export type BusinessCriticalId = (typeof BUSINESS_CRITICAL_IDS)[number];

/** Soft gate: at least this many business-critical rows must pass (or be waived). */
export const BUSINESS_CRITICAL_MIN_PASS = 27;

/** Maximum active documented exceptions allowed toward the soft gate. */
export const BUSINESS_CRITICAL_MAX_EXCEPTIONS = 3;
