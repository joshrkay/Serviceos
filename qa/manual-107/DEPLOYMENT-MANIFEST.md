# Deployment and commit manifest — Manual QA 107

| When (UTC) | Git commit | Branch | Railway env | Service | Deployment ID | Health | Notes |
|------------|------------|--------|-------------|---------|---------------|--------|-------|
| pending | pending | `cursor/serviceos-qa-107-pass-142f` | Development | api/web | pending | `/health` observed ok at kickoff | Auth to Railway CLI blocked; cannot read deploy IDs yet |

## Observed public health (kickoff)

- API Development `/health` → `200` `{status:ok, environment:development, database:ok, drain:ok}`
- Web Development `/` → `200`
- API Production `/health` → `200` (not the QA target)

## Production configuration intentionally left disabled

| Setting | Why left disabled |
|---------|-------------------|
| `CLERK_DEV_HMAC_TOKENS` on **production** | Dev-only HMAC auth path; must stay off in prod |
| Destructive `qa:full:reset` against production DB | Safety gates refuse prod host/name patterns |
| Live (non-test) Stripe / Twilio traffic to real customers | QA uses sandbox/test mode + disposable tenants only |
