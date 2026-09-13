# §8.4 row 4.3 — concurrent-drag presence at real Redis + real browsers (#1017)

Lane: TEST-ONLY (Sonnet). Branch `test/8-4-presence-redis` off `origin/main`
(d8122045533f3f71a3fc94bc3c81663159e44e11). Scope: `packages/api/test/`,
`e2e/`, `docs/audit/lane-reports/` only. No product code touched (`git diff
--stat` against main below confirms only the two new test files + this
report). Nothing here states a rung — that is Fable's call.

## Starting point (from `docs/audit/lane-reports/1017-dispatch.md`, row 4.3)

A prior pass on this same issue reported honestly that this row's ceiling
was architectural: presence is `InMemoryDispatchPresenceStore` /
`RedisDispatchPresenceStore` only (`packages/api/src/dispatch/presence-store.ts:66,137-149`,
`redis-presence-store.ts:53`), `grep -c presence packages/api/src/db/schema.ts`
→ 0, and the existing `redis-presence-store.test.ts` runs only against a
scripted ioredis fake — "3 is this row's ceiling unless Redis joins the
Docker lane." That schema fact is UNCHANGED by this lane (still 0 — this is
test-only work, no migration added) — the ceiling was about EVIDENCE CLASS,
not the data model, and that is what this lane closes.

## What's REAL vs simulated (§12.4d honesty), spelled out once

- **Redis: REAL**, both halves. The integration test starts a genuine
  `redis:7-alpine` **testcontainer** (`GenericContainer` from `testcontainers`,
  honoring `DOCKER_HOST`/`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE`) and drives
  `RedisDispatchPresenceStore` through **two independent `ioredis` TCP
  connections** (simulating two API replicas, same shape as
  `redis-tenant-quota-two-instance.test.ts` / `board-fanout-two-instance.test.ts`).
  The e2e spec starts its OWN separate `redis:7-alpine` container and points
  the real API webServer at it via `REDIS_URL`
  (`initDispatchPresenceStore(process.env.REDIS_URL)`, `app.ts:4950`) — a
  single api process, so it does not exercise cross-replica sharing (the
  vitest file does that), but it proves the browser is answered by the real
  `RedisDispatchPresenceStore` codepath, not the in-memory fallback.
- **Postgres: REAL** for the revision-token half — the shared integration
  testcontainer (`test/integration/global-setup.ts`, same one every other
  file in that directory uses) for the vitest file, and the e2e run's own
  `pgvector/pgvector:pg16` container (via `e2e/fixtures/setup-test-db.ts`)
  for the browser leg.
- **Browser: REAL**, Chromium via Playwright, TWO independent
  `BrowserContext`s (two real, isolated browser sessions) for tenant A's two
  owners, plus a THIRD context for tenant B's bystander owner.
