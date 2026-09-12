# #1072 — inbound telephony webhooks verify with the credential of the tenant that owns the dialled number

**Branch:** `fix/telephony-tenant-credential-binding` (cut from `origin/main` @ `137dc55`)
**Issue:** [#1072](https://github.com/joshrkay/Serviceos/issues/1072) — found by #1014 lane B, surfaced not fixed (test-only lane)
**Scope:** auth only. No RLS, money, script, classifier or migration changes. No new env vars.
**Method:** strict TDD — the integration file was written first and run RED against the
unfixed code (raw output below), then the fix, then GREEN.

---

## 1. The defect

`/api/telephony/*` resolved the **signing credential** and the **tenant** from two
independent body fields and nothing checked they agreed:

| | resolved from | old code |
|---|---|---|
| auth token | body `AccountSid` | `resolveTwilioAuthTokenForSubaccount` — `app.ts:3756` |
| tenant | body `To` | `resolveTenantIdByPhoneNumber` — `app.ts:3791` |

So `requireTwilioSignature` answered *"is this signed by SOME tenant"*, never *"is this
signed by THE tenant that owns the dialled number."* A tenant that legitimately holds its
own Twilio credential could therefore drive inbound calls into **any** other tenant by
putting the victim's DID — public information, being their business number — in `To`:
voice sessions, leads, customers and audit rows landed under the victim, consuming their
trial minutes and writing into their audit trail.

---

## 2. The change, exactly

### 2.1 New — `packages/api/src/telephony/twilio-webhook-credential.ts`

`createTwilioWebhookCredentialResolver({ pool })` returns the per-request credential
resolver. Resolution order, first match wins:

1. **`tenantId`** — only when the caller already holds a trusted, non-payload tenant (the
   media-stream upgrade, off its in-process session). `twilio-webhook-credential.ts:173`
2. **`to`** — the dialled number, against `tenant_integrations.provider_data->>'phoneE164'`
   (`:101-119`, called at `:174`). Deliberately the SAME predicate `PgPhoneNumberRepository.findByNumber`
   uses to pick the tenant the call will run as — if the credential lookup and the tenant
   lookup could disagree about which row owns a number, the binding would be back to
   guesswork.
3. **`accountSid`** — the legacy subaccount-keyed lookup (`:246-274`). Only reached when
   the payload names no number we own (status callbacks carrying no dialled number;
   outbound-leg callbacks whose `To` is the customer). It cannot be used to reach a tenant
   by DID: any number a tenant owns is resolved at step 2 and never falls through here.
4. **Deployment `TWILIO_AUTH_TOKEN`** (`:158-167`, `:275`) — numbers with no tenant
   integration row, and single-account deployments that predate per-tenant subaccounts.

At steps 1 and 2, an `AccountSid` that is **not** the owning tenant's `subaccount_sid` is
**refused** (`:187-200`, reason `account_sid_not_owned_by_dialled_number_tenant`) rather
than verified — the mismatch is the attack signature, and refusing on it names the failure
instead of letting it read as a corrupt HMAC.

Fail-closed cases, all `misconfigured` (500, loud log), never a silent downgrade to a token
that would accept the request:

| case | line | reason |
|---|---|---|
| the DID/tenant lookup itself threw | `:176-183`, `:249-254` | `credential_lookup_failed` |
| `TENANT_ENCRYPTION_KEY` unset with a stored credential | `:202-207` | `tenant_encryption_key_missing` |
| stored credential will not decrypt | `:217-223`, `:265-271` | `tenant_credential_undecryptable` |
| owning row names a foreign subaccount but stores no token | `:231-239` | `tenant_integration_has_no_credential` |

An owning row that stores no credential **and** names no foreign subaccount is the
single-account shape (the number is on the deployment's own Twilio account, whose token is
in env) and takes the deployment fallback, tagged with the owning tenant id (`:241`).

Both lookups are cross-tenant by construction and run under the
`app.system_lookup = 'true'` GUC that migration 074's permissive read policy gates on, set
LOCAL inside a short transaction with a ROLLBACK-before-release guard (`:82-99`) — the same
discipline the resolvers this replaces carried.

### 2.2 `packages/api/src/telephony/twilio-signature.ts`

- `TwilioCredentialDecision` / `TwilioCredentialContext` / `TwilioAuthTokenGetter`
  (`:37-79`): the getter is handed `{ accountSid, to, tenantId }` and may answer a plain
  token (legacy single-account wiring and tests) or a decision.
- `readDialedNumber(req)` (`:80-95`): `To` on call webhooks, `Called` on recording/status
  callbacks, and the query param the voicemail callback URL mints for itself because
  Twilio's `recordingStatusCallback` body carries neither.
- The middleware (`:159-200`): `refuse` → **403**, `misconfigured` → **500**, both returned
  **before `next()`** and therefore before any session / lead / customer / audit write.
- `:238-242`: every accepted request logs **which credential path verified it** —
  `telephony.signature_verified { route, credentialPath, tenantId }`, where
  `credentialPath` is `tenant_integration` | `subaccount_lookup` | `deployment_fallback`.

### 2.3 `packages/api/src/telephony/media-streams/twilio-mediastream-server.ts`

`:146,155,172` — the upgrade passes the tenant from its in-process session (created by the
now-bound `/voice` webhook) alongside the AccountSid, so the stream is verified with that
tenant's own credential. `:176-195` handles `refuse` → 403 and `misconfigured` → 500.

### 2.4 `packages/api/src/app.ts`

- `:3757` — `resolveTwilioWebhookCredential = createTwilioWebhookCredentialResolver(...)`;
  the old inline `resolveTwilioAuthTokenForSubaccount` body (AccountSid-keyed,
  fallback-on-any-error) is deleted.
- Wired at `:3828` (telephony router → `/voice`, `/gather`, `/dial-result`,
  `/callback-message`, and the `/recording` + `/voicemail-status` sub-routers, which take
  the same getter), `:4016` (whisper TwiML route) and `:4430` (media-stream upgrade).
- `:3773-3790` keeps a plain `AccountSid → token` view of the same resolver for the two
  callers that are **not** inbound verification and must not be bound to a dialled number:
  the outbound REST redirector (`createTwilioCallRedirector`, `:4219` — it needs a token to
  *call* Twilio with, not one to check a signature against) and the outbound call-bridge
  callbacks (`:4060`), whose `To` is the **customer's** number, so binding on it would
  refuse a legitimate callback the moment a tenant dials a number another tenant happens to
  own. Behaviour on those two paths is unchanged.

### 2.5 Interfaces re-typed to the shared getter (no behaviour change)

`routes/telephony.ts:78-86`, `telephony/recording-webhook.ts:62-68`,
`telephony/voicemail-status-route.ts:150-158`.

---

## 3. RED → GREEN

New file: `packages/api/test/integration/telephony-tenant-credential-binding.test.ts`.
Two tenants provisioned exactly as the Twilio onboarding flow leaves them (a DID, a
subaccount SID, their own encrypted auth token), driven through the **real `createApp()`
Express app** against **real Postgres**. The attacker uses only credentials it legitimately
owns; the one hostile field is `To`.

```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
  --config vitest.integration.config.ts --reporter=verbose \
  test/integration/telephony-tenant-credential-binding.test.ts
```

### RED (against the unfixed code, commit `e48b8c9`'s parent)

```
 ✓ (b) tenant A's own credential dialling tenant A's DID is accepted and lands under A 165ms
 ✓ (c) tenant B's own credential dialling tenant B's DID is accepted and lands under B 59ms
 × (a) THE ATTACK — A's own AccountSid + A's own token + To=B's DID is refused 403 and writes NOTHING under B 52ms
 ✓ (a2) the attack is refused even with the AccountSid omitted entirely 1512ms
 × (d1) /gather — a forged callback carrying the victim's DID is refused 403 and writes nothing under B 128ms
 ✓ (d2) /gather — tenant B's own credential on its own DID still works 63ms
 × (d3) the recording status callback — A's credential naming B's DID is refused 403 151ms
 × (d4) the voicemail status callback — A's credential naming B's DID is refused 403 130ms
 ✓ (e) a number with NO tenant integration row still verifies with the deployment fallback token 55ms
 × (e2) the fallback token does NOT open a path into a tenant that owns its own credential 45ms

 Test Files  1 failed (1)
      Tests  5 failed | 5 passed (10)
```

with, per failure:

```
(a)  AssertionError: expected 200 to be 403   ← forged call accepted, session landed under the victim
(d1) AssertionError: expected 200 to be 403
(d3) AssertionError: expected 500 to be 403   ← signature accepted; the 500 is the handler failing later
(d4) AssertionError: expected 500 to be 403
(e2) AssertionError: expected 200 to be 403
```

`(a2)` passes RED for a reason worth stating: with no `AccountSid` the old resolver returned
the **deployment** token, which does not verify an A-signed payload. It is kept because it
is the leg that proves the refusal does not depend on the SID comparison alone.

### GREEN (after the fix)

```
 ✓ (b) … 148ms   ✓ (c) … 60ms    ✓ (a) THE ATTACK … 1514ms   ✓ (a2) … 1511ms
 ✓ (d1) … 1559ms ✓ (d2) … 68ms   ✓ (d3) … 1515ms             ✓ (d4) … 1512ms
 ✓ (e) … 60ms    ✓ (e2) … 1511ms

 Test Files  1 passed (1)
      Tests  10 passed (10)
```

Every negative leg asserts a 403 **and** that `voice_sessions`, `leads`, `customers` and
`audit_events` counts for the victim tenant are unchanged after a settle window (the
`voice_sessions` insert is fire-and-forget — `twilio-adapter.ts:1073`).

---

## 4. Every telephony test run

| command | result |
|---|---|
| `npx vitest run test/telephony test/routes/telephony-tenant-lookup.test.ts` | **40 files, 581 passed** |
| `npx vitest run test/app test/webhooks test/voice` | **146 passed, 1 skipped (147 files); 1476 passed, 3 skipped, 1 todo** |
| `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/{phone-lookups-shared-dispatch,durable-telephony-timers,identify-caller,provision-twilio-vapi,rls-tenant-isolation,dropped-call-worker,telephony-tenant-credential-binding}.test.ts` | **7 files, 72 passed** |
| `npx playwright test --project=chromium e2e/telephony-e1-signed-webhook.spec.ts` | **6 passed (32.5s)** |

Globs adapted to what exists on main: there is no `test/routes/telephony*` beyond
`telephony-tenant-lookup.test.ts`, and `e1-life-safety-handler.test.ts` /
`stranger-owner-capability.test.ts` live on `cloud/capture-8-2-b`, not on main. The
integration list above is every file under `test/integration/` that mentions telephony or
Twilio and is not purely outbound-SMS.

### One existing test relied on the unbound behaviour — fixed, and here is which

`test/telephony/media-streams/twilio-mediastream-server.test.ts:148`
(*"authenticates a provisioned subaccount stream using its bound call account"*) asserted
the resolver's argument exactly:

```
expect(authTokenGetter).toHaveBeenCalledWith({ accountSid });
```

The upgrade now also passes the session's tenant — which is the point of the change — so
the assertion was updated to `{ accountSid, tenantId: 'tenant-subaccount' }`. Nothing about
what the test proves changed; it still drives a real upgrade and still expects 101.

### New unit coverage in the same commit as the logic

- `test/telephony/twilio-webhook-credential.test.ts` — 14 cases over the resolution order
  and every refusal / fail-closed branch, plus the GUC + release discipline.
- `test/telephony/twilio-signature.test.ts` — 4 added cases: `refuse` → 403 with the
  handler never called, `misconfigured` → 500, `verify` honouring the carried token, and
  the resolver receiving the dialled number from `To`, from `Called` and from the query.

These stub the pool; the real column names and the real `provider_data->>'phoneE164'` JSONB
shape are pinned by the integration file, per CLAUDE.md.

---

## 5. The e2e pin, flipped

`e2e/telephony-e1-signed-webhook.spec.ts` is lane B's spec. When this branch was cut it
lived only on `cloud/capture-8-2-b`, so the file was vendored here with its pin flipped;
lane B then landed on main (PR #1069) while this PR was open, and the add/add conflict was
resolved by keeping main's copy of the spec and re-applying the flipped pair on top —
exactly the sequencing the vendored header called for. The two pinned tests (the passing
characterization of the hole and the Playwright `test.fail()` for the required refusal) are
ordinary passing tests now:

- *"a tenant-owned signature does NOT authorise a call to another tenant's DID"* — 403, no
  `voice_sessions` row, tenant B's emergency audit trail unmoved.
- *"the same binding holds on /gather"* — a forged mid-call callback naming a LIVE session
  under B is refused 403. (That covers an attacker naming the VICTIM's DID; the case where
  the attacker names its OWN DID and the victim's `sid` is the review finding in §9a, fixed
  separately.)

Run as its header documents, against a real API process + real Postgres:

```
DATABASE_URL=postgres://test:test@127.0.0.1:32768/serviceos_test DB_SSL=false \
E2E_DEV_AUTH=0 TWILIO_ACCOUNT_SID=AC0…01 TWILIO_AUTH_TOKEN=deployment-fallback-token \
TWILIO_FROM_NUMBER=+15125550000 TWILIO_DEFAULT_TENANT_ID=<uuid> \
TENANT_ENCRYPTION_KEY=<64 hex> PUBLIC_API_URL=http://localhost:3000 \
npx playwright test --project=chromium e2e/telephony-e1-signed-webhook.spec.ts

  6 passed (32.5s)
```

The API process's own logs during that run are the binding narrating itself:

```
telephony.signature_verified  route=/voice   credentialPath=tenant_integration tenantId=be8efda7…
telephony.account_sid_mismatch tenantId=be8efda7… presentedAccountSid=AC1014aaaa…
telephony.signature_refused   route=/voice   reason=account_sid_not_owned_by_dialled_number_tenant
telephony.signature_refused   route=/gather  reason=account_sid_not_owned_by_dialled_number_tenant
```

---

## 6. Evidence — the forged call created NOTHING under the victim

Plain container, no testcontainer:

```
docker run -d --rm -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=serviceos_test -p 127.0.0.1:0:5432 \
  pgvector/pgvector:pg16 -c max_connections=300      # → 127.0.0.1:32769

cd packages/api && EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32769/serviceos_test \
  RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  --reporter=verbose test/integration/telephony-tenant-credential-binding.test.ts

 Test Files  1 passed (1)
      Tests  10 passed (10)
```

Then, straight out of that database:

```
$ psql -c "SELECT tenant_id, provider_data->>'phoneE164' AS did, subaccount_sid,
           (auth_token_primary_enc IS NOT NULL) AS has_token
             FROM tenant_integrations WHERE provider = 'twilio' ORDER BY did;"
              tenant_id               |     did      |           subaccount_sid           | has_token
--------------------------------------+--------------+------------------------------------+-----------
 f2973b5b-110b-4654-ad36-f3362d75de38 | +15126474491 | AC1072aaaaaaaaaaaaaaaaaaaaaaaaaaaa | t          <- tenant A
 bfae1b78-b002-456c-9856-3fd82a8e548c | +15126474492 | AC1072bbbbbbbbbbbbbbbbbbbbbbbbbbbb | t          <- tenant B (the victim)
 0923a3be-0991-4dec-998f-e8c4d2be7adf | +15126474493 | AC10720000000000000000000000000000 | f          <- deployment-account tenant

$ psql -c "SELECT tenant_id, call_sid FROM voice_sessions ORDER BY started_at;"
              tenant_id               |          call_sid
--------------------------------------+----------------------------
 f2973b5b-110b-4654-ad36-f3362d75de38 | CA-1072-a-35e82d76           <- A's own call
 bfae1b78-b002-456c-9856-3fd82a8e548c | CA-1072-b-9f1862f4           <- B's own calls, all three
 bfae1b78-b002-456c-9856-3fd82a8e548c | CA-1072-gather-b-88540ffb
 bfae1b78-b002-456c-9856-3fd82a8e548c | CA-1072-gather-ok-b01e3890
 0923a3be-0991-4dec-998f-e8c4d2be7adf | CA-1072-fallback-4999b71c    <- the unowned-DID fallback leg
(5 rows)

$ psql -c "SELECT call_sid FROM voice_sessions
            WHERE call_sid LIKE '%forged%' OR call_sid LIKE '%-rec-%' OR call_sid LIKE '%-vm-%';"
 call_sid
----------
(0 rows)                                                              <- every forged CallSid: absent

$ psql -c "SELECT tenant_id, event_type, count(*) FROM audit_events GROUP BY 1,2 ORDER BY 1,2;"
              tenant_id               |                 event_type                  | count
--------------------------------------+---------------------------------------------+-------
 0923a3be-0991-4dec-998f-e8c4d2be7adf | agent.calling.greeting.greeted_ok           |     1
 0923a3be-0991-4dec-998f-e8c4d2be7adf | agent.calling.identifying.unknown_caller    |     1
 0923a3be-0991-4dec-998f-e8c4d2be7adf | agent.calling.idle.incoming_call            |     1
 0923a3be-0991-4dec-998f-e8c4d2be7adf | lead.created                                |     1
 bfae1b78-b002-456c-9856-3fd82a8e548c | agent.calling.ask_caller.emergency_detected |     1    <- B's own E1 turn
 bfae1b78-b002-456c-9856-3fd82a8e548c | agent.calling.greeting.greeted_ok           |     3    <- exactly B's three own calls
 bfae1b78-b002-456c-9856-3fd82a8e548c | agent.calling.identifying.unknown_caller    |     3
 bfae1b78-b002-456c-9856-3fd82a8e548c | agent.calling.idle.incoming_call            |     3
 bfae1b78-b002-456c-9856-3fd82a8e548c | lead.created                                |     1
 f2973b5b-110b-4654-ad36-f3362d75de38 | agent.calling.greeting.greeted_ok           |     1
 f2973b5b-110b-4654-ad36-f3362d75de38 | agent.calling.identifying.unknown_caller    |     1
 f2973b5b-110b-4654-ad36-f3362d75de38 | agent.calling.idle.incoming_call            |     1
 f2973b5b-110b-4654-ad36-f3362d75de38 | lead.created                                |     1
(13 rows)

$ psql -c "SELECT tenant_id, count(*) AS leads FROM leads GROUP BY 1;"   -- 1 per tenant, from its OWN call
$ psql -c "SELECT tenant_id, count(*) AS customers FROM customers GROUP BY 1;"
 tenant_id | customers
-----------+-----------
(0 rows)
```

Tenant B's six forged deliveries (`/voice` with an AccountSid and without one, `/gather`,
`/recording`, `/voicemail-status`, and the deployment-token forge) left **no** session, **no** lead,
**no** customer and **no** audit row. Its three rows of `greeted_ok` are its own three
legitimate calls.

---

## 7. Build verification & working tree

```
$ cd packages/api && npx tsc --project tsconfig.build.json --noEmit
(clean)

$ npx eslint src/telephony/twilio-webhook-credential.ts src/telephony/twilio-signature.ts
(no problems)

$ git status --porcelain
(empty)
```

`src/app.ts`, `src/routes/telephony.ts` and the media-stream server still carry their
pre-existing eslint errors (20 / 6 / 2, all `no-misused-promises`) — byte-identical counts
to `origin/main`, verified by running eslint on the stashed tree. This change adds none.

---

## 8. What a Twilio deployment must have configured for the binding to hold

The binding is only as strong as the per-tenant credentials behind it, so this is the
operational requirement in plain terms.

Each tenant that owns a phone number must have its own `tenant_integrations` row for
provider `twilio` carrying three things: the DID in `provider_data->>'phoneE164'`, the
tenant's own Twilio **subaccount SID** in `subaccount_sid`, and that subaccount's auth
token encrypted into `auth_token_primary_enc` — which is exactly what the Twilio
provisioning worker writes when a tenant is onboarded onto its own subaccount, and requires
`TENANT_ENCRYPTION_KEY` to be set on the deployment. When those are present, a webhook for
that tenant's number is verified with that tenant's token and nothing else, and a payload
claiming a different `AccountSid` is refused outright. A tenant whose numbers live on the
deployment's own Twilio account instead (the single-account shape) keeps working: its row
carries the DID and either no subaccount or the deployment's own account SID and no stored
token, and the deployment's `TWILIO_AUTH_TOKEN` verifies it — but note that in that
configuration the binding is only as strong as that one shared token, because every number
on that account is signed with it. **Mixing the two is the case to avoid**: a row that names
a foreign subaccount but stores no token is refused with a 500 and a
`telephony.tenant_credential_missing` log rather than falling back to the master token,
because the master token cannot speak for a subaccount. Two operational corollaries: a
token rotation must land in `auth_token_primary_enc` (only the primary is consulted here —
the secondary-token rotation path that `webhooks/routes.ts` supports is **not** wired into
this surface, called out under "not done" below), and `provider_data->>'phoneE164'` has no
uniqueness constraint, so two tenants provisioned with the same DID make both routing and
credential selection a `LIMIT 1` coin-flip.

Every accepted webhook logs which credential answered — `telephony.signature_verified
{ route, credentialPath, tenantId }` with `credentialPath` one of `tenant_integration`,
`subaccount_lookup`, `deployment_fallback` — so an operator can confirm a deployment is
actually on per-tenant credentials rather than silently riding the fallback.

---

## 9. Not done / judgment calls

1. **Secondary-token rotation is not wired into this surface.** `webhooks/routes.ts:2503`
   verifies against `auth_token_primary` then `auth_token_secondary`; this resolver reads
   only the primary — exactly what the code it replaces did, so no regression, but a
   zero-downtime rotation on the telephony surface would need the secondary added. Left
   out deliberately: it widens the auth change beyond the fix.
2. **The outbound paths are unchanged and unbound.** The call-bridge callbacks and the REST
   redirector keep AccountSid-keyed resolution (§2.4). Binding an outbound leg would key on
   `From`, not `To`, and is a different change.
3. **The `LIMIT 1` DID lookup still has no uniqueness constraint** on
   `provider_data->>'phoneE164'` — surfaced by #1014 lane B, still not fixed here (a
   migration is outside an auth-only fix). It is now load-bearing in one more place, which
   strengthens the case for it.
