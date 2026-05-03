# Phase 14 (Inventory + Parts) — Multi-Agent Dispatch Addendum

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 14A | P14-001 | single agent (foundational schema) | unlocks 14B |
| 14B | P14-002, P14-003 | parallel | sprint complete |

## Migration ledger

- 070: P14-001 `inventory_items` + `inventory_locations` + `inventory_transactions`
- 071: P14-002 `job_parts` (new migration; P14-002 reserves at dispatch time)
- P14-003: no migration

---

## P14-001 — Inventory ledger

**Wave:** 14A
**Migration number reserved:** 070
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/catalog/**` (READ ONLY — extend via FK only)
- `packages/api/src/jobs/**` (READ ONLY — job_id is FK only)
- `packages/api/src/notifications/**` (READ ONLY — call existing send-service)

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "inventory|stock|low-stock|P14-001") && \
  (cd packages/web && npm test -- --run -t "Inventory|P14-001")
```

**Risk note:**
- **Stock-on-hand computation**: SUM-based; cache if N transactions per item exceeds 10k (defer until then).
- **Atomic transfer**: both legs in one DB transaction; use `withTenantTransaction()`.
- **Low-stock alert dedup**: 24-hour window per item; in-memory v1.

**Implementation hints:**
1. Mirror `packages/api/src/agreements/agreement-run.ts` for the multi-table repo pattern.
2. Worker pattern: mirror `packages/api/src/workers/recurring-agreements-worker.ts`.

---

## P14-002 — Parts-used-per-job

**Wave:** 14B
**Migration number reserved:** 071 (verify free at dispatch time)
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/inventory/**` (READ ONLY — call inventory service)
- `packages/api/src/jobs/job.ts` (interface — do NOT modify)
- `packages/api/src/invoices/**` (READ ONLY — call invoice service to add line items)

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "job-parts|P14-002") && \
  (cd packages/web && npm test -- --run -t "JobParts|P14-002")
```

**Risk note:**
- **Atomic add**: job_parts row + inventory_transaction in one DB transaction.
- **Stock availability check**: before deduction, query stock; reject if insufficient (return 409).
- **Invoice line item**: only add if job has an open (non-paid) invoice. If no invoice, just record the parts; line item added at invoice creation.

---

## P14-003 — Voice skill lookup_part_availability

**Wave:** 14B
**Migration number reserved:** none
**Forbidden files:**
- `packages/api/src/inventory/**` (READ ONLY)
- `packages/shared/**`
- `packages/api/src/ai/agents/**` (FSM is pure — do NOT modify)

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "lookup-part|part-availability|P14-003")
```

**Risk note:**
- **Fuzzy match**: use ILIKE %query% as v1; pg_trgm if available.
- **Voice clarification flow**: if 2+ candidates, return clarification request rather than guessing.
- **Intent prompt size**: Phase 11 already added 6 lookup intents; this is the 7th. Keep prompt example block tight.
