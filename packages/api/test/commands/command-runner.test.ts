/**
 * WS11 — audited-command runner unit tests.
 *
 * Proves the structural guarantee at the wrapper level: the state change and
 * its audit-event insert share ONE transaction, so a failure in EITHER rolls
 * back BOTH. The compile-time half of the guarantee (an audited command
 * cannot be declared without an audit descriptor) is pinned by the
 * @ts-expect-error cases at the bottom — this file is type-checked by tsc.
 */
import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import {
  executeAudited,
  runInTenantTransaction,
} from '../../src/commands/command-runner';
import {
  AuditEvent,
  AuditEventInput,
  AuditRepository,
  InMemoryAuditRepository,
} from '../../src/audit/audit';

const TENANT = '11111111-1111-1111-1111-111111111111';

/** Records only the transaction-control statements the runner issues. */
class RecordingClient {
  public readonly events: string[] = [];
  async query(sql: unknown): Promise<{ rows: unknown[] }> {
    if (typeof sql === 'string') {
      const s = sql.trim().toUpperCase();
      if (s.startsWith('BEGIN')) this.events.push('BEGIN');
      else if (s.startsWith('COMMIT')) this.events.push('COMMIT');
      else if (s.startsWith('ROLLBACK')) this.events.push('ROLLBACK');
    }
    return { rows: [] };
  }
  release(): void {
    /* no-op */
  }
}

function asPoolClient(client: RecordingClient): PoolClient {
  return client as unknown as PoolClient;
}

function auditInput(): AuditEventInput {
  return {
    tenantId: TENANT,
    actorId: 'user-1',
    actorRole: 'system',
    eventType: 'proposal.executed',
    entityType: 'proposal',
    entityId: 'proposal-1',
    metadata: { proposalType: 'create_customer', status: 'executed' },
  };
}

class ThrowingAuditRepository extends InMemoryAuditRepository {
  async create(): Promise<AuditEvent> {
    throw new Error('audit insert failed');
  }
}

describe('runInTenantTransaction', () => {
  it('commits on success', async () => {
    const client = new RecordingClient();
    const result = await runInTenantTransaction(asPoolClient(client), TENANT, async () => 42);
    expect(result).toBe(42);
    expect(client.events).toEqual(['BEGIN', 'COMMIT']);
  });

  it('rolls back and rethrows when the callback throws', async () => {
    const client = new RecordingClient();
    await expect(
      runInTenantTransaction(asPoolClient(client), TENANT, async () => {
        throw new Error('state change failed');
      }),
    ).rejects.toThrow('state change failed');
    expect(client.events).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('runs the callback directly with no client (no transaction to open)', async () => {
    const result = await runInTenantTransaction(null, TENANT, async () => 'direct');
    expect(result).toBe('direct');
  });
});

describe('executeAudited', () => {
  it('happy path: state change and audit row commit together', async () => {
    const client = new RecordingClient();
    const auditRepo = new InMemoryAuditRepository();
    let stateChanged = false;

    const result = await executeAudited({
      client: asPoolClient(client),
      tenantId: TENANT,
      auditRepo,
      stateChange: async () => {
        stateChanged = true;
        return 'entity-1';
      },
      audit: (entityId) => ({ ...auditInput(), entityId }),
    });

    expect(result).toBe('entity-1');
    expect(stateChanged).toBe(true);
    expect(client.events).toEqual(['BEGIN', 'COMMIT']);
    const rows = auditRepo.getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBe('entity-1');
    expect(rows[0].eventType).toBe('proposal.executed');
  });

  it('rolls back the state change when the audit insert throws', async () => {
    const client = new RecordingClient();
    let stateChanged = false;

    await expect(
      executeAudited({
        client: asPoolClient(client),
        tenantId: TENANT,
        auditRepo: new ThrowingAuditRepository(),
        stateChange: async () => {
          stateChanged = true;
        },
        audit: () => auditInput(),
      }),
    ).rejects.toThrow('audit insert failed');

    // The state change RAN, but its transaction was rolled back — nothing
    // committed without the audit row.
    expect(stateChanged).toBe(true);
    expect(client.events).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('rolls back and never writes the audit row when the state change throws', async () => {
    const client = new RecordingClient();
    const auditRepo = new InMemoryAuditRepository();

    await expect(
      executeAudited({
        client: asPoolClient(client),
        tenantId: TENANT,
        auditRepo,
        stateChange: async () => {
          throw new Error('state change failed');
        },
        audit: () => auditInput(),
      }),
    ).rejects.toThrow('state change failed');

    expect(auditRepo.getAll()).toHaveLength(0);
    expect(client.events).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('writes every descriptor when audit returns an array', async () => {
    const auditRepo = new InMemoryAuditRepository();
    await executeAudited({
      client: null,
      tenantId: TENANT,
      auditRepo,
      stateChange: async () => undefined,
      audit: () => [
        auditInput(),
        { ...auditInput(), eventType: 'proposal.execution_failed' },
      ],
    });
    expect(auditRepo.getAll().map((e) => e.eventType)).toEqual([
      'proposal.executed',
      'proposal.execution_failed',
    ]);
  });

  it('no client: audit failure still surfaces (never swallowed)', async () => {
    await expect(
      executeAudited({
        client: null,
        tenantId: TENANT,
        auditRepo: new ThrowingAuditRepository(),
        stateChange: async () => undefined,
        audit: () => auditInput(),
      }),
    ).rejects.toThrow('audit insert failed');
  });
});

// ---------------------------------------------------------------------------
// Compile-time refusal (WS11): an audited command cannot be declared without
// its audit descriptor or repository. tsc checks these; a regression that
// makes either optional turns the @ts-expect-error lines into compile errors.
// ---------------------------------------------------------------------------
declare const someAuditRepo: AuditRepository;

async function typeLevelRefusals(): Promise<void> {
  // @ts-expect-error audit descriptor is required (WS11)
  await executeAudited({
    client: null,
    tenantId: TENANT,
    auditRepo: someAuditRepo,
    stateChange: async () => undefined,
  });

  // @ts-expect-error audit repository is required (WS11)
  await executeAudited({
    client: null,
    tenantId: TENANT,
    stateChange: async () => undefined,
    audit: () => auditInput(),
  });
}
void typeLevelRefusals;
