import { describe, it, expect } from 'vitest';
import { MIGRATIONS } from '../../src/db/schema';

describe('Migration 141 — milestone billing safeguards', () => {
  const sql = MIGRATIONS['141_milestone_billing_safeguards'];

  it('is registered in MIGRATIONS', () => {
    expect(sql).toBeDefined();
  });

  it('creates the one-schedule-per-job and one-invoice-per-milestone unique indexes', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoice_schedules_job\s+ON invoice_schedules\(tenant_id, job_id\)/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoices_schedule_milestone\s+ON invoices\(schedule_id, milestone_index\)\s+WHERE schedule_id IS NOT NULL/,
    );
  });

  it('reconciles pre-existing duplicates BEFORE enforcing uniqueness', () => {
    const repoint = sql.indexOf('UPDATE invoices i\n    SET schedule_id = sv.survivor_id');
    const detach = sql.indexOf('UPDATE invoices i\n    SET schedule_id = NULL');
    const deleteDupes = sql.indexOf('DELETE FROM invoice_schedules s');
    const scheduleIndex = sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoice_schedules_job');
    const milestoneIndex = sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoices_schedule_milestone');

    // All three reconciliation steps are present...
    expect(repoint).toBeGreaterThan(-1);
    expect(detach).toBeGreaterThan(-1);
    expect(deleteDupes).toBeGreaterThan(-1);
    // ...and every one runs before BOTH unique indexes.
    expect(repoint).toBeLessThan(scheduleIndex);
    expect(detach).toBeLessThan(scheduleIndex);
    expect(deleteDupes).toBeLessThan(scheduleIndex);
    expect(deleteDupes).toBeLessThan(milestoneIndex);
  });

  it('keeps the survivor with the most invoices, then earliest', () => {
    expect(sql).toMatch(/ORDER BY tenant_id, job_id, inv_count DESC, created_at ASC, id ASC/);
  });

  it('detaches colliding invoices instead of deleting billing rows', () => {
    // The only DELETE targets invoice_schedules — never invoices. Collisions are
    // resolved by unlinking (schedule_id = NULL), preserving the invoice row.
    expect(sql).not.toMatch(/DELETE FROM invoices/);
    expect(sql).toMatch(/SET schedule_id = NULL/);
  });
});
