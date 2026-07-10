import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddEntrySheet } from './AddEntrySheet';

// Keep the sheet chrome trivial — we only care about the photo pipeline here.
vi.mock('./JobSheets', () => ({
  SheetOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const CAPTURED = [
  {
    id: 'c1',
    type: 'photo' as const,
    url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    capturedAt: '2026-06-27T10:00:00.000Z',
  },
];

vi.mock('../shared/CameraCapture', () => ({
  CameraCapture: ({ onClose }: { onClose: (m: typeof CAPTURED) => void }) => (
    <button data-testid="finish-capture" onClick={() => onClose(CAPTURED)}>finish</button>
  ),
}));

function renderSheet(opts: {
  uploadPhoto: ReturnType<typeof vi.fn>;
  onSubmit?: ReturnType<typeof vi.fn>;
  onClose?: ReturnType<typeof vi.fn>;
}) {
  const onSubmit = opts.onSubmit ?? vi.fn();
  const onClose = opts.onClose ?? vi.fn();
  render(
    <AddEntrySheet
      jobId="j1"
      author="Owner"
      authorInitials="O"
      authorColor="#475569"
      onClose={onClose}
      onSubmit={onSubmit}
      uploadPhoto={opts.uploadPhoto as never}
    />,
  );
  return { onSubmit, onClose };
}

async function captureAPhoto() {
  fireEvent.click(screen.getByRole('button', { name: /photo/i }));
  fireEvent.click(screen.getByRole('button', { name: /open camera/i }));
  fireEvent.click(screen.getByTestId('finish-capture'));
  await screen.findByText(/ready to attach/i);
}

describe('AddEntrySheet — photo persistence', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('uploads each captured photo through the job-photos client before emitting the entry', async () => {
    const uploadPhoto = vi.fn().mockResolvedValue({ id: 'p-1' });
    const { onSubmit, onClose } = renderSheet({ uploadPhoto });

    await captureAPhoto();
    fireEvent.click(screen.getByRole('button', { name: /add to timeline/i }));

    await waitFor(() =>
      expect(uploadPhoto).toHaveBeenCalledWith(
        'j1',
        expect.any(File),
        'before',
        undefined,
        '2026-06-27T10:00:00.000Z',
      ),
    );
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ type: 'photo' })));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('surfaces an upload failure and does not fake success', async () => {
    const uploadPhoto = vi.fn().mockRejectedValue(new Error('S3 PUT failed: 500'));
    const { onSubmit, onClose } = renderSheet({ uploadPhoto });

    await captureAPhoto();
    fireEvent.click(screen.getByRole('button', { name: /add to timeline/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('S3 PUT failed: 500'));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not render a note-tag picker (notes API has no tags field)', () => {
    renderSheet({ uploadPhoto: vi.fn() });
    expect(screen.queryByText('Tag this note')).not.toBeInTheDocument();
  });
});
