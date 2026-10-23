# U8 design: money cap on AI spend per tenant

**Part of:** [`docs/plans/2026-10-18-002-fix-ai-enterprise-hardening-plan.md`](2026-10-18-002-fix-ai-enterprise-hardening-plan.md).
**Status:** draft design, pending the owner decision named below. The plan's Key Technical
Decisions (durable, resumable jobs; limits serialized with their consumers) and its owner
decisions apply here. U7 and U8 refer to each other by name; both live next to this file.

## U8. Money cap on AI spend per tenant (the GATEWAY-05 follow-up) — after U3, needs an owner decision

- **Goal:** a tenant's AI spend can be capped in money, which the token buckets cannot do.
- **Dependencies:** U3, plus owner decision 2 below.
- **Design rules:** both rules under Key Technical Decisions apply. In this unit:
  - **Durable, resumable jobs:** each attempt's reservation (reserve, dispatch, settle, with the
    lease reaper as its resume), repricing, the 80% alert, the bound-breach alert, and the Vapi
    settle when owner decision 2 charges Vapi.
  - **Limits serialized with their consumers:** the ceiling and every reservation and ledger
    transition, under one per-tenant spend lock. The ceiling, the month and the decision to admit
    an unpriced attempt are each read after that lock is granted.
- **Approach:**
  - A nullable `tenant_settings` monthly ceiling in whole cents, as `BIGINT` (new idempotent
    migration). Null means no cap is enforced. `billing/overage-cap.ts`'s column is `INTEGER`
    (`schema.ts:7122`); this one isn't, for the reason in "Keep the ledger in micro-cents" below.
  - **One module writes the ceiling, so no write can skip the spend lock.** `tenant_settings` has a
    generic key-to-column updater. `PgSettingsRepository.update` maps each key through `fieldMap`
    (`settings/pg-settings.ts:421`) into one `UPDATE tenant_settings` (`:696`), with no spend lock
    and none of the checks below. Many callers reach it besides `PUT /api/settings`: onboarding and
    proposal handlers, among others. Leaving a key out of `updateSettingsSchema`
    (`shared/contracts.ts:537`) guards only the route. `siteAboutText` is absent from that schema
    yet still in `fieldMap` (`pg-settings.ts:485`). A ceiling written that way would reopen the
    race below. So:
    - The ceiling has its own store module, the way `ai_overage_cap_cents` has
      `billing/overage-cap.ts`. Its write takes the spend lock and runs the checks below. Its read
      is the one the reserve runs under the lock.
    - The ceiling is kept out of `fieldMap` and off `TenantSettings`, so the generic updater can't
      name it. The settings page sends a cap change to that module.
    - A structural test in `packages/api/test/invariants/` (the
      `i9-one-totals-engine.structural.test.ts` pattern) scans `packages/api/src`. It fails on any
      SQL that names the ceiling column outside that module and its migration.
  - **The cap is the owner's, and every change is audited.** Most settings routes require only
    `requirePermission('settings:update')` (`routes/settings.ts:419`), while some also require
    `requireRole('owner')` (`:789`). A cap route on the common pattern would let a non-owner clear
    or raise the cap, with no record. So:
    - The cap route is owner-only, with `requireRole('owner')`.
    - The module writes an audit event (actor, old value, new value) in the same transaction as
      the change, under the spend lock.
    - No proposal handler can reach it. The structural test also fails on an import of the
      module's write function outside the cap route.
    - Tests: a non-owner gets `403`, and each change leaves exactly one audit row.
  - **The ledger runs for every tenant, capped or not, so a cap set mid-month is a real monthly
    cap.** If the ledger started when a cap was set, a tenant that had already spent $90 could
    enable a $100 ceiling and spend another $100.
    - Every attempt is reserved and settled in the ledger whether or not a ceiling is set. With a
      null ceiling, the reserve step skips only the comparison. It still takes the spend lock and
      reads the ceiling under it (see "A ceiling change and a reservation take the same lock"
      below).
    - **Caps start in the first full calendar month after the ledger ships, so no pre-ledger
      spend has to be estimated.** Every attempt to reconcile old-version spend inside a month
      left a race. A seed missed late writes. A reconcile on an interval went stale. Even a
      recompute inside the reserve transaction can't serialize with an old-version write it never
      sees under `READ COMMITTED`, because old code takes no lock. Old-version processes can't be
      proven gone either, because they predate any heartbeat. So:
      - Every ledger-era `ai_runs` row carries a ledger tag from the moment it is inserted, from
        the day the ledger ships. The `ai_runs` repository's insert writes `ledger_era = true`, in
        a column whose default is `false` and that old code never names.
        - The tag can't be the reservation's `attempt_id`. The gateway inserts the pending
          `ai_runs` row before dispatch (`gateway.ts:568-588`), the reservations wrap each attempt
          inside the retry loop after that, and no `ai_runs` write runs under the spend lock. So a
          run's own pending row would still be untagged when its first reserve checks the
          tripwire below, and every capped request would refuse itself. The attempt link stays on
          `ai_spend_reservations.ai_run_id`.
        - A cache hit still writes an `ai_runs` audit row (`ai/gateway/cache.ts:191-224`), through
          the same insert, so it carries the tag too. It costs nothing and has no reservation.
      - A cap can be enabled from the first full calendar month after the ledger ships. Every run
        in that month, and in every month after it, was written by ledger-era code, so `spent` is
        the month's real spend. During the ship month, the settings write that enables a cap is
        refused, with a plain "available from <date>".
      - **A tripwire stays in place.** A capped tenant's reserve transaction checks a partial index
        for the current month:
        `ai_runs (tenant_id, created_at) WHERE NOT ledger_era`.
        - An untagged row means an old-version writer is still alive, weeks after the ship. The
          capped reservation is then refused, and `alertOperator` fires.
        - A ledger-era run is tagged before its first reserve, so neither its own pending row, nor
          a cache hit, nor a run whose process died before dispatch ever trips it.
        - Tests: a capped tenant's cache hit writes a tagged row, and the next capped request is
          admitted. A capped tenant's request and a concurrent second request are both admitted.
      - The conditional reserve therefore compares `spent + reserved + $cost` with the cap. There is
        no `pre_ledger_spent`.
    - **Unpriced usage fails closed; it is not shown as a floor.** `SUM(cost_micro_cents)` skips
      null-cost runs. A tenant with substantial unpriced usage could therefore enable a $100 cap
      and still get close to another $100. So:
      - Once a verified price exists for a run's model, the run is repriced from its stored
        `model` and `token_usage`, and the computed cost is written back. A leader-gated sweep does
        this at boot and on an interval. Each row's state is its checkpoint, so a sweep killed
        partway through a batch resumes with the rows it hadn't reached.
      - **Repricing reconciles the ledger in the same transaction, exactly once per physical
        attempt.** The run's `settled_unpriced` reservation row takes one guarded transition out
        of that state: to `settled` when it has usage, or to `charged_unreconciled` at its worst
        case when it has none (below). The guard is `state = 'settled_unpriced' AND
        reserved_micro_cents IS NULL` (see "Repricing is what gives it its amounts" below). The
        ledger's `spent` grows by exactly the repriced amount. A repricing that runs twice matches
        no row the second time. Retried attempts each have their own row, so each one is counted.
        - The `ai_runs` cost is written back after that transaction commits, in a transaction of
          its own, never under the spend lock (see "One lock order with U7" below). It is guarded
          on a charge stamp (see "A later change to a charge is written back too" below). A crash
          between the two leaves the cost unwritten, and the sweep's next pass writes it.
        - **The write-back waits for no open reservation, not for every one to be priced.** A
          `released` reservation has no snapshot and is never repriced, so "every reservation of
          the run is priced" would never hold for an unpriced attempt that failed before
          dispatch, and the sweep would re-select that run forever. So a ledger-era run's cost is
          written once none of its reservations is `reserved` or `settled_unpriced`, and no new
          attempt can start: the `ai_runs` row is no longer pending, or is older than the maximum
          gateway deadline, which bounds the whole retry loop. The cost is
          `COALESCE(SUM(charged_micro_cents), 0)` over the run's reservations, so a `released` one
          counts as zero, and a run whose only reservation was released gets cost 0. The second
          condition keeps a retry loop that is between a released attempt and its next reserve
          from being written early. An
          `ai_runs` row therefore never shows a cost that the ledger didn't hold, and a later
          change reaches it on the next write-back. The cap's checks read the ledger and the
          reservations, not the `ai_runs` cost, so a cost that lags by one pass changes none of
          them.
        - **A later change to a charge is written back too.** A priced attempt's lease expires
          while its call is still running, and the reaper charges its worst case as
          `charged_unreconciled`. The write-back writes that worst case. When the call then
          settles with real usage, `charged_unreconciled → settled` lowers the charge, and a
          write-back guarded on the cost being null would never run again, so `ai_runs` would
          keep the worst case for good. So:
          - Every change to a reservation's `charged_micro_cents`, made under the spend lock,
            stamps the reservation with the next value of one sequence. The spend lock orders a
            tenant's changes, so a later change has a higher stamp.
          - The write-back reads the run's charge sum and its highest stamp in one statement,
            through the spend module, and writes the cost guarded on the run's stored stamp being
            lower: `COALESCE(cost_stamp, 0) < $stamp`. A write-back that read before a later
            change then matches no row once the newer one has landed.
          - The `charged_unreconciled → settled` transition marks the run for another
            write-back, which runs in its own transaction outside the spend lock.
          - Test: a reaped attempt that later settles from usage ends with its `ai_runs` cost
            equal to the settled charge.
      - Each row is repriced from its own stored inputs, never from the logical `ai_runs` row:
        - An attempt with recorded usage is settled at the new price.
        - An attempt with no usage (it timed out after dispatch, or its lease expired) is charged at
          the worst case from its stored bound, and moves to `charged_unreconciled`. Its output
          bound is the price entry's `maxBilledOutputTokens`, never less than the stored
          `maxTokens` (see "An unpriced attempt is priced at its entry's billed bound" below).
        So every `settled_unpriced` row can be cleared once its model has a price. Only the
        current month's rows gate a cap (below), so an old month's row whose model never gets a
        price, such as a model the deployment has since stopped using, doesn't block enabling one.
      - **A reservation with no price snapshot never charges zero.** An unpriced reservation has no
        amount. A lease reaper or an ambiguous failure that moved it to `charged_unreconciled` would
        charge it 0. Repricing, which matches only `settled_unpriced`, would then skip it, and so
        would the cap-enable count, while its spend stayed outside the ledger. So:
        - The reaper and the ambiguous-failure path move a row with no snapshot to
          `settled_unpriced`, with no usage, never to `charged_unreconciled`. Repricing then charges
          it at the worst case, as above.
        - A definitive no-dispatch failure still releases it.
        - The check constraint ties each state to its snapshot and its amounts (see "two amounts"
          below). `settled` and `charged_unreconciled` need a price snapshot and a
          `charged_micro_cents`. Only `reserved`, `settled_unpriced` and `released` may lack a
          snapshot, since a released row charges nothing, plus Vapi's two states when owner
          decision 2 charges Vapi (see "The charge doesn't come from the end-of-call report"
          below). `reserved_micro_cents` is null exactly when the row has no snapshot, and
          `charged_micro_cents` is set exactly in `settled`, `charged_unreconciled` and
          `vapi_settled`.
      - The cap-enable check counts every reservation without a price snapshot that can still
        change this month's spend, not just null `ai_runs` costs:
        - the `settled_unpriced` rows of the month `spend_month` returns, reaped and ambiguous ones
          included
        - the `reserved` rows of unpriced attempts still in flight, in any month (see below)
        An earlier month's `settled_unpriced` row stays in the repricing queue. Repricing, and the
        ceiling write's pricing of an attempt, only ever charge the reservation's own month, so
        that row can't change this month's headroom, and it doesn't gate the cap. Once the counted
        rows are priced, the ledger already holds that spend.
        - It counts rows (`reserved_micro_cents IS NULL` in those two states). It never sums their
          amounts, because `SUM` skips nulls, the same trap as the null `ai_runs` costs above.
      - While any of those is still unpriced after that repricing, the settings write that enables a
        cap is refused. The message says plainly that this month's usage can't be fully counted
        yet.
      - A tenant that already has a cap and later gets an unpriced run has its capped reservations
        refused. That matches the existing fail-closed rule for unpriced models.
    - **A ceiling change and a reservation take the same lock, so a cap can't slip in beside an
      uncapped attempt.** Without it, an attempt can read the null ceiling and reserve or dispatch
      with no comparison, while the settings write reads the ledger before that attempt commits and
      enables a lower cap. An unpriced attempt is the worst case: it is still `reserved`, not yet
      `settled_unpriced`, so the enable check misses it, and it can later settle above the new
      ceiling. So:
      - **One per-tenant spend lock.** Every transaction that inserts a reservation, transitions
        one, changes the ledger or writes the ceiling first takes `pg_advisory_xact_lock` on the
        tenant's spend key, in the two-key form with the spend class id (see U7's "Stripes and
        the spend lock have key spaces of their own"). That covers reserve, settle, release,
        expiry, reconciliation and repricing. The lock is per tenant, not per tenant-month, so a
        cap written in the last second of a month still serializes with a reservation that lands
        in the next one.
      - **The spend module's transactions never join an ambient one.** Repositories here are
        `PgBaseRepository`s, which join any open tenant transaction: the request transaction,
        `executeAudited`, or `PgTenantTransactionRunner.run` (`db/tenant-transaction.ts:96`).
        Suppose a gateway call runs inside one, on an `/api` route missing from the hand-kept
        `LLM_LONG_CALL_ROUTES` or in a proposal handler. The pending `ai_runs` insert
        (`gateway.ts:568-588`) would join it and its erasure trigger would set the stripe flag,
        so the spend module would raise on entry and every AI call on that path would fail
        closed. Or, with no stripe taken first, the reservation and the spend lock would last
        until the outer COMMIT, across the dispatch, and every reserve and settle in the tenant,
        live calls included, would wait for the whole LLM call. A disconnect or crash would then
        roll the reservation back after the provider had billed. So:
        - Reserve, settle, release, expiry, reconciliation, repricing and the ceiling write each
          run in their own transaction, outside any ambient one (`runOutsideRequestTransaction`,
          `middleware/tenant-context.ts:676`), and commit before the module returns.
        - **They run on a small dedicated pool, not the main one.** A caller inside a request
          transaction holds one main-pool client, and each reserve and settle would await a
          second from the same pool. `runOutsideRequestTransaction`'s own comment says a request
          must never await it on its routine path, and `middleware/tenant-context.ts:222-226`
          records the incident: in-app voice turns that each held two connections "deadlocked on
          checkout and 500'd every tenant's /api". `POST /api/tenant-site/about/draft`
          (`routes/tenant-site.ts:279`) calls the gateway inside the request transaction and
          isn't on `LLM_LONG_CALL_ROUTES` (`middleware/tenant-context.ts:212`). At the default
          `DB_MAX_CONNECTIONS` of 20 (`db/pool.ts:110`), 20 such drafts at once would each hold
          a client and wait for a second, every reserve would fail closed after the 5-second
          `connectionTimeoutMillis`, and the rest of `/api` would wait on the pool. So:
          - The spend module, and U7's claim, flip and terminal writes, use a dedicated pool
            with its own size, as the session-lock holders use the direct pool
            (`db/pool.ts:155-175`).
          - Its transactions wait only on the spend lock, a stripe, or a row that only they
            write, and each sets a `lock_timeout`. A caller holding a main-pool client never
            waits on the main pool through them.
        - **Every gateway-calling path leaves the request transaction.** Inside one, the pending
          `ai_runs` insert, a local-write fence that may join the caller's transaction, holds its
          shared stripes until the request commits, across the whole LLM call, and an erase's
          phase 1 times out behind it while a draft is in flight. So `POST
          /tenant-site/about/draft`, and every other route and proposal handler that calls the
          gateway, moves onto `LLM_LONG_CALL_ROUTES`, or makes its gateway call before it opens
          its transaction.
        - Entering the spend module while `currentTenantContext()` (`:619`) is present throws
          under test and logs its caller in production. A structural test fails on a gateway or
          provider-sink call reachable from `executeAudited`, `PgTenantTransactionRunner.run`,
          or an `/api` route not on the no-transaction list.
        - Tests, with the under-test throw switched off to prove the production path: a reserve
          called inside a `PgTenantTransactionRunner.run` that then rolls back leaves its
          reservation committed, and the spend lock is free once the reserve returns.
          Docker-gated, at `DB_MAX_CONNECTIONS=2`, three concurrent in-transaction gateway calls
          all reserve, dispatch and settle.
      - **One lock order with U7: the erasure stripes first, the spend lock last.** `ai_runs` is a
        U7 `scrub` table, so a write to it takes shared erasure stripes, and those wait while an
        erase's phase 1 holds them. A transaction that held the spend lock while it waited there
        would hold up every reserve and settle in the tenant, live calls included. So:
        - A transaction never takes a stripe while it holds the spend lock. U7 states the same
          order, and the erase never takes the spend lock.
        - Under the spend lock, a transaction writes only `ai_spend_reservations`,
          `ai_spend_ledger`, `ai_spend_bound_breaches` (see "A settle above its reservation is
          caught" below), the ceiling and their audit events. The U7 manifest classifies the
          three spend tables `keep`, since they hold a model, token counts and amounts but no
          subject content, so they carry no erasure trigger. Their audit events set no PII metadata key,
          so the `audit_events` trigger takes no stripe for them (see U7's "`audit_events` is
          classified `anonymize` by metadata key").
        - **The order is checked at runtime, not only by the repricing test.** A later change
          could write the `ai_runs` cost inside the settle transaction, which is the obvious place
          for it, or put a PII key into a spend audit event. Either would take a stripe under the
          spend lock, and while an erase's phase 1 held that stripe, every reserve and settle in
          the tenant would wait behind it, with no test failing. So:
          - Taking the spend lock and taking a stripe each set a transaction-local flag to a
            fixed sentinel, `set_config(<name>, '1', true)`, which reverts at commit or rollback.
          - **A check reads `= '1'`, never `IS NOT NULL`.** A custom setting that a
            transaction-local `set_config` created doesn't go back to unset at commit. For the
            rest of the session, `current_setting(<name>, true)` returns `''`, not `NULL`, and
            node-pg reuses connections. An `IS NOT NULL` check would then raise on every later
            spend-module entry on a connection that once took a stripe, refusing AI calls for
            uncapped tenants too, and on every fenced write on a connection that once took the
            spend lock. So each check is `current_setting(<name>, true) = '1'`, which reads
            `NULL` and `''` alike as unset.
          - The stripe helper that the erasure trigger and `withErasureFence` use raises when the
            spend-lock flag is set. The spend module raises on entry when the stripe flag is set,
            since a spend transaction writes no fenced table at all.
          - Integration test: on one pooled client, a stripe-taking transaction commits and then
            a spend transaction runs, and the reverse. Both pass.
          - Each check is one `current_setting` read, cheap enough for the per-row trigger. Any
            integration test that exercises a violating path then fails loudly.
        - Any write to a fenced table that goes with a spend change runs in its own transaction,
          outside the spend lock. That covers the `ai_runs` cost write-back (see "Repricing
          reconciles the ledger" above). The gateway's completion write (`gateway.ts:679`) is
          already its own call.
      - **The reserve reads the ceiling under the lock.** It reads `tenant_settings` in a statement
        that runs after the lock is granted, never a value read earlier or passed in, and compares
        against that. Under `READ COMMITTED` each statement sees every transaction committed before
        it starts, so a cap that committed while the reserve waited is the cap it compares against.
      - **The month and the unpriced decision are read under the lock too.** The lock orders the
        transactions, but not the values they act on. Postgres `now()` and `CURRENT_DATE` return
        the transaction's start time. A settings write that begins at 23:59:59.990 on Oct 31 and
        gets the lock just after midnight would check October. It would miss a November unpriced
        attempt that committed while it waited, and enable the cap. Once that attempt is repriced,
        November ends above the cap by its worst case. So:
        - One SQL function, `spend_month(clock_timestamp())`, defines the month. The month is the
          UTC calendar month. A tenant's timezone setting can change, and a month that moved would
          leave open reservations in the wrong month. The settings page renders the reset time in
          the tenant's timezone, like every other time.
        - The reserve, the settings check, the tripwire and the ship-month rule each evaluate it in
          a statement that runs after the lock is granted. A reservation records the month that
          `spend_month` returned in its reserve.
        - **An unpriced attempt is admitted only when the ceiling read under the lock is null.** The
          reserve inserts a row with no price snapshot only in a statement guarded on that read.
          Otherwise it returns the typed refusal. So no pre-check outside the lock decides the
          path. Neither does a replica whose pricing table lacks the model, during a rolling deploy
          or after an `AI_MODEL_PRICING_JSON` change.
      - **Every ceiling write takes the lock too**, whether it enables, lowers, raises or clears the
        cap. One that enables or lowers it then checks, in that transaction and before it writes the
        new value:
        - the `spent` and `reserved` of the month `spend_month` returns after the lock
        - every reservation without a price snapshot that can still change this month's spend: a
          `reserved` row with none, in any month, which is an unpriced attempt in flight, and every
          `settled_unpriced` row of the month `spend_month` returns
        - the tripwire, the ship-month rule, and the rule that every configured model and every
          reserved surface has a price (see "That check covers every reserved surface" below)
      - **Only two orders exist.** Either an attempt's reservation commits first, and the settings
        write counts it, or the settings write commits first, and the reservation compares against
        the new ceiling.
      - **An attempt already dispatched when a cap is enabled counts at its worst case until it
        settles.**
        - A priced attempt is already in `reserved` at its worst case.
        - An unpriced attempt in flight is priced inside the settings transaction, when its model
          now has a verified price. The transaction writes that price into the attempt's snapshot,
          sets its `reserved_micro_cents` to the worst case from the attempt's own stored input
          bound and the entry's billed output bound (below), and adds that to `reserved`. The
          attempt then settles at its actual cost. Settle reads the snapshot from the row in its
          guarded transition, so it can't settle as unpriced.
        - **An unpriced attempt is priced at its entry's billed bound, not at the `maxTokens` it
          sent.** An attempt reserved while unpriced stored only its input bound and its
          `maxTokens`, since it had no entry to declare `maxBilledOutputTokens` (see "`max_tokens`
          bounds billed output only where the provider says so" below). Say an uncapped tenant's
          tier points at a reasoning model with no verified price, and an attempt with
          `maxTokens` 1,000 is in flight. The owner adds a price whose entry declares 33,000
          billed output tokens, and enables a $50 cap at $49.95 spent. Priced at 1,000 output
          tokens, the attempt is admitted, bills 30,000, and takes the month over the cap. So:
          - The ceiling write, and repricing's worst-case charge, take the output bound from the
            entry's `maxBilledOutputTokens`, never less than the stored `maxTokens`.
          - An in-flight attempt whose frozen request lacks a bound the entry requires, such as
            an OpenRouter request reserved with no `provider.max_price`, is unpriceable, and the
            cap write is refused until it settles.
          - A `settled_unpriced` row with that gap is repriced only from the endpoint's reported
            per-request charge. With none, it stays unpriced, and while it is counted the cap
            can't be enabled.
          - Tests: enabling a cap while an unpriced reasoning-model attempt is in flight reserves
            its worst case at `maxBilledOutputTokens`. With an unpriced OpenRouter attempt in
            flight, the enable is refused.
        - A counted `settled_unpriced` row is repriced in the same transaction, by the transition
          the repricing sweep uses. Its `ai_runs` cost is written back after the settings transaction
          commits, as in the sweep.
        - If any of them can't be priced, the cap write is refused, as above.
      - Enabling a cap takes effect at once against the month's real spend. The settings response
        states `spent + reserved` against the new ceiling in plain words. When that is already over
        the ceiling, it says so, and new AI work is refused.
  - **Keep the ledger in micro-cents.** `computeCostMicroCents` returns micro-cents (1 cent =
    1,000,000; `packages/api/src/ai/gateway/model-pricing.ts`), so the arithmetic must stay in that
    unit.
    - The ledger's `spent` and `reserved` are `BIGINT` micro-cents.
    - The owner-set ceiling stays in whole cents. Convert it once (× 1,000,000) before the atomic
      comparison.
    - **The conversion can't overflow, and no `BIGINT` is read as a string.** As `int4 × int4`,
      `ceiling_cents * 1000000` raises "integer out of range" from a cap of 2,148 cents, and the
      80% threshold (× 800,000) from 2,685 cents. Every capped reserve would then error. And
      node-pg returns `BIGINT` values as strings, since `packages/api/src` registers no
      `setTypeParser`, so a `spent + reserved` in JS would concatenate. So:
      - The ceiling column is `BIGINT`, and SQL that converts it casts with `::bigint` before it
        multiplies. A conversion in JS checks `Number.isSafeInteger` first.
      - Every `BIGINT` the spend module reads (`spent`, `reserved`, each `*_micro_cents`) goes
        through an explicit safe-integer parse, like `toSafeInteger`
        (`admin/tenant-usage.ts:70`, used by `admin/pg-tenant-usage.ts`).
      - **Every reserve error fails closed.** A reserve that throws returns the typed refusal,
        and the call is never dispatched.
      - **A reserve the caller gave up on is released, even when it commits later.** A reserve's
        COMMIT can succeed while its caller never sees the result: a connection error after the
        COMMIT, the caller's own deadline, or a Deepgram renewal that commits just after the
        meter closed the socket at the chunk's reserved end. Nothing takes that reservation,
        and the lease reaper later charges its worst case as `charged_unreconciled` for a call
        that was never made. So:
        - The caller generates the `attempt_id` before the reserve.
        - On any reserve error, or when the meter abandons a renewal, it releases that
          `attempt_id` as a definitive no-dispatch, since `take()` was never called.
        - A release that finds no row for the `attempt_id` inserts one, already `released`, with
          no amount. A reserve whose `attempt_id` already has a row inserts nothing and changes
          no ledger amount. Both run under the spend lock, so whichever commits first decides.
        - Test: a renewal that commits after the meter closed the socket ends `released`, and
          `spent` is unchanged.
    - Never round an individual call to cents: sub-cent calls would count as zero and the
      aggregate could pass the cap.
    - A unit test pins the conversion: a cap of 100 cents admits exactly 100,000,000 micro-cents of
      reservations. Integration tests at a cap of 1,000,000 cents admit a reservation under it,
      and cross 80% at that cap exactly once.
  - **Reserve before dispatch, atomically, then reconcile.** A plain check before dispatch followed by
    a charge on completion lets concurrent requests near the ceiling all pass and overshoot it.
    - Before dispatch, reserve the call's worst-case cost at that model's prices: an upper bound on
      input tokens, plus `maxTokens`. Do not use the fairness quota's `estimateTokens`
      (`ceil(chars / 4)`, `tenant-quota.ts`), which undercounts multilingual and punctuation-heavy
      text and leaves out chat framing.
      - Bound the input by its UTF-8 byte length. For a byte-level BPE tokenizer, the token count
        can never exceed the byte count.
      - Add a per-message framing allowance, and each image's maximum token charge.
      - An exact tokenizer for the model family may replace the byte bound only if a test proves it
        never undercounts.
    - **Bound the final wire payload, not the gateway's view of it.** For a `responseFormat: 'json'`
      request whose messages don't mention JSON, the provider adapter injects
      `JSON_MODE_SYSTEM_INSTRUCTION` downstream of the gateway (`openai-compatible.ts:63-69`,
      `:369-372`). A bound computed from the original messages misses that text and its framing.
      - Each provider adapter therefore exposes the payload it will actually send, with every
        injected instruction, transformation and framing included, for example through a
        `buildWireRequest()` it also uses itself.
      - The reservation is computed from that payload.
      - A test covers JSON-mode injection on byte-dense input.
    - **The reservation carries the payload it bounded, so nothing else can be sent.** A bound tied
      to the sent payload only by convention breaks the first time an adapter adds tool
      definitions or a preamble inside `complete()` after `buildWireRequest()` has run, or a new
      adapter builds its own payload. Every call would under-reserve, and N concurrent calls near
      the ceiling would all be admitted and settle above their reservations. So:
      - The reserve takes the wire request, computes the bound from it, and returns it frozen
        inside the `ActiveReservation`. The dispatch method sends only `reservation.wireRequest`.
      - `maxTokens` is required on the reserve input. It is optional today in `LLMRequest`,
        `RoutingDecision` and `TaskRouteConfig` (`ai/gateway/gateway.ts:75`,
        `ai/gateway/router.ts:55`, `ai/gateway/routing-config.ts:16`), and only the default tier
        table fills it in. When a request leaves it out, the reserve resolves it from the model's
        maximum output and puts that value in the wire request.
      - Test: an adapter that changes the payload after building it fails.
    - **`max_tokens` bounds billed output only where the provider says so.** The adapter serves any
      OpenAI-compatible endpoint, and sends `max_tokens` (`openai-compatible.ts:402`). DeepSeek's
      reasoning-model docs say `max_tokens` caps only the final answer, and that the chain of
      thought before it, billed as output, can run to 32K more tokens. A capped tenant whose tier
      points at such a model would pass the reserve with a worst case built from `maxTokens`, and
      settle up to 32K output tokens above it. So each pricing entry declares the most output a
      request can bill. That equals `max_tokens` only where the provider documents it as a hard
      bound on all billed output. Otherwise the entry declares `maxBilledOutputTokens`, and a model
      without one counts as unpriced for a capped tenant.
    - **A settle above its reservation is caught.** Settle compares the actual input and output
      tokens with the reserved bound. When the actual cost exceeds `reserved_micro_cents`, settle
      still charges the actual cost, since the provider billed it. It records a breach, which
      alerts and refuses later capped reserves on that model. Under test, an overshoot throws.
      - **The breach is a durable row, not a process-memory mark.** Settle runs under the spend
        lock, which limits what its transaction may write, so a mark in memory or a write after
        the commit is the obvious build. A replica that marks the model in memory and alerts
        inline, then exits on a deploy, loses both. Other replicas, and that one after its
        restart, keep admitting capped reserves at the too-low bound, each settling above its
        reservation. So:
        - An `ai_spend_bound_breaches` row, keyed by model and pricing-source version, records
          the bound that was exceeded. It holds no tenant data and has no `tenant_id`, so the
          table sits on U7's pinned global list, with that reason (see U7's "The global list is
          pinned and constrained").
        - Settle writes it, with an audit event, in its own transaction under the spend lock.
        - The capped reserve reads it in a statement that runs after the spend lock is granted,
          as it reads the ceiling. A breach refuses the reserve while the current pricing
          entry's declared bound is no higher than the bound it recorded. Only a pricing version
          that raises the bound clears it.
        - The alert goes through an outbox on the breach row, with `alert_due_seq` and
          `alert_sent_seq`, sent and stamped like the 80% alert below.
      - Unit test: a mocked reasoning endpoint that returns usage above `max_tokens` triggers the
        alert, and the next capped reservation on that model is refused.
      - Integration test, with two gateway instances on real Postgres: the process is killed
        right after an overshooting settle commits. After the restart the alert is sent once,
        and a capped reserve on that model from the other instance is refused.
    - **Give each physical attempt its own durable reservation, in Postgres.** An aggregate
      `reserved` counter can't say which of two concurrent attempts expired, whether that attempt
      was already reconciled, or whether a retried completion has already been counted. So:
      - An `ai_spend_reservations` row is keyed by a unique `attempt_id`. It holds:
        - `tenant_id`, the month, `state` and `lease_expires_at`
        - **two amounts, because settle needs both.** A settle takes the worst case off the
          month's `reserved` and adds the actual cost to `spent`. One amount column can't hold both
          values, and an `UPDATE`'s `RETURNING` gives only the new ones. A settle that overwrote
          the amount would take only the actual cost off `reserved`, stranding the rest there on
          every call, so a capped tenant would be refused well under its cap. So:
          - `reserved_micro_cents` is the worst case. It is set once, when the row gets its
            snapshot (at the reserve, when the ceiling write prices an in-flight attempt, or when
            repricing prices a `settled_unpriced` row), and never changed after that.
          - `charged_micro_cents` is what `spent` holds for the row. Settle, expiry, an ambiguous
            failure and repricing set it.
          - So each month's `spent` is the sum of its rows' `charged_micro_cents`, and its
            `reserved` is the sum of `reserved_micro_cents` over its rows still `reserved`.
        - the `ai_run_id`, once known
        - **this physical attempt's own pricing inputs:** the `model`, the worst-case input-token
          bound and `maxTokens` it reserved against, and its actual `token_usage` when the provider
          returned one
        - **a snapshot of the rates it reserved at:** the concrete input, output and per-image rates
          in micro-cents, and the pricing source's version. `AI_MODEL_PRICING_JSON` or a built-in
          price can change between reserve and settle, and settling at newer rates could charge
          more than was reserved and push a capped tenant over its ceiling. So settle, the
          worst-case charge and any later reconciliation or repricing of an attempt all use that
          snapshot. Only an attempt reserved while unpriced takes the first verified price, when
          repricing prices its `settled_unpriced` row or a ceiling write prices it in flight, and
          that price is then written into its snapshot.
          - **A routed endpoint's rate is bounded in the request, or it is unpriced.** OpenRouter
            is the documented fallback, or the primary in Profile B
            (`ai/gateway/factory.ts:36-57`). Its provider routing load-balances one model id
            across upstream providers at different per-token prices. A failover hop to
            `meta-llama/llama-3.1-8b-instruct` routed to a pricier provider is billed above the
            snapshot rate while its tokens stay inside the bound, so the ledger records less than
            OpenRouter charged, and N such calls near the ceiling pass the cap with no alert. So:
            - Pricing entries are keyed by endpoint as well as model.
            - For an OpenRouter endpoint, the wire request the reserve freezes carries
              `provider.max_price` set to the snapshot rates, so OpenRouter refuses any route
              that would bill above the reservation. That refusal is a definitive no-dispatch
              failure, and the reservation is released.
            - Where the endpoint reports what it charged per request, settle charges the larger
              of that figure and the snapshot-rate cost, and alerts when they differ.
            - A pricing entry for a routed endpoint that can't bound its rate counts as unpriced
              for a capped tenant.
            - Test: a mocked OpenRouter that bills a higher upstream rate is either refused by
              `max_price`, or settled at its reported cost.
        The logical `ai_runs` row keeps only the final attempt's usage. A timed-out first attempt
        followed by a successful retry would otherwise leave nothing to price the first attempt
        from.
        The states, and the only transitions allowed out of `reserved`:
        - `settled`: the actual cost from the usage object is charged. A success with no usage
          object doesn't settle at zero (see "A success with no usage block" below).
        - `released`: a definitive no-dispatch failure, so nothing is charged.
        - `charged_unreconciled`: a priced attempt's ambiguous failure or expired lease, charged at
          the worst-case amount. If the provider's usage later becomes known, one guarded transition
          `charged_unreconciled → settled` sets `charged_micro_cents` to the actual cost, and
          adjusts `spent` by the actual cost minus the charge it read under the lock.
        - `settled_unpriced`: an uncapped tenant's call to a model with no verified price, including
          one whose outcome is ambiguous or whose lease expired. There is no amount to charge yet;
          see "Unpriced usage" above.
        A check constraint holds exactly these states, plus Vapi's two when owner decision 2
        charges Vapi (see "The charge doesn't come from the end-of-call report"). Only
        `reserved`, `settled_unpriced` and `released`, and those Vapi states, may lack a price
        snapshot (see "A reservation with no price snapshot never charges zero").
      - Its RLS matches every tenant table.
      - A per-tenant monthly `ai_spend_ledger` row holds `spent` and `reserved`. Its key is
        `(tenant_id, month)`. Both columns are `BIGINT NOT NULL DEFAULT 0`, with a check that
        neither goes negative, so a null amount, or an adjustment that would go below zero, fails
        loudly instead of corrupting the row.
      - **The month's ledger row exists before anything reads or updates it.** A tenant's first
        attempt, and its first attempt after a UTC month rollover, find no row for that month. A
        plain `UPDATE` would match nothing, and the reserve couldn't tell "over the cap" from "no
        row yet". It would either refuse work that has headroom or dispatch with no reservation.
        So every reserve, on either path below, and every transaction that changes a ledger row
        runs this under the spend lock, before its first statement on a ledger row:
        `INSERT INTO ai_spend_ledger (tenant_id, month, spent, reserved) VALUES ($t, $m, 0, 0)
        ON CONFLICT (tenant_id, month) DO NOTHING`
        - `$m` is the month this transaction read from `spend_month` after the lock, or the month
          stored on the reservation it transitions. It is never recomputed.
        - Every insert of a ledger row holds the spend lock, so this one never waits on another
          transaction's insert. Under `READ COMMITTED` the next statement takes a new snapshot,
          so it sees the row whether this transaction created it or an earlier one did.
        - That covers the reserve, settle, release, expiry, reconciliation, repricing, the Vapi
          settle and every ceiling write, including its checks, its pricing of in-flight attempts
          and its 80% stamps.
        - After it, a ledger update that matches no row is a bug: it raises, and the transaction
          rolls back. The one exception is the priced reserve's conditional update, where no row
          means the cap refused the attempt. A refused reserve may leave the zeroed row behind,
          which changes no total.
      - **Reserve** is one transaction. It takes the spend lock, then reads the ceiling and
        `spend_month` under it (see "A ceiling change and a reservation take the same lock" above).
        A missing `tenant_settings` row counts as a null ceiling. It creates the month's ledger row
        as above. When a row for the attempt's `attempt_id` already exists, such as one a release
        inserted after the caller gave up (see "A reserve the caller gave up on is released"
        above), the reserve stops there: it changes no ledger amount, inserts nothing and returns
        the typed refusal. Otherwise it takes exactly one of two paths:
        - **A priced attempt** runs the conditional update on that month's row, against that
          ceiling:
          `UPDATE ai_spend_ledger SET reserved = reserved + $cost WHERE tenant_id = $t AND month =
          $m AND ($cap::bigint IS NULL OR spent + reserved + $cost <= $cap) RETURNING …`
          - `$cost` is the attempt's worst case, and is never null on this path. `$cap` is the
            ceiling in micro-cents, or null for no comparison. The cast lets Postgres type a null
            parameter.
          - When it returns a row, the reservation row is inserted with that month, its snapshot
            and its `reserved_micro_cents`. When it returns none, the cap refused the attempt,
            nothing is inserted, and the caller gets the typed refusal.
        - **An unpriced attempt never touches the ledger's numbers.** It has no amount to add, and
          `reserved + NULL` would make `reserved` null, or fail the `NOT NULL`. So it inserts only
          its reservation row, in `reserved`, with no snapshot and no amount, in one statement
          guarded on the ceiling being null:
          `INSERT INTO ai_spend_reservations (…) SELECT … WHERE NOT EXISTS (SELECT 1 FROM
          tenant_settings WHERE tenant_id = $t AND <ceiling> IS NOT NULL)`
          - The guard admits the attempt when the settings row is missing or its ceiling is null,
            and refuses it otherwise. No row inserted means the typed refusal.
          - The ledger's `spent` and `reserved` stay as they were until repricing, or the ceiling
            write that prices an in-flight attempt, supplies an amount.
        Caps start only in a month with no untagged runs (see above), so `spent` is the month's
        full spend.
      - **Every later step is a guarded transition on that one row**, in the same transaction as
        the ledger adjustment, after the spend lock.
        - Under the lock, the step reads the row (its state, snapshot, `reserved_micro_cents` and
          month) and computes `$charge` from the row's own snapshot. Every write to a reservation
          holds the tenant's spend lock, so the row can't change between that read and the update.
        - Then it runs `UPDATE ai_spend_reservations SET state = $next, charged_micro_cents =
          $charge WHERE tenant_id = $t AND attempt_id = $1 AND state = 'reserved' AND
          reserved_micro_cents IS NOT NULL RETURNING reserved_micro_cents, charged_micro_cents,
          month`.
        - The ledger row for the returned month then moves by exactly the returned amounts:
          `reserved` down by `reserved_micro_cents`, and `spent` up by `charged_micro_cents`, or
          not at all when it is null.
        - That covers settle (`$charge` is the actual cost from `computeCostMicroCents` at the
          snapshot rates, even when it exceeds the reservation; see "A settle above its
          reservation is caught"), release (`$charge` is null) and expiry or an ambiguous failure
          (`$charge` is the row's `reserved_micro_cents`, the worst case).
        - An attempt reserved at 23:59:50 on Oct 31 that settles just after midnight adjusts
          October's row. November's `reserved` never goes negative, and its headroom isn't inflated.
        - **A row with no amount takes its own transitions, and they never touch the ledger.**
          Under the spend lock, the step reads the row and runs the transition for its kind. The
          unpriced transition is guarded on `reserved_micro_cents IS NULL`. A settle, an expiry or
          an ambiguous failure moves it to `settled_unpriced`, keeping any usage the provider
          returned. A definitive no-dispatch failure moves it to `released`. Nothing was added to
          the ledger for it, so nothing is taken off.
        - **Repricing is what gives it its amounts.** One guarded update sets its snapshot, its
          `reserved_micro_cents` (the worst case from its stored bound), its `charged_micro_cents`
          and its next state, `WHERE tenant_id = $t AND attempt_id = $1 AND state =
          'settled_unpriced' AND reserved_micro_cents IS NULL`. The same transaction adds the
          returned `charged_micro_cents` to `spent` on the ledger row for the reservation's month.
          The ceiling write prices an in-flight attempt the same way, guarded on `state =
          'reserved'` instead, and sets only the snapshot and `reserved_micro_cents`. The row stays
          `reserved`, and its worst case is added to the month's `reserved`.
      - A transition that matches no row is a no-op. A retried completion, a reaper that races a
        late completion, and a double release therefore each count once.
      - The lease reaper expires each attempt by its own id and amount, and moves an attempt with no
        price snapshot to `settled_unpriced`. It never strands capacity, double-charges, charges
        zero, or releases a reservation that may have been billed. It is a leader-gated sweep that
        runs at boot and every minute, so a crashed process's reservations are charged after a
        restart too.
      - **U8's sweeps start with no tenant, so those that read tenant tables use U4's pattern.**
        The lease reaper, the repricing sweep, the 80% alert sweep and, when owner decision 2
        charges Vapi, the Vapi settle sweep each read forced-RLS tenant tables. The breach alert
        reads only the global `ai_spend_bound_breaches`. A scan on
        the runtime role with no tenant context sees no rows, so expired reservations would stay
        `reserved` for good, with no alert: a priced one holding its worst case in the month's
        `reserved`, an unpriced one keeping the cap-enable check refusing. So:
        - Each sweep selects the due rows' `(tenant_id, attempt_id)` across tenants, the way U4's
          purge selects tenants (PRIV-1).
        - It then runs one transaction per tenant that sets that tenant's context, takes its spend
          lock and runs the guarded transitions.
        - `tenant_id` is in every transition's `WHERE` and `RETURNING`, and in every ledger
          `WHERE`.
        - Test the sweep entry point, not the per-tenant function, under `RLS_RUNTIME_ROLE=true`,
          with expired reservations in two tenants. Both are reaped, and each ledger row moves
          only by its own amounts.
      - Postgres, not Redis, holds this, because a money ledger must be durable and auditable.
        Each transition writes an audit event in the same transaction as the transition, so a
        transition that matches no row writes none.
    - **Only a failure that definitively never reached the provider releases the reservation.**
      Examples: preflight rejection, quota rejection, a connection refused before send, a 4xx
      validation error. An ambiguous failure — a timeout or connection reset after send, a 5xx after
      streaming started — has no usage object, so charge the full worst-case reservation and move it
      to `charged_unreconciled`. Otherwise outage retries would be free in the ledger and could exceed the cap.
      An attempt with no price snapshot has no worst case yet, so it moves to `settled_unpriced`
      instead, and repricing charges it.
      This is the same definitive-no-call rule as the onboarding plan's demo-call budget (D11).
    - **A success with no usage block is charged like an ambiguous outcome, never at zero.**
      `ai/providers/openai-compatible.ts:430-440` turns a missing `usage` into zero tokens. That
      adapter targets any OpenAI-compatible endpoint, and some omit `usage`. A settle at
      `computeCostMicroCents(…, 0)` would release the worst case while the provider billed the
      tokens, and a capped tenant's real spend could pass the cap while the ledger showed headroom.
      So:
      - The adapter returns usage as `undefined` when the provider omits it, not zeros.
      - Settle treats such a success like an ambiguous outcome: `charged_unreconciled` at the
        worst case, or `settled_unpriced` for a row with no snapshot. Usage that arrives later
        settles it through the guarded `charged_unreconciled → settled`.
      - Unit test: a success with no usage object leaves the worst-case charge in `spent`.
    - **Reserve every physical dispatch, not every logical call.** `ProviderRetryDeadlineWrapper`
      can send another attempt to the same provider after a timeout
      (`compose-resilience.ts:167-182`). The first attempt may already have been billed, and if the
      retry succeeds, only the retry's usage comes back.
      - The reservation, and the ambiguous-failure charge, wrap each attempt inside the retry loop.
      - A failover hop reserves again at the fallback model's price.
    - **The compiler ties every model dispatch to a reservation.** Unit tests of today's retry and
      failover paths, and a tripwire that sees only untagged `ai_runs` rows, can't catch spend
      that writes no `ai_runs` row or rides a run that already has a reservation. Two paths do
      that today:
      - `createEmbedding` (`ai/providers/openai-compatible.ts:352`) is called directly by
        `workers/transcript-ingestion-worker.ts:356` and `workers/proposal-correction-worker.ts:191`,
        with no reservation.
      - `ShadowComparisonGateway.complete` (`ai/evaluation/shadow-comparison.ts:117-133`) sends a
        second request per sampled call inside the provider that the retry loop wraps
        (`ai/gateway/factory.ts:184`). One reservation, priced at the primary model, covers two
        dispatches.
      So:
      - Every provider dispatch method (`complete`, `createEmbedding` and any new one) takes an
        `ActiveReservation`, which only the spend module's reserve returns, and settles through
        it. The shadow wrapper reserves its own dispatch at the shadow model's price, and skips the
        shadow call when the cap refuses it, never failing the primary call.
      - **`ActiveReservation` can't be forged.** TypeScript types are structural, so a worker could
        pass `{ attemptId: randomUUID(), settle: async () => {} } as ActiveReservation`, or reuse a
        test fake. It would compile, sit inside a method that takes the type, and dispatch with no
        ledger row. So `ActiveReservation` is a class with an ECMAScript `#private` field,
        constructed only inside the spend module. The structural test fails on any
        `as ActiveReservation`, any object literal typed as one, and any `new` of it outside that
        module, test helpers included. Tests get a real reservation from an in-test spend module.
      - **`ActiveReservation` is single-use and checked at runtime, and no SDK retries under
        it.** A real reservation can't be forged but could be reused, and one call can bill
        twice:
        - `workers/transcript-ingestion-worker.ts` could reserve once and pass the same
          reservation to `createEmbedding` for each of 40 chunks. Every call type-checks. The
          first settle moves the row to `settled`, the other 39 match no row, and 39 billed
          dispatches never reach `spent`.
        - A new adapter that calls `new OpenAI({ apiKey, baseURL })` without `maxRetries: 0`
          gets the SDK's default of 2 (the repo's own warning, `openai-compatible.ts:121-123`).
          The voice-quality harness builds one with `maxRetries: config.maxRetries`, defaulting to
          `LAYER_TWO_MAX_RETRIES = 2` (`ai/gateway/real-layer-two-factory.ts:192`, `:471-476`). A
          timeout after send is then retried inside one `complete()`: billed twice, reserved
          once, and settled from the last usage only.
        - An `any`-typed value passed where an `ActiveReservation` parameter is expected needs no
          `as`, and the `#private` brand is never checked at runtime.
        So:
        - A dispatch reaches the provider only through `reservation.take()`. `take()` checks the
          brand (`#field in r`), flips an internal consumed flag, and throws on a second call.
          Settle refuses a reservation that was never taken.
        - **`take()` returns a one-shot sender, not a payload.** A payload can be sent many times.
          An adapter could write `const req = reservation.take(); return runWithRetry(() =>
          this.client.embeddings.create(req, { signal }))`, reusing the gateway's helper
          (`ai/gateway/retry.ts:314`), or wrap a `fetch` to Whisper in a loop that retries on a
          5xx. `take()` runs once, the SDK has `maxRetries: 0` and the signal is passed, so every
          check passes, while each retry the provider accepted is billed and only the last one
          settles. So `take()` returns `send(transport)`, which makes the single network call
          with the frozen request and throws on a second invocation.
        - The scan also fails on a reserved call site, or a `send(...)` call, that sits lexically
          inside a loop, inside a recursive function, or inside a function passed to any callee
          other than `send` itself, `runWithRetry` included.
        - The structural test fails on any model-provider SDK client built without a literal
          `maxRetries: 0`, or the equivalent option on another SDK, unless its entry is
          `spend_exempt`. It also fails on an `any`-typed argument at an `ActiveReservation`
          parameter.
        - Tests: one reservation reused for a second dispatch throws. A fixture adapter with SDK
          retries left on fails the scan. A fixture adapter that wraps its call in
          `runWithRetry` after `take()` fails the scan, and a second `send` throws.
      - U7's call-site scan gains one rule: every model-provider call site sits inside such a
        method, or is registered `spend_exempt` with a reason.
      - **Every `externalSinks` entry declares its spend, so "model-provider call site" is
        mechanical.** A `fetch`-typed call site carries no type that marks it as a model provider.
        `voice/voice-service.ts:329` and `ai/tts/tts-provider.ts:144` are plain `fetch` calls to
        OpenAI's transcription and speech endpoints on the platform key. Whisper
        (`voice/transcription-providers.ts:254`), Deepgram live STT (the `ws` stream at `:580-582`)
        and ElevenLabs TTS (`ai/tts/elevenlabs-stream.ts:119-121`) never pass through `complete` or
        `createEmbedding`. A capped tenant at its ceiling would have its LLM calls refused while it
        kept transcribing voicemails and synthesizing speech, none of it in `spent`. So:
        - `spend` is a required field on every `externalSinks` entry: `reserved` (the call site sits
          inside a dispatch method that takes an `ActiveReservation`) or `spend_exempt` with a
          reason.
        - Each entry names its provider, and a checked-in table says which providers bill per use.
          The test requires `reserved`, or a `spend_exempt` with a reason, on every entry whose
          provider does.
        - U7's transport rule (see U7's "a transport value") makes the Deepgram and ElevenLabs
          WebSockets call sites, so they need entries too.
        - **Vapi spends with no call site to reserve.** When `VAPI_API_KEY` is set, tenant calls
          route to Vapi by number (see U7's "Vapi takes whole calls by routing"), and each Vapi
          minute, with its LLM, speech-to-text and text-to-speech, is billed on the platform key
          with no reservation. A capped tenant at its ceiling would keep spending. So the Vapi
          entry either charges each call's cost to the ledger after the fact, under the spend
          lock, keyed by the Vapi call id so the call counts once, or is `spend_exempt` with
          that reason. Owner decision 2 picks one. Either way the settings page says that a Vapi
          call isn't stopped at the cap.
          - **The charge doesn't come from the end-of-call report.** A report can fail to arrive,
            and its call object can be a stale snapshot whose `cost` reads 0. Settled from the
            webhook, a dropped report would record nothing, and a report with cost 0 would use
            up the call id's one count before a correct figure arrived. So, when owner decision
            2 picks charging:
            - The webhook records each Vapi call id from its first event as an open spend row,
              in a state of its own, `vapi_pending`, under the spend lock. It has no snapshot
              and no amount, the reserve path never admits against it, and the cap-enable check
              doesn't count it, since the settings page already says a Vapi call isn't stopped
              at the cap.
            - A leader-gated sweep, per tenant like U8's other sweeps, fetches `GET /call/{id}`
              once the call has ended, and moves the row with one guarded transition
              `vapi_pending → vapi_settled`, setting `charged_micro_cents` to the reported cost
              and adding it to `spent`. It never settles at 0 unless Vapi reports that the call
              never connected.
            - A row is retried until its cost is final, under a deadline after which it alerts.
            - Calls whose ids were never recorded are found by listing Vapi calls per tenant
              `phoneNumberId`.
            - The check constraint gains both states: `vapi_pending` with no amount, and
              `vapi_settled` with a `charged_micro_cents` and no rate snapshot.
            - Test: a dropped report and a report with cost 0 each still end with the call's
              real cost in `spent`, once.
        - **The cap's own fallback spends too.** A refused renewal degrades the call to Gather.
          Twilio bills `<Gather input="speech">` speech recognition per use, and premium `<Say>`
          voices too, through TwiML returned in a webhook response, so no outbound call site
          carries that spend. `telephony/twilio-adapter.ts:739` and `routes/telephony.ts:1423`
          emit `<Gather input="speech">`, and the voice path speaks with Polly voices. A capped
          tenant at its ceiling would have every live call degrade to Gather and keep billing
          speech recognition and speech, with no reservation, no `spend_exempt` decision and
          nothing in `spent`. So:
          - A manifest and `externalSinks` entry covers Twilio speech recognition and premium
            `<Say>` voices, marked as spend that enters by TwiML, like Vapi's routing entry, with
            `spend` declared.
          - Either the TwiML builder reserves before it emits each `<Gather input="speech">`,
            bounded by its maximum speech duration, and each premium `<Say>`, by character
            count, and on refusal emits a non-speech fallback (a DTMF Gather or the hold line),
            or the entry is `spend_exempt` and the settings page says Gather speech is outside
            the cap. Owner decision 2 picks one.
          - A scan rule fails on any TwiML string that emits `<Gather input="speech…">`, or a
            `<Say voice="Polly.…">` or `<Say voice="Google.…">`, outside a builder that carries
            that entry.
      - **Each price declares its billing unit.** The worst case above is defined in tokens, but
        OpenAI prices Whisper per minute of audio (the repo's own constant,
        `ai/voice-quality/audio/whisper-real-provider.ts:44`), Deepgram prices streamed audio by
        the minute, and ElevenLabs and OpenAI speech bill per character. A reserve that can't
        compute their worst case would treat them as unpriced and refuse every capped tenant's
        live-call STT. So each pricing entry declares its unit (tokens, audio seconds or
        characters), and the reserve computes the worst case in that unit from the wire request:
        - Whisper from the audio's duration, capped by the provider's file limit
        - ElevenLabs and OpenAI speech from the text's character count
        - a Deepgram stream as renewable chunks of audio time. A refused renewal ends the stream,
          and the call degrades to Gather.
      - **A rate that depends on request flags is keyed on them.** Owner decision 1 may set
        `mip_opt_out=true` on every Deepgram request, and Deepgram charges more to customers who
        opt out of its Model Improvement Partnership Program. A single per-minute entry per model
        would keep reserving and settling at the old rate after the flag is added. So the
        Deepgram pricing entry is keyed on the request parameters that change its rate,
        `mip_opt_out` and any add-on Deepgram bills separately, read from the frozen wire
        request. A unit test fails when a request sets a rate-changing flag that its pricing entry
        doesn't declare.
      - **A streamed chunk is metered at the transport, and stops at its reserved end.**
        `startStream` returns a session whose `send(chunk)` calls `ws.send(chunk)` for the whole
        call (`voice/transcription-providers.ts:745`). Giving `startStream` an `ActiveReservation`
        parameter would pass the scan while nothing tied the frames to a live chunk, so every
        capped call near the ceiling could stream to its `TimeLimit` on its first chunk's
        reservation. And a renewal requested at the chunk boundary waits on the tenant's spend
        lock while audio keeps flowing. Seconds past the reserved end are then billed with no
        reservation, and even a granted renewal leaves the chunk settling above its
        `reserved_micro_cents`. That trips "A settle above its reservation is caught" and
        refuses every capped tenant's live speech-to-text, though the model's bound was right.
        So:
        - For a `spend: reserved` streaming entry, the reserve returns a metered reservation
          whose `send(bytes)` is the only route to the transport. It counts audio time against
          the current chunk.
        - It requests each renewal early, once a fixed fraction of the chunk is used. The renewal
          is a new attempt row under the spend lock, off the per-frame path. Its reserve sets
          `lock_timeout` to the time left before the reserved end, so a long wait for the lock
          ends the stream rather than overrunning the chunk.
        - It never forwards audio past the reserved end. If the renewal hasn't committed by then,
          or is refused, it closes the socket and the call degrades to Gather.
        - Each chunk settles at the seconds actually streamed inside it.
        - The same rules apply to a character-reserved TTS stream.
        - The scan fails on a raw transport `send` under a reserved streaming entry that doesn't
          go through the meter.
        - Tests: a three-chunk fixture stream reserves three times. A refused renewal closes the
          socket, and the call degrades to Gather. With the spend lock held across a chunk
          boundary, no audio past the reserved end is sent, and no overshoot alert fires.
      - The recommended default, pending owner decision 2, is that this spend is capped like
        model tokens. If the owner keeps any of it outside the cap, each such entry is
        `spend_exempt` with that reason, and the settings page says the cap covers model tokens
        only.
      - The one-ceiling-writer structural test also fails on SQL that names
        `ai_spend_reservations`, `ai_spend_ledger` or `ai_spend_bound_breaches` outside the spend
        module.
      - Test: with the shadow wrapper on, a capped tenant's sampled call reserves twice, and an
        embedding call reserves once. A capped tenant's voicemail transcription reserves by
        duration. A fixture `new WebSocket('wss://api.deepgram.com/...')` with no reservation and no
        `spend_exempt` fails the scan.
    - A reservation carries a lease expiry. A crashed process can't say whether its call went out, so
      an expired lease is charged at worst case and marked `charged_unreconciled`; it is not released.
      An unpriced one goes to `settled_unpriced`, as above.
    - **Fail closed on unpriced models.** A worst-case reservation can't be computed without a price.
      U3 deliberately leaves unverified models unpriced (null, with a boot warning), and the default
      `gpt-4o-mini` is not in the built-in table.
      - For a tenant with a cap set, a request whose selected or fallback model has no verified price
        is rejected with a typed error. The ceiling read under the spend lock decides that, never a
        check made before the lock (see "The month and the unpriced decision are read under the
        lock too").
      - The settings write that enables a cap is refused until every configured tier and fallback
        model has a price, from the defaults or `AI_MODEL_PRICING_JSON`. The fail-closed path then
        only fires on later misconfiguration.
      - **That check covers every reserved surface, not only the tier and fallback models.**
        Embeddings, the shadow model, Whisper, OpenAI speech, ElevenLabs and Deepgram are each
        priced from an entry in its own billing unit, and none is a tier or fallback model. An
        owner who enabled a cap while Deepgram's per-second price was missing would have every
        call degrade to Gather, and its voicemail transcriptions and embedding ingests refused.
        So the enable check, and the boot warning, cover every surface whose `externalSinks`
        entry is `spend: reserved` and whose provider is configured, priced in its declared unit,
        plus the shadow model while sampling is on. The refusal names each unpriced surface.
        Test: enabling a cap with Deepgram unpriced is refused, and the refusal names Deepgram.
  - Reject with a typed error that the voice path turns into its existing hold-line / Gather behaviour.
    That fallback's own spend is covered in "The cap's own fallback spends too" above.
  - **Alert at 80% through `alertOperator`, from an outbox.** A reservation can't send the alert
    inside its transaction, and a call after the commit is lost if the process exits first. The
    outbox uses integer generations, as U7's does, not a timestamp. A due timestamp from the
    database clock has microseconds, while node-pg parses it into a JS `Date` with milliseconds
    (`packages/api/src` registers no `setTypeParser`). A guard that passes that value back would
    match almost no row, so every pass would send the alert again, for past months too. So:
    - The ledger row carries `alert_80_crossed` (`BOOLEAN NOT NULL DEFAULT false`), and
      `alert_80_due_seq` and `alert_80_sent_seq` (both `BIGINT NOT NULL DEFAULT 0`). So the
      zeroed row that every reserve inserts (see "The month's ledger row exists before anything
      reads or updates it" above) needs no other value.
    - The transaction that first takes the month to 80% of the ceiling sets `alert_80_crossed` and
      bumps `alert_80_due_seq`, under the spend lock, guarded on `alert_80_crossed` being false.
    - A ceiling write applies the same rule in its transaction, under the same lock. A lower cap
      that puts the month past 80% marks the alert due. A higher cap that puts it back under 80%
      clears `alert_80_crossed`, so the alert can fire again.
    - A leader-gated sweep sends every alert whose `alert_80_due_seq` is past `alert_80_sent_seq`,
      then sets `alert_80_sent_seq` to the value it read, guarded on `alert_80_due_seq` still being
      that value. A guard on the sent stamp alone isn't enough. A ceiling raise between the send
      and the stamp clears `alert_80_crossed`, a reservation then crosses 80% of the new cap and
      bumps `alert_80_due_seq`, and the stamp would mark that new alert sent without sending it.
      With the guard, the stamp matches no row, and the next pass sends the new alert.
    - A crash between the send and the stamp sends it twice, which is harmless for an operator
      alert. A crash before the send loses nothing.
- **Test scenarios:**
  - **Unit:** a call is admitted under the cap and rejected over it.
  - **Unit:** failover is charged once.
  - **Unit:** a timeout followed by a successful retry leaves the ledger with attempt 1's worst-case
    charge plus attempt 2's actual cost.
  - **Unit:** an input that tokenizes far above `chars / 4` (dense punctuation or CJK) still reserves at
    least its true cost.
  - **Concurrency (real Postgres, Docker-gated):** N requests start together just below the
    ceiling, through the spend module, on N connections released together by a barrier, under
    `RLS_RUNTIME_ROLE=true`. Admitted reservations never exceed the cap, and every rejection is
    typed. It runs once with a cap and once with a null cap, where every request is admitted and
    `reserved` is their sum. An in-memory ledger fake would pass even with a missing
    `$cap::bigint` cast or a ceiling read before the lock.
  - **Unit:** an expired lease is charged at worst case and marked `charged_unreconciled`. A usage
    object that arrives later settles it once, with the difference.
  - **Integration (unpriced, uncapped):** an uncapped tenant makes two unpriced attempts. The first
    times out after dispatch with no usage, and the retry succeeds. After a price is added,
    repricing does two things:
    - It charges the first attempt at the worst case from its own stored bound, as
      `charged_unreconciled`.
    - It settles the retry from its own usage.
    Both amounts are added to `spent` once. A second repricing changes nothing, and enabling a cap
    then counts that spend.
  - **Unit:** a definitive no-dispatch failure releases its reservation, and an ambiguous timeout keeps
    the worst-case charge.
  - **Unit:** a capped tenant's request to an unpriced model is rejected with a typed error.
  - **Unit:** enabling a cap is refused while any configured model, or any configured surface
    whose entry is `spend: reserved`, is unpriced.
  - **Integration:** the monthly window resets. The ledger's `spent` equals the sum of the month's
    `charged_micro_cents`, not the `ai_runs` costs, and its `reserved` equals the sum of
    `reserved_micro_cents` over the month's rows still `reserved`. A timed-out attempt followed by
    a successful retry is charged twice by design, while `ai_runs` keeps only the retry. Each
    `settled` row's `charged_micro_cents` equals `computeCostMicroCents` of that attempt's own
    stored usage at its snapshot rates, and its `reserved_micro_cents` still holds its worst case.
  - **Integration (settle frees the whole worst case):** a capped tenant runs many calls that each
    settle well below their worst case. Afterwards `reserved` is 0, and a request that fits under
    the cap against `spent` alone is admitted.
  - **Integration (price change):** a price changes between an attempt's reserve and its settle.
    The settle charges at the snapshot rates, and a capped tenant can't be pushed over by the
    change.
  - **Integration (per-attempt reservations, real Postgres):**
    - Two concurrent attempts reserve different amounts, and one process dies. The reaper charges
      exactly that attempt's amount, and the other attempt settles normally.
    - A completion delivered twice settles once.
    - A reaper racing a late completion produces exactly one transition.
  - **Integration (first request of a month, real Postgres):**
    - A tenant whose only ledger row is October's makes its first request on Nov 1. The reserve
      creates November's row, with `spent` 0 and `reserved` equal to the worst case. October's
      row is unchanged.
    - A first-ever tenant with no ceiling has its first request reserved, and its ledger row
      appears.
    - A first-ever tenant with a cap, in a month after the ship month, has a request under the cap
      admitted. A request whose worst case alone exceeds the cap is refused with the typed error,
      and no reservation row exists for it.
    - Two first requests of a new month start together. Afterwards one ledger row exists for that
      month, and its `reserved` is the sum of both.
    - A first-ever tenant enables a cap. The settings write reads zero spend for the month and
      succeeds.
  - **Integration (unpriced reserve, then repricing, real Postgres):** a first-ever, uncapped
    tenant makes an attempt on an unpriced model.
    - Its reservation has no snapshot and no amount. The month's ledger row exists, with `spent`
      and `reserved` both 0, not null.
    - The attempt completes with usage and moves to `settled_unpriced`. The ledger is unchanged.
    - A priced attempt in the same month then reserves and settles normally.
    - A price is added. Repricing sets the snapshot and both amounts, moves the row to `settled`,
      and adds exactly `computeCostMicroCents` of its usage to `spent`, once. A second repricing
      changes nothing.
    - An unpriced attempt that fails before dispatch ends `released`, with no amount, and the
      ledger is unchanged.
  - **Integration (mid-month cap):** in a month after the ship month, a tenant has $90 of tagged
    `ai_runs` cost. It enables a $100 cap, and a $15 worst-case call is refused.
  - **Integration (ship month):**
    - Enabling a cap during the ship month is refused, with the date it becomes available.
    - An untagged run in a later month trips the wire: the capped reservation is refused, and an
      alert fires.
  - **Integration (unpriced):**
    - A current-month `settled_unpriced` reservation blocks enabling a cap. A null `ai_runs` cost
      alone doesn't, since the check reads only reservations.
    - An unpriced attempt that fails before dispatch is `released`. Once the run is no longer
      pending, the write-back gives it cost 0, and the sweep doesn't select it again.
    - After a verified price is added, the run is repriced from its `model` and `token_usage`, and
      the cap can then be enabled against the full total.
    - A `settled_unpriced` row from an earlier month, on a model that never gets a price, doesn't
      block enabling a cap. It stays in the repricing queue.
  - **Integration (cap change versus a reservation, real Postgres, the racy order forced):** two
    connections, each held at a set point.
    - **Reservation first.** An uncapped tenant's attempt, reserved while its model was unpriced,
      takes the spend lock, reads the null ceiling, inserts its `reserved` row and is held before
      commit. A settings write that enables a cap starts. While the reservation is held, the
      settings write doesn't return. Once the reservation commits, the settings write counts it.
      With a verified price now present, it prices the attempt at its worst case from its stored
      bound. Without one, it refuses the cap. The attempt then settles within the counted amount.
    - **Settings first.** The settings write is held after its checks, before commit. A reservation
      that starts then waits, reads the new ceiling once the write commits, and is compared against
      it. One that would exceed the cap is refused with the typed error.
    - **Month boundary.** A cap written in the last second of a month and a reservation in the
      first second of the next serialize, in both orders.
    - **Midnight while waiting.** The settings write is held between `BEGIN` and the lock while the
      clock `spend_month` is given crosses midnight. An unpriced attempt reserves in the new month
      and commits. The settings write then counts that attempt: it prices it at its worst case, or
      it refuses the cap.
    - **A settle that straddles midnight.** An attempt reserved before midnight settles after it.
      The adjustment lands on its reserve month's ledger row, and the new month's `reserved` is
      unchanged.
    - **A replica with the model unpriced.** After a cap is enabled, an attempt from a replica whose
      pricing table lacks the model is refused with the typed error, and no row without a price
      snapshot is inserted.
  - **Integration (unpriced attempt reaped, real Postgres):** an uncapped tenant's call to an
    unpriced model is in flight when its process dies. The reaper moves its reservation to
    `settled_unpriced`, never to `charged_unreconciled` at zero. Enabling a cap is refused while it
    stays unpriced. After a price is added, repricing charges its worst case once, then writes the
    `ai_runs` cost in its own transaction, and enabling a cap then counts that spend. An ambiguous
    timeout on the same kind of attempt ends the same way.
  - **Integration (in-flight priced attempt):** a priced attempt is dispatched while the tenant is
    uncapped, and a cap is then enabled. Until the attempt settles, the cap's headroom excludes its
    worst case. It settles at its actual cost, and the difference is freed.
  - **Integration (repricing sweep):** the sweep is killed partway through a batch. The next run
    reprices the rest, and each row is counted once. A run whose ledger transition committed
    before the kill gets its `ai_runs` cost on the next run.
  - **Integration (80% alert):** the process exits right after the reservation that crosses 80%
    commits. After the restart the sweep sends the alert once. Lowering a cap so the month is
    already past 80% marks the alert due without any new reservation.
    - A ceiling raise lands between the sweep's send and its stamp, and a reservation then
      crosses 80% of the new cap. The new alert is still sent, once.
    - A crossing alerts exactly once across several sweep passes, including a crossing in a month
      that has since ended.
  - **Integration (lock order with U7, real Postgres):** an erase's phase 1 holds the stripes of a
    run's correlation id and customer. A repricing of that run commits its ledger transition
    without waiting, and reserves and settles for other attempts in the tenant don't wait either.
    The run's `ai_runs` cost is written once phase 1 commits. A test-only path that takes a stripe
    under the spend lock raises, and so does one that enters the spend module holding a stripe.
  - **Structural (one ceiling writer):** SQL that names the ceiling column outside its module fails
    the build, and so does SQL that names `ai_spend_reservations`, `ai_spend_ledger` or
    `ai_spend_bound_breaches` outside the spend module. A `PUT /api/settings` body that carries a
    ceiling key leaves the ceiling unchanged.
