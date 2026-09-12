# Lane B (Opus) — #1020 §5 invariants: I3 and I12′ at real Postgres

Branch `cloud/invariants-s5-b`, cut from `origin/main` at `a306aa7`.
Test-only. No product code, no migration, no auth/money/RLS/PIN-scheme change.
Two rows. **No rung is claimed here** — only Fable states a rung.

Lane A (Sonnet, `cloud/invariants-s5-a`) owns I2, I8, I13 and the
neighbour-tenant additions; nothing in this branch touches those files.

---

## Row I3 — money-class approval, in-memory → real Postgres

**Claim offered:** the three-wrong-codes lock, the cancelled-and-restarted
dialogue clause, the capture-class carve-out and every attempt's audit row are
now proven against real Postgres, tenant-graded **T1**. Rung 5 stays parked on
O-4 (static PIN) and O-6 (transport) — untouched here, and not answered.

### Files

| | |
|---|---|
| Added | `packages/api/test/integration/i3-voice-approval-challenge-lock.test.ts` (5 tests, all passing — the fifth pins the durability gap as its current value; see finding 3 below) |
| Changed | none |

### Seams driven (file:line)

| Behaviour | Seam |
|---|---|
| dialogue entry / target resolution / readback | `packages/api/src/ai/tasks/proposal-approval-task.ts:794` `startVoiceApproval` |
| next-utterance turns (confirm, challenge) | `packages/api/src/ai/tasks/proposal-approval-task.ts:1216` `continueVoiceApproval` |
| challenge verify + session fail counter | `packages/api/src/ai/tasks/proposal-approval-task.ts:1412` (`failCount = (input.sessionState?.challengeFailCount ?? 0) + 1`) |
| 3rd failure → lockout + one-tap SMS | `packages/api/src/ai/tasks/proposal-approval-task.ts:1414-1428` |
| post-lockout refusal of money/irreversible | `packages/api/src/ai/tasks/proposal-approval-task.ts:583` |
| capture-class bypasses the challenge | `packages/api/src/ai/tasks/proposal-approval-task.ts:369` `requiresChallenge` |
| audit write for every attempt | `packages/api/src/ai/tasks/proposal-approval-task.ts:342` `audit()` → `PgAuditRepository.create` |
| audit read-back | `packages/api/src/audit/pg-audit.ts:48` `findByEntity` |

Real stores on every leg: `PgProposalRepository`, `PgSettingsRepository`,
`PgAuditRepository`, all over `getSharedTestDb()`. The PIN goes through the
live WS21a hashed path (`settings/voice-approval-pin.ts` `hashVoiceApprovalPin`,
HMAC salted by `tenantId`) written into `tenant_settings.escalation_settings`,
not the deprecated plaintext key the unit tests use. Only the outbound SMS
transport is stubbed — an external send, not a DB leg.

### Command

```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
  --config vitest.integration.config.ts --reporter=verbose \
  test/integration/i3-voice-approval-challenge-lock.test.ts
```

### RED (raw)

Nine assertions were first written with deliberately wrong expectations
(`challenge_lockout`→`challenge_failed`, `challengeFailCount: 3`→`4`,
lockout-row count `1`→`0`, `challengeLockedOut: true`→`false`,
`challenge_lockout`→`readback`, `approved`→`challenge_lockout`,
cross-tenant `toHaveLength(0)`→`(1)`, `challenge_failed`→`approved`):

```
 × I3 … > three wrong codes lock money approval, and every attempt lands its audit row read back through PgAuditRepository.findByEntity 84ms
   → expected 'challenge_lockout' to be 'challenge_failed' // Object.is equality
 × I3 … > the lock survives the dialogue being CANCELLED and restarted — the third wrong code across three dialogues still locks 67ms
   → expected { challengeFailCount: 2 } to match object { challengeFailCount: 1 }
 × I3 … > once locked, a money proposal is refused while a capture-class proposal still approves — both outcomes persisted 31ms
   → expected 'challenge_lockout' to be 'readback' // Object.is equality
 × I3 … > T1 — tenant B's lock state never leaks into tenant A, and neither do its audit rows (and the reverse) 91ms
   → expected 'approved' to be 'challenge_lockout' // Object.is equality
 ✓ I3 … > PRODUCT GAP — the lock does not survive a session rebuilt from the real store … 60ms

 Test Files  1 failed (1)
      Tests  4 failed | 1 expected fail (5)
   Duration  11.72s
```

