# fix: Cache Gather STT hints and bound the glossary queries

**Created:** 2026-07-17
**Depth:** Lightweight
**Status:** plan

## Summary
Every Twilio `<Gather>` turn currently fires three tenant-scoped DB queries
(catalog items, customers, users) to rebuild the same ~100-term STT hint
list, and two of the three queries are unbounded (capped only in JS after
fetching every row). This plan adds a per-tenant TTL cache to
`TenantGlossaryProvider`, threads real SQL `LIMIT`s into the two unbounded
repo methods, and shares one provider instance between the Gather-hints
path and the transcription-correction worker so both benefit from one
cache. Deferred review finding from the voice-AI branch (PR #696).

## Problem Frame
`TwilioTelephonyAdapter.resolveGatherHints` runs on every Gather webhook
(inbound greeting, every speech turn via `finalizeTwiml`, and session
replay). Its fallback `TenantGlossaryProvider.termsForTenant` issues
`catalogRepo.listByTenant` (unbounded — a 5,000-item catalog is fully
fetched then sliced to 40), `customerRepo.findByTenant` (bounded, limit 40),
and `userRepo.findByTenant` (unbounded) — three round-trips per caller
utterance for data that changes on the order of days. The transcription
worker pays the same three queries per voice recording via its own separate
provider instance. Under call volume this is pure wasted DB load and adds
avoidable latency inside the Twilio webhook response window.

## Requirements
- R1. A repeat Gather turn for the same tenant within the cache window
  issues zero glossary DB queries.
- R2. Catalog and user glossary queries are bounded in SQL (`LIMIT`), not
  just in post-fetch JS.
- R3. Concurrent lookups for the same tenant coalesce into one in-flight
  query set (no thundering herd when two calls arrive together).
- R4. Behavior is unchanged from the consumer's perspective: same terms,
  same caps (40/source, 100 merged), same never-throws contract.
- R5. The adapter's Gather-hints fallback and the transcription worker
  share one provider instance (one cache, not two).

## Key Technical Decisions
- **Cache inside `TenantGlossaryProvider`, opt-out via `cacheTtlMs: 0`** —
  a per-tenant TTL cache (default 5 minutes) built into the provider
  benefits every consumer without new wiring, and the provider is the
  natural owner of "how fresh are terms". (Alternative: a decorator class
  or adapter-side session cache — rejected: two consumers would each need
  wiring, and a session-scoped cache still re-queries once per call
  instead of once per tenant-window.)
- **Cache the in-flight `Promise`, not just the resolved value** — storing
  the promise on first call coalesces concurrent lookups (R3); a rejected
  promise is evicted so a transient failure doesn't poison the window.
  Note `termsForTenant` never rejects by contract, but eviction-on-reject
  keeps the cache safe if that ever changes.
- **Bound the cache with a max-entries LRU-ish sweep (e.g. 500 tenants)** —
  the provider lives for the process lifetime; an unbounded per-tenant map
  is a slow leak on a multi-tenant box. Simple insertion-order eviction
  (Map delete/re-insert on hit) is sufficient; no dependency needed.
- **Thread `limit` through the existing options objects** — add
  `limit?: number` to `ListCatalogItemOptions` and `UserListOptions`,
  mirroring the customer repo's existing pattern
  (`packages/api/src/customers/pg-customer.ts` already clamps and
  parameterizes `LIMIT`). (Alternative: new bounded methods like
  `listNamesForGlossary` — rejected: the option generalizes; a bespoke
  method duplicates query code for one caller.)
- **Deterministic order under LIMIT** — a SQL `LIMIT` without `ORDER BY`
  makes the 40-term window nondeterministic across turns, which would
  churn the cache-busted hint list. Keep each pg method's existing
  `ORDER BY` (add one only if a method lacks it, matching its in-memory
  counterpart's ordering).

## Scope Boundaries
**In scope:** TTL cache + coalescing in `TenantGlossaryProvider`; `limit`
option on catalog/user repo list methods (interface + pg + in-memory);
glossary provider passes `limit: PER_SOURCE_CAP`; app.ts shares one
provider instance with the Twilio adapter via the existing
`sttHintsResolver` seam.
**Non-goals:** vertical `sttKeywords` merging into Gather hints (separate
deferred item); media-streams glossary wiring; any change to hint content,
caps, or the transcription-correction prompt; cache invalidation on
catalog/customer/user writes (TTL staleness of ≤5 min is acceptable for
STT bias terms).
### Deferred to follow-up work
- Wiring vertical `sttKeywords` into the Gather hints source (the
  `sttHintsResolver` doc comment already flags this).

## Repository invariants touched
- **tenant_id + RLS:** all queries remain tenant-scoped through the
  existing repo methods; the cache is keyed by `tenantId` so terms can
  never bleed across tenants. `limit` is parameterized, never
  interpolated.
- **No mutations** — no audit-event changes. No money, no proposals, no
  LLM-call changes (the correction pass consumes the same provider
  contract).
- **DB-touching change** — the new `limit` option on pg repos requires a
  Docker-gated integration test in `packages/api/test/integration/`
  (mocked-DB tests are not sufficient proof).

## Implementation Units

### U1. Per-tenant TTL cache with in-flight coalescing in TenantGlossaryProvider
- **Goal:** repeat `termsForTenant` calls within the TTL window hit a
  cache; concurrent calls share one query set.
- **Requirements:** R1, R3, R4
- **Dependencies:** none
- **Files:**
  - `packages/api/src/voice/tenant-glossary-provider.ts` (modify)
  - `packages/api/test/voice/tenant-glossary-provider.test.ts` (extend)
- **Approach:** constructor gains an options arg
  `{ cacheTtlMs?: number }` (default 5 min; `0` disables — existing tests
  that assert per-call repo hits pass `0` or rely on fake timers). Cache
  is `Map<tenantId, { promise, expiresAt }>`; on call: evict expired
  entry, return live entry's promise, else insert the in-flight promise
  and evict it on rejection. Bound the map at ~500 entries with
  insertion-order eviction. Use the injected clock pattern only if one
  already exists in the file's tests — otherwise `Date.now()` with
  vitest fake timers in tests.
- **Patterns to follow:** the file's existing doc-comment style
  (contract-first, per-source caps rationale); vitest fake timers as used
  elsewhere in `packages/api/test/voice/`.
- **Test scenarios:**
  - Happy path: two sequential calls for the same tenant → repos hit
    once; returned terms identical.
  - TTL expiry: advance fake timers past the TTL → repos hit again.
  - Coalescing: two concurrent calls (unresolved repo promise) → repos
    hit once, both callers get the same terms.
  - Isolation: two tenants → separate cache entries, no term bleed.
  - Disabled: `cacheTtlMs: 0` → repos hit on every call (pins the
    escape hatch for consumers needing freshness).
  - Bound: exceeding the max-entries bound evicts the oldest tenant
    (repo re-queried for it).
- **Verification:** driving two Gather turns for the same tenant in the
  in-memory API (packages/api:verify) shows the second turn issuing no
  glossary repo calls (observable via repo spies in the handler-level
  test; runtime-observable as unchanged TwiML `hints` with no added
  latency).

### U2. SQL LIMIT threading for catalog and user list queries
- **Goal:** the two unbounded glossary queries are bounded in the
  database, not post-fetch.
- **Requirements:** R2, R4
- **Dependencies:** none (parallel with U1)
- **Files:**
  - `packages/api/src/catalog/catalog-item.ts` (interface + in-memory)
  - `packages/api/src/catalog/pg-catalog-item.ts`
  - `packages/api/src/users/user.ts` (interface + in-memory)
  - `packages/api/src/users/pg-user.ts`
  - `packages/api/src/voice/tenant-glossary-provider.ts` (pass
    `limit: PER_SOURCE_CAP` for catalog and users)
  - `packages/api/test/catalog/catalog-item.test.ts` and
    `packages/api/test/users/` unit tests (extend existing files; confirm
    exact paths at implementation)
  - `packages/api/test/integration/glossary-query-limits.test.ts` (new,
    Docker-gated)
- **Approach:** add `limit?: number` to `ListCatalogItemOptions` and
  `UserListOptions`. Pg implementations append a parameterized
  `LIMIT $n` (clamped like `pg-customer.ts` does); ensure a stable
  `ORDER BY` exists so the limited window is deterministic. In-memory
  implementations `slice(0, limit)` after their existing
  filter/sort. Glossary provider keeps its JS `.slice` as a belt-and-
  suspenders cap (harmless, protects non-limit-aware repo fakes).
- **Patterns to follow:** `packages/api/src/customers/pg-customer.ts`
  limit clamping and parameterization.
- **Test scenarios:**
  - Happy path (unit, in-memory): `limit: 2` on a 5-row tenant returns 2
    rows; omitted limit returns all (backward compat).
  - Edge: `limit: 0` and `limit > rowcount` behave sanely (0 rows / all
    rows); other option combinations (role filter, search, category)
    compose with limit.
  - Integration (Docker): seed >40 catalog items and >40 users for a
    tenant against real Postgres; assert `listByTenant(t, {limit: 40})`
    and `findByTenant(t, {limit: 40})` return exactly 40 with the
    expected ordering — pins real column names and the generated SQL.
  - Glossary: provider passes the limit (spy assertion) and still caps
    merged output at 100.
- **Verification:** integration test green under Docker; glossary terms
  for a large-catalog tenant unchanged in content vs. before (same first
  40 by the pinned ordering).

### U3. Share one glossary provider between the adapter and the worker
- **Goal:** one cache instance process-wide (R5) instead of the adapter's
  private fallback plus the worker's instance.
- **Requirements:** R1, R5
- **Dependencies:** U1 (the shared instance is what carries the cache)
- **Files:**
  - `packages/api/src/app.ts` (pass the existing
    `transcriptionGlossaryProvider` to the Twilio adapter via
    `sttHintsResolver`)
  - `packages/api/src/telephony/twilio-adapter.ts` (no behavior change
    expected; if `sttHintsResolver` is now always wired in app
    composition, keep the lazily-built fallback for other constructors —
    do NOT delete it unless a grep shows no remaining constructor site
    relies on it, per the dead-code rule)
  - `packages/api/test/telephony/` adapter test (extend the existing
    Gather-hints test to pin that a wired `sttHintsResolver` is preferred
    and hit once per turn)
- **Approach:** in app.ts, wire
  `sttHintsResolver: (tenantId) => transcriptionGlossaryProvider.termsForTenant(tenantId)`.
  The resolver seam already exists and is preferred over the fallback, so
  this is composition-only. Note app.ts currently builds the provider
  unconditionally but only hands it to the worker when the real gateway
  exists — the hints path has no LLM dependency, so wire the resolver
  unconditionally.
- **Patterns to follow:** existing dep wiring in app.ts around
  `createTwilioAdapter`/`createTranscriptionWorker` (lines ~1620-1660).
- **Test scenarios:**
  - Adapter prefers the wired resolver over building its own provider
    (existing test likely covers preference; extend for per-turn count).
  - App-level composition: hints still appear in Gather TwiML when only
    repos (no AI key) are configured — pins the "no LLM dependency"
    decision.
- **Verification:** in-memory boot (packages/api:verify) with no AI key:
  `/voice` inbound TwiML still carries `hints=` from seeded tenant data;
  transcription worker behavior unchanged.

## Risks & Dependencies
- **Staleness:** a newly added customer/catalog item won't bias STT for up
  to 5 minutes. Acceptable for hint terms; called out in the provider doc
  comment.
- **Ordering churn:** if a pg method needs a new `ORDER BY`, confirm it
  matches the in-memory ordering so unit and integration tests agree.
- **PR #696 overlap:** this touches `twilio-adapter.ts` and `app.ts`,
  both active on `claude/voice-ai-improvements-rly3mt`. Build on that
  branch (or on main after #696 merges) — do not fork from stale main.

## Open Questions (deferred to implementation)
- Exact unit-test file paths for catalog/user repos (extend existing
  files; locate at implementation).
- Whether `pg-user.ts`/`pg-catalog-item.ts` already have a stable
  `ORDER BY` (grep showed none for LIMIT; ordering must be confirmed at
  implementation).
