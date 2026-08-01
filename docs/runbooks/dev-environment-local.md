# Local Development Environment — Railway Development mirror

This workspace is wired to the **Railway Development** stack (`serviceosapi-development` / `serviceosweb-development`).

## Quick start

```bash
source scripts/load-dev-env.sh
npm run qa:doctor
```

## Files (gitignored — not committed)

| File | Purpose |
|------|---------|
| `.env.qa` | Railway dev URLs, Postgres, Clerk HMAC secret |
| `.env.qa.local` | Tenant UUIDs (matrix + voice probe) |
| `.env` | Root local dev defaults |
| `packages/api/.env` | API package (shared dev DB + Clerk) |
| `packages/web/.env.local` | Vite → dev API + Clerk publishable key |

Regenerate from cloud agent secrets:

```bash
# Requires DATABASE_URL + CLERK_SECRET_KEY + VITE_CLERK_PUBLISHABLE_KEY in shell
bash scripts/sync-dev-env-from-cloud.sh
```

## Railway Development endpoints

| Service | URL |
|---------|-----|
| API | `https://serviceosapi-development.up.railway.app` |
| Web | `https://serviceosweb-development.up.railway.app` |
| Clerk instance | `romantic-lark-48` (`pk_test_` / `sk_test_`) |
| JWT template | `serviceos` |

## QA tenants (existing in dev Postgres)

| Purpose | Tenant ID | Actor / Clerk sub |
|---------|-----------|-------------------|
| Matrix A | `a948cc66-7279-44bd-9718-4ef7721f9422` | `qa-matrix-user-A` |
| Matrix B | `ce4d752d-651a-4b72-8a01-f7113fba9454` | `qa-matrix-user-B` |
| Voice probe | `b8e2dc0f-04c2-4ba0-9385-0ebcf3168052` | `user_3GZQEdOUZSzhUNn7pb57fW5jKyg` |

Voice probe actor: `25abab01-4303-4626-9672-af9a19bf6a64`

## Voice probe

```bash
source scripts/load-dev-env.sh
cd packages/api && npx tsx scripts/seed-operator-voice-fixtures.ts
cd ../..
CASES_PATH=fixtures/voice/operator-voice-top-50-v4-cases.json \
  OUT_DIR=/opt/cursor/artifacts/operator-voice-50-v4-$(date -u +%Y%m%d-%H%M) \
  node scripts/probe-operator-voice-50-live.mjs
```

Requires `CLERK_SECRET_KEY` (same as `E2E_CLERK_HMAC_SECRET`).

## Notes

- **Do not** run `npm run qa:setup` seed against the shared `railway` database without `E2E_DB_ALLOW_UNSAFE=1` — it refuses destructive seed on non-test DB names.
- Journey fixture tenants (`qa-journey-*`) are **not** pre-seeded; run journey seed only if needed with explicit unsafe flag.
- Production uses live Clerk/Stripe keys — see `docs/runbooks/clerk-setup.md` §7.