### GREEN (raw)

```
 ✓ test/integration/i3-voice-approval-challenge-lock.test.ts > I3 — money-class voice approval challenge + three-strike lock at real Postgres > three wrong codes lock money approval, and every attempt lands its audit row read back through PgAuditRepository.findByEntity 83ms
 ✓ … > the lock survives the dialogue being CANCELLED and restarted — the third wrong code across three dialogues still locks 94ms
 ✓ … > once locked, a money proposal is refused while a capture-class proposal still approves — both outcomes persisted 53ms
 ✓ … > T1 — tenant B's lock state never leaks into tenant A, and neither do its audit rows (and the reverse) 144ms
 ✓ … > PRODUCT GAP — the lock does not survive a session rebuilt from the real store: a restarted session re-prompts the challenge although three failures are already in audit_events 60ms

 Test Files  1 passed (1)
      Tests  4 passed | 1 expected fail (5)
   Duration  6.08s
```

### Evidence class

**D** — Docker-gated integration, real pools on both legs (the proposal /
settings write **and** its audit event through `PgAuditRepository`). Not a
mocked pool, not an in-memory repository, not a directory path.

### Tenant grade — T1

Two tenants provisioned, each with its own enrolled PIN, and explicit isolation
assertions in both directions: tenant B locks out while tenant A, in its own
session, still reaches the challenge and approves; neither tenant reads the
other's proposal row or audit rows; and tenant A's PIN does **not** open tenant
B's challenge (the HMAC is salted by `tenantId`).

Not T3: both tenants are configured the same way apart from the PIN value. No
tenant-iterating sweep is involved, so no `sweep-tenant-fanout.test.ts` entry
applies.

G4 grep (`grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" packages/api/test/integration/i3-voice-approval-challenge-lock.test.ts`):

```
144:  let tenantB: { tenantId: string; userId: string };
157:    tenantB = await createTestTenant(pool);
163:      [tenantB, TENANT_B_PIN],
377:      tenantId: tenantB.tenantId,
387:    const moneyB = await seedPending(proposalRepo, tenantB.tenantId, {
427:    expect((await proposalRepo.findById(tenantB.tenantId, moneyB.id))?.status).toBe(
434:    expect(await auditRepo.findByEntity(tenantB.tenantId, 'proposal', moneyA.id)).toHaveLength(0);
436:    expect(await proposalRepo.findById(tenantB.tenantId, moneyA.id)).toBeNull();
440:    const moneyB2 = await seedPending(proposalRepo, tenantB.tenantId, {
446:      tenantId: tenantB.tenantId,
457:    expect((await proposalRepo.findById(tenantB.tenantId, moneyB2.id))?.status).toBe(
```

### Product gap found, NOT fixed

