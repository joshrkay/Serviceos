/**
 * #1173 — resolveChatImageAttachments: an Assistant chat photo's fileId becomes
 * a presigned image URL ONLY when it is a readable image in the caller's own
 * tenant. The tenant-scoped repo lookup is the T1 seam (pinned at real
 * Postgres in test/integration/assistant-photo-estimate-draft.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryFileRepository,
  createFileRecord,
  type FileRecord,
} from '../../src/files/file-service';
import {
  MAX_CHAT_IMAGES,
  resolveChatImageAttachments,
} from '../../src/files/chat-image-attachments';

const A = 'tenant-a';
const B = 'tenant-b';

function record(tenantId: string, contentType = 'image/jpeg'): FileRecord {
  return createFileRecord(
    { tenantId, filename: 'photo.jpg', contentType, sizeBytes: 10, uploadedBy: 'u' },
    'bucket',
  );
}

async function setup() {
  const fileRepo = new InMemoryFileRepository();
  const storage = {
    generateDownloadUrl: vi.fn(async (bucket: string, key: string) => `https://s.test/${bucket}/${key}?sig=x`),
  };
  return { fileRepo, storage };
}

describe('#1173 — resolveChatImageAttachments', () => {
  it("presigns the caller's own image", async () => {
    const { fileRepo, storage } = await setup();
    const own = await fileRepo.create(record(A));

    const out = await resolveChatImageAttachments({ fileRepo, storage }, A, [{ fileId: own.id }]);

    expect(out.refused).toEqual([]);
    expect(out.images).toEqual([
      { url: `https://s.test/bucket/${own.storageKey}?sig=x`, contentType: 'image/jpeg', fileId: own.id },
    ]);
  });

  it("refuses another tenant's file and never presigns its key", async () => {
    const { fileRepo, storage } = await setup();
    const foreign = await fileRepo.create(record(B));

    const out = await resolveChatImageAttachments({ fileRepo, storage }, A, [{ fileId: foreign.id }]);

    expect(out.images).toEqual([]);
    expect(out.refused).toEqual([foreign.id]);
    expect(storage.generateDownloadUrl).not.toHaveBeenCalled();
  });

  it('refuses a non-image, a malformed id, and a lookup that throws', async () => {
    const { fileRepo, storage } = await setup();
    const pdf = await fileRepo.create(record(A, 'application/pdf'));
    const good = await fileRepo.create(record(A, 'image/PNG; charset=binary'));
    const throwingRepo = {
      findById: vi.fn(async (tenantId: string, id: string) => {
        if (id === good.id) return fileRepo.findById(tenantId, id);
        throw new Error('db down');
      }),
    };
    const brokenId = '11111111-1111-4111-8111-111111111111';

    const out = await resolveChatImageAttachments({ fileRepo: throwingRepo, storage }, A, [
      { fileId: pdf.id },
      { fileId: 'file-abc123' },
      { fileId: brokenId },
      { fileId: good.id },
    ]);

    expect(out.refused).toEqual([pdf.id, 'file-abc123', brokenId]);
    expect(out.images.map((i) => [i.fileId, i.contentType])).toEqual([[good.id, 'image/png']]);
  });

  it(`dedupes repeated ids and refuses photos past MAX_CHAT_IMAGES (${MAX_CHAT_IMAGES})`, async () => {
    const { fileRepo, storage } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < MAX_CHAT_IMAGES + 1; i += 1) ids.push((await fileRepo.create(record(A))).id);

    const out = await resolveChatImageAttachments(
      { fileRepo, storage },
      A,
      [ids[0]!, ...ids].map((fileId) => ({ fileId })),
    );

    expect(out.images).toHaveLength(MAX_CHAT_IMAGES);
    expect(out.refused).toEqual([ids[MAX_CHAT_IMAGES]]);
  });
});
