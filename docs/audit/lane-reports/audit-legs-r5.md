# Lane report — the missing audit events on rows 2.2, 2.6, 9.4, 9.6, 9.12

Branch `fix/audit-legs-2-2-2-6-9-4-9-6-9-12`, cut from `origin/main` at
`765e5ca08`. Head: `3fe522a09`. Draft PR; Josh merges.

Five PRD rows were held at REAL-DB-WRITE-ONLY for one reason each: **the
product performs the write, and emits no audit event for it.** That is the
same shape as #1040, which PR #1128 closed for scheduling proposals
(`packages/api/src/proposals/create-scheduling.ts` now emits
`proposal.created` through the audit repo the router is already wired with).
This lane closes the other five.

No migration. Nothing here touches pricing, money movement, RLS or auth.
Every emitter goes through the audit repository **already wired** for that
path and mirrors the event shape that path's own sibling emitters use.

---

## What changed, row by row

| Row | Write that was unaudited | Event now emitted | Emitter file |
|---|---|---|---|
| 2.2 | `consent_events` implicit-consent grant | `recording_consent.granted` | `src/telephony/twilio-adapter.ts` (`commitRecordingConsent`) |
| 2.6 | `triage_events` triage outcome | `vulnerability_triage.recorded` | `src/ai/agents/customer-calling/vulnerability-triage-hook.ts` |
| 9.4 | fresh `google_reviews` insert; 429/auth backoff stamp | `review.ingested`, `review.sweep_backoff` | `src/workers/google-reviews.ts` |
| 9.6 | `daily_digests` + `message_dispatches` send | `notification.daily_digest.sent` / `.suppressed` / `.failed` | `src/workers/daily-digest-worker.ts` |
| 9.12 | DNC-blocked reply (no row at all); failed dispatch row | `conversation.reply.suppressed`, `conversation.reply.failed` | `src/conversations/reply-service.ts` |

Wiring added in `src/app.ts` for the three paths whose dependency struct had
no audit repository at all (triage hook, Google-reviews sweep, digest
sweep). 2.2 and 9.12 needed no wiring — those paths already carry an
`auditRepo`; they simply never called it on these branches.

### 2.2 — the grant of recording consent

`commitRecordingConsent` commits the parked consent-ledger thunk at the
transport's point of evidence that the caller actually heard the notice.
It audited nothing — while the caller-initiated *revocation* on the same
adapter has always written `recording_consent.revoked` through the same
repo. Grant and revocation now read the same way in the audit log:
entityType `voice_session`, the session id as entity **and** correlation, a
system actor. Guarded exactly like its sibling (`consentEvents` wired **and**
a caller phone — the two things that make a consent row possible at all), so
the fail-closed disclosure path, which never calls this method, still audits
nothing. Proven below.

### 2.6 — the triage outcome

`triage_events` (migration 166) is the analytics record. The RV-121 patch
action **on this very path** already writes `vulnerability_patch.attempted`
through an `auditRepo` that `app.ts` hands it — the triage decision that
*chose* the patch did not. The hook now takes its own `auditRepo` and emits
after the `triage_events` write, so the two records agree on `actionTaken`,
and only on turns that persist a row (the zero-grade early return keeps both
a signal log, not a per-turn firehose).

### 9.4 — the reviews sweep

Two durable writes were unaudited. `review.ingested` rides the upsert's own
`inserted` flag, so a re-sweep audits nothing exactly as it persists nothing
(asserted). `review.sweep_backoff` covers the 429 and the unrecoverable-401
stamps — that stamp is a state change the owner *feels*, because reviews
silently stop arriving, and it was log-only. **The cursor advance is
deliberately not audited**: it is a watermark derived from the ingest rows,
carrying no information they don't already carry.

### 9.6 — the digest send (#1113)