**The lockout is in-process state and nothing else.** `challengeLockedOut` lives
on `VoiceApprovalSessionState`
(`packages/api/src/ai/tasks/proposal-approval-task.ts:142`), which the caller
parks on the voice session
(`packages/api/src/ai/agents/customer-calling/voice-session-store.ts:310`,
`voiceApprovalState`), and that store is a **single-process in-memory `Map`**
(`voice-session-store.ts:5-7`: *"Phase 1 (P8-009): single-process, in-memory map
keyed by sessionId … Future phases will swap this for Redis when the agent runs
on more than one Railway instance"*). Nothing about a lockout is persisted and
nothing re-derives it.

So the clause the PRD row states — *the lock survives a cancelled and restarted
dialogue* — **holds, and is now proven at real Postgres**: the counter is
session-level, not per-dialogue, and three wrong codes spread across three
separate dialogues still lock (test 2). What does **not** hold is durability of
that session: a session rebuilt from the real store — a mid-call reconnect
landing on a second Railway replica, or an API restart — arrives with
`sessionState` empty and re-prompts the challenge with the counter back at
zero, even though the three failures and the lockout are already sitting in
`audit_events` (the dump below shows them).

Recorded as an ordinary test in the same file that **pins the broken behaviour**
(`expect(rebuilt.outcome).toBe('readback')`), so every setup assertion around it
stays live and the test goes red the day the lock is re-derived from the real
store. It was first written as `it.fails`; that masked setup regressions — see
finding 3 below. **Product code deliberately untouched**: this is a product
decision, tracked as **#1051** and sitting next to O-4/O-6 on #1000, which is
Josh's, not this lane's.

---

## Row I12′ — §5.0b tier-2 audit semantics, in-memory → real Postgres

**Claim offered:** §5.0b's stated consequence for the tier-2 handler-domain
audit is now falsifiable at a real database on the handler family the PRD names,
tenant-graded **T1**.

### Files

| | |
|---|---|
| Added | `packages/api/test/integration/i12-prime-tier2-audit-best-effort.test.ts` (3 tests) |
| Changed | none |

### Seams driven (file:line)

| Behaviour | Seam |
|---|---|
| tier-2 domain audit + its swallow | `packages/api/src/proposals/execution/callback-handler.ts:108` (the `auditRepo.create` for `callback.acknowledged`) and its swallow at `:123` `catch (auditErr)` |
| tier-1 execution-outcome write (must survive) | `packages/api/src/proposals/execution/executor.ts` — the `proposal.executed` write inside the executor's transaction |
| audit read-back | `packages/api/src/audit/pg-audit.ts:48` `findByEntity`, plus a direct `audit_events` query |

The outage is scoped to exactly the call the guarantee is about:
`Tier2FailingAuditRepository` **wraps a real `PgAuditRepository`** and throws
only when `event.eventType === 'callback.acknowledged'`; every other write
delegates to the real repository. The executor itself is constructed with the
unwrapped `PgAuditRepository`, so the tier-1 row is a genuine real-Postgres
write on the real code path. That is what makes *"tier 1 survived, tier 2 did
not"* a claim about the product rather than about the double.

Note on what "the mutation" is for this family: `CallbackExecutionHandler` is
dep-free by design (its own doc comment: *"There is nothing to wire: no
repository call, no external send"*) — a `callback` approval mutates no domain
row. The committed unit the test pins is therefore the status transition to
`executed` **and** the idempotency/execution record, both read back from
Postgres after the tier-2 throw.

### Command

```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
  --config vitest.integration.config.ts --reporter=verbose \
  test/integration/i12-prime-tier2-audit-best-effort.test.ts
```

### RED (raw) — three passes, because the first wrong expectation in a test masks the later ones

Pass 1 (`callback.acknowledged` present→absent in the control, `success`
true→false, tenant-A tier-2 absent→present):

```
 × I12′ … > control: with a healthy audit store BOTH tiers land — proposal.executed and callback.acknowledged 43ms
   → expected [ 'proposal.executed', …(1) ] to not include 'callback.acknowledged'
 × I12′ … > tier-2 outage: the domain audit row is LOST but the execution commits and the tier-1 outcome row survives 17ms
   → expected true to be false // Object.is equality
 × I12′ … > T1 — a second tenant executing the same proposal type is unaffected by the first tenant's outage 32ms
   → expected [ 'proposal.executed' ] to include 'callback.acknowledged'

 Test Files  1 failed (1)
      Tests  3 failed (3)
```

Pass 2 (persisted status `executed`→`approved`; cross-tenant
`toHaveLength(0)`→`(2)`):

```
 FAIL … > tier-2 outage: …
AssertionError: expected 'executed' to be 'approved' // Object.is equality
 ❯ …i12-prime-tier2-audit-best-effort.test.ts:180:31

 FAIL … > T1 — …
AssertionError: expected [] to have a length of 2 but got +0
 ❯ …i12-prime-tier2-audit-best-effort.test.ts:252:7

 Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)
```

Pass 3 (the direct `audit_events` row list, `['proposal.executed']` →
`['proposal.executed','callback.acknowledged']`):

```
 FAIL … > tier-2 outage: …
AssertionError: expected [ 'proposal.executed' ] to deeply equal [ 'proposal.executed', …(1) ]

- Expected
+ Received

  [
    "proposal.executed",
-   "callback.acknowledged",
  ]
 ❯ …i12-prime-tier2-audit-best-effort.test.ts:206:47

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
```

### GREEN (raw)

```
 ✓ test/integration/i12-prime-tier2-audit-best-effort.test.ts > I12′ — §5.0b tier-2 handler audit is best-effort, proven at real Postgres > control: with a healthy audit store BOTH tiers land — proposal.executed and callback.acknowledged 48ms
stderr | … > tier-2 outage: …
Failed to emit callback.acknowledged audit event for proposal cc2214a4-…: audit store unavailable (I12′ simulated tier-2 outage)
 ✓ … > tier-2 outage: the domain audit row is LOST but the execution commits and the tier-1 outcome row survives 24ms
 ✓ … > T1 — a second tenant executing the same proposal type is unaffected by the first tenant's outage 34ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  4.25s
```

The `stderr` line is the product's own diagnostic from
`callback-handler.ts:128` — the swallow firing, visible rather than silent.

### Evidence class

**D** — Docker-gated integration. The mutation leg (proposal status +
idempotency record) and the audit leg (`proposal.executed`) are both real
Postgres, and the tier-2 absence is pinned twice: through
`PgAuditRepository.findByEntity` **and** with a direct `SELECT event_type FROM
audit_events`, so a nonexistent column would fail here where a mocked pool
would not.

### Tenant grade — T1

Two tenants through **one** failure-injected executor — a single wired
`CallbackExecutionHandler` instance serving both, which is the production shape
— with the outage scoped to tenant A by tenant id. Tenant B's tier-2 write goes
through the same wrapper and is not knocked out (`attemptedTier2` stays at 1);
tenant B keeps both tiers, tenant A loses only its own tier-2 row, and neither
tenant can read the other's proposal or audit rows.

The first version of this test ran tenant B through a *separate* healthy
executor, which would have passed just as well if the outage were process-wide.
Caught by `xhawk-ai` on PR #1050 and fixed — see "Review findings" below.

Not T3: both tenants are identically configured.

G4 grep (`grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" packages/api/test/integration/i12-prime-tier2-audit-best-effort.test.ts`):

```
116:  let tenantB: { tenantId: string; userId: string };
142:    tenantB = await createTestTenant(pool);
226:      tenantB.tenantId,
227:      tenantB.userId,
230:      tenantId: tenantB.tenantId,
231:      executedBy: tenantB.userId,
237:      await realAuditRepo.findByEntity(tenantB.tenantId, 'proposal', healthyProposal.id)
254:      await realAuditRepo.findByEntity(tenantB.tenantId, 'proposal', outageProposal.id),
256:    expect(await proposalRepo.findById(tenantB.tenantId, outageProposal.id)).toBeNull();
```

### Swallow-site count, measured rather than estimated

The PRD row says *"~40 swallow sites untested"*. Measured on this tree:

- **8** handlers in `src/proposals/execution/` carry the same explicit
  `catch (auditErr)` swallow: `add-catalog-item`, `add-material`, **`callback`**,
  `create-change-order`, `create-service-agreement`, `log-expense`,
  `record-refund`, `send-customer-message`.
- **9** files under `src/proposals/execution/` contain an audit-swallow-shaped
  catch.
- **11** such catches exist across `src/`.

So **7 of the 8** named handlers remain untested at a real DB after this row.
The "~40" figure in the PRD does not reconcile with any grep I could construct
over `src/`; it is probably counting all ~160 files that call `auditRepo.create`
in a `try`, or predates consolidation. Flagged for §5.0b rather than edited here
— editing the PRD is not this lane's job.

---

## Evidence — a kept container, run again, rows dumped

Both files re-run once more against a plain Postgres container held open for the
dumps (not the testcontainer):

```
docker run -d --rm -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=serviceos_test -p 127.0.0.1:0:5432 \
  pgvector/pgvector:pg16 -c max_connections=300
# → container 761176af0ffc, host port 32768

EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32768/serviceos_test \
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  --reporter=verbose test/integration/i3-voice-approval-challenge-lock.test.ts
# → Tests  4 passed | 1 expected fail (5)   [before finding 3; now 5 passed (5)]

EXTERNAL_TEST_DB_URL=… (same) … test/integration/i12-prime-tier2-audit-best-effort.test.ts
# → Tests  3 passed (3)
```

Tenant ids below: `0d275656` = I3 tenant A, `66d1606d` = I3 tenant B,
`9e25e56d` = I12′ tenant A (the outage tenant), `bf4fe844` = I12′ tenant B.

### `audit_events` by tenant / event / entity

```
   left   |                    event_type                    | entity_type | count 
----------+--------------------------------------------------+-------------+-------
 9e25e56d | callback.acknowledged                            | proposal    |     1
 bf4fe844 | callback.acknowledged                            | proposal    |     1
 0d275656 | proposal.approved                                | proposal    |     2
 9e25e56d | proposal.executed                                | proposal    |     3
 bf4fe844 | proposal.executed                                | proposal    |     1
 0d275656 | proposal.voice_approval_challenge_failed         | proposal    |     6
 66d1606d | proposal.voice_approval_challenge_failed         | proposal    |     3
 0d275656 | proposal.voice_approval_challenge_passed         | proposal    |     1
 0d275656 | proposal.voice_approval_challenge_prompted       | proposal    |     6
 66d1606d | proposal.voice_approval_challenge_prompted       | proposal    |     2
 0d275656 | proposal.voice_approval_declined                 | proposal    |     1
 0d275656 | proposal.voice_approval_readback                 | proposal    |     8
 66d1606d | proposal.voice_approval_readback                 | proposal    |     2
 0d275656 | proposal.voice_approved                          | proposal    |     2
 0d275656 | proposal.voice_approve_refused_challenge_lockout | proposal    |     1
 0d275656 | proposal.voice_challenge_lockout                 | proposal    |     3
 66d1606d | proposal.voice_challenge_lockout                 | proposal    |     1
 0d275656 | unsupervised_proposal_routed                     | proposal    |     4
 66d1606d | unsupervised_proposal_routed                     | proposal    |     1
(19 rows)
```

Read the I12′ half straight off it: **3** `proposal.executed` for `9e25e56d`
against only **1** `callback.acknowledged` — three executions, two through the
outage, and the tier-1 row survived every one of them. Tenant `bf4fe844` has
1 and 1.

### Proposal rows (the approval outcomes)

```
  tenant  | proposal_type  |      status      |                   summary                    
----------+----------------+------------------+----------------------------------------------
 0d275656 | record_payment | ready_for_review | Record $200 payment from Acme
 0d275656 | record_payment | ready_for_review | Record $310 payment from Bellweather
 0d275656 | record_payment | ready_for_review | Record $500 payment from Castillo
 0d275656 | add_note       | approved         | Note for Dunbar — gate code is on the work o
 0d275656 | record_payment | approved         | Record $700 payment from Everton
 0d275656 | record_payment | ready_for_review | Record $410 payment from Holloway
 66d1606d | record_payment | ready_for_review | Record $900 payment from Fairlane
 66d1606d | record_payment | ready_for_review | Record $150 payment from Garnet
 9e25e56d | callback       | executed         | Call back the Tuesday caller
 9e25e56d | callback       | executed         | Call back the Tuesday caller
 9e25e56d | callback       | executed         | Call back the Tuesday caller
 bf4fe844 | callback       | executed         | Call back the Tuesday caller
(12 rows)
```

Every money proposal touched by a failed challenge is still
`ready_for_review` — three wrong codes approve nothing. The two `approved`
rows are exactly the two that should be: the capture-class `add_note` approved
inside a locked session, and the `record_payment` that got the right PIN.

### Approval-attempt and lock rows

```
  tenant  | proposal |                    event_type                    | attempt | sms  |         created_at         
----------+----------+--------------------------------------------------+---------+------+----------------------------
 0d275656 | 7e4df8a0 | proposal.voice_approval_challenge_failed         | 1       |      | 2026-09-12 18:21:18.046+00
 0d275656 | 7e4df8a0 | proposal.voice_approval_challenge_failed         | 2       |      | 2026-09-12 18:21:18.055+00
 0d275656 | 7e4df8a0 | proposal.voice_challenge_lockout                 | 3       | true | 2026-09-12 18:21:18.067+00
 0d275656 | 38d8bb80 | proposal.voice_approval_challenge_failed         | 1       |      | 2026-09-12 18:21:18.11+00
 0d275656 | 38d8bb80 | proposal.voice_approval_declined                 |         |      | 2026-09-12 18:21:18.118+00
 0d275656 | 38d8bb80 | proposal.voice_approval_challenge_failed         | 2       |      | 2026-09-12 18:21:18.14+00
 0d275656 | 38d8bb80 | proposal.voice_challenge_lockout                 | 3       | true | 2026-09-12 18:21:18.169+00
 0d275656 | edd05108 | proposal.voice_approve_refused_challenge_lockout |         | true | 2026-09-12 18:21:18.197+00
 0d275656 | d308cc5b | proposal.voice_approval_challenge_passed         |         |      | 2026-09-12 18:21:18.31+00
 0d275656 | 24413388 | proposal.voice_approval_challenge_failed         | 1       |      | 2026-09-12 18:21:18.407+00
 0d275656 | 24413388 | proposal.voice_approval_challenge_failed         | 2       |      | 2026-09-12 18:21:18.414+00
 0d275656 | 24413388 | proposal.voice_challenge_lockout                 | 3       | true | 2026-09-12 18:21:18.423+00
 66d1606d | 1e1d1530 | proposal.voice_approval_challenge_failed         | 1       |      | 2026-09-12 18:21:18.270+00
 66d1606d | 1e1d1530 | proposal.voice_approval_challenge_failed         | 2       |      | 2026-09-12 18:21:18.278+00
 66d1606d | 1e1d1530 | proposal.voice_challenge_lockout                 | 3       | true | 2026-09-12 18:21:18.288+00
 66d1606d | 69027c28 | proposal.voice_approval_challenge_failed         | 1       |      | 2026-09-12 18:21:18.370+00
(16 rows)
```

Row `38d8bb80` is the cancelled-and-restarted dialogue: fail 1, an explicit
decline (the owner said "never mind" — **no attempt burned**, per
`proposal-approval-task.ts:1389-1405`), then fail 2 and the lockout on 3, each
in a fresh dialogue within one session. Row `69027c28` is tenant A's PIN spoken
at tenant B's challenge — one failure, no approval.

### I12′ per-proposal tiers, side by side

```
  tenant  | proposal |  status  |                audit_rows                 
----------+----------+----------+-------------------------------------------
 9e25e56d | 7d427e71 | executed | callback.acknowledged + proposal.executed
 9e25e56d | d3ad6244 | executed | proposal.executed
 9e25e56d | ed9008c5 | executed | proposal.executed
 bf4fe844 | cd0d3293 | executed | callback.acknowledged + proposal.executed
```

That table is §5.0b in four rows: `executed` with the tier-1 outcome row present
and the tier-2 domain row missing is exactly *"operational state can be created
without its domain audit row; the execution-outcome row still lands"*.

---

## Build verification

```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
# → clean (exit 0)

npx tsc --noEmit   # includes tests
# → 0 errors in either new file

git status --porcelain
# → empty
```

---

## Review findings addressed (PR #1050 — `xhawk-ai`, `chatgpt-codex-connector`)

Three findings across two review bots, all correct, all false-negatives in this
lane's own tests. Verified, fixed RED-first, and pushed:

1. **I12′ tenant isolation was not exercised under the same wiring**
   (`i12-prime-tier2-audit-best-effort.test.ts:231`). Tenant B ran through a
   separate healthy executor, so a process-wide outage would still have passed.
   `Tier2FailingAuditRepository` now takes an optional `failForTenantId` and the
   T1 test drives **both** tenants through one failure-injected executor.
   RED (`expect(failing.attemptedTier2).toBe(2)` — asserting tenant B's write
   was knocked out too): `AssertionError: expected 1 to be 2`. GREEN: 3 passed.

2. **The I3 PIN-leak assertion could not catch the leak it guards against**
   (`i3-voice-approval-challenge-lock.test.ts:234-235`). The wrong codes are
   spoken as `"0 0 0 0"` / `"9 9 9 9"` but the assertion searched only for the
   normalized `"0000"` / `"9999"`, so a regression writing the raw utterance
   into audit metadata would have passed. The test now records every code it
   actually speaks and asserts neither the raw utterance nor
   `spokenDigits(utterance)` appears — driven off the same array, so the two
   cannot drift. RED (`toContain` instead of `not.toContain`):
   `expected '[{"channel":"voice","sessionId":"i3-s…' to contain '0 0 0 0'`,
   with the full metadata dump showing no PIN in either form. GREEN: 4 passed
   + 1 expected fail.

3. **The I3 `it.fails` block masked setup regressions**
   (`i3-voice-approval-challenge-lock.test.ts:497`, Codex P2). `it.fails`
   passes when **any** assertion in the body throws, so a real I3 regression in
   the setup — failing to reach the challenge, failing to lock on the third
   attempt, failing to persist the lockout row — would have read as "expected
   failure" and gone green without the durability assertion ever running.

   Verified concretely rather than taken on faith. Breaking the setup's
   `expect(lockout.outcome).toBe('challenge_lockout')` inside the `it.fails`
   body: `Tests  4 passed | 1 expected fail (5)` — still green, so the finding
   is real. The block is now an ordinary `it(...)` that pins the gap as its
   current value (`expect(rebuilt.outcome).toBe('readback')` plus
   `.not.toBe('challenge_lockout')`), so every setup assertion is live and the
   test flips red the day #1051 is closed. Re-breaking the same setup assertion
   after the change: `AssertionError: expected 'challenge_lockout' to be
   'THIS_SETUP_ASSERTION_IS_DELIBERATELY_…'`, `Tests 1 failed | 4 passed (5)` —
   the hole is closed. GREEN with the assertion restored: `Tests 5 passed (5)`.

Neither fix changes what either row claims; all three make the existing claims
actually falsifiable. `tsc --project tsconfig.build.json --noEmit` still clean.
The I3 file now reports `5 passed (5)` rather than `4 passed | 1 expected fail
(5)` — the same five tests, with no expected-failure mechanism left.

---

## Not done / judgment calls

1. **No rung claimed.** Both rows are handed over as evidence. Only Fable states
   a rung, and I3's ceiling is in any case parked on O-4/O-6.
2. **The money handler for I12′ is not covered.** The parent ticket #995 text
   says *"pick the family the PRD names (`callback-handler`) plus one money
   handler"*; this lane's brief says the family the PRD names, and *do not
   widen*. I took the narrower reading rather than putting a new test around
   `record-refund-handler` on my own initiative — refunds are the most
   sensitive swallow site in the list and the brief also forbids touching money
   code. **This is the one piece of #995's I12′ ask left open**, and it is cheap
   to add in a follow-up (the `Tier2FailingAuditRepository` wrapper generalises
   by event type in one line). Orchestrator's call.
3. **T2/T3 not attempted on either row.** Both rows use two identically
   configured tenants; a T3 claim needs two *differently configured* tenants in
   one run, which neither invariant's text calls for. Reported as T1, not
   rounded up.
4. **O-4 and O-6 untouched.** The static per-tenant PIN and the transport
   question are not answered, argued, or worked around here. The test enrols a
   PIN through the existing WS21a hashed path and says nothing about whether a
   static secret is the right design.
5. **The durability gap is reported, not fixed.** See I3 above. Writing the
   lockout to a durable store is a product change (a new column or a Redis
   session store) and this is a test-only lane. The pinning test goes red the
   day someone fixes it (#1051), which is the point.
6. **`voice-approval-gather.test.ts` was read but not extended.** The ticket
   lists it as a proving file for I3; it covers the Twilio Gather transport, and
   its lock-relevant behaviour is the same `startVoiceApproval` /
   `continueVoiceApproval` pair this lane now proves at real Postgres. Adding a
   second integration file at the adapter layer would re-prove the same seam
   through a stubbed LLM gateway, so I did not.
7. **The PRD's "~40 swallow sites" figure is not reproducible** from any grep
   over `src/` (measured: 8 / 9 / 11 — see above). Surfaced, not edited: PRD
   edits are the resolution comment's job, not a lane's.
