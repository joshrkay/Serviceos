/**
 * WS11 — transactional audited-command runner.
 *
 * "All mutations emit audit events" was a convention developers had to
 * remember; this module makes it structural for agent-driven state changes:
 * `executeAudited` runs the state change AND its audit-event insert inside ONE
 * tenant-scoped Postgres transaction, so they commit or abort together. A
 * state change literally cannot commit without its audit row — and the audit
 * descriptor is a required parameter, so a call site cannot compile without
 * declaring one.
 *
 * The transaction primitive is DATA-31's (extracted verbatim from
 * ProposalExecutor.runInProposalTransaction): a caller-owned connection —
 * typically the idempotency advisory lock's own client, whose lifecycle
 * (unlock + release) the lock provider owns — gets BEGIN / SET LOCAL tenant
 * context / COMMIT-or-ROLLBACK, and the callback runs inside
 * `tenantContextStore` so every PgBaseRepository call (including
 * PgAuditRepository.create) reuses THIS client and joins the one transaction.
 */
import type { PoolClient } from 'pg';
import { applyTenantContext } from '../db/rls-runtime-role';
import { tenantContextStore } from '../middleware/tenant-context';
import {
  AuditEventInput,
  AuditRepository,
  createAuditEvent,
} from '../audit/audit';

/**
 * Run `fn` inside a single tenant-scoped transaction on the supplied,
 * caller-owned connection (NOT released here — the owner's `finally` does
 * that). Sets the tenant GUC with `SET LOCAL` (auto-reset at COMMIT/ROLLBACK —
 * PgBouncer transaction-pooling safe) and runs `fn` inside
 * `tenantContextStore`, so repository calls made by `fn` join this
 * transaction. COMMIT on success, ROLLBACK on any throw.
 *
 * `client === null/undefined` (no real lock connection: no-op lock provider,
 * in-memory repos, single-threaded tests) runs `fn` directly — there is no
 * transaction to open, matching the executor's pre-existing Path C semantics.
 */
export async function runInTenantTransaction<T>(
  client: PoolClient | null | undefined,
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!client) {
    return fn();
  }
  await client.query('BEGIN');
  try {
    await applyTenantContext(client, tenantId, { transactional: true });
    const result = await tenantContextStore.run({ client, tenantId }, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Best-effort: surface the original error. If the connection is broken
      // the owner (e.g. the idempotency lock provider) destroys it on release,
      // which aborts the transaction server-side.
    }
    throw err;
  }
}

export interface AuditedCommand<T> {
  /** The caller-owned transaction connection (see runInTenantTransaction). */
  client: PoolClient | null | undefined;
  tenantId: string;
  auditRepo: AuditRepository;
  /** The state change. Repository calls inside it join the transaction. */
  stateChange: () => Promise<T>;
  /**
   * Required audit descriptor — the structural guarantee. Computed AFTER the
   * state change (so it can reference its result) and inserted with the SAME
   * client before COMMIT. Return an array to write several rows atomically.
   */
  audit: (result: T) => AuditEventInput | AuditEventInput[];
}

/**
 * Execute a state change and its audit event(s) in one atomic unit. Any
 * failure — in the state change OR the audit insert — rolls back both.
 */
export async function executeAudited<T>(command: AuditedCommand<T>): Promise<T> {
  return runInTenantTransaction(command.client, command.tenantId, async () => {
    const result = await command.stateChange();
    const inputs = command.audit(result);
    for (const input of Array.isArray(inputs) ? inputs : [inputs]) {
      await command.auditRepo.create(createAuditEvent(input));
    }
    return result;
  });
}