Per the ticket. `DailyDigestWorkerDeps` had no `auditRepo` at all; the one
inside `computeDeps` is READ-only, feeding the WS22 "N fixed" reflection
*inside* the digest's content. The worker now writes on the `daily_digest`
entity with `{channel, digestDate, tenantLocalTime, dispatchId|reason}`.
`sendDigestSms` returns a discriminated outcome instead of
`'sent' | 'claimed' | false` so the reason survives to the row; the sweep's
counters are unchanged. **A claim-only pass writes nothing** — the sweep that
actually sent already audited it, and a second row would read as a second
send.

**Open decision #1113 left to Josh** — *is the suppressed case audited or
deliberately silent?* It is audited here, the way `thank-you-sms-worker.ts`
audits its own `.suppressed`. It is one guarded call and one test assertion
to flip if the decision goes the other way; the test says so in place.
(#1077 asks the same question for 3.8's confirmation.)

### 9.12 — the conversation reply

The `sent` path already emitted `conversation.reply.sent`; the integration
test never wired a repo, so the row was real but unasserted. It is asserted
now. **The refusals were the genuine product gap**: a DNC block and a
provider failure both end the operator's action, and the DNC block
deliberately writes *no dispatch row*, so nothing at all recorded that the
reply was stopped. "Nothing sent without my hand on it" is only half the
row's promise; the other half is that a suppression the owner did not choose
is visible afterwards.

### On swallowing

Every emitter here is deliberately best-effort, and each says why in place.
This is the **opposite** of the #1040 call, and the difference is the call
site, not a preference: #1040's emitter sits in a synchronous operator
request where `proposals/actions.ts` lets an audit failure surface on every
other transition. These five all run mid-call, mid-sweep, or behind a
fire-and-forget hook whose existing siblings are already best-effort for the
same reason — a vulnerable caller must not be dropped, a live call must not
be cut, a sweep must not skip a tenant, and a digest the owner has already
received must not re-enter the retry path, because a ledger write failed.

---

## RED — the pins failing against unchanged product code

Product code untouched; only the test files carried the new assertions.

```
cd packages/api
export DOCKER_HOST=unix:///Users/joshuakay/.colima/default/docker.sock \
       TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
RLS_RUNTIME_ROLE=true \
EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32787/serviceos_test \
npx vitest run --config vitest.integration.config.ts --reporter=verbose \
  test/integration/conversation-consent-ordering.test.ts \
  test/integration/vulnerability-triage-hook.test.ts \
  test/integration/google-reviews-worker.test.ts \
  test/integration/daily-digest-send-9-6.test.ts \
  test/integration/conversation-reply-send.test.ts
```

```
 × daily-digest-send-9-6 > T3 — two tenants in different timezones … 82ms
   → expected [] to have a length of 1 but got +0
 × daily-digest-send-9-6 > #1113 — a digest send writes notification.daily_digest.sent through PgAuditRepository 37ms
   → expected [] to have a length of 1 but got +0
 × daily-digest-send-9-6 > #1113 — digestChannel 'none' is audited as a suppression, not silence 28ms
   → expected [] to have a length of 1 but got +0
 × google-reviews-worker > happy path: sweep persists new reviews + advances the per-tenant cursor 29ms
   → expected [] to have a length of 1 but got +0
 × google-reviews-worker > idempotent on re-sweep: a second sweep with the same upstream data persists nothing new 13ms
   → expected [] to have a length of 1 but got +0
 × google-reviews-worker > 429 from Google: throttled++ AND poll state stamps backoff_until + consecutive_429_count 11ms
   → expected [] to have a length of 1 but got +0
 × google-reviews-worker > tenant isolation: reviews persisted under tenant A are invisible to tenant B under RLS 29ms
   → expected [] to have a length of 1 but got +0
 × conversation-consent-ordering > writes the consent_events row at the disclosure-PLAYED point … 36ms
   → expected [ { …(10) }, { …(10) }, { …(10) } ] to have a length of 1 but got 3
 × conversation-consent-ordering > T1: a consent row ledgered for tenant B never satisfies tenant A's gate … 33ms
   → expected [ { …(10) }, { …(10) }, { …(10) } ] to have a length of 1 but got 3
 × conversation-reply-send > blocks a reply to a DNC number and writes no dispatch row 24ms
   → expected [] to have a length of 1 but got +0
 × conversation-reply-send > records a failed dispatch AND a conversation.reply.failed audit row when the provider throws 21ms
   → expected [] to have a length of 1 but got +0
 × vulnerability-triage-hook > T3: tenant A (flag ON) writes a real triage_events row + a real audit_events row … 19ms
   → expected [] to have a length of 1 but got +0

 Test Files  5 failed (5)
      Tests  12 failed | 11 passed (23)
   Duration  7.40s
```

The two consent failures report `got 3` rather than `got 0` because that
session's bootstrap already writes other `voice_session` audit rows. The
assertion was tightened to filter on `eventType` — asserting an unfiltered
count there would have been asserting somebody else's rows — and the RED was
re-confirmed by the fact that no `recording_consent.granted` row existed at
all (the filter yields zero against unchanged product; the GREEN run below
is the first time it yields one).

## GREEN — same command, after the product change

```
 ✓ conversation-consent-ordering > writes the consent_events row at the disclosure-PLAYED point — strictly before any caller audio is captured 904ms
 ✓ conversation-consent-ordering > a disclosure that fails closed (non-PCM TTS) never writes a consent_events row 1974ms
 ✓ conversation-consent-ordering > T1: a consent row ledgered for tenant B never satisfies tenant A's gate for the same phone number 222ms
 ✓ daily-digest-send-9-6 > an enabled sms-channel tenant with real activity today gets exactly ONE digest send, read back from message_dispatches 1873ms
 ✓ daily-digest-send-9-6 > digestChannel 'none' is a documented skip — the digest stores but sends nothing 662ms
 ✓ daily-digest-send-9-6 > a tenant with the digest disabled gets no row and no send at all 161ms
 ✓ daily-digest-send-9-6 > T3 — two tenants in different timezones are BOTH due at one instant and each gets its OWN send, with no cross-tenant leakage 1199ms
 ✓ daily-digest-send-9-6 > #1113 — a digest send writes notification.daily_digest.sent through PgAuditRepository 557ms
 ✓ daily-digest-send-9-6 > #1113 — digestChannel 'none' is audited as a suppression, not silence 382ms
 ✓ google-reviews-worker > happy path: sweep persists new reviews + advances the per-tenant cursor 1004ms
 ✓ google-reviews-worker > idempotent on re-sweep: a second sweep with the same upstream data persists nothing new 233ms
 ✓ google-reviews-worker > throttling: a tenant whose backoff_until is in the future is skipped — no Google call, throttled++ 79ms
 ✓ google-reviews-worker > 429 from Google: throttled++ AND poll state stamps backoff_until + consecutive_429_count 247ms
 ✓ google-reviews-worker > silently skips tenants with no integration row (not counted as failed) 75ms
 ✓ google-reviews-worker > tenant isolation: reviews persisted under tenant A are invisible to tenant B under RLS 426ms
 ✓ google-reviews-worker > findRecent: rating + since filters, newest-first order, LIMIT — against real columns 453ms
 ✓ conversation-reply-send > persists a sent dispatch row and an outbound message under the right tenant 613ms
 ✓ conversation-reply-send > blocks a reply to a DNC number and writes no dispatch row 519ms
 ✓ conversation-reply-send > records a failed dispatch AND a conversation.reply.failed audit row when the provider throws 96ms
 ✓ vulnerability-triage-hook > T3: tenant A (flag ON) writes a real triage_events row + a real audit_events row; tenant B (flag OFF) writes neither — same hook, same run 790ms
 ✓ vulnerability-triage-hook > T1: tenant B's session id never surfaces under tenant A's triage log even after tenant B's flag is later turned on 416ms
 ✓ vulnerability-triage-hook > a critical-grade turn drives the REAL patch-owner-through fallback ladder … 1495ms
 ✓ vulnerability-triage-hook > a critical-grade turn with a REACHABLE owner dials the owner directly (rung 1) … 140ms

 Test Files  5 passed (5)
      Tests  23 passed (23)
   Duration  50.45s
```

One stability fix was needed in `conversation-consent-ordering.test.ts`: the
fail-closed case waited a fixed `sleep(50)` for the socket to close and flaked
on a loaded machine (the GREEN run took 50 s against the RED run's 7 s under
lane contention). Replaced with a 2 s bounded poll, the same idiom the file
already uses for `waitForSilenceArmMark`. It still fails loudly if the socket
genuinely never closes.

---

## Row dumps — `audit_events` at real Postgres after the GREEN run

```sql
SELECT event_type, entity_type, actor_role, count(*) AS rows,
       count(DISTINCT tenant_id) AS tenants
FROM audit_events
WHERE event_type IN ('recording_consent.granted','vulnerability_triage.recorded',
  'review.ingested','review.sweep_backoff','notification.daily_digest.sent',
  'notification.daily_digest.suppressed','conversation.reply.sent',
  'conversation.reply.suppressed','conversation.reply.failed')
GROUP BY 1,2,3 ORDER BY 1;
```

```
              event_type              |    entity_type    | actor_role | rows | tenants
--------------------------------------+-------------------+------------+------+---------
 conversation.reply.failed            | conversation      | owner      |    2 |       2
 conversation.reply.sent              | conversation      | owner      |    4 |       4
 conversation.reply.suppressed        | conversation      | owner      |    2 |       2
 notification.daily_digest.sent       | daily_digest      | system     |    6 |       6
 notification.daily_digest.suppressed | daily_digest      | system     |    2 |       2
 recording_consent.granted            | voice_session     | system     |    4 |       4
 review.ingested                      | review            | system     |   10 |       8
 review.sweep_backoff                 | review_poll_state | system     |    2 |       2
 vulnerability_triage.recorded        | voice_session     | system     |    2 |       2
(9 rows)
```

### 2.2

```
tenant_id      | c1b38a31-4e6a-4c61-975d-c371389e1e85
actor_id       | calling-agent
actor_role     | system
event_type     | recording_consent.granted
entity_type    | voice_session
entity_id      | c9c7efe9-0ebd-4920-bc5f-6c926d86d6cc
correlation_id | c9c7efe9-0ebd-4920-bc5f-6c926d86d6cc
metadata       | {"kind": "recording", "phone": "+15125550111", "state": "implicit",
                  "source": "voice", "channel": "telephony", "customerId": null}
created_at     | 2026-09-13 15:58:53.525+00
```

### 2.6

```
tenant_id  | 204767b3-89c7-4ec2-88dc-29d50bfccb98
actor_id   | bc11e2e5-4991-4f54-9082-ba613d047023
actor_role | system
event_type | vulnerability_triage.recorded
entity_id  | bc11e2e5-4991-4f54-9082-ba613d047023
metadata   | {"tier": "critical", "score": 0.9, "decision": "patch_owner",
              "customerId": null, "actionTaken": "patch_owner", "matrixTotal": 1}
```

### 9.4

```
tenant_id   | 52a8366f-5209-4516-a441-0781c7a568df
actor_id    | system:google-reviews-worker
actor_role  | system
event_type  | review.ingested
entity_type | review
entity_id   | 64e39aab-1ded-4748-accc-fde28f66b78b
metadata    | {"rating": 5, "source": "google_business", "hasComment": true,
               "locationId": "accounts/789/locations/012",
               "externalReviewId": "accounts/789/locations/012/reviews/iso_b",
               "reviewerDisplayName": "Iso"}

tenant_id   | 972095d8-43f7-491f-82f3-64c1aa3a38fd
actor_role  | system
event_type  | review.sweep_backoff
entity_id   | 972095d8-43f7-491f-82f3-64c1aa3a38fd
metadata    | {"reason": "quota_429", "retryAfterSeconds": 45}
```

### 9.6 — the two tenants of the T3 sweep, each with its OWN tenant-local time

```
tenant_id   | c95cfd94-7fe2-49e8-b26b-b2e679cf63d8
actor_id    | system:daily-digest-worker
event_type  | notification.daily_digest.sent
entity_type | daily_digest
entity_id   | 17d99b53-b6e6-4bc6-a1d1-bf0139e4f6be
metadata    | {"channel": "sms", "digestDate": "2026-06-11",
               "dispatchId": "ed993b2a-0a7a-4350-b258-aba63b3720ca",
               "tenantLocalTime": "18:05"}          ← America/Chicago

tenant_id   | 1b5f9dcf-16d4-4fbe-8d53-fa6725051bb0
event_type  | notification.daily_digest.sent
entity_id   | 4fdf240b-cd8d-4c6c-8552-3fb69f1fe7bd
metadata    | {"channel": "sms", "digestDate": "2026-06-11",
               "dispatchId": "1a310346-ba46-4979-ae0e-dea02a75e0ee",
               "tenantLocalTime": "16:05"}          ← America/Phoenix

tenant_id   | 2c49837e-637e-4ce5-9f41-488c36d3b16a
event_type  | notification.daily_digest.suppressed
entity_id   | a87b9b41-0a32-48c1-b6c5-6e8f67ae19c3
metadata    | {"reason": "channel_none", "channel": "none",
               "digestDate": "2026-06-11", "tenantLocalTime": "18:05"}
```

### 9.12 — all three outcomes, one tenant, one run

```
event_type     | conversation.reply.sent
actor_role     | owner
entity_id      | 0a0322d9-e7bb-47ae-bd7a-492635991304
correlation_id | c46b8dfc-2897-4e59-a055-a5ed781b7609
metadata       | {"channel": "sms", "messageId": "f568eddc-…",
                  "recipient": "+15555551001", "dispatchId": "c46b8dfc-…"}

event_type     | conversation.reply.suppressed
entity_id      | 66ca79d4-80b3-4e33-baae-3aadb3a1427a
metadata       | {"reason": "dnc_blocked", "channel": "sms",
                  "recipient": "+15555551002"}      ← no dispatch row exists

event_type     | conversation.reply.failed
entity_id      | 5d95cf4b-f47e-419a-9e86-e2da8e78d3ba
correlation_id | 86e997ba-9377-40ce-aa08-6be1a91f1409
metadata       | {"reason": "delivery_failed", "channel": "sms",
                  "recipient": "+15555551003", "dispatchId": "86e997ba-…"}
```

## Tenant isolation (T1) — asserted on every row

Every row's `findByEntity` under the *other* tenant returns `0`, in the same
run, against divergent data:

- **2.2** — tenant B's call ledgers and audits its own grant for the *same*
  phone number; tenant A reads zero rows for B's session (unfiltered: not
  just no grant row, no row of any kind).
