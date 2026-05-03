/**
 * P12-001 — placeholder unit tests for the job-photo domain module.
 * Real route + integration coverage lives in test/jobs/job-photos.test.ts;
 * this file exercises the pure helpers + InMemory repo to catch
 * regressions in the value object surface.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryJobPhotoRepository,
  buildJobPhoto,
  isValidJobPhotoCategory,
  JOB_PHOTO_CATEGORIES,
} from '../job-photo';

const TENANT = '00000000-0000-4000-8000-000000000001';
const JOB = '00000000-0000-4000-8000-000000000002';

describe('P12-001 job-photo domain', () => {
  it('isValidJobPhotoCategory accepts every declared category', () => {
    for (const c of JOB_PHOTO_CATEGORIES) {
      expect(isValidJobPhotoCategory(c)).toBe(true);
    }
  });

  it('isValidJobPhotoCategory rejects junk', () => {
    expect(isValidJobPhotoCategory('wrong')).toBe(false);
    expect(isValidJobPhotoCategory(42)).toBe(false);
    expect(isValidJobPhotoCategory(undefined)).toBe(false);
  });

  it('buildJobPhoto stamps id + createdAt', () => {
    const photo = buildJobPhoto({
      tenantId: TENANT,
      jobId: JOB,
      uploadedByUserId: 'user-1',
      fileId: 'file-1',
      category: 'before',
    });
    expect(photo.id).toBeTruthy();
    expect(photo.createdAt).toBeInstanceOf(Date);
    expect(photo.category).toBe('before');
    expect(photo.notes).toBeUndefined();
  });

  it('InMemoryJobPhotoRepository round-trips a photo and isolates by tenant', async () => {
    const repo = new InMemoryJobPhotoRepository();
    const created = await repo.create({
      tenantId: TENANT,
      jobId: JOB,
      uploadedByUserId: 'user-1',
      fileId: 'file-1',
      category: 'after',
      notes: 'looks great',
    });

    const found = await repo.findById(TENANT, created.id);
    expect(found?.id).toBe(created.id);

    const otherTenant = await repo.findById('other-tenant', created.id);
    expect(otherTenant).toBeNull();

    const list = await repo.listByJob(TENANT, JOB);
    expect(list).toHaveLength(1);

    const removed = await repo.delete(TENANT, created.id);
    expect(removed).toBe(true);

    const afterDelete = await repo.findById(TENANT, created.id);
    expect(afterDelete).toBeNull();
  });
});
