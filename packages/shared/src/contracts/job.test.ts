import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JobPriority } from '../enums.js';
import { jobSchema, jobDetailResponseSchema, jobPrioritySchema, jobListItemSchema } from './job.js';
import { resolveDbCheckSet } from './db-check.js';

const schemaSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../api/src/db/schema.ts'),
  'utf8',
);

const baseJob = {
  id: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
  customerId: '33333333-3333-3333-3333-333333333333',
  locationId: '44444444-4444-4444-4444-444444444444',
  jobNumber: 'J-1001',
  summary: 'No heat on second floor',
  status: 'new',
  priority: 'normal',
  createdBy: 'user_abc',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

describe('jobSchema', () => {
  it('parses a representative job payload', () => {
    expect(jobSchema.parse(baseJob).jobNumber).toBe('J-1001');
  });

  it('reuses the canonical job status set — rejects the historical-drift value', () => {
    // 'created' was the old (wrong) shared-enum value; the DB uses 'new'.
    expect(jobSchema.safeParse({ ...baseJob, status: 'created' }).success).toBe(false);
    expect(jobSchema.safeParse({ ...baseJob, status: 'new' }).success).toBe(true);
  });

  it('accepts optional deposit + money-state fields', () => {
    const parsed = jobSchema.parse({
      ...baseJob,
      depositRequiredCents: 5000,
      depositStatus: 'pending',
      moneyState: 'estimate_sent',
    });
    expect(parsed.depositRequiredCents).toBe(5000);
  });

  it('jobPrioritySchema stays in lockstep with the JobPriority enum', () => {
    expect([...jobPrioritySchema.options].sort()).toEqual([...Object.values(JobPriority)].sort());
  });

  it('jobPrioritySchema equals the authoritative jobs.priority DB CHECK', () => {
    const dbSet = resolveDbCheckSet(schemaSource, 'jobs', 'priority');
    expect([...jobPrioritySchema.options].sort()).toEqual([...dbSet].sort());
  });
});

describe('jobListItemSchema', () => {
  it('validates an unenriched list row (no customer/technician)', () => {
    expect(jobListItemSchema.safeParse(baseJob).success).toBe(true);
  });

  it('accepts optional list enrichment', () => {
    const parsed = jobListItemSchema.parse({
      ...baseJob,
      customer: { id: baseJob.customerId, displayName: 'Acme Co' },
      technician: { id: 'tech-1', firstName: 'Sam', color: '#10b981' },
      scheduledStart: '2026-06-02T15:00:00.000Z',
      serviceType: 'HVAC',
    });
    expect(parsed.technician?.firstName).toBe('Sam');
  });
});

describe('jobDetailResponseSchema', () => {
  it('parses a job enriched with embedded customer + location', () => {
    const parsed = jobDetailResponseSchema.parse({
      ...baseJob,
      customer: {
        id: baseJob.customerId,
        displayName: 'Acme Co',
        locations: [{ id: baseJob.locationId, city: 'Portland', isPrimary: true }],
      },
      location: { id: baseJob.locationId, city: 'Portland', isPrimary: true },
    });
    expect(parsed.customer?.displayName).toBe('Acme Co');
    expect(parsed.location?.city).toBe('Portland');
  });
});
