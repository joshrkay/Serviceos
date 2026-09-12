# §8.2 Capture — lane B (Opus: auth-adjacent + life-safety)

Ticket: [#1014](https://github.com/joshrkay/Serviceos/issues/1014) · map [#995](https://github.com/joshrkay/Serviceos/issues/995)
Branch: `cloud/capture-8-2-b` (cut from `origin/main` @ `a306aa7`)
Rows in scope: **2.4** (stranger cannot reach owner-only capability) and **2.5** (E1 life safety), plus the #1004 phone-surface reachability leg where it was cheap.
Scope discipline: **test-only.** No auth, RLS, E1 script text (O-2), `emergency-tier.ts` semantics, money, pricing or migration code was changed. `git diff --stat origin/main...` touches three test files and this report, nothing else.

**Not claiming rungs — that is Fable's call.** What follows is the four things each row owes: the command, its raw output (RED before GREEN), the evidence class, and the tenant grade.

---

## Row 2.4 — a stranger on the phone cannot reach owner-only capability

**File:** `packages/api/test/integration/stranger-owner-capability.test.ts` (new, 5 tests)
**Evidence class:** D (real Postgres testcontainer; real `PgUserRepository`, `PgSettingsRepository`, `PgAuditRepository`, `PgProposalRepository`, `PgCustomerRepository`, `PgEntityResolver`, real `createAuthorizationLoader` membership loader). Only the LLM gateway is scripted — the documented pattern for voice/AI handler tests (CLAUDE.md, *Code Hygiene & Testing*).
**Tenant grade:** T1 (two tenants in one run, plus a positive control — see below).

### The seam driven, with file:line

Production chain, end to end, nothing hand-dispatched except `greeted_ok` (which the Gather transport itself owns):

| Step | Where |
|---|---|
| caller-ID → actor, tenant-scoped, at real Postgres | `resolvePhoneActor` — `packages/api/src/telephony/phone-actor.ts:62`, called from `establishInboundSession` — `packages/api/src/telephony/twilio-adapter.ts:1162` |
| owner-line bridge (`tenant_settings.owner_phone`) | `resolveOwnerSession` — `packages/api/src/telephony/twilio-adapter.ts:906` → `isApproverPhone` — `packages/api/src/proposals/approver-identity.ts:65` |
| actor → classifier profile (identity-derived, never transcript) | `classifierProfileForSession` — `packages/api/src/ai/voice-turn/create-voice-turn-processor.ts:560` |
| profile → post-parse surface guard | `isIntentAcceptedOnProfile` — `packages/api/src/ai/orchestration/intent-classifier.ts:651`, applied at `intent-classifier.ts:2884` |
| the interception's audit row | `auditOffSurfaceClassification` — `create-voice-turn-processor.ts:588`, called from the live Gather classify seam `twilio-adapter.ts:2381` |
| owner-grade lookup RBAC (the *other* layer) | `answerPhoneLookup` default-deny — `packages/api/src/ai/voice-turn/phone-lookup-surface.ts:168` |

The call is driven as Twilio drives it: `handleInbound`, then the `ask_caller` find-or-create turn, then the classifying turn — two real webhook round trips.

### Command

```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
  --config vitest.integration.config.ts --reporter=verbose \
  test/integration/stranger-owner-capability.test.ts
```

### RED (raw)

Every assertion was first written with a deliberately wrong expectation. Four rounds, because new assertions were added as the real behaviour became known (each new assertion got its own RED).

RED 1 — 5/5 fail:
```
 × … a stranger: an unmatched caller-ID resolves NO actor …
   → expected undefined to be 'some-actor' // Object.is equality
 × … T1: tenant B's owner phone AND owner mobile are both strangers to tenant A …
   → expected undefined to be 'c2149b64-0039-434f-9b05-5e0f32367807' // Object.is equality
 × … an owner-only intent from a stranger is intercepted as intent_off_surface, AUDITED, and mints no proposal
   → expected +0 to be 1 // Object.is equality
 × … the SAME intent on tenant A's own owner line is NOT intercepted …
   → expected 'owner_line' to be 'caller' // Object.is equality
 × … an owner-grade LOOKUP from a stranger is refused by the RBAC, not intercepted by the profile guard
   → expected [] to have a length of 1 but got +0
      Tests  5 failed (5)
```

RED 2 — after wiring the production-shaped lookup bundle so the lookup leg hits the *real* refusal rather than the "no bundle wired" deployment-gap line; 5/5 still fail, and the real refusal text is now visible:
```
 × … an owner-grade LOOKUP from a stranger is refused by the REAL RBAC …
   → expected '<?xml version="1.0" encoding="UTF-8"?…' not to contain 'owner-level report'
Received: "<?xml …><Say voice="Polly.Joanna">That&apos;s an owner-level report. Ask an owner
 or dispatcher on your team to pull it up.</Say>…"
      Tests  5 failed (5)
```

RED 3 — four corrected, only the newly added audit-metadata assertion wrong:
```
 × … an owner-only WRITE intent from a stranger is intercepted as intent_off_surface, AUDITED, and mints no proposal
   → expected { intent: 'send_invoice', …(2) } to deeply equal { intent: 'nothing-was-blocked', …(2) }
- Expected            + Received
-   "confidence": 0.5   + "confidence": 0.96
-   "intent": "nothing-was-blocked"  + "intent": "send_invoice"
-   "profile": "owner_line"          + "profile": "caller"
      Tests  1 failed | 4 passed (5)
```

RED 4 — only the newly added `actorRole` assertion wrong:
```
 × … an owner-only WRITE intent from a stranger is intercepted …
   → expected 'system' to be 'owner' // Object.is equality
      Tests  1 failed | 4 passed (5)
```

### GREEN (raw)

```
 ✓ … a stranger: an unmatched caller-ID resolves NO actor, and the session classifies on the caller profile 39ms
 ✓ … T1: tenant B's owner phone AND owner mobile are both strangers to tenant A — while both DO resolve on tenant B's own line 86ms
 ✓ … an owner-only WRITE intent from a stranger is intercepted as intent_off_surface, AUDITED, and mints no proposal 115ms
 ✓ … the SAME intent on tenant A's own owner line is NOT intercepted — the guard is identity-derived, not a blanket refusal 60ms
 ✓ … an owner-grade LOOKUP from a stranger is refused by the REAL RBAC — a different layer from the write guard 35ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  7.35s
```

### What is actually proven

- A caller-ID no row in tenant A carries resolves **no actor**, leaves `ownerSession` unset, and puts the session on the `caller` profile — all three read off the live session after the real establishment core ran against real Postgres.
- **T1, two ways:** tenant B's `tenant_settings.owner_phone` **and** tenant B's owner's `users.mobile_number` are both strangers to tenant A. With a **positive control** — the same two numbers on tenant B's *own* line do resolve (`owner_line`, actor = tenant B's owner) — so a query that matched nothing at all could not pass as tenant isolation.
- `send_invoice` (the canonical case named in `proposals/surface.ts:41`) spoken by that stranger is intercepted to `unknown`/`intent_off_surface` **before routing**: no `intent_classified` row for it, **zero proposals** minted for the tenant, and an audit row read back through `PgAuditRepository` carrying `{intent: send_invoice, profile: caller, confidence: 0.96}` with `actor_role: system`.
- The guard is **identity-derived, not a blanket refusal**: the same intent on tenant A's own owner line is *not* intercepted (no off-surface row) and reaches `intent_confirm`. That contrast is what makes the stranger assertion mean something.
- An owner-grade **lookup** from the stranger is refused by the real D-026 dispatch RBAC and produces **no** off-surface row — the two mechanisms are distinct layers, and the stranger is stopped at the earlier one for writes.

### Tenant-grade grep (G4)

```
$ grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" \
    packages/api/test/integration/stranger-owner-capability.test.ts
132:  let tenantB: Seeded;
190:    tenantB = await seedTenant(B_OWNER_PHONE, B_OWNER_MOBILE);
286:    const ownLineOwnerPhone = await call(tenantB.tenantId, B_OWNER_PHONE, OWNER_ONLY_INTENT);
290:    const ownLineMobile = await call(tenantB.tenantId, B_OWNER_MOBILE, OWNER_ONLY_INTENT);
291:    expect(ownLineMobile.session.actorUserId).toBe(tenantB.ownerUserId);
```

### Not duplicated

`packages/api/test/integration/phone-lookups-shared-dispatch.test.ts` already proves, at real Postgres, the lookup-RBAC refusals (`the customer line is refused revenue (no actor)`, `RBAC: the technician asking for revenue is refused`) and `cross-tenant: a mobile registered in tenant B resolves NO actor in tenant A`. **Row 2.4's printed "(prose only)" understates what exists.** This file adds only the legs that file has no repository for: the `intent_off_surface` mapping, its audit row, the no-proposal leg, the owner-line negative control, and the `tenant_settings.owner_phone` half of T1.

---

## Row 2.5 — a gas leak recognised before any AI thinks about it

**File:** `packages/api/test/integration/e1-life-safety-handler.test.ts` (new, 4 tests + 1 `it.fails`)
**Evidence class:** D (real Postgres testcontainer; real `PgProposalRepository`, `PgAuditRepository`, `PgAppointmentRepository`, `PgCustomerRepository`, `PgJobRepository`, `PgUserRepository`, `PgSettingsRepository`). Gateway scripted, and for the recognition test **rejected outright**.
**Tenant grade:** T1.

### The seam driven, with file:line

| Step | Where |
|---|---|
| the deterministic scan, positioned BEFORE the classify call | `runDeterministicSafetyScan` — `packages/api/src/telephony/twilio-adapter.ts:2185` (state branch starts at `:2290`) |
| tier classification | `runEmergencyScan` — `twilio-adapter.ts:1612` → `classifyCallerSafety` — `packages/api/src/ai/agents/customer-calling/emergency-tier.ts:213` |
| the E1 terminal guard | `transitions.ts:546` (tier `E1` branch at `:557`) → `terminated` |
| booking revocation against real Postgres | `handleRevokePendingBookings` — `packages/api/src/ai/voice-turn/create-voice-turn-processor.ts:2555` (`updateStatusIf` at `:2575`) |
| both audit legs | read back through `PgAuditRepository` |

The booking under test is created by the **real** flow: unknown caller identifies themselves → asks for an appointment → confirms the readback → a real `create_appointment` row in `proposals`, status `draft`, its id in `session.proposalIds`. Only then does the caller report the gas leak.

### Command

```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
  --config vitest.integration.config.ts --reporter=verbose \
  test/integration/e1-life-safety-handler.test.ts
```

### RED (raw)

RED 1 — 4/4 real tests fail; note the last line, which is the Spanish gap already announcing itself:
```
 × ENGLISH: a gas leak is recognised with the LLM gateway DOWN …
   → expected 'terminated' to be 'escalating' // Object.is equality
 × ENGLISH: it NEVER books — a booking drafted earlier in the call is revoked …
   → expected 'rejected' to be 'draft' // Object.is equality
 × T1: tenant B's own E1 call revokes only tenant B's booking …
   → expected 'draft' to be 'rejected' // Object.is equality
 × SPANISH — GAP …: "fuga de gas" classifies E2, so the E1 terminal path never runs
   → expected undefined to be 'E1' // Object.is equality
 ✓ SPANISH — DESIRED (currently FAILS, see the GAP above) …
      Tests  4 failed | 1 expected fail (5)
```

RED 2 — three corrected, only the newly added "no classification ever ran" assertion wrong:
```
 × ENGLISH: a gas leak is recognised with the LLM gateway DOWN …
   → expected [] to have a length of 1 but got +0
      Tests  1 failed | 3 passed | 1 expected fail (5)
```
That failure is the proof, inverted: there were **zero** `intent_classified` rows on the call.

### GREEN (raw)

```
 ✓ ENGLISH: a gas leak is recognised with the LLM gateway DOWN — the call terminates on the life-safety path and the audit row carries tier E1 115ms
 ✓ ENGLISH: it NEVER books — a booking drafted earlier in the call is revoked in real Postgres with its own audit row 161ms
 ✓ T1: tenant B's own E1 call revokes only tenant B's booking — tenant A's live booking is untouched 368ms
 ✓ SPANISH — GAP (surfaced on #1014, NOT fixed here): "fuga de gas" classifies E2, so the E1 terminal path never runs 666ms
 ✓ SPANISH — DESIRED (currently FAILS, see the GAP above): "fuga de gas" must reach the E1 terminal path and revoke the booking 72ms
 Test Files  1 passed (1)
      Tests  4 passed | 1 expected fail (5)
   Duration  8.00s
```

### What is actually proven (English)

- **"Before any AI thinks about it", made falsifiable:** the gateway is switched to `mockRejectedValue` before the E1 turn. The turn still terminates on the life-safety script, and the call's audit trail contains **zero** `*.intent_classified` rows. If any part of E1 recognition needed a model, that turn could not have produced this outcome.
- The caller hears the 911 direction and the call **closes**: TwiML contains `911` and `<Hangup/>` and **no** `<Gather>` — no further turn, no dispatcher bridge.
- The audit row read back through `PgAuditRepository` carries `{tier: 'E1', reason: 'life_safety_e1', keyword: 'smell gas'}`.
- **It never books:** the real `create_appointment` proposal moves to `rejected` / `rejection_reason = life_safety_emergency`, with its own `agent.calling.e1_booking_revoked` row (`{proposalType: create_appointment, fromStatus: draft, reason: life_safety_e1}`); no second proposal is minted, and `appointments` holds **zero** rows.
  The test polls for this rather than sleeping, because the revocation runs **detached** by design (`twilio-adapter.ts:1732` — nothing slow may sit between the keyword hit and the TwiML that speaks the script).
- **T1:** tenant B's own E1 call revokes only tenant B's booking. Tenant A's live booking stays `draft`, tenant A has no `emergency_detected` row, and tenant B's revocation row exists only under tenant B.

### Tenant-grade grep (G4)

```
$ grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" \
    packages/api/test/integration/e1-life-safety-handler.test.ts
104:  let tenantB: Seeded;
128:    tenantB = await seedTenant('+15125550802');
322:    const bCall = await inboundCall(tenantB.tenantId);
327:      () => proposalRepo.findById(tenantB.tenantId, bBooking),
339:    const underB = await auditRepo.findByEntity(tenantB.tenantId, 'proposal', bBooking);
352:    const c = await inboundCall(tenantB.tenantId);
393:      const c = await inboundCall(tenantB.tenantId);
```

### Not duplicated

The separate Sonnet lane (**#1020**, invariant I8) owns "E1 with no triage rules loaded" at this handler. This file deliberately owns only the language pair, the booking revocation, the never-books clause and T1.

---

## 🚨 PRODUCT GAP FOUND, NOT FIXED — a Spanish gas leak is not E1

This is the one finding that matters most in this report, and it is life-safety-grade.

**A Spanish gas-leak report does not reach the E1 life-safety path. It classifies E2.**

### Cause

`classifyCallerSafety` (`packages/api/src/ai/agents/customer-calling/emergency-tier.ts:213`) derives E1 **only** from `detectLifeSafetyE1`, whose `E1_HAZARD_PHRASES` table (`emergency-tier.ts:73`) is **English-only**. The Spanish phrases — `fuga de gas`, `escape de gas`, `huele a gas`, `olor a gas` — live only in `emergency-detector.ts`'s `SPANISH_EMERGENCY_KEYWORDS` (`:73`), which `classifyCallerSafety` folds in as the **`backstop` candidate at tier E2, unconditionally** (`emergency-tier.ts:265`) — discarding the `language` field `detectEmergency` already returns (`emergency-detector.ts:212`).

`emergency-detector.ts:28` documents the opposite intent, verbatim:

> *"a Spanish speaker on an 'English' call still says "fuga de gas", and the life-safety path **must fire either way**."*

It does not, at E1 grade.

### Consequence, proven end to end at the real handler

| | English `smell gas` | Spanish `fuga de gas` |
|---|---|---|
| tier | **E1** | *(none — E2 backstop)* |
| FSM | `terminated`, `life_safety_e1` | not terminated, `emergency_dispatch` |
| spoken | evacuation script — *"leave the building immediately without using light switches"* | dispatcher bridge — *"I'm connecting you with our on-call dispatcher"* |
| booking drafted this call | **revoked** (`rejected` / `life_safety_emergency`) | **still LIVE** (`draft`) |
| extra proposal | none | an `emergency_dispatch` draft |

So a Spanish-speaking caller reporting a gas leak is never told to evacuate, the call is not closed, and the appointment they just booked stands.

### Why this lane did not fix it

Fixing it means changing `emergency-tier.ts` **semantics**, which the lane B scope explicitly forbids, and it is a life-safety change that needs a named owner with trade standing — the same reasoning behind decision O-2 on the script text. The likely shape of the fix is small (carry `backstop.language` into the E1 candidate, or add the Spanish hazard phrases to `E1_HAZARD_PHRASES`), but "small" is not the same as "mine to make".

### How it is pinned, so it cannot be lost

1. A passing **characterization** test records exactly what happens today — tier absent, not terminated, dispatcher copy, booking still live.
2. An **`it.fails`** test states the DESIRED behaviour in full (the English assertions, in Spanish). It reports as `1 expected fail`, keeps CI honest, and **starts failing loudly the day someone fixes the product** — which is the signal to delete it, promote its assertions into the English test, and re-grade row 2.5.

**Recommended routing:** a life-safety fix ticket with a named owner, plus an entry on `docs/audit/blocked-on-josh.md` (#1000) if the owner is not immediate. I did not add either — that is the orchestrator's call, and the row note is the honest place for it until then.

---

## Phone-surface reachability leg (#1004 definition, applied)

**File:** `e2e/telephony-e1-signed-webhook.spec.ts` (new, 4 tests) — **RAN, all green.**
**Evidence class:** D + hermetic surface (real `/api/telephony/*` Express routes in a real API process, real Postgres, real `requireTwilioSignature`, signature computed offline by the test).
**Tenant grade:** T1, twice.

#1004's definition is adopted verbatim: a Playwright process with **no live Twilio call and no browser** constructs Twilio-shaped form-encoded webhooks, computes each `X-Twilio-Signature` itself via `twilio.getExpectedTwilioSignature` **keyed on the tenant's own auth token as stored encrypted in `tenant_integrations.auth_token_primary_enc`**, and POSTs them through the real `/api/telephony/voice` and `/api/telephony/gather` routes.

**Why E1 and not the 2.4 stranger case:** E1 recognition is deterministic and pre-LLM, so it needs no AI provider key and nothing is stubbed. The 2.4 stranger case turns on an intent **classification**, which on this surface needs a live model — so 2.4 is proven at the handler seam instead (above), and that limit is recorded rather than papered over.

**Project:** the default `chromium` project, **not** `chromium-devauth` — per the correction on #1014 that project forces InMemory repositories and `TELEPHONY_ENABLED=false`, so a claim there would fail *mocked is not proven*.

### Command (as run)

```
DATABASE_URL=postgres://test:test@localhost:32768/serviceos_test \
DB_SSL=false E2E_DEV_AUTH=0 \
TWILIO_ACCOUNT_SID=AC00000000000000000000000000000001 \
TWILIO_AUTH_TOKEN=deployment-fallback-token \
TWILIO_FROM_NUMBER=+15125550000 \
TWILIO_DEFAULT_TENANT_ID=00000000-0000-4000-8000-000000000001 \
TENANT_ENCRYPTION_KEY=<64 hex chars> \
PUBLIC_API_URL=http://localhost:3000 \
npx playwright test --project=chromium e2e/telephony-e1-signed-webhook.spec.ts --reporter=list
```

The Postgres was provisioned first (`DATABASE_URL=… npx tsx e2e/fixtures/setup-test-db.ts`) — see the first gotcha below. Chromium was already present at `/opt/pw-browsers`; no browser is launched, the spec uses only the `request` fixture.

### RED (raw)

Staged, because `test.describe.configure({ mode: 'serial' })` stops the file at the first failure — so each test got its own RED round with the earlier ones restored.

```
RED 1  ✘ an UNSIGNED inbound webhook is rejected …            Expected: 200   Received: 403
RED 2  ✘ a self-signed Twilio webhook reaches the E1 …         Expected substring: not "911"
       Received: "…<Say>If anyone is in immediate danger, hang up and call 911 now. If you smell
       gas or suspect carbon monoxide, please leave the building immediately without using light
       switches or your phone inside…</Say><Hangup/></Response>"
RED 3  ✘ T1: … lands only in tenant B                          Expected length: 0  Received length: 1
       Received array: [{"event_type": "agent.calling.ask_caller.emergency_detected",
         "metadata": {…, "keyword": "smell gas", "reason": "life_safety_e1", "tier": "E1",
         "toState": "terminated", "tenantId": "8e5c38c4-…"}}]
RED 4  ✘ T1: tenant A's token cannot sign for tenant B's DID    Expected: 200   Received: 403
```

### GREEN (raw)

```
  ✓  1 … an UNSIGNED inbound webhook is rejected — the signature genuinely gates the surface (42ms)
  ✓  2 … a self-signed Twilio webhook reaches the E1 life-safety path through the real /api/telephony routes (133ms)
  ✓  3 … T1: the same caller signed with tenant B's token and dialling tenant B's DID lands only in tenant B (93ms)
  ✓  4 … T1: tenant A's token cannot sign a webhook for tenant B's DID (20ms)
  4 passed (28.4s)
```

### Two gotchas worth keeping (each silently degrades into a false negative)

1. **Playwright evaluates `playwright.config.ts` — and with it `apiWebServerEnv` — BEFORE `globalSetup` runs.** So the `DATABASE_URL` that `e2e/global-setup.ts` sets from its `E2E_USE_TEST_DB` testcontainer never reaches the API webServer's env: the API boots on **InMemory repositories**, the tenant's Twilio credential is not found, and every signed webhook 403s against the env fallback token. The DB must be provisioned first and passed in as `DATABASE_URL`. This is a real trap for any future rung-5 phone spec and is documented in the spec header. (`DB_SSL=false` is also needed for a plain local container — `db/pool.ts:13` requests SSL otherwise.)
2. **`To`/`From` ride every Twilio webhook for a call, the `<Gather>` action callback included** — and `/gather` resolves the tenant from `To` through the **legacy resolver only** (`routes/telephony.ts:622` → `app.ts:3791`), never through `phoneNumberRepo`. A hand-rolled replay that omits them falls back to `TWILIO_DEFAULT_TENANT_ID`, the E1 path still runs correctly but every audit write lands under the wrong tenant and fails its FK. Observed, then fixed by sending the parameters Twilio actually sends.

Also noted while getting there, as ordinary tenant provisioning rather than a test seam: the real `createVoiceGate` (`voice/voice-gate.ts:30`) runs for this call and answers with voicemail TwiML unless `tenants.subscription_status` is `trialing`/`active` **and** `tenant_settings.voice_agent_live_at` is set. The spec provisions both, so the gate genuinely runs.

And: the DID → tenant lookup (`PgPhoneNumberRepository.findByNumber`) is a `LIMIT 1` with **no ORDER BY**, so two tenants holding the same DID make inbound routing non-deterministic. Harmless here (the spec uses a per-run DID and clears prior rows), but it is a real sharp edge in a table with no uniqueness constraint on `provider_data->>'phoneE164'`. **Surfaced, not fixed** — it is routing/auth-adjacent.

---

## Evidence pass — artifact before sign-off

A plain Postgres container was started and kept, both integration files re-run against it, and the rows dumped with tenant ids visible.

```
$ docker run -d --rm -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
    -e POSTGRES_DB=serviceos_test -p 127.0.0.1:0:5432 \
    pgvector/pgvector:pg16 -c max_connections=300
638d1ac66f6063e5aa42c1d11e71d4b3b8ca78bddc1e52ba95284098f3390ee9   (port 32768)

$ DATABASE_URL=postgres://test:test@localhost:32768/serviceos_test npx tsx e2e/fixtures/setup-test-db.ts
[setup-test-db] migrations complete

$ cd packages/api && EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32768/serviceos_test \
    RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
    --reporter=verbose test/integration/stranger-owner-capability.test.ts
 ✓ … a stranger: an unmatched caller-ID resolves NO actor … 40ms
 ✓ … T1: tenant B's owner phone AND owner mobile are both strangers to tenant A … 84ms
 ✓ … an owner-only WRITE intent from a stranger is intercepted as intent_off_surface, AUDITED, and mints no proposal 116ms
 ✓ … the SAME intent on tenant A's own owner line is NOT intercepted … 47ms
 ✓ … an owner-grade LOOKUP from a stranger is refused by the REAL RBAC … 32ms
 Test Files  1 passed (1)
      Tests  5 passed (5)

$ … test/integration/e1-life-safety-handler.test.ts
 ✓ ENGLISH: a gas leak is recognised with the LLM gateway DOWN … 118ms
 ✓ ENGLISH: it NEVER books — a booking drafted earlier in the call is revoked … 173ms
 ✓ T1: tenant B's own E1 call revokes only tenant B's booking … 363ms
 ✓ SPANISH — GAP (surfaced on #1014, NOT fixed here) … 683ms
 ✓ SPANISH — DESIRED (currently FAILS, see the GAP above) … 66ms
 Test Files  1 passed (1)
      Tests  4 passed | 1 expected fail (5)
```

### `audit_events` grouped (tail — full dump is 90 rows)

```
$ docker exec 638d1ac66f60 psql -U test -d serviceos_test -P pager=off \
  -c "SELECT left(tenant_id::text,8), event_type, entity_type, count(*)
      FROM audit_events GROUP BY 1,2,3 ORDER BY 2,1;"

   left   |                   event_type                    |  entity_type  | count
----------+-------------------------------------------------+---------------+-------
 22d0a8d0 | agent.calling.ask_caller.emergency_detected     | voice_session |     1
 8e5c38c4 | agent.calling.ask_caller.emergency_detected     | voice_session |     1
 …        (9 rows — the phone-surface runs)
 8c15b378 | agent.calling.closing.emergency_detected        | voice_session |     1
 aa9f3349 | agent.calling.closing.emergency_detected        | voice_session |     3
 8c15b378 | agent.calling.e1_booking_revoked                | proposal      |     1
 aa9f3349 | agent.calling.e1_booking_revoked                | proposal      |     1
 8c15b378 | agent.calling.intent_capture.emergency_detected | voice_session |     1
 0a42f39b | agent.calling.intent_capture.intent_classified  | voice_session |     1
 0a42f39b | agent.calling.intent_capture.reprompt           | voice_session |     1
 8c15b378 | agent.calling.intent_confirm.confirmed          | voice_session |     2
 aa9f3349 | agent.calling.intent_confirm.confirmed          | voice_session |     3
 8c15b378 | agent.calling.proposal_draft.proposal_queued    | voice_session |     2
 aa9f3349 | agent.calling.proposal_draft.proposal_queued    | voice_session |     3
 017ecf01 | voice_blocked_no_billing                        | voice_session |     4
 0a42f39b | voice.intent_off_surface                        | voice_session |     1
(90 rows)
```

`017ecf01 / voice_blocked_no_billing` is from the surface-spec debugging described above (a not-yet-provisioned tenant hitting the real voice gate), kept in the dump rather than swept — it is what the gate looks like when it fires.

### Row 2.4 — the off-surface interception row

```
$ docker exec … -c "SELECT left(tenant_id::text,8) AS tenant, actor_id, actor_role, event_type,
                           entity_type, metadata
                    FROM audit_events WHERE event_type = 'voice.intent_off_surface'
                    ORDER BY created_at;"

  tenant  |   actor_id    | actor_role |        event_type        |  entity_type  |                              metadata
----------+---------------+------------+--------------------------+---------------+---------------------------------------------------------------------
 0a42f39b | calling-agent | system     | voice.intent_off_surface | voice_session | {"intent": "send_invoice", "profile": "caller", "confidence": 0.96}
(1 row)
```

### Row 2.4 — the actor-resolution inputs, and zero proposals for the stranger's tenant

```
$ docker exec … -c "SELECT left(u.tenant_id::text,8) AS tenant, u.role, u.mobile_number, s.owner_phone
                    FROM users u JOIN tenant_settings s ON s.tenant_id = u.tenant_id
                    WHERE s.business_name = 'Stranger Test Shop' ORDER BY 1;"

  tenant  | role  | mobile_number | owner_phone
----------+-------+---------------+--------------
 0a42f39b | owner |               | +15125550401     <- tenant A: owner_phone only (bridge path)
 8067f3e9 | owner | +15125550403  | +15125550402     <- tenant B: both, and both strangers to A

$ docker exec … -c "SELECT left(tenant_id::text,8) AS tenant, count(*) AS proposals
                    FROM proposals GROUP BY 1 ORDER BY 1;"

  tenant  | proposals
----------+-----------
 8c15b378 |         2
 aa9f3349 |         5
(2 rows)
```

Neither 2.4 tenant (`0a42f39b`, `8067f3e9`) appears at all: **the stranger minted nothing, and neither did the owner-line control.**

### Row 2.5 — every `emergency_detected` row, tier and reason visible

**The gap is legible in this dump.** Tenant `aa9f3349` carries an English row at `tier=E1 / life_safety_e1 / terminated` and two Spanish rows at **`tier` NULL, `reason` NULL, `toState=escalating`**.

```
$ docker exec … -c "SELECT left(tenant_id::text,8) AS tenant, event_type, metadata->>'tier' AS tier,
                           metadata->>'reason' AS reason, metadata->>'keyword' AS keyword,
                           metadata->>'toState' AS to_state
                    FROM audit_events WHERE event_type LIKE '%.emergency_detected'
                    ORDER BY tenant, created_at;"

  tenant  |                   event_type                    | tier |     reason     |   keyword   |  to_state
----------+-------------------------------------------------+------+----------------+-------------+------------
 22d0a8d0 | agent.calling.ask_caller.emergency_detected     | E1   | life_safety_e1 | smell gas   | terminated
 32b9e634 | agent.calling.ask_caller.emergency_detected     | E1   | life_safety_e1 | smell gas   | terminated
 8c15b378 | agent.calling.intent_capture.emergency_detected | E1   | life_safety_e1 | smell gas   | terminated
 8c15b378 | agent.calling.closing.emergency_detected        | E1   | life_safety_e1 | smell gas   | terminated
 8e5c38c4 | agent.calling.ask_caller.emergency_detected     | E1   | life_safety_e1 | smell gas   | terminated
 906c40e9 | agent.calling.ask_caller.emergency_detected     | E1   | life_safety_e1 | smell gas   | terminated
 9116f3b1 | agent.calling.ask_caller.emergency_detected     | E1   | life_safety_e1 | smell gas   | terminated
 9fdc63b2 | agent.calling.ask_caller.emergency_detected     | E1   | life_safety_e1 | smell gas   | terminated
 a41edb0f | agent.calling.ask_caller.emergency_detected     | E1   | life_safety_e1 | smell gas   | terminated
 aa9f3349 | agent.calling.closing.emergency_detected        | E1   | life_safety_e1 | smell gas   | terminated
 aa9f3349 | agent.calling.closing.emergency_detected        |      |                | fuga de gas | escalating
 aa9f3349 | agent.calling.closing.emergency_detected        |      |                | fuga de gas | escalating
 d599ccff | agent.calling.ask_caller.emergency_detected     | E1   | life_safety_e1 | smell gas   | terminated
 e7c73270 | agent.calling.ask_caller.emergency_detected     | E1   | life_safety_e1 | smell gas   | terminated
(14 rows)
```

### Row 2.5 — the booking revocations, and the Spanish booking still live

```
$ docker exec … -c "SELECT left(tenant_id::text,8) AS tenant, actor_role, event_type, entity_type,
                           left(entity_id,8) AS proposal, metadata
                    FROM audit_events WHERE event_type = 'agent.calling.e1_booking_revoked'
                    ORDER BY created_at;"

  tenant  | actor_role |            event_type            | entity_type | proposal |                                            metadata
----------+------------+----------------------------------+-------------+----------+-------------------------------------------------------------------------------------------------
 8c15b378 | system     | agent.calling.e1_booking_revoked | proposal    | eda229c7 | {"reason": "life_safety_e1", "fromStatus": "draft", "proposalId": "eda229c7-…", "proposalType": "create_appointment"}
 aa9f3349 | system     | agent.calling.e1_booking_revoked | proposal    | 8983790c | {"reason": "life_safety_e1", "fromStatus": "draft", "proposalId": "8983790c-…", "proposalType": "create_appointment"}
(2 rows)

$ docker exec … -c "SELECT left(tenant_id::text,8) AS tenant, proposal_type, status, rejection_reason
                    FROM proposals WHERE proposal_type IN ('create_appointment','emergency_dispatch')
                    ORDER BY tenant, proposal_type, status;"

  tenant  |   proposal_type    |  status  |   rejection_reason
----------+--------------------+----------+-----------------------
 8c15b378 | create_appointment | draft    |                        <- T1 control: tenant A's booking, untouched
 8c15b378 | create_appointment | rejected | life_safety_emergency  <- English E1 revoked it
 aa9f3349 | create_appointment | draft    |                        <- SPANISH E1 call: STILL LIVE  🚨
 aa9f3349 | create_appointment | draft    |                        <- SPANISH E1 call: STILL LIVE  🚨
 aa9f3349 | create_appointment | rejected | life_safety_emergency  <- English E1 revoked it
 aa9f3349 | emergency_dispatch | draft    |                        <- the E2 path the Spanish call took instead
 aa9f3349 | emergency_dispatch | draft    |
(7 rows)

$ docker exec … -c "SELECT count(*) AS appointments FROM appointments;"
 appointments
--------------
            0                                                       <- no booking left behind by any E1 call
```

---

## Build verification & working tree

```
$ cd packages/api && npx tsc --project tsconfig.build.json --noEmit
TSC CLEAN

$ npx eslint e2e/telephony-e1-signed-webhook.spec.ts
(no output)

$ git status --porcelain
(empty)
```

---

## Not done / judgment calls

1. **The Spanish E1 gap is surfaced, not fixed.** Reasoned above. It is the single most important line in this report, and it needs a named owner.
2. **Row 2.4 is NOT proven on the phone surface, and I did not pretend otherwise.** The stranger case turns on an intent classification, which on `/api/telephony/*` requires a live model — outside #1004's hermetic definition (which is why #1004 lists a "cannot be proven without a live line" set at all). 2.4 is proven at the handler seam with real repositories; the surface leg covers 2.5 only.
3. **Row 2.4's printed evidence column ("prose only") is wrong.** `phone-lookups-shared-dispatch.test.ts` already proved the lookup-RBAC and cross-tenant-actor legs at real Postgres before this lane. I deliberately did not re-prove them. Whatever 2.4 is graded, the input should be corrected.
4. **The `it.fails` Spanish test reports as "expected fail", which reads like a pass in a summary line.** Chosen over a red CI (which this lane may not cause) and over silence (which loses the finding). Its name starts with `SPANISH — DESIRED (currently FAILS…)` so a scan of the output cannot mistake it. If the reviewer prefers a different convention, it is one line to change.
5. **The phone-surface spec is not wired into any CI job.** It needs a pre-provisioned `DATABASE_URL` plus five env vars, so it cannot ride the default `npm run e2e`. Wiring it (as its own opt-in project, the way `qa-matrix` is) is a follow-up I did not take on unasked.
6. **The `LIMIT 1` DID lookup with no uniqueness constraint** on `tenant_integrations.provider_data->>'phoneE164'` — surfaced above, not fixed (routing/auth-adjacent, outside a test-only lane).
7. **Did not touch** the E1 script text (O-2), `emergency-tier.ts`, any auth/RLS/gate code, money, pricing, or migrations. No rung is claimed anywhere in this report.
8. **No `sweep-tenant-fanout.test.ts` entry** is needed for either row — neither is a tenant-iterating sweep.
