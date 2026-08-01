# Operator Voice Top-50 — v2 corpus (fresh utterances)

**File:** `fixtures/voice/operator-voice-top-50-v2-cases.json`  
**Created:** 2026-07-22  
**Baseline it replaces for wording:** `docs/verification-runs/operator-voice-50-live-2026-07-20.results.json`

## Purpose

Same 50-workflow acceptance coverage as the original Top-50 probe, with **brand-new operator phrasing** so regressions cannot pass by memorizing the July 20 utterances. Each case includes optional `fixtureRefs` (catalog keys) and `tags` for failure triage.

## Workflow mix (50 cases)

| Category | Count | Proposal expected |
|----------|------:|-------------------|
| client | 8 | 6 mutations + 2 read-only |
| job | 6 | 4 mutations + 1 read-only |
| estimate | 8 | 8 mutations |
| invoice | 10 | 9 mutations + 1 read-only balance |
| schedule | 8 | 7 mutations + 1 read-only |
| ops | 10 | 7 mutations + 2 read-only + 1 emergency |

## Fixture alignment

Cases reference the audited QA catalog (`fixtures/voice/operator-voice-fixture-catalog.json`):

- **Khan, Johnson, Mrs Lee, Smith (×2), Garcia, Carlos, Greenfield lead**
- **Document numbers:** `EST-0001`, `EST-0042`, `INV-0042`
- **Appointment:** `appointment.garcia-tuesday` (2026-07-28 14:00 UTC)

Tagged **seed-gap** cases intentionally reference entities not in the catalog (Alvarez, Jones, Patel, Hayes) to preserve negative-path coverage.

## Run the probe

```bash
source /opt/cursor/artifacts/railway-database-url.env   # if seeding first
cd packages/api
QA_TENANT_ID=b8e2dc0f-04c2-4ba0-9385-0ebcf3168052 \
QA_ACTOR_ID=25abab01-4303-4626-9672-af9a19bf6a64 \
NODE_ENV=development \
npx tsx scripts/seed-operator-voice-fixtures.ts

cd ../..
CASES_PATH=fixtures/voice/operator-voice-top-50-v2-cases.json \
OUT_DIR=/opt/cursor/artifacts/operator-voice-50-v2-$(date +%Y%m%d) \
API_URL=https://serviceosapi-development.up.railway.app \
node scripts/probe-operator-voice-50-live.mjs
```

## Compare to v1

| | v1 (2026-07-20) | v2 (this corpus) |
|--|-----------------|------------------|
| Utterances | Original phrasing | All new phrasing |
| Metadata | Results JSON only | Dedicated cases file + tags |
| Fixture refs | Implicit | Explicit per case |
| Probe input | `results[]` wrapper required | `cases[]` or legacy `results[]` |