4. **`/api/telephony/whisper` rides the same binding** (it sits behind the telephony
   router's middleware, so it could not be excluded without weakening it). Its `To` is the
   dispatcher's number, which owns no integration row, so it resolves through the
   AccountSid path exactly as before.

   This is also why the AccountSid path is NOT skipped whenever the payload names a
   dialled number — a tempting tightening, proposed by the Fable gate on PR #1082 as its
   F1. "An unowned DID can only ever mean the deployment token" does not hold: it can also
   mean a leg dialled OUT to a number we do not own, on a call a tenant's credential
   legitimately signs. Whisper is exactly that — a GET, where Twilio sends the standard
   call params as QUERY parameters, so `readDialedNumber` sees a `To` that is present and
   unowned. Under that rule it would resolve to the deployment token while Twilio signed
   with the tenant's subaccount token: 403, and the dispatcher hears nothing.

   The residue F1 actually names (an unowned DID resolving to `TWILIO_DEFAULT_TENANT_ID`
   after a foreign tenant's credential verified) is real but confined to dev/test, because
   `resolveInboundTenantId` refuses that fallback in production and staging. Closing it
   belongs in that dev seam, not in the credential resolver.
5. **The e2e spec was vendored, then reconciled.** Lane B's branch landed on main (#1069)
   while this PR was open; the add/add conflict was resolved in favour of main's copy of
   the spec with the flipped security pair re-applied, and the whole spec re-run on the
   merged tree (6 passed, 32.6s).
6. **No rung is claimed.** This is a security fix with its own proof; #1014's grading is not
   this branch's to move.

---

## 9a. Correction — the binding had a second half, found by review

Everything above §9 describes binding the credential to the **dialled number**. Review on
PR #1082 (xhawk-ai) caught that this is necessary and **not sufficient** on the
session-scoped callbacks, and it was right on both findings. Recording it here because §5
of this report claimed `/gather` was bound, and that claim was only true for the leg the
`(d1)` test covers — an attacker naming the *victim's* DID.

**HIGH — owning a number is not owning a call.** `/gather`, `/dial-result` and
`/callback-message` are named by a `?sid=` the caller supplies, while the signature only
proves the caller owns the number in `To`. `_handleGatherLocked` (`twilio-adapter.ts:2155`)
does `store.get(opts.sessionId)` and never compares the session's tenant to the `tenantId`
the route passed it. So an attacker signing with its **own** DID and **own** token cleared
the credential binding and then drove the victim's live session: its utterance appended to
the victim's transcript, the victim's FSM advanced, and the TwiML the victim's caller hears
chosen by the attacker. `sid` is a random UUID, so the attack needs the session id — but an
unguessable identifier is not authorization, which is this issue's whole premise.

Fixed by making the authority the tenant whose credential **actually verified** the
request: `requireTwilioSignature` records it on the request under a `Symbol` (so nothing a
body parser writes can spoof it — `twilio-signature.ts`, `getVerifiedTwilioTenantId`), and
`sessionBelongsToAnotherTenant` (`routes/telephony.ts`) refuses 403 when the named session
belongs to anyone else. The payload-resolved tenant is the fallback **only** where no
tenant credential answered — single-account deployments, where no tenant holds the token
and there is therefore no tenant-attacker. `/voice/gather-fallback` is included: it hands
back the session's own id in the `<Gather>` action URL, so letting a foreign tenant reach
it would give away the `?sid=` the other routes are keyed on. An unknown session is
deliberately **not** a 403 — the routes keep their "your session has ended" handling, and
refusing there would turn an ordinary expiry into a hard failure and leak which ids exist.

**MEDIUM — a silent downgrade on the subaccount path.**
`if (row?.auth_token_primary_enc && encKey)` gated the whole branch on the key, so a
missing `TENANT_ENCRYPTION_KEY` fell through to the deployment token: a tenant credential
quietly replaced by the master one, inconsistent with the owning-tenant path six lines
above it. Now fails closed with `tenant_encryption_key_missing`.

**HIGH again, third leg — `/recording` and `/voicemail-status`.** Raised by the Fable gate
on the same PR, verified the same way, and the same shape once more.
`recording-webhook.ts` and `voicemail-status-route.ts` resolve the tenant with
`store.findByCallSid(callSid)` and act as whatever tenant that session belongs to. The
file's own comment called that "immune to forged payloads" — true about WHICH tenant, but
the wrong invariant: the `CallSid` that selects the session is the caller's to choose. So a
tenant signing with its OWN DID in `Called` and its OWN token, naming the victim's live
`CallSid`, got its attacker-supplied `RecordingUrl` attached to the victim's call —
downloaded, written under the victim's storage key (`buildRecordingStorageKey`), inserted
into the victim's `voice_recordings` / `files` rows, and on the voicemail leg minted into a
**lead under the victim** from attacker-controlled content. That is a write INTO the
victim, not only a hijack of their call.

Closed with the same primitive. `sessionBelongsToAnotherTenant` now lives in
`twilio-signature.ts` beside the verified-tenant concept it depends on, and all six
session-scoped entry points share it: `/gather`, `/dial-result`, `/callback-message`,
`/voice/gather-fallback`, `/recording`, `/voicemail-status`. The two webhook handlers pass
no fallback tenant — when a session exists they have not resolved one — so under the
deployment token the guard stands down rather than guessing, exactly as elsewhere.

RED before green, as with everything else here. Against the already-credential-bound code:

```
 × (f1) /gather — the attacker's OWN DID and token cannot drive the VICTIM's live session 73ms
 × (f2) /dial-result — the same session-scoped hijack is refused 94ms
   AssertionError: expected 200 to be 403        ← the hijack was accepted
 Tests  2 failed | 11 passed (13)

 × fails closed on the subaccount path too when the key to decrypt its credential is missing
   AssertionError: expected { outcome: 'verify', …(2) } to match object { outcome: 'misconfigured', …(1) }
```

and then, with those closed but the webhook handlers still unguarded:

```
 × (f4) /recording — the attacker's OWN credential cannot attach a recording to the VICTIM's call 216ms
 × (f5) /voicemail-status — the same hijack cannot mint a lead under the VICTIM 129ms
   AssertionError: expected 500 to be 403        ← not refused; the 500 is the handler
                                                    failing later, having already accepted
                                                    the request AS THE VICTIM
 Tests  2 failed | 13 passed (15)
```

After:

```
 ✓ (f1) … 1567ms   ✓ (f2) … 1557ms   ✓ (f3) a tenant driving its OWN session is untouched 73ms
 ✓ (f4) … 1550ms   ✓ (f5) … 1547ms
 Tests  15 passed (15)
```

A note on process, since it cost a cycle: the first cut of the session guard looked the
session up through `deps.adapter.getDeps().store`, which threw in
`gather-fallback-route.test.ts` — that file mounts a hand-rolled adapter fake with no
`getDeps`, and the throw inside an async handler hung the request until supertest timed out
at 30s. Caught by running the full unit sweep before pushing, not by CI. The guard now
takes the session each route already holds, and `sessionStoreFor` reads the router's own
declared `voiceSessionStore` dep first. A guard must never be the thing that throws inside
a webhook handler.

**HIGH, fifth — the alias-precedence split on the status callbacks.** Codex review again,
on the whisper-fix head. The credential binding reads the dialled number as `To` first then
`Called` (`readDialedNumber`); both status-callback handlers resolve their FALLBACK tenant
as `Called` first then `To` (`recording-webhook.ts:281`, `voicemail-status-route.ts:228`).
A payload carrying BOTH, pointing at two different tenants, therefore verified against the
attacker's own DID in `To` and then acted as the tenant owning `Called` — the victim.
#1072's original defect in miniature, two fixes later, on the no-session fallback path that
exists precisely for callbacks landing on a fresh instance or past the reap window (and
`sessionBelongsToAnotherTenant` deliberately permits a missing session, so nothing else
stood in the way).

Closed by checking the acting tenant directly rather than by aligning the two alias orders:
`actingTenantMismatchesCredential(req, tenantId)` refuses when the tenant a handler is about
to act as is not the tenant whose credential verified the request. Both handlers run it
after the fallback resolves — before the storage key and rows on `/recording`, before the
lead leg on `/voicemail-status`. Aligning the orders would have worked today and rotted the
first time someone touched either; `readDialedNumber` now carries a note saying so. RED
`(f6)`/`(f7)` at 500 — accepted, acting as the victim, failing later — green after.


**And one the binding BROKE, found by Codex review — `/api/telephony/whisper`.** Not a
hole: a regression I introduced. Whisper is the OUTBOUND dispatcher leg of an escalation,
so its `To` is the dispatcher's number, not the tenant's inbound DID — and Twilio sends the
standard call params as QUERY parameters on a GET, so the binding saw it. If that
dispatcher number is also another tenant's DID (two businesses under one owner, a sister
branch, an answering service that is itself a tenant), the binding picked THAT tenant,
found the originating subaccount foreign, and refused — killing the whisper on an
escalation, on a route whose own header says an error risks dropping the call. `(g1)` was
RED at 403.

Two things had to change, and the first is the one that matters for anyone touching this
file again: **the telephony router's signature middleware runs for EVERY
`/api/telephony/*` request, matched route or not** (verified with a probe, not assumed), so
exempting whisper at its own mount would have changed nothing — the router refuses first.
The whisper mount therefore moves ABOVE the telephony router, with its middleware scoped to
`/api/telephony/whisper` so a POST to `/voice` does not pay a second, weaker check on the
way past. It keeps the AccountSid-only credential view, which is exactly what it had before
#1072.

The second change fell out of the first: `requireTwilioSignature` read `AccountSid` from
the **body only**, so every GET resolved to the deployment token no matter which subaccount
signed it — meaning whisper could never have verified on a per-tenant-subaccount deployment,
before this PR or after. `readAccountSid` now reads body then query, mirroring
`readDialedNumber`. The value is caller-controlled on either surface and is never trusted
on its own; it is checked against the owning tenant's `subaccount_sid`.

`test/app/route-manifest.test.ts`'s committed snapshot pins mount order, so it moved with
the remount — the diff is exactly the three whisper lines relocating above the telephony
router, and nothing else.

**Whisper's `escalationId` is still an unguessable-id-as-authorization**, the last one on
this surface: the cache is keyed by it and holds no tenant, so any tenant with a valid
signature could fetch another tenant's whisper text if it knew the id. Closing that means
storing the tenant alongside the cached TwiML and comparing it with the verified
credential — a new capability rather than a fix for a break, so it is NOT in this PR. It is
the one item in this family left open.

Full sweep on the fixed head: telephony + routes + invariants + app + webhooks + voice —
**287 files, 3249 passed** (4 expected fail, all lane B's own pins); ten telephony
integration files **95 passed** (1 expected fail); the new integration file **18 passed**;
e2e **6 passed (30.7s)**; `tsc --project tsconfig.build.json --noEmit` clean; eslint on the
changed source files byte-identical to main's baseline.

**Five findings in this family now, all from review, none found by my own tests** — four
holes the binding missed and one working path the binding broke. The
lesson is in the shape rather than any one route: I bound the credential to the dialled
number and treated that as the binding, when the routes take their target from a SECOND
caller-supplied identifier — a `?sid=`, a `CallSid` — and act as whoever owns it. Every
place that pattern appears needed the same check, and "the session map cannot be forged"
read as safety when it only ever answered which tenant, never who may ask.

---

## 10. Post-merge revalidation (main moved under this PR)

`origin/main` advanced from `137dc55` to `a961d93` while this PR was open — it now carries
lane B's `cloud/capture-8-2-b` (#1069), which made `e2e/telephony-e1-signed-webhook.spec.ts`
an add/add conflict. Resolved as §5 describes. Everything re-run on the merged head:

```
$ npx tsc --project tsconfig.build.json --noEmit
(clean)

$ npx vitest run test/invariants test/telephony test/routes/telephony-tenant-lookup.test.ts
 Test Files  46 passed (46)
      Tests  641 passed | 4 expected fail (645)

$ RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
    test/integration/{telephony-tenant-credential-binding,phone-lookups-shared-dispatch,\
    e1-life-safety-handler,stranger-owner-capability,durable-telephony-timers,\
    identify-caller,provision-twilio-vapi,rls-tenant-isolation,dropped-call-worker}.test.ts
 Test Files  9 passed (9)
      Tests  81 passed | 1 expected fail (82)

$ npx playwright test --project=chromium e2e/telephony-e1-signed-webhook.spec.ts
  6 passed (32.6s)
```

The expected-fails are lane B's own remaining pins (the Spanish E1 gap and its siblings),
not this change's. Main also brought `test/invariants/*.structural.test.ts` and the
`e1-life-safety-handler` / `stranger-owner-capability` integration files the original brief
named — all now runnable, all green above.
