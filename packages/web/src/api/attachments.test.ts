import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachFileToEntity,
  listAttachments,
  pairAttachments,
  presignAttachmentUpload,
  uploadAttachment,
} from './attachments';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('attachments api client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('posts the presign payload shape expected by /api/attachments/presign', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ fileId: 'f1', uploadUrl: 'https://upload.test' }, 201));

    await expect(presignAttachmentUpload({
      entityType: 'estimate',
      entityId: 'e1',
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 123,
    })).resolves.toEqual({ fileId: 'f1', uploadUrl: 'https://upload.test' });

    expect(fetch).toHaveBeenCalledWith('/api/attachments/presign', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        entityType: 'estimate',
        entityId: 'e1',
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 123,
      }),
    }));
  });

  it('posts the attach payload shape', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ id: 'a1', fileId: 'f1' }, 201));

    await attachFileToEntity({
      fileId: 'f1',
      entityType: 'invoice',
      entityId: 'i1',
      kind: 'photo',
      caption: 'done',
      category: 'completion',
      source: 'app',
    });

    expect(fetch).toHaveBeenCalledWith('/api/attachments', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        fileId: 'f1',
        entityType: 'invoice',
        entityId: 'i1',
        kind: 'photo',
        caption: 'done',
        category: 'completion',
        source: 'app',
      }),
    }));
  });

  it('lists attachments by entity query params', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([]));
    await listAttachments('estimate', 'e1');
    expect(fetch).toHaveBeenCalledWith('/api/attachments?entityType=estimate&entityId=e1', expect.any(Object));
  });

  it('runs presign -> PUT -> attach in order', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ fileId: 'f1', uploadUrl: 'https://upload.test/file' }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ id: 'a1', fileId: 'f1' }, 201));

    const file = new File(['abc'], 'photo.jpg', { type: 'image/jpeg' });
    await uploadAttachment('estimate', 'e1', file, 'before', 'start');

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/attachments/presign', expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://upload.test/file', expect.objectContaining({
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': 'image/jpeg' },
    }));
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/attachments', expect.any(Object));
  });

  // #1122 — the technician's photo surface needs to reach the existing
  // before/after pairing endpoint (RV-005, POST /api/attachments/:id/pair).
  describe('pairAttachments', () => {
    it('posts { otherId, role } to /api/attachments/:id/pair', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse({ pairGroupId: 'g1', attachment: { id: 'a1' }, other: { id: 'a2' } }),
      );

      const result = await pairAttachments('a1', 'a2', 'before');

      expect(fetch).toHaveBeenCalledWith(
        '/api/attachments/a1/pair',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ otherId: 'a2', role: 'before' }),
        }),
      );
      expect(result.pairGroupId).toBe('g1');
    });

    it('throws when the pair request fails', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 404 }));
      await expect(pairAttachments('a1', 'a2', 'after')).rejects.toThrow('404');
    });
  });
});
