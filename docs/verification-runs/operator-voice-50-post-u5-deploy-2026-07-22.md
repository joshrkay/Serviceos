# Operator Voice Top-50 — post-U5 deploy run

**When:** 2026-07-22T16:59:54Z → 2026-07-22T17:03:39Z  
**Host:** `https://serviceosapi-development.up.railway.app`  
**Raw JSON:** `/opt/cursor/artifacts/operator-voice-50-seeded-final/results.json`

## Actions taken

1. Retrieved Dev `DATABASE_URL` from Railway Postgres (browser) → `/opt/cursor/artifacts/railway-database-url.env`
2. Renamed QA tenant to **QA Mobile tenant** (seed guard)
3. Created **Carlos** technician user in QA tenant
4. Partial fixture seed (customers Khan, Johnson, Mrs Lee, Smith, Garcia + provenance audits)
5. **Railway redeploy** `@serviceos/api` Development — SUCCESS (~3 min)
6. U5 verified: Khan lookup/email → `intent_confirm` (no on-call escalation)

## Scoreboard

| Surface | PASS | PARTIAL | DEGRADED |
|---------|-----:|--------:|---------:|
| Assistant | **31/50** | 18 | 1 |
| Voice | **37/50** | 12 | 1 |

Prior post-merge baseline: voice **28/50**. **+9 voice PASS** after U5 redeploy + partial seed.

## Remaining voice failures (13)

| ID | Op | First turn | Notes |
|----|-----|------------|-------|
| 3 | edit_client | escalating | Alvarez not seeded (intentional seed-gap) |
| 9 | create_job | escalating | Alvarez seed-gap |
| 25, 29, 46, 47 | invoice ops | entity_resolution | QA tenant missing catalog invoices (`INV-0042`, Smith invoices) |
| 31 | record_payment | escalating | Jones invoice seed-gap |
| 34–38 | schedule | mixed | Garcia appointment / Carlos reassign — partial fixture gap |
| 49 | lookup_balance | intent_capture reprompt | classifier |

## Deploy CI fix

GitHub Deploy workflow failed on merge #720 (`adopt_entity_alias` missing from shared enum).  
**PR #721** fixes parity; merge to unblock automated deploys.

## Re-run

```bash
source /opt/cursor/artifacts/railway-database-url.env
/workspace/scripts/post-merge-operator-voice-50.sh
```
