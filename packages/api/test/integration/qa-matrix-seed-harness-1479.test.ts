/**
 * #1479 item 5 (harness) — two QA-matrix seed fixes, at real Postgres through
 * the seed's exported ensureTenantFixture.
 *
 * 1. The VOX-13 ambiguous pair was seeded as `${slug}-ambiguous-1/2` (first
 *    name "QA"), so every "the QA Matrix job" utterance tied three customers
 *    and the resolver correctly refused to guess. #1322 renamed the pair to
 *    Riley/Rowan Twinsley but was closed unmerged; this ports it. Existing
 *    tenants migrate in place — never a third customer on the shared phone.
 *
 * 2. Repeated matrix runs text the same seeded customer, so the #1464
 *    per-recipient cap started refusing the matrix's own sends. The cap is
 *    product behaviour and stays; the harness instead gives each run its own
 *    recipient number by re-pointing the seeded customer's phone.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { getSharedTestDb } from './shared';
import { ensureTenantFixture } from '../../../../e2e/qa-matrix/fixtures/seed';

const AMBIGUOUS_PHONE = '555-0200';

describe('Postgres integration — QA matrix seed harness (#1479)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  async function namesOnPhone(tenantId: string, phone: string): Promise<string[]> {
    const { rows } = await pool.query(
      `SELECT display_name FROM customers WHERE tenant_id = $1 AND primary_phone = $2 ORDER BY display_name`,
      [tenantId, phone],
    );
    return rows.map((r) => r.display_name as string);
  }

  it('seeds the ambiguous pair as Riley/Rowan Twinsley — no "QA" or slug token', async () => {
    const slug = `qa-matrix-t1479-${randomUUID().slice(0, 8)}-A`;

    const fixture = await ensureTenantFixture(pool, slug);

    expect(await namesOnPhone(fixture.tenantId, AMBIGUOUS_PHONE)).toEqual([
      'Riley Twinsley',
      'Rowan Twinsley',
    ]);
  });

  it('migrates a tenant seeded with the old names in place — never a third customer on the shared phone', async () => {
    const slug = `qa-matrix-t1479-${randomUUID().slice(0, 8)}-B`;
    const fixture = await ensureTenantFixture(pool, slug);
    // Put the tenant back in its pre-rename state (what dev holds today).
    await pool.query(
      `UPDATE customers SET first_name = 'QA', last_name = 'ambiguous-1', display_name = $2
        WHERE tenant_id = $1 AND display_name = 'Riley Twinsley'`,
      [fixture.tenantId, `${slug}-ambiguous-1`],
    );
    await pool.query(
      `UPDATE customers SET first_name = 'QA', last_name = 'ambiguous-2', display_name = $2
        WHERE tenant_id = $1 AND display_name = 'Rowan Twinsley'`,
      [fixture.tenantId, `${slug}-ambiguous-2`],
    );

    await ensureTenantFixture(pool, slug);

    expect(await namesOnPhone(fixture.tenantId, AMBIGUOUS_PHONE)).toEqual([
      'Riley Twinsley',
      'Rowan Twinsley',
    ]);
  });

  it('a run can give the seeded customer its own recipient number; a re-seed moves the SAME customer', async () => {
    const slug = `qa-matrix-t1479-${randomUUID().slice(0, 8)}-A`;

    const defaulted = await ensureTenantFixture(pool, slug);
    expect(defaulted.customerPhone).toBe('555-0100');

    const run1 = await ensureTenantFixture(pool, slug, { customerPhone: '555-1101' });
    const run2 = await ensureTenantFixture(pool, slug, { customerPhone: '555-1102' });

    expect(run1.customerId).toBe(defaulted.customerId);
    expect(run2.customerId).toBe(defaulted.customerId);
    expect(run2.customerPhone).toBe('555-1102');
    // Exactly one customer answers to the run's number (callerPhone must resolve
    // to one match), and the previous run's number is released.
    expect(await namesOnPhone(defaulted.tenantId, '555-1102')).toEqual([`${slug}-customer`]);
    expect(await namesOnPhone(defaulted.tenantId, '555-1101')).toEqual([]);
  });
});