- **2.6** — tenant B has the flag OFF and is never graded, never logged,
  never audited; and tenant B's context reads zero for tenant A's session.
- **9.4** — one sweep, two tenants, two different GBP accounts: each ingest
  audits under its own tenant and neither reads the other's row (alongside
  the file's existing RLS-enumeration proof under an unprivileged role).
- **9.6** — Chicago and Phoenix, due at one instant, each with its own
  `tenantLocalTime` and `dispatchId`; neither reads the other's.
- **9.12** — a second tenant reads zero for the first tenant's conversation.

---

## Unit suites for the touched modules

```
cd packages/api && npx vitest run --reporter=dot \
  test/workers/google-reviews.test.ts test/workers/daily-digest-worker.test.ts \
  test/workers/daily-digest-approval-link-gating.test.ts \
  test/ai/agents/customer-calling/vulnerability-triage-hook.test.ts \
  test/conversations/reply-service.test.ts test/telephony/twilio-adapter.test.ts \
  test/telephony/gather-vulnerability-triage.test.ts test/telephony/media-streams
→  Test Files  15 passed (15)
        Tests  366 passed (366)

cd packages/api && npx vitest run --reporter=dot test/conversations test/workers
→  Test Files  63 passed (63)
        Tests  737 passed (737)
```

