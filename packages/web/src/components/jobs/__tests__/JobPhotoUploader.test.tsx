import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { JobPhotoUploader } from '../JobPhotoUploader';
import type { JobPhoto } from '../../../api/job-photos';
import {
  listOfflinePhotos,
  removeOfflinePhoto,
  base64ToFile,
} from '../../../lib/offline-photo-queue';

vi.mock('../../../lib/offline-photo-queue', () => ({
  enqueueOfflinePhoto: vi.fn().mockResolvedValue(undefined),
  fileToBase64: vi.fn().mockResolvedValue('YmFzZTY0'),
  listOfflinePhotos: vi.fn().mockResolvedValue([]),
  removeOfflinePhoto: vi.fn().mockResolvedValue(undefined),
  base64ToFile: vi.fn((_b64: string, name: string, type: string) => new File(['x'], name, { type })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  (listOfflinePhotos as Mock).mockResolvedValue([]);
  (base64ToFile as Mock).mockImplementation(
    (_b64: string, name: string, type: string) => new File(['x'], name, { type }),
  );
});

function makeQueuedItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q1',
    jobId: 'job-1',
    fileName: 'queued.jpg',
    contentType: 'image/jpeg',
    base64: 'YmFzZTY0',
    category: 'after',
    notes: 'queued note',
    createdAt: '2026-05-03T00:00:00.000Z',
    ...overrides,
  };
}

function makeFile(): File {
  return new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
}

function makeUploaded(): JobPhoto {
  return {
    id: 'p-new',
    tenantId: 't1',
    jobId: 'j1',
    uploadedByUserId: 'u1',
    fileId: 'f1',
    category: 'before',
    notes: undefined,
    createdAt: '2026-05-03T00:00:00.000Z',
    downloadUrl: 'https://cdn.example/p-new.jpg',
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
  };
}

describe('JobPhotoUploader (P12-001)', () => {
  it('renders a file input with image accept and capture=environment for mobile camera', () => {
    render(<JobPhotoUploader jobId="job-1" />);
    const input = screen.getByTestId('job-photo-file-input') as HTMLInputElement;
    expect(input.getAttribute('accept')).toBe('image/*');
    expect(input.getAttribute('capture')).toBe('environment');
  });

  it('invokes the uploader with category + notes when a file is chosen', async () => {
    const uploader = vi.fn().mockResolvedValue(makeUploaded());
    const onUploaded = vi.fn();
    render(
      <JobPhotoUploader jobId="job-1" uploader={uploader} onUploaded={onUploaded} />
    );

    fireEvent.change(screen.getByTestId('job-photo-category-select'), {
      target: { value: 'after' },
    });
    fireEvent.change(screen.getByTestId('job-photo-notes-input'), {
      target: { value: 'all done' },
    });
    fireEvent.change(screen.getByTestId('job-photo-file-input'), {
      target: { files: [makeFile()] },
    });

    await waitFor(() => expect(uploader).toHaveBeenCalledTimes(1));
    expect(uploader).toHaveBeenCalledWith(
      'job-1',
      expect.any(File),
      'after',
      'all done',
      expect.any(String)
    );
    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
  });

  it('surfaces upload errors via an alert', async () => {
    const uploader = vi.fn().mockRejectedValue(new Error('S3 PUT failed'));
    render(<JobPhotoUploader jobId="job-1" uploader={uploader} />);
    fireEvent.change(screen.getByTestId('job-photo-file-input'), {
      target: { files: [makeFile()] },
    });
    await waitFor(() =>
      expect(screen.getByTestId('job-photo-error')).toHaveTextContent('S3 PUT failed')
    );
  });

  describe('P22-004 — offline queue drain', () => {
    it('drains photos queued while offline on mount and removes them after a successful upload', async () => {
      (listOfflinePhotos as Mock).mockResolvedValueOnce([makeQueuedItem()]);
      const uploader = vi.fn().mockResolvedValue(makeUploaded());
      const onUploaded = vi.fn();

      render(<JobPhotoUploader jobId="job-1" uploader={uploader} onUploaded={onUploaded} />);

      await waitFor(() =>
        expect(uploader).toHaveBeenCalledWith(
          'job-1',
          expect.any(File),
          'after',
          'queued note',
          '2026-05-03T00:00:00.000Z'
        )
      );
      await waitFor(() => expect(removeOfflinePhoto).toHaveBeenCalledWith('q1'));
      await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
    });

    it('leaves a queued photo in IndexedDB when its drain upload fails', async () => {
      (listOfflinePhotos as Mock).mockResolvedValueOnce([makeQueuedItem()]);
      const uploader = vi.fn().mockRejectedValue(new Error('still flaky'));

      render(<JobPhotoUploader jobId="job-1" uploader={uploader} />);

      await waitFor(() => expect(uploader).toHaveBeenCalledTimes(1));
      expect(removeOfflinePhoto).not.toHaveBeenCalled();
    });

    it('does not fire onUploaded for a queued item belonging to another job', async () => {
      (listOfflinePhotos as Mock).mockResolvedValueOnce([
        makeQueuedItem({ id: 'q2', jobId: 'other-job' }),
      ]);
      const uploader = vi.fn().mockResolvedValue(makeUploaded());
      const onUploaded = vi.fn();

      render(<JobPhotoUploader jobId="job-1" uploader={uploader} onUploaded={onUploaded} />);

      await waitFor(() => expect(uploader).toHaveBeenCalledWith('other-job', expect.any(File), 'after', 'queued note', expect.any(String)));
      await waitFor(() => expect(removeOfflinePhoto).toHaveBeenCalledWith('q2'));
      expect(onUploaded).not.toHaveBeenCalled();
    });

    it('drains again when the browser fires an online event', async () => {
      const uploader = vi.fn().mockResolvedValue(makeUploaded());
      render(<JobPhotoUploader jobId="job-1" uploader={uploader} />);

      // Mount drain saw an empty queue.
      await waitFor(() => expect(listOfflinePhotos).toHaveBeenCalled());
      expect(uploader).not.toHaveBeenCalled();

      // Connectivity returns with a backlog.
      (listOfflinePhotos as Mock).mockResolvedValueOnce([makeQueuedItem()]);
      window.dispatchEvent(new Event('online'));

      await waitFor(() => expect(uploader).toHaveBeenCalledTimes(1));
    });
  });
});
