# ADR P0-028 — Use PgQueue as the production work-queue backend (defer SQS)

## Status

Accepted — 2026-04-28.

## Context

The P0 audit listed `InMemoryQueue` in `app.ts` as a launch blocker and proposed
migrating to AWS SQS via the existing CDK `QueueStack`. While reviewing the
codebase for this story, we found:

- `packages/api/src/queues/pg-queue.ts` already exists, with `FOR UPDATE SKIP
  LOCKED` semantics and visibility-timeout-style reservation. It implements the
  same `Queue` interface as `InMemoryQueue`, so callers do not need to change.
- The current `app.ts` wires `InMemoryQueue` unconditionally, ignoring
  `PgQueue` even when a Postgres pool is available. This is the actual launch
  blocker — not the absence of SQS.
- No production traffic is hitting SQS today; no caller depends on
  SQS-specific semantics (FIFO ordering, message attributes, cross-region
  replication, etc.).
- The CDK `QueueStack` is provisioned but unused. Wiring it up would require
  IAM, env-var plumbing, and a new `SqsQueue` adapter — meaningful infra work
  with no user-visible benefit at our current scale.

In short: the audit conflated "Pg-backed work queue" with "SQS-backed work
queue." Both solve the durability problem that `InMemoryQueue` does not.
PgQueue is already written.

## Decision

Adopt `PgQueue` as the **production default** when a Postgres pool is
configured. Keep `InMemoryQueue` as the dev-only fallback for local
development without Postgres.

Defer the `SqsQueue` implementation until at least one of these triggers
fires:

1. Sustained queue depth >10 000 messages OR p95 enqueue latency >50 ms.
2. Need for cross-region durability or fan-out semantics.
3. Need for fully managed retry / DLQ semantics that PgQueue cannot match
   (e.g. exponential backoff with jitter at the broker level, or
   long-polling consumers across regions).

## Consequences

### Positive

- **Zero new infrastructure to operate.** No SQS wiring, no IAM policies, no
  CDK changes for this story. The existing `QueueStack` stays unused (and
  costs nothing while idle).
- **Single transactional system.** Work-queue state and entity state live in
  the same Postgres database, so we can enqueue work in the same transaction
  that writes the entity. No risk of "message processed but DB write failed"
  inconsistencies, and no two-phase-commit dance.
- **Multi-worker safety natively.** `FOR UPDATE SKIP LOCKED` on the dequeue
  path means N workers can poll the same table without coordination and never
  double-process a message.
- **Cheaper at our scale.** SQS charges per-message (and per-API-call for
  long-polling consumers). PgQueue is essentially free above the existing
  Postgres baseline.
- **Simpler local dev.** Developers already need Postgres for the rest of the
  stack; they don't also need LocalStack or a real SQS endpoint to exercise
  background work.

### Negative

- **Postgres table bloat.** PgQueue queue depth growth contributes to table
  bloat — `VACUUM` / archive policy needs to be in place. Mitigation: add a
  daily worker that deletes completed messages older than 7 days (see
  Implementation, item 2).
- **Single point of failure.** If Postgres is down, the queue is down. SQS
  would survive a brief Postgres outage; PgQueue obviously cannot. This is an
  acceptable trade-off because every other critical path in the API also
  requires Postgres — the queue is not uniquely vulnerable.
- **Future migration cost.** If a trigger above fires, swapping to SQS is
  non-trivial: we'd need an `SqsQueue` adapter, IAM/env wiring, and a
  cut-over plan that drains in-flight PgQueue messages. This cost is
  acceptable because the `Queue` interface already abstracts the backend, so
  callers stay unchanged.

## Implementation

1. **P0-023 (Wave 1C) wires the selection.** That story will swap `app.ts` to
   wire `pool ? new PgQueue(pool) : new InMemoryQueue()`. **No code in this
   story.**
2. **Add follow-up story P0-035: `pg_queue_cleanup` worker.** Schedules a
   daily job that deletes processed/failed messages older than 7 days, to
   prevent table bloat. This is a small worker, not a schema change.
3. **`InMemoryQueue` stays in the codebase.** It remains the test-suite
   default and the local-dev fallback when no `DATABASE_URL` is set. No
   deprecation.
4. **Monitoring.** Add a queue-depth gauge and a p95-enqueue-latency
   histogram (both already trivial against Postgres) so we can see the
   trigger thresholds before they become incidents.

## Alternatives considered

- **Full SQS implementation today.** Rejected — meaningful infra work
  (CDK output wiring, IAM, env vars, new adapter, LocalStack for dev) for no
  current load benefit. Revisit at the trigger thresholds above.
- **Redis Streams (e.g. via Upstash).** Rejected — adds another paid SaaS to
  the stack with no clear win over PgQueue at our scale, and reintroduces the
  "enqueue succeeded but DB write failed" inconsistency window.
- **Keep `InMemoryQueue` in production.** Rejected — message loss on every
  process restart is unacceptable for proposals and the audit chain.
- **Hybrid (PgQueue for transactional work, SQS for fan-out).** Rejected for
  now because we have no fan-out use case. Reconsider if/when one appears.

## Revisit triggers

- Queue-depth alarm fires (10 000+ messages stuck, or sustained growth that
  outpaces worker throughput).
- A P0 outage where PgQueue and Postgres go down together and we wish we had
  cross-AZ SQS durability.
- Anyone proposes a new use case that requires FIFO ordering, fan-out, or
  cross-region durability.
- Per-message Postgres cost (storage + VACUUM overhead) exceeds the
  equivalent SQS bill.

## References

- `packages/api/src/queues/pg-queue.ts` — existing PgQueue implementation
  using `FOR UPDATE SKIP LOCKED`.
- `packages/api/src/queues/in-memory-queue.ts` — dev/test fallback.
- Wave 1C story `P0-023` — wires the queue selection in `app.ts`.
- `docs/superpowers/contracts/p0-dispatch-addendum.md` — coordinator block
  for P0-028 that re-scoped this story to a docs-only ADR.
- `infra/` CDK `QueueStack` — provisioned but intentionally unused under this
  decision.
