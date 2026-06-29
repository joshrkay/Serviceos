import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgJobFormRepository } from '../../src/job-forms/pg-job-form';
import {
  createJobFormSubmission,
  createJobFormTemplate,
  updateJobFormSubmission,
  updateJobFormTemplate,
} from '../../src/job-forms/job-form';
import type { Job } from '../../src/jobs/job';

async function seedJob(
  pool: Pool,
  tenantId: string,
  userId: string,
  jobs: PgJobRepository
): Promise<string> {
  const customers = new PgCustomerRepository(pool);
  const locations = new PgLocationRepository(pool);
  const customerId = crypto.randomUUID();
  await customers.create({
    id: customerId,
    tenantId,
    firstName: 'Form',
    lastName: 'Customer',
    displayName: 'Form Customer',
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    createdBy: userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const locationId = crypto.randomUUID();
  await locations.create({
    id: locationId,
    tenantId,
    customerId,
    street1: '5 Maple',
    city: 'Akron',
    state: 'OH',
    postalCode: '44301',
    country: 'USA',
    isPrimary: true,
    addressType: 'service',
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const job: Job = {
    id: crypto.randomUUID(),
    tenantId,
    customerId,
    locationId,
    jobNumber: `JOB-${Math.floor(Math.random() * 1_000_000)}`,
    summary: 'Furnace tune-up',
    status: 'new',
    priority: 'normal',
    createdBy: userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return (await jobs.create(job)).id;
}

describe('Postgres integration — job forms & checklists (migration 221)', () => {
  let pool: Pool;
  let forms: PgJobFormRepository;
  let jobs: PgJobRepository;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    forms = new PgJobFormRepository(pool);
    jobs = new PgJobRepository(pool);
    tenant = await createTestTenant(pool);
    jobId = await seedJob(pool, tenant.tenantId, tenant.userId, jobs);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists a template with its typed fields as real columns', async () => {
    const tpl = await createJobFormTemplate(
      {
        tenantId: tenant.tenantId,
        name: 'Furnace Tune-Up',
        description: 'Annual maintenance checklist',
        fields: [
          { label: 'Filter replaced', fieldType: 'checkbox', required: true },
          { label: 'Tier', fieldType: 'select', options: ['gold', 'silver'] },
        ],
        createdBy: tenant.userId,
      },
      forms
    );

    // Pin the real columns (the in-memory repo can't catch a column typo).
    const { rows } = await pool.query(
      `SELECT tenant_id, name, description, sort_order, is_archived,
              jsonb_array_length(fields) AS field_count
         FROM job_form_templates WHERE id = $1`,
      [tpl.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenant.tenantId);
    expect(rows[0].name).toBe('Furnace Tune-Up');
    expect(rows[0].description).toBe('Annual maintenance checklist');
    expect(rows[0].is_archived).toBe(false);
    expect(Number(rows[0].field_count)).toBe(2);

    const reloaded = await forms.findTemplateById(tenant.tenantId, tpl.id);
    expect(reloaded!.fields[0].fieldType).toBe('checkbox');
    expect(reloaded!.fields[1].options).toEqual(['gold', 'silver']);
  });

  it('creates, fills and completes a submission attached to a job', async () => {
    const tpl = await createJobFormTemplate(
      {
        tenantId: tenant.tenantId,
        name: 'Safety',
        fields: [{ label: 'Serial', required: true }],
        createdBy: tenant.userId,
      },
      forms
    );
    const fieldId = tpl.fields[0].id;

    const sub = await createJobFormSubmission(
      { tenantId: tenant.tenantId, jobId, templateId: tpl.id, createdBy: tenant.userId },
      forms
    );
    expect(sub.status).toBe('draft');

    const completed = await updateJobFormSubmission(
      tenant.tenantId,
      sub.id,
      { answers: [{ fieldId, value: 'SN-9001' }], complete: true },
      forms,
      tenant.userId
    );
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBeInstanceOf(Date);

    const { rows } = await pool.query(
      `SELECT job_id, template_id, template_name, status, completed_by,
              answers->0->>'value' AS first_answer
         FROM job_form_submissions WHERE id = $1`,
      [sub.id]
    );
    expect(rows[0].job_id).toBe(jobId);
    expect(rows[0].template_id).toBe(tpl.id);
    expect(rows[0].template_name).toBe('Safety');
    expect(rows[0].status).toBe('completed');
    expect(rows[0].completed_by).toBe(tenant.userId);
    expect(rows[0].first_answer).toBe('SN-9001');

    const forJob = await forms.listSubmissionsByJob(tenant.tenantId, jobId);
    expect(forJob.map((s) => s.id)).toContain(sub.id);
  });

  it('snapshots template fields so a later template edit does not change history', async () => {
    const tpl = await createJobFormTemplate(
      {
        tenantId: tenant.tenantId,
        name: 'Snapshot',
        fields: [{ label: 'Step 1', fieldType: 'checkbox' }],
        createdBy: tenant.userId,
      },
      forms
    );
    const sub = await createJobFormSubmission(
      { tenantId: tenant.tenantId, jobId, templateId: tpl.id, createdBy: tenant.userId },
      forms
    );

    await updateJobFormTemplate(
      tenant.tenantId,
      tpl.id,
      { fields: [{ label: 'Step 1 RENAMED', fieldType: 'text' }] },
      forms
    );

    const reloaded = await forms.findSubmissionById(tenant.tenantId, sub.id);
    expect(reloaded!.fields[0].label).toBe('Step 1');
    expect(reloaded!.fields[0].fieldType).toBe('checkbox');
  });

  it('does not leak templates or submissions across tenants (RLS)', async () => {
    const tpl = await createJobFormTemplate(
      { tenantId: tenant.tenantId, name: 'Secret', fields: [{ label: 'A' }], createdBy: tenant.userId },
      forms
    );
    const other = await createTestTenant(pool);
    expect(await forms.findTemplateById(other.tenantId, tpl.id)).toBeNull();
    expect(await forms.listTemplates(other.tenantId)).toEqual([]);
    expect(await forms.listSubmissionsByJob(other.tenantId, jobId)).toEqual([]);
  });
});
