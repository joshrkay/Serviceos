import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentSection } from './AttachmentSection';

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
});
