import { describe, it, expect } from 'vitest';
import {
  buildInvoicePhoto,
  InMemoryInvoicePhotoRepository,
  isValidJobPhotoCategory,
  JOB_PHOTO_CATEGORIES,
  type CreateInvoicePhotoInput,
} from '../../src/invoices/invoice-photo';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';

function input(overrides: Partial<CreateInvoicePhotoInput> = {}): CreateInvoicePhotoInput {
  return {
    tenantId: TENANT,
    invoiceId: 'inv-1',
    uploadedByUserId: 'user-1',
    fileId: 'file-1',
    category: 'before',
    ...overrides,
  };
}

describe('buildInvoicePhoto', () => {
  it('builds a photo with a generated id, createdAt, and clientVisible defaulting to false', () => {
    const photo = buildInvoicePhoto(input());
    expect(photo.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(photo.tenantId).toBe(TENANT);
    expect(photo.invoiceId).toBe('inv-1');
    expect(photo.category).toBe('before');
    expect(photo.clientVisible).toBe(false);
    expect(photo.createdAt).toBeInstanceOf(Date);
    expect(photo.notes).toBeUndefined();
    expect(photo.takenAt).toBeUndefined();
  });

  it('carries through notes, takenAt, and an explicit clientVisible', () => {
    const takenAt = new Date('2026-05-01T10:00:00.000Z');
    const photo = buildInvoicePhoto(
      input({ notes: 'cracked pipe', takenAt, clientVisible: true, category: 'problem' }),
    );
    expect(photo.notes).toBe('cracked pipe');
    expect(photo.takenAt).toBe(takenAt);
    expect(photo.clientVisible).toBe(true);
    expect(photo.category).toBe('problem');
  });

  it('generates unique ids across calls', () => {
    expect(buildInvoicePhoto(input()).id).not.toBe(buildInvoicePhoto(input()).id);
  });
});

describe('isValidJobPhotoCategory (re-exported)', () => {
  it('accepts every catalog category and rejects unknowns', () => {
    for (const c of JOB_PHOTO_CATEGORIES) {
      expect(isValidJobPhotoCategory(c)).toBe(true);
    }
    expect(isValidJobPhotoCategory('not-a-category')).toBe(false);
    expect(isValidJobPhotoCategory('')).toBe(false);
  });
});

describe('InMemoryInvoicePhotoRepository', () => {
  it('create returns a detached copy (mutating the result does not affect the store)', async () => {
    const repo = new InMemoryInvoicePhotoRepository();
    const created = await repo.create(input({ notes: 'orig' }));
    created.notes = 'mutated';
    const fetched = await repo.findById(TENANT, created.id);
    expect(fetched?.notes).toBe('orig');
  });

  it('findById returns the photo for its tenant, null for a different tenant, and null when missing', async () => {
    const repo = new InMemoryInvoicePhotoRepository();
    const created = await repo.create(input());
    expect((await repo.findById(TENANT, created.id))?.id).toBe(created.id);
    expect(await repo.findById(OTHER_TENANT, created.id)).toBeNull();
    expect(await repo.findById(TENANT, 'missing')).toBeNull();
  });

  it('listByInvoice returns only this tenant + invoice photos, newest first', async () => {
    const repo = new InMemoryInvoicePhotoRepository();
    const a = await repo.create(input({ invoiceId: 'inv-1' }));
    const b = await repo.create(input({ invoiceId: 'inv-1' }));
    await repo.create(input({ invoiceId: 'inv-2' })); // different invoice
    await repo.create(input({ tenantId: OTHER_TENANT, invoiceId: 'inv-1' })); // different tenant

    const rows = await repo.listByInvoice(TENANT, 'inv-1');
    const ids = rows.map((r) => r.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    // sorted by createdAt desc — verify it is a non-increasing sequence
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(rows[i].createdAt.getTime());
    }
  });

  it('delete removes only this tenant’s photo and reports success/failure', async () => {
    const repo = new InMemoryInvoicePhotoRepository();
    const created = await repo.create(input());
    expect(await repo.delete(OTHER_TENANT, created.id)).toBe(false); // wrong tenant
    expect(await repo.delete(TENANT, 'missing')).toBe(false); // missing
    expect(await repo.delete(TENANT, created.id)).toBe(true);
    expect(await repo.findById(TENANT, created.id)).toBeNull();
  });

  it('updateClientVisible flips the flag for its tenant and returns null otherwise', async () => {
    const repo = new InMemoryInvoicePhotoRepository();
    const created = await repo.create(input({ clientVisible: false }));

    expect(await repo.updateClientVisible(OTHER_TENANT, created.id, true)).toBeNull();
    expect(await repo.updateClientVisible(TENANT, 'missing', true)).toBeNull();

    const updated = await repo.updateClientVisible(TENANT, created.id, true);
    expect(updated?.clientVisible).toBe(true);
    expect((await repo.findById(TENANT, created.id))?.clientVisible).toBe(true);
  });
});
