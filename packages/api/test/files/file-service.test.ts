import {
  validateUpload,
  createFileRecord,
  InMemoryFileRepository,
  UploadRequest,
} from '../../src/files/file-service';

describe('P0-010 — File upload and attachment storage', () => {
  const validRequest: UploadRequest = {
    tenantId: 'tenant-1',
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1024,
    uploadedBy: 'user-1',
  };

  it('happy path — validates a correct upload request', () => {
    const errors = validateUpload(validRequest);
    expect(errors).toHaveLength(0);
  });

  it('validation — rejects empty filename', () => {
    const errors = validateUpload({ ...validRequest, filename: '' });
    expect(errors).toContain('Filename is required');
  });

  it('validation — rejects invalid content type', () => {
    const errors = validateUpload({ ...validRequest, contentType: 'application/x-malware' });
    expect(errors.some((e) => e.includes('Content type not allowed'))).toBe(true);
  });

  it('validation — rejects oversized files', () => {
    const errors = validateUpload({ ...validRequest, sizeBytes: 200 * 1024 * 1024 });
    expect(errors.some((e) => e.includes('exceeds maximum'))).toBe(true);
  });

  it('validation — rejects missing tenantId', () => {
    const errors = validateUpload({ ...validRequest, tenantId: '' });
    expect(errors).toContain('Tenant ID is required');
  });

  it('happy path — creates file record with S3 key', () => {
    const record = createFileRecord(validRequest, 'my-bucket');
    expect(record.id).toBeTruthy();
    expect(record.s3Bucket).toBe('my-bucket');
    expect(record.s3Key).toContain('tenant-1/');
    expect(record.s3Key).toContain('photo.jpg');
  });

  it('happy path — repository stores and retrieves', async () => {
    const repo = new InMemoryFileRepository();
    const record = createFileRecord(validRequest, 'my-bucket');
    await repo.create(record);

    const found = await repo.findById('tenant-1', record.id);
    expect(found).not.toBeNull();
    expect(found!.filename).toBe('photo.jpg');
  });

  it('tenant isolation — cannot access other tenant files', async () => {
    const repo = new InMemoryFileRepository();
    const record = createFileRecord(validRequest, 'my-bucket');
    await repo.create(record);

    const found = await repo.findById('other-tenant', record.id);
    expect(found).toBeNull();
  });
});
