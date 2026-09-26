/**
 * #1122 — JobPhotos page pairing wiring.
 *
 * The gallery only knows about JobPhoto rows (job_photos table); pairing
 * lives on the generalized `attachments` table (RV-005), which job-photo
 * uploads dual-write a shadow row into (same fileId). This page resolves
 * photo.fileId -> attachment id via the attachments list endpoint, then
 * calls POST /api/attachments/:id/pair.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { JobPhotos } from './JobPhotos';
import type { JobPhoto } from '../../api/job-photos';
import type { Attachment } from '../../api/attachments';

function makePhoto(overrides: Partial<JobPhoto> = {}): JobPhoto {
  return {
    id: 'p1',
    tenantId: 't1',
    jobId: 'j1',
    uploadedByUserId: 'u1',
    fileId: 'f1',
    category: 'before',
    createdAt: '2026-05-03T00:00:00.000Z',
    downloadUrl: 'https://cdn.example/p1.jpg',
    filename: 'p1.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1234,
    ...overrides,
  };
}

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a1',
    fileId: 'f1',
    entityType: 'job',
    entityId: 'j1',
    kind: 'photo',
    category: 'before',
    ...overrides,
  };
}

describe('JobPhotos page — #1122 pairing wiring', () => {
  it('resolves attachment ids by fileId and calls the pair client with the right role', async () => {
    const before = makePhoto({ id: 'p-before', fileId: 'f-before', category: 'before' });
    const after = makePhoto({ id: 'p-after', fileId: 'f-after', category: 'after' });
    const attachmentBefore = makeAttachment({ id: 'a-before', fileId: 'f-before', category: 'before' });
    const attachmentAfter = makeAttachment({ id: 'a-after', fileId: 'f-after', category: 'after' });

    const fetcher = vi.fn().mockResolvedValue([before, after]);
    const listAttachmentsFn = vi.fn().mockResolvedValue([attachmentBefore, attachmentAfter]);
    const pairFn = vi.fn().mockResolvedValue({
      pairGroupId: 'g1',
      attachment: attachmentBefore,
      other: attachmentAfter,
    });

    render(
      <JobPhotos
        jobId="j1"
        fetcher={fetcher}
        listAttachmentsFn={listAttachmentsFn}
        pairFn={pairFn}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('job-photo-card-p-before')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('job-photo-pair-select-p-before'), {
      target: { value: 'p-after' },
    });
    fireEvent.click(screen.getByTestId('job-photo-pair-button-p-before'));

    await waitFor(() => {
      expect(listAttachmentsFn).toHaveBeenCalledWith('job', 'j1');
      expect(pairFn).toHaveBeenCalledWith('a-before', 'a-after', 'before');
    });
  });

  it('surfaces an error when the matching attachment cannot be found', async () => {
    const before = makePhoto({ id: 'p-before', fileId: 'f-before', category: 'before' });
    const after = makePhoto({ id: 'p-after', fileId: 'f-after', category: 'after' });

    const fetcher = vi.fn().mockResolvedValue([before, after]);
    const listAttachmentsFn = vi.fn().mockResolvedValue([]); // no shadow rows found
    const pairFn = vi.fn();

    render(
      <JobPhotos
        jobId="j1"
        fetcher={fetcher}
        listAttachmentsFn={listAttachmentsFn}
        pairFn={pairFn}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('job-photo-card-p-before')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('job-photo-pair-select-p-before'), {
      target: { value: 'p-after' },
    });
    fireEvent.click(screen.getByTestId('job-photo-pair-button-p-before'));

    await waitFor(() => expect(screen.getByTestId('job-photos-error')).toBeInTheDocument());
    expect(pairFn).not.toHaveBeenCalled();
  });

  it('surfaces an error when the pair request itself fails', async () => {
    const before = makePhoto({ id: 'p-before', fileId: 'f-before', category: 'before' });
    const after = makePhoto({ id: 'p-after', fileId: 'f-after', category: 'after' });
    const attachmentBefore = makeAttachment({ id: 'a-before', fileId: 'f-before', category: 'before' });
    const attachmentAfter = makeAttachment({ id: 'a-after', fileId: 'f-after', category: 'after' });

    const fetcher = vi.fn().mockResolvedValue([before, after]);
    const listAttachmentsFn = vi.fn().mockResolvedValue([attachmentBefore, attachmentAfter]);
    const pairFn = vi.fn().mockRejectedValue(new Error('Pair failed: 404'));

    render(
      <JobPhotos
        jobId="j1"
        fetcher={fetcher}
        listAttachmentsFn={listAttachmentsFn}
        pairFn={pairFn}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('job-photo-card-p-before')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('job-photo-pair-select-p-before'), {
      target: { value: 'p-after' },
    });
    fireEvent.click(screen.getByTestId('job-photo-pair-button-p-before'));

    await waitFor(() =>
      expect(screen.getByTestId('job-photos-error')).toHaveTextContent('Pair failed: 404'),
    );
  });
});