## Typecheck

```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Zero errors attributable to this branch. The command is **not clean in this
worktree**, and was not before this branch either — proven by re-running it
with only this branch's six product files reverted to `765e5ca08`, which
produces a byte-identical error set:

- a wall of `TS7016 … module 'uuid'` — this worktree has no `node_modules`
  of its own and resolves to `/Users/joshuakay/node_modules`, where
  `@types/uuid` is absent;
- `src/auth/clerk.ts(181,24)` `JsonWebKey`, `src/voice/voice-service.ts(258,35)`
  `Uint8Array<ArrayBufferLike>` — lib-typing drift, untouched files;
- `src/routes/assistant.ts(5-8)` — four symbols imported from
  `@ai-service-os/shared` that the package's barrel (`packages/shared/src/index.ts`)
  does not re-export: `contracts/money.ts` defines `isCentsKey` and
  `centsToInputValue` but is not in the `export *` list. **This is a real
  pre-existing break on `main`**, not an environment artifact — flagged, not
  fixed (outside this lane).

`packages/shared` must be built (`cd packages/shared && npx tsc -p tsconfig.json`)
before the api typecheck resolves the package at all in a fresh worktree.

---

## What is NOT proven

- **No phone-surface or browser leg.** Every emitter is proven at real
  Postgres through the production wiring, driven the way the transport
  drives it, but no Playwright spec and no signed Twilio webhook was run for
  these rows. 2.2's reachability leg is lane C's; 9.6's browser leg is
  already on the row (`digest-toggle.spec.ts`, #1010) and was not re-run.
- **The `app.ts` wiring is compile-proven, not run-proven.** The three new
  `auditRepo` arguments are typed and typecheck, and each test constructs the
  same dependency object app.ts constructs — but no boot of the real app was
  observed writing one of these rows.
- **9.4's `review.sweep_backoff` is proven only on the 429 branch.** The
  auth-failure branch emits the same event with `reason: 'auth_failed'` and
  is covered by the shared helper, but no test drives a dead refresh grant.
- **9.6's `.failed` outcomes are partly unproven at Postgres.** The
  provider-throws path is proven for 9.12 (`conversation.reply.failed`, real
  row dumped above); for the digest, the `send_attempts_exhausted`
  dead-letter and the re-thrown provider error are implemented and typed but
  have no integration assertion — the existing unit suite covers the
  dead-letter counter, not the audit row.
- **9.6's `claimed` case writes nothing by design** and that "nothing" is
  argued, not asserted by a test.
- **T2/T3 are not claimed anywhere new.** Every isolation claim in this lane
  is T1 (a second tenant, divergent data, reads zero). 9.6's existing T3 test
  gained audit assertions; the grade itself is the row's, not this lane's.

## Product gaps found and NOT fixed

1. `packages/shared/src/index.ts` does not re-export `contracts/money.ts`,
   so `packages/api/src/routes/assistant.ts:5-8` imports four symbols that
   do not exist on the package's public surface — a `tsc --project
   tsconfig.build.json` failure on `main`, i.e. the documented Build
   Verification command does not pass on `main` in a clean worktree. Not
   this lane's file; reported for a ticket.
2. `packages/api/src/workers/google-reviews.ts` — the pre-existing
   known-limitation noted in its own docstring stands: a review whose upsert
   succeeds but whose proposal emission throws is never retried
   (`inserted: false` on re-upsert), so it exists with no draft proposal.
   The new `review.ingested` row now at least makes that state visible
   in the audit trail, but the gap itself is untouched.
