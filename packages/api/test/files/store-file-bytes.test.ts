import { describe, it, expect, vi } from 'vitest';
import {
  storeFileBytes,
  InMemoryFileRepository,
  StorageProvider,
} from '../../src/files/file-service';

function fakeStorage(): StorageProvider & { puts: Array<{ key: string; bytes: Buffer; ct: string }> } {
  const puts: Array<{ key: string; bytes: Buffer; ct: string }> = [];
  return {
    puts,
    generateUploadUrl: async () => 'url',
    generateDownloadUrl: async () => 'url',
    getObjectMetadata: async () => null,
    deleteObject: async () => {},
    putObject: async (_bucket, key, body, ct) => {
      puts.push({ key, bytes: body, ct });
    },
  };
}

describe('storeFileBytes', () => {
  it('validates, uploads the bytes, and persists a file row', async () => {
    const fileRepo = new InMemoryFileRepository();
    const storage = fakeStorage();
    const bytes = Buffer.from('JPEGDATA');

    const record = await storeFileBytes(
      {
        tenantId: 't-1',
        filename: 'photo.jpg',
        buffer: bytes,
        contentType: 'image/jpeg',
        uploadedBy: 'tech-1',
        entityType: 'job',
        entityId: 'job-1',
      },
      { fileRepo, storage, bucket: 'media' },
    );

    expect(record.id).toBeTruthy();
    expect(record.sizeBytes).toBe(bytes.length);
    expect(record.storageBucket).toBe('media');
    expect(record.entityId).toBe('job-1');
    // Bytes were uploaded under the record's key.
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0].key).toBe(record.storageKey);
    expect(storage.puts[0].bytes.equals(bytes)).toBe(true);
    // Row is persisted + retrievable.
    expect(await fileRepo.findById('t-1', record.id)).not.toBeNull();
  });

  it('throws on a disallowed content-type (no upload, no row)', async () => {
    const fileRepo = new InMemoryFileRepository();
    const storage = fakeStorage();
    await expect(
      storeFileBytes(
        { tenantId: 't-1', filename: 'x.exe', buffer: Buffer.from('x'), contentType: 'application/x-msdownload', uploadedBy: 'u' },
        { fileRepo, storage, bucket: 'media' },
      ),
    ).rejects.toThrow(/Invalid file upload/);
    expect(storage.puts).toHaveLength(0);
  });

  it('throws when the storage provider cannot accept server-side bytes', async () => {
    const fileRepo = new InMemoryFileRepository();
    const storage: StorageProvider = {
      generateUploadUrl: async () => 'u',
      generateDownloadUrl: async () => 'u',
      getObjectMetadata: async () => null,
      deleteObject: async () => {},
      // no putObject
    };
    await expect(
      storeFileBytes(
        { tenantId: 't-1', filename: 'p.jpg', buffer: Buffer.from('x'), contentType: 'image/jpeg', uploadedBy: 'u' },
        { fileRepo, storage, bucket: 'media' },
      ),
    ).rejects.toThrow(/server-side putObject/);
  });

  it('does not persist a file row if the upload fails', async () => {
    const fileRepo = new InMemoryFileRepository();
    const createSpy = vi.spyOn(fileRepo, 'create');
    const storage: StorageProvider = {
      generateUploadUrl: async () => 'u',
      generateDownloadUrl: async () => 'u',
      getObjectMetadata: async () => null,
      deleteObject: async () => {},
      putObject: async () => {
        throw new Error('storage down');
      },
    };
    await expect(
      storeFileBytes(
        { tenantId: 't-1', filename: 'p.jpg', buffer: Buffer.from('x'), contentType: 'image/jpeg', uploadedBy: 'u' },
        { fileRepo, storage, bucket: 'media' },
      ),
    ).rejects.toThrow(/storage down/);
    expect(createSpy).not.toHaveBeenCalled();
  });
});
