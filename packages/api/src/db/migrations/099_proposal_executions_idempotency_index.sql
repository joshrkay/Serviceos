-- 099_proposal_executions_idempotency_index.sql
-- §11 H1: replace the O(n) in-process scan in IdempotencyGuard with an
-- indexed lookup keyed by (tenant_id, idempotency_key). The existing
-- inline index on (tenant_id, proposal_id, idempotency_key) is wider than
-- the guard's lookup — the guard doesn't know proposal_id up-front for a
-- replay — so it can't be used.
--
-- Source of truth is packages/api/src/db/schema.ts
-- MIGRATIONS['099_proposal_executions_idempotency_index'].
CREATE UNIQUE INDEX IF NOT EXISTS proposal_executions_tenant_idempotency_uniq
  ON proposal_executions (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
