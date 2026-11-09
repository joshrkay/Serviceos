# The public demo line

One real phone number, published, that answers as a seeded demo tenant. Because
anyone can dial it and every answered second costs money, the API caps it (demo
tenants only — a real tenant's calls never see these caps) and the number is
attached with a script that cannot create a tenant, a Clerk user or a Stripe
checkout.

## Attaching the number

`packages/api/scripts/attach-demo-number.ts` buys one local number into an
**existing** demo tenant (`tenants.demo = true`, from
`scripts/seed-demo-tenants.ts`) and records it the way normal provisioning does
(subaccount, `tenant_integrations` row with `provider_data.phoneE164`, and
`tenant_settings.business_phone`). The voice webhook is the normal inbound path,
`/api/telephony/voice`, with the LCR-04 voice fallback and the status callback.

```sh
# 1. Look first. Searches Twilio and reads the database; buys and writes nothing.
DATABASE_URL=... TENANT_ENCRYPTION_KEY=... TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... \
VOICE_PUBLIC_URL=https://voice.example.com \
  npx tsx packages/api/scripts/attach-demo-number.ts \
    --tenant-id <demo-tenant-uuid> --dry-run

# 2. Buy it. This spends real money (a number is recurring).
  ... same environment ... \
  npx tsx packages/api/scripts/attach-demo-number.ts --tenant-id <demo-tenant-uuid>
```

| Flag | |
| --- | --- |
| `--tenant-id <uuid>` | Required. Must be a demo tenant; a real tenant, the platform tenant or an unknown id is refused before any Twilio call. |
| `--area-code <3 digits>` | Search this area code. Wins over `--region`. |
| `--region <US state>` | Search that state's area code (the one normal provisioning uses). Default `AZ`. |
| `--dry-run` | Print the number it would buy and the URLs it would set; buy and write nothing. |

| Required environment | |
| --- | --- |
| `DATABASE_URL` | Database the demo tenant lives in. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Master account: searches, creates the tenant's subaccount. |
| `TENANT_ENCRYPTION_KEY` | Encrypts the subaccount auth token at rest. |
| `VOICE_PUBLIC_URL` (else `PUBLIC_API_URL`, else `APP_PUBLIC_URL`) | Public **https** base of the service that answers calls. A non-https base is refused: it is baked into a number you pay for. |

It is idempotent: a tenant that already has its number is reported and left
alone, and a re-run after a crash reuses the saved subaccount and recovers a
number already bought into it instead of buying a second. If no number exists in
the area code it stops before creating or buying anything. It does not attach a
Messaging Service (the line is voice-only) or create a Vapi assistant.

## The caps

All three apply to inbound calls to a demo tenant only, are read once at boot,
and have the defaults below. Each is a positive integer; a malformed value
closes just the demo line (every demo call hears the limit message and is hung
up, one error log) and never touches real tenants or the outbound demo call.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEMO_INBOUND_PER_CALLER_DAILY` | `3` | Calls one caller (Twilio `From`) gets per trailing 24 h. |
| `DEMO_INBOUND_DAILY_TOTAL` | `50` | Calls the whole line takes per trailing 24 h. |
| `DEMO_INBOUND_MAX_SECONDS` | `180` | Longest one call may run. |

- **Over a cap**: the caller hears a polite "demo limit reached" message and the
  call hangs up before any session or AI turn exists.
- **Per call**: the existing max-call-duration cap of both voice transports,
  tightened for demo tenants (`terminal_reason = 'max_call_duration'`). On media
  streams a timer speaks the wrap-up line 30 s before the limit and ends the call
  at it. On the Gather path there is no timer: the first turn after the limit
  gets the wrap-up and the hang-up. It can only tighten
  `VOICE_MAX_CALL_DURATION_MS`, never loosen it.
- **Spend** is bounded by the day's total times the per-call limit
  (defaults: 50 × 180 s = 150 call-minutes). There is no separate cents cap;
  lower `DEMO_INBOUND_DAILY_TOTAL` or `DEMO_INBOUND_MAX_SECONDS` to tighten it.
- "Daily" is a trailing 24 h window, as the outbound demo's visitor allowance is,
  not a UTC day. Callers are keyed on an HMAC of the number (never stored in the
  clear). A caller over their own limit never spends the shared total, so one
  number redialing cannot drain the day.
- The counters are `phone_rate_limits` rows on the **platform tenant**, so a
  demo tenant's reset (which empties every table the tenant owns) cannot clear
  them. They are deliberately not on `demo_call_budget`: that is the outbound
  demo call's own budget, and sharing it would let abuse of the public number
  use up the outbound demo.
- **Voice gate**: a demo tenant has no billing, so the usual voice gate would
  send every call to voicemail. A demo call inside the caps is answered without
  it; the caps stand in for it. If the guard itself fails, or the demo flag
  cannot be read, the call is treated as ordinary and the gate blocks an unbilled
  tenant, so a failure can never grant the bypass. A counter that cannot be read
  refuses the demo call (fails closed).
- The caps need the database and `DEMO_LEASE_TOKEN_SECRET` (explicit in prod and
  staging). Without the secret there, the caps are not installed and a demo
  tenant's calls go to voicemail — closed, never uncapped.

To pull the line immediately, release the number in the Twilio console (the call
then fails at Twilio), or unset `DEMO_LEASE_TOKEN_SECRET` and redeploy (calls go
to voicemail).

## Known hazard: the outbound demo-call pool

The tenant you attach is still a member of the outbound demo-call pool.
`src/demo/lease.ts` leases any free `demo = true` tenant of the visitor's trade,
and when that call ends `src/demo/reset.ts` purges every tenant-owned table
except `tenants`, `demo_tenant_leases`, `demo_inflight_jobs` and `audit_events`
— `tenant_integrations` included. After the first outbound demo call that leases
the attached tenant, its number would no longer resolve to a tenant and the
public line would answer "this number is not in service".

Until that is closed in code, do **not** enable `DEMO_CALLS_ENABLED` while the
public line is attached to a pool tenant, or attach it to a trade the outbound
demo does not offer. Closing it for good means either keeping
`tenant_integrations` out of the reset walk or excluding a tenant that holds a
number from the lease pick; both touch the reset/lease contract and need their
own change and tests.

## Tests

- `test/demo/inbound-limits.test.ts`, `test/demo/config.test.ts` — the guard and
  its configuration: per-caller limit, daily total, demo-only behaviour,
  fail-closed paths.
- `test/routes/telephony-demo-inbound.test.ts` — `/voice`: limit message and
  hang-up, gate bypass for an allowed demo call, real tenants unaffected.
- `test/telephony/gather-max-call-duration.test.ts`,
  `test/telephony/media-streams/mediastream-adapter.test.ts`,
  `test/ai/voice-turn/shared/max-call-duration.test.ts` — the per-tenant call
  limit on both transports.
- `test/scripts/attach-demo-number.test.ts` — the script, with Twilio mocked:
  dry run buys and writes nothing, demo-only, idempotent, recovery.
- `test/integration/attach-demo-number.test.ts` (Docker-gated) — the SQL at real
  Postgres, and the counters on the platform tenant under RLS.
