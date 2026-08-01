import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentSection } from './AttachmentSection';

// Track the latest onAttached/onClose callbacks from CaptureSheet
let capturedOnAttached: ((attachment: object, previewUrl?: string) => void) | null = null;
let capturedOnClose: (() => void) | null = null;

vi.mock('./CaptureSheet', () => ({
  CaptureSheet: ({
    onAttached,
    onClose,
  }: {
    onAttached?: (attachment: object, previewUrl?: string) => void;
    onClose?: () => void;
  }) => {
    capturedOnAttached = onAttached ?? null;
    capturedOnClose = onClose ?? null;
    return <div data-testid="mock-capture-sheet">Capture open</div>;
  },
}));

vi.mock('../shared/CameraCapture', () => ({
  CameraCapture: () => <div data-testid="mock-capture-sheet">Capture open</div>,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AttachmentSection', () => {
  beforeEach(() => {
    capturedOnAttached = null;
    capturedOnClose = null;
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('renders a thumbnail grid with captions and customer visibility badge', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([
      {
        id: 'a1',
        fileId: 'f1',
        entityType: 'estimate',
        entityId: 'e1',
        kind: 'photo',
        caption: 'Before repair',
        category: 'before',
        portalVisible: true,
        downloadUrl: 'https://cdn.test/a1.jpg',
      },
      {
        id: 'archived',
        fileId: 'f2',
        entityType: 'estimate',
        entityId: 'e1',
        kind: 'photo',
        caption: 'Hidden',
        archivedAt: '2026-06-11T00:00:00.000Z',
        downloadUrl: 'https://cdn.test/a2.jpg',
      },
    ]));

    render(<AttachmentSection entityType="estimate" entityId="e1" />);

    expect(await screen.findByTestId('attachment-grid')).toBeInTheDocument();
    expect(screen.getByAltText('Before repair')).toHaveAttribute('src', 'https://cdn.test/a1.jpg');
    expect(screen.getByText('Before repair')).toBeInTheDocument();
    expect(screen.getByText('Visible to customer')).toBeInTheDocument();
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
  });

  it('opens CaptureSheet from Add photo and keeps the tap target class', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([]));

    render(<AttachmentSection entityType="invoice" entityId="i1" />);
    const button = await screen.findByRole('button', { name: /add photo/i });
    expect(button.className).toContain('min-h-11');
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByTestId('mock-capture-sheet')).toBeInTheDocument());
  });

  it('optimistic grid shows blob preview url immediately after capture+attach', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([]));

    render(<AttachmentSection entityType="estimate" entityId="e1" />);
    // Open the CaptureSheet
    fireEvent.click(await screen.findByRole('button', { name: /add photo/i }));
    await waitFor(() => expect(screen.getByTestId('mock-capture-sheet')).toBeInTheDocument());

    // Simulate onAttached being called with a new attachment + blob preview
    const blobPreview = 'blob:http://localhost/preview-1';
    const attachment = {
      id: 'new-a1',
      fileId: 'f-new',
      entityType: 'estimate' as const,
      entityId: 'e1',
      kind: 'photo' as const,
    };

    // Call onAttached (no downloadUrl on the attachment — POST doesn't return one)
    capturedOnAttached?.(attachment, blobPreview);

    // The grid should now be visible and the img src should be the blob preview
    await waitFor(() => expect(screen.getByTestId('attachment-grid')).toBeInTheDocument());
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', blobPreview);
  });

  it('refetches list when CaptureSheet closes so blob previews get replaced by presigned URLs', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([])) // initial load
      .mockResolvedValueOnce(jsonResponse([    // reload after sheet close
        {
          id: 'a1',
          fileId: 'f1',
          entityType: 'estimate',
          entityId: 'e1',
          kind: 'photo',
          downloadUrl: 'https://cdn.test/a1.jpg',
        },
      ]));

    render(<AttachmentSection entityType="estimate" entityId="e1" />);
    fireEvent.click(await screen.findByRole('button', { name: /add photo/i }));
    await waitFor(() => expect(screen.getByTestId('mock-capture-sheet')).toBeInTheDocument());

    // Simulate sheet close
    capturedOnClose?.();

    // Should have called fetch twice (initial + reload)
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    // After reload, the grid should show the presigned URL
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'https://cdn.test/a1.jpg'));
  });

  it('keeps the attachment grid mounted during background reload after capture (no flicker)', async () => {
    // Initialised to a no-op (not null) so TS keeps the type callable — the
    // real resolver is assigned inside the mockImplementationOnce executor,
    // which control-flow analysis can't see, and a `| null` union would
    // narrow to `null` at the call site below.
    let resolveReload: (value: Response) => void = () => {};
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'a1',
            fileId: 'f1',
            entityType: 'estimate',
            entityId: 'e1',
            kind: 'photo',
            caption: 'Before',
            downloadUrl: 'https://cdn.test/a1.jpg',
          },
        ]),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveReload = resolve;
          }),
      );

    render(<AttachmentSection entityType="estimate" entityId="e1" />);
    expect(await screen.findByTestId('attachment-grid')).toBeInTheDocument();
    expect(screen.getByAltText('Before')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /add photo/i }));
    await waitFor(() => expect(screen.getByTestId('mock-capture-sheet')).toBeInTheDocument());
    capturedOnClose?.();

    // While the background reload is in flight the grid must stay mounted —
    // previously load() set loading=true and hid the grid behind "Loading…".
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('attachment-grid')).toBeInTheDocument();
    expect(screen.queryByText('Loading attachments…')).not.toBeInTheDocument();

    resolveReload(
      jsonResponse([
        {
          id: 'a1',
          fileId: 'f1',
          entityType: 'estimate',
          entityId: 'e1',
          kind: 'photo',
          caption: 'Before',
          downloadUrl: 'https://cdn.test/a1.jpg',
        },
        {
          id: 'a2',
          fileId: 'f2',
          entityType: 'estimate',
          entityId: 'e1',
          kind: 'photo',
          caption: 'After',
          downloadUrl: 'https://cdn.test/a2.jpg',
        },
      ]),
    );
    await waitFor(() => expect(screen.getByAltText('After')).toBeInTheDocument());
  });
});
