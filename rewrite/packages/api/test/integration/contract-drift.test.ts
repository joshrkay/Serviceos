import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APPOINTMENT_STATUSES,
  ESTIMATE_STATUSES,
  INVOICE_STATUSES,
  JOB_STATUSES,
  PAYMENT_METHODS,
  PROPOSAL_SOURCES,
  PROPOSAL_STATUSES,
  PROPOSAL_TYPES,
  ROLES,
} from '@rivet/contracts';
import { createTestDb, type TestDb } from './helpers';

/**
 * Drift gate: the shared contract enums and the database CHECK constraints
 * must stay in lockstep. If either side changes unilaterally, this fails.
 */
describe('contract <-> schema drift', () => {
  let env: TestDb;

  beforeAll(async () => {
    env = await createTestDb();
  });

  afterAll(async () => {
    await env.destroy();
  });

  async function checkConstraint(table: string, column: string): Promise<string> {
    const { rows } = await env.db.admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = $1 AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%' || $2 || '%'`,
      [table, column],
    );
    return rows.map((row) => row.def).join('\n');
  }

  function expectExactEnum(def: string, values: readonly string[]): void {
    for (const value of values) {
      expect(def).toContain(`'${value}'`);
    }
    const quoted = def.match(/'[a-z_]+'/g) ?? [];
    const dbValues = new Set(quoted.map((v) => v.replace(/'/g, '')));
    for (const dbValue of dbValues) {
      expect(values).toContain(dbValue);
    }
  }

  it('job statuses match', async () => {
    expectExactEnum(await checkConstraint('jobs', 'status'), JOB_STATUSES);
  });

  it('appointment statuses match', async () => {
    expectExactEnum(await checkConstraint('appointments', 'status'), APPOINTMENT_STATUSES);
  });

  it('estimate statuses match', async () => {
    expectExactEnum(await checkConstraint('estimates', 'status'), ESTIMATE_STATUSES);
  });

  it('invoice statuses match', async () => {
    expectExactEnum(await checkConstraint('invoices', 'status'), INVOICE_STATUSES);
  });

  it('payment methods match', async () => {
    expectExactEnum(await checkConstraint('payments', 'method'), PAYMENT_METHODS);
  });

  it('proposal statuses, types and sources match', async () => {
    expectExactEnum(await checkConstraint('proposals', 'status'), PROPOSAL_STATUSES);
    expectExactEnum(await checkConstraint('proposals', 'type = ANY'), PROPOSAL_TYPES);
    expectExactEnum(await checkConstraint('proposals', 'source'), PROPOSAL_SOURCES);
  });

  it('user roles match', async () => {
    expectExactEnum(await checkConstraint('users', 'role'), ROLES);
  });
});
