# Operator Voice Top-50 — v4/v5/v6 corpora

Fourth, fifth, and sixth independent utterance sets. Same 50-workflow matrix, fixture refs, and tags as v1–v3.

## Files

| Version | Cases file |
|---------|------------|
| v4 | `fixtures/voice/operator-voice-top-50-v4-cases.json` |
| v5 | `fixtures/voice/operator-voice-top-50-v5-cases.json` |
| v6 | `fixtures/voice/operator-voice-top-50-v6-cases.json` |

Regenerate from v3 structure:

```bash
node scripts/generate-operator-voice-corpus.mjs
```

## Seed + probe (Development)

```bash
source /opt/cursor/artifacts/railway-database-url.env

cd packages/api
QA_TENANT_ID=b8e2dc0f-04c2-4ba0-9385-0ebcf3168052 \
QA_ACTOR_ID=25abab01-4303-4626-9672-af9a19bf6a64 \
NODE_ENV=development \
npx tsx scripts/seed-operator-voice-fixtures.ts

cd ../..
for V in v4 v5 v6; do
  CASES_PATH=fixtures/voice/operator-voice-top-50-${V}-cases.json \
  OUT_DIR=/opt/cursor/artifacts/operator-voice-50-${V}-$(date -u +%Y%m%d-%H%M) \
  API_URL=https://serviceosapi-development.up.railway.app \
  node scripts/probe-operator-voice-50-live.mjs
done
```

Requires `CLERK_SECRET_KEY`. Target after PR #727: **50/50 voice PASS** per corpus.

## Unit checks

```bash
node --test scripts/__tests__/probe-operator-voice-50-live.test.mjs
```
