# Reproduction instructions — 107-item Manual QA

These steps let another tester independently reset the environment and rerun
all 107 tests against a disposable Railway Development/QA target.

## 0. Access required

1. Git clone of `joshrkay/serviceos` on branch with `qa/manual-107/`.
2. Railway project access: `https://railway.com/project/a769e9f1-8d94-4491-8c11-5e46fd736f08`
3. Prefer a **dedicated QA environment**. If reusing Development, confirm no
   real customer tenants will be deleted (reset only touches `qa:qa-full:*`).
4. Secrets (set in shell / `.env.qa`, never commit):
   - `E2E_BASE_URL`, `E2E_API_URL`
   - `E2E_DB_URL_READWRITE` (public proxy URL)
   - `E2E_DB_URL_READONLY` (optional `qa_readonly` NOSUPERUSER NOBYPASSRLS)
   - `E2E_CLERK_HMAC_SECRET` (= API `CLERK_SECRET_KEY`)
   - Provider sandboxes as needed: Stripe test, Twilio test numbers, SendGrid,
     Google OAuth disposable calendar, LLM key for voice/assistant

## 1. Deploy gate

```bash
curl -sS "$E2E_API_URL/health"
curl -sS "$E2E_API_URL/ready"
# Confirm Railway deploy SHA matches the commit under test
```

API Development must have `CLERK_DEV_HMAC_TOKENS=true` (never enable in production).

## 2. Reset + seed

```bash
export QA_TARGET_ENV=development
export E2E_DB_ALLOW_UNSAFE=1
export QA_RESET_CONFIRM=reset-qa-full
npm run qa:full:reset
npm run qa:full:seed
source .env.qa.full.local
npm run qa:full:mint
source .env.qa.full.tokens
npm run qa:full:preflight
npm run qa:evidence:init -- --all
```

Preflight must report **0 hard failures** before section 1.

## 3. Execute

Work through `ACCEPTANCE-CRITERIA.md` in section order 1→22.

For each `QA-xxx`:

1. Prepare fixtures (reset section-specific state if polluted).
2. Start screen recording.
3. Display QA ID + name + tenant + role on screen (notes pad / browser tab title).
4. Execute exact manual steps.
5. Capture API/DB/provider evidence (redacted).
6. Hard-refresh UI and confirm persistence.
7. Stop recording → store under `qa-evidence/QA-xxx/recording.mp4`.
8. Update `qa-evidence/manifest.json` and `execution-ledger.json`.
9. On FAIL: log in `DEFECT-LOG.md`, fix, test, deploy, **rerun from the start of that QA ID**.

## 4. Final gates

```bash
npm run verify                 # full repo verification
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npm run qa:full:preflight
# Confirm Railway deployments healthy
# Confirm PASS:107 FAIL:0 in execution-ledger.json + evidence manifest
```

## 5. Success definition

Only declare complete when `execution-ledger.json` counts are:

```json
{ "PASS": 107, "FAIL": 0, "NOT_RUN": 0, "BLOCKED": 0 }
```

and every evidence entry has a recording path (or stronger alternative proof if
video was technically impossible — document why).