- **Not real / explicitly bounded**: the vitest file's proposal-EXECUTION
  bookkeeping (`InMemoryProposalRepository` + `InMemoryProposalExecutionRepository`
  for the `ProposalExecutor`'s own idempotency ledger) is in-memory — same
  precedent as `test/integration/auto-pick-appointment-920.test.ts`'s
  `executeApproved` helper. The appointment row itself and the version check
  are 100% real Postgres (see below). The e2e run's WS gateway transport
  (`CLIENT_WS_GATEWAY_ENABLED`) was left at its default (unset/off), so the
  browser leg exercises the **HTTP-fallback + SSE-refetch** presence
  transport, not the WS gateway transport — documented explicitly in the
  spec's file header and again below; this is the transport that is actually
  live by default in this repo today.

## Part 1 — real Redis + real Postgres integration test

**File (new):** `packages/api/test/integration/dispatch-presence-redis.test.ts`

**Command:**
```
cd packages/api && export DOCKER_HOST=unix:///Users/joshuakay/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose test/integration/dispatch-presence-redis.test.ts
```

**Raw output (GREEN — clean, deterministic re-run):**
```
 RUN  v4.1.10 /Users/joshuakay/Serviceos/.claude/worktrees/agent-a55ae4bc1177e2cbb/packages/api

 ✓ test/integration/dispatch-presence-redis.test.ts > Real Redis + real Postgres — dispatch presence & revision-token ordering (row 4.3) > two users of tenant A take/hold/release the SAME card — the second holder sees the first over REAL Redis 5ms
 ✓ test/integration/dispatch-presence-redis.test.ts > Real Redis + real Postgres — dispatch presence & revision-token ordering (row 4.3) > TTL/lease expiry releases the hold without an explicit clear, at real Redis (not simulated fake timers) 604ms
 ✓ test/integration/dispatch-presence-redis.test.ts > Real Redis + real Postgres — dispatch presence & revision-token ordering (row 4.3) > T2 — tenant B's presence NEVER appears under tenant A's key, even for the identical card id with a different holder 7ms
 ✓ test/integration/dispatch-presence-redis.test.ts > Real Redis + real Postgres — dispatch presence & revision-token ordering (row 4.3) > revision tokens order two writes: user 2's stale appointmentVersion is rejected 409 at real Postgres, after user 1's write really landed 97ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Duration  5.34s (transform 1.39s, setup 0ms, import 2.09s, tests 1.12s, environment 0ms)
```

There is no RED-then-GREEN cycle to show for this file — it is a NEW
capability test (proving something the product already does correctly),
not a fix to broken product code, so the "RED" would just be "the file does
not exist yet." Per §12.4d, RED-then-GREEN applies to product-code fixes;
this lane touches no product code.

**What each test proves:**

1. **Take/hold/release, real Redis, two connections.** Two independent
   `ioredis` clients (`clientForUser1`, `clientForUser2`) wrap two
   `RedisDispatchPresenceStore` instances against the SAME `redis:7-alpine`
   container. User 1 `upsert()`s `mode: 'dragging'` through connection 1; a
   raw `HGETALL` over connection 2 shows the real hash key
   `dispatch:presence:<tenantA>:<date>` with exactly the one field, and
   `storeForUser2.list()` / `findEditingOnAppointment()` (the SAME function
   `board-query.ts` calls) return the hold. User 1 clears through connection
   1; connection 2 immediately sees the hash empty — genuine cross-connection
   visibility, not per-process cache.
2. **TTL/lease expiry**, real wall-clock (`setTimeout`, no `vi.useFakeTimers`)
   against a real Redis key `expiresAt` payload — the hold disappears from
   `list()` without an explicit clear, and the expired field is purged from
   the real hash (confirmed via a follow-up raw `HGETALL`).
3. **T2** — the SAME card id (`shared-card-id-across-tenants`) held by
   different users under tenant A and tenant B never cross-contaminates:
   separate Redis hash keys (`dispatch:presence:<tenantA>:...` vs
   `dispatch:presence:<tenantB>:...`), asserted both through the store API
   and via raw `HGETALL` on each key.
4. **Revision tokens order two writes, real Postgres.** User 1 creates a
   `reschedule_appointment` proposal against `appointmentBefore.updatedAt`
   (v0) via the REAL `POST /api/proposals` route
   (`routes/proposals.ts` → `create-scheduling.ts`), then that proposal is
   REALLY approved (`approveProposal`) and REALLY executed
   (`RescheduleAppointmentExecutionHandler` → `updateAppointment`, which
   stamps `updatedAt: new Date()` — `appointments/appointment.ts:314` — via
   a real `UPDATE` through `PgAppointmentRepository`). The appointment's
   `updated_at` genuinely advances (v0 → v1, read back from Postgres). User
   2, still holding the STALE v0 (their browser hasn't refreshed), submits a
   second proposal with `If-Match: v0`: rejected **409 `STALE_APPOINTMENT`**
   with `currentVersion: v1, providedVersion: v0` — the exact real-Postgres
   check at `packages/api/src/proposals/create-scheduling.ts:53-56`. The
   appointment itself is untouched by the rejected write (still at v1, still
   at user 1's schedule). User 2 then re-bases on v1 and succeeds — proving
   the ordering is real sequencing, not data loss.

**Tenant grade:** T2 (divergent tenant B, different holder, same card id,
asserted both via the store API and raw Redis reads — `grep -c tenantB
packages/api/test/integration/dispatch-presence-redis.test.ts` → 9 matches).

## Part 2 — real browsers

**File (new):** `e2e/journeys/dispatch-presence.spec.ts`

**Setup (per the lane's Redis container instructions):**
```
export DOCKER_HOST=unix:///Users/joshuakay/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
docker run -d --rm -p 127.0.0.1:0:6379 redis:7-alpine   # -> container id, then `docker port <id> 6379/tcp` for the host port
TESTCONTAINERS_RYUK_DISABLED=true npx tsx e2e/fixtures/setup-test-db.ts   # -> DATABASE_URL for the ephemeral Postgres
```

**Command actually run:**
```
CLERK_DEV_HMAC_TOKENS=true DB_SSL=false \
DATABASE_URL=postgres://test:test@localhost:<pg-port>/serviceos_e2e_test \
E2E_USE_TEST_DB=true \
VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== \
STRIPE_SECRET_KEY=sk_test_e2e_stub_placeholder \
STRIPE_WEBHOOK_SECRET=whsec_e2e_stub_secret_1234567890 \
REDIS_URL=redis://127.0.0.1:<redis-port> \
npx playwright test e2e/journeys/dispatch-presence.spec.ts --project=chromium --retries=0 --workers=1
```

**Raw output (GREEN):**
```
✓  1 [chromium] › e2e/journeys/dispatch-presence.spec.ts:358:7 › dispatch presence (4.3) — real Redis-backed API, two real browsers › user 2 sees user 1 holding the card while dragging; releasing clears it; T2 — tenant B never sees it (10.0s)
1 passed (52.8s)
```

Server log confirms `GET /api/ws` returns 401 throughout (the client-gateway
WebSocket, gated by `CLIENT_WS_GATEWAY_ENABLED`, is off by default in this
environment) and every `PUT /api/dispatch/presence` / `GET
/api/dispatch/board` call is 204/200 — i.e. the run genuinely exercised the
HTTP-fallback + SSE-refetch presence path, not a WS-gateway path that isn't
live by default.

**RED note, environment (not product): before this could run at all**, the
webServer failed to boot — `packages/api`'s `npm run dev` (`ts-node/register`)
errored `TS7016: Could not find a declaration file for module 'uuid'`,
because this git worktree had never had `npm install`/`npm ci` run in it (a
worktree gets its own `node_modules`; it does not inherit the main
checkout's). Node's module resolution then fell through to a stray, unrelated
`uuid@8.3.2` under `$HOME/node_modules` (no bundled types). Fixed by running
`npm ci` at the worktree root (825 packages, ~20s) — a local, gitignored
dependency install, not a product-code change. Raw failing output and the
fix are in the PR body.

**What it proves, mapped to the acceptance line ("two users, when both act,
revision tokens order the writes and presence shows who holds which card")
— the presence half, in a real browser:**

- Two REAL owner-class browser sessions in tenant A: owner 1 (the tenant's
  webhook-bootstrapped owner) and owner 2, invited through the REAL
  `POST /api/users/invitations` (`role: 'owner'`) + signed `user.created`
  webhook-join flow (mirrors `e2e/journeys/accept-invitation.spec.ts`), bound
  to their own HMAC dev token carrying `tenant_id`/`role` claims.
- Owner 1 starts a native HTML5 drag (`mousedown` + move onto a drop
  target, held — NOT released) on one of two seeded appointments. This
  fires the real `dragstart` handler
  (`packages/web/src/components/dispatch/AppointmentCard.tsx`), which sets
  `dragSource` (`DispatchBoard.tsx`), which `useDispatchPresence` picks up
  immediately (its HTTP-fallback effect depends on the dragged appointment
  id) and `PUT /api/dispatch/presence` with `mode: "dragging"`.
- **Owner 2's board — a SEPARATE browser context, no shared state with
  owner 1 beyond the real server — renders the "␣ is moving this" chip**
  (`AppointmentCard.tsx`, `data-testid="appointment-editing-chip"`) on the
  SAME card, screenshotted at
  `docs/audit/lane-reports/8-4-presence/2-during-drag-owner2-sees-held.png`.
  This is the real chain: presence PUT → `presence_updated` on the board
  event bus → SSE push on owner 2's `/api/dispatch/board/events` connection
  → `useDispatchBoardStream`'s `onStale` (since `presenceViaWs` is false in
  this transport) → a real board refetch → `findEditingOnAppointment`
  embedded server-side into the appointment's `editing` field → the chip.
- Owner 1 releases (`mouse.up()` on a valid gap — a genuine reorder, not a
  same-lane no-op — opens the real confirm-proposal dialog, which is
  dismissed via Cancel without creating a proposal; row 4.2 already owns
  proposal-creation proof). Owner 2's chip **clears** —
  `4-after-release-cleared.png`.
- **T2, asserted WHILE the hold is live** (not just before/after): a THIRD
  browser context, a bystander owner on tenant B's OWN, entirely separate
  tenant/technician/appointment, shows **zero** editing chips at the exact
  moment tenant A's hold is visible on owner 2's screen —
  `3-tenant-b-unaffected-during-hold.png`.
- Screenshots (all four, `docs/audit/lane-reports/8-4-presence/`):
  `1-before-drag-owner2-view.png` (no chip yet), `2-during-drag-owner2-sees-held.png`
  (chip visible: "E2E Stub User is moving this"), `3-tenant-b-unaffected-during-hold.png`
  (tenant B's own board, no chip), `4-after-release-cleared.png` (chip gone).

**No missing UI surface to pin.** The "someone else is holding this card"
indicator DOES exist end to end (`AppointmentCard.tsx`'s
`appointment-editing-chip`) and IS reachable from a real second browser in
this repo's default configuration — nothing here needed a `test.fail()`.

**Tenant grade:** T2 (tenant B seeded with its own divergent tenant, owner,
technician, and two appointments — same `seedTenantWithTwoOwners` helper,
label `'b'` — checked for zero chips DURING tenant A's live hold, not just
as an afterthought).

## What is NOT proven

- **Cross-replica Redis sharing reached from a browser.** The e2e run is
  one api process; it proves the browser is served by the real
  `RedisDispatchPresenceStore` codepath (via `REDIS_URL`), not that two
  DIFFERENT api replicas serving two DIFFERENT browsers share a hold over
  Redis. That cross-replica claim is what Part 1 proves (two `ioredis`
  connections), just not wired to a second live api process serving a
  second browser — doing that would mean running two full webServer
  instances on two ports with one shared `REDIS_URL`, which the existing
  Playwright config does not support per-spec without editing
  `playwright.config.ts` (out of scope — root-level Playwright config is
  not in this lane's allowed paths: `e2e/`, `packages/api/test/`,
  `packages/web/src/**/*.test.tsx`, `docker-compose*`/Redis test config,
  `docs/audit/lane-reports/`).
- **The WS-gateway presence transport**, in a browser. `CLIENT_WS_GATEWAY_ENABLED`
  is off by default; this run (deliberately, to match the actual default
  environment) exercises the HTTP-fallback + SSE path. `useDispatchPresence.test.tsx`
  and `client-gateway-presence.test.ts` already unit-cover the WS path in
  isolation; nothing in this lane proves the on-card chip stays LIVE-updating
  under the WS transport specifically (see the code-reading note below).
- **A genuine product observation, not a gap in this row**: reading
  `DispatchBoard.tsx` closely, the per-card `editing` chip is populated only
  from the BOARD QUERY snapshot (`board-query.ts`'s `findEditingOnAppointment`),
  never merged live from the WS gateway's `presencePeers` state (that state
  feeds only the confirm-dialog's `presenceWarning`, `DispatchBoard.tsx:692-711`).
  With the WS gateway OFF (this repo's default), presence riding HTTP + SSE
  refetch is what keeps the chip live — which is exactly what this lane
  proved. If `CLIENT_WS_GATEWAY_ENABLED=true` ships, the on-card chip may
  stop updating live for a passively-viewing peer (only the confirm dialog
  would, and only for a peer who ALSO attempts a drag on the same card).
  This is a code-reading observation for Fable to weigh, not a claim this
  lane verified as broken — filing it, if warranted, is Fable's call per
  the map's rules.
- **Redis `FAIL-OPEN-TO-LOCAL` under a real outage, reached from a browser.**
  The mocked suite (`redis-presence-store.test.ts`) already pins this at
  the unit level; this lane did not kill the Redis container mid-e2e-run to
  prove the browser degrades gracefully.

## Cleanup

Every container this lane started was removed after use: the vitest file's
Redis + Postgres testcontainers are lifecycle-owned by the test/global-setup
itself (start/stop automatic); the e2e run's manually-started
`redis:7-alpine` and `pgvector/pgvector:pg16` (`TESTCONTAINERS_RYUK_DISABLED=true`)
containers were `docker rm -f`'d by this lane once the run passed. Other
lanes' concurrent Postgres containers on this shared Mac were left
untouched.
