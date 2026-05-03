import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { JobPhotoUploader } from '../JobPhotoUploader';
import type { JobPhoto } from '../../../api/job-photos';

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
});
