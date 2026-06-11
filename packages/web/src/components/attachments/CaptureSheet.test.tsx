import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureSheet } from './CaptureSheet';

let mockCaptureCounter = 0;

vi.mock('../shared/CameraCapture', () => ({
  CameraCapture: ({ onClose }: { onClose: (media: Array<{ id: string; type: 'photo'; url: string; capturedAt: string }>) => void }) => {
    const captureId = `capture-${++mockCaptureCounter}`;
    return (
      <button
        type="button"
        onClick={() => onClose([{
          id: captureId,
          type: 'photo',
          url: 'data:image/jpeg;base64,eA==',
          capturedAt: '2026-06-11T00:00:00.000Z',
        }])}
      >
        Mock shutter done
      </button>
    );
  },
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CaptureSheet', () => {
  let storage: Record<string, string>;
  let originalLocalStorage: PropertyDescriptor | undefined;

  beforeEach(() => {
    mockCaptureCounter = 0;
    vi.restoreAllMocks();
    originalLocalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
    storage = {};
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value;
        }),
        removeItem: vi.fn((key: string) => {
          delete storage[key];
        }),
        clear: vi.fn(() => {
          storage = {};
        }),
      },
      configurable: true,
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    if (originalLocalStorage) {
      Object.defineProperty(window, 'localStorage', originalLocalStorage);
    }
  });

  it('captures, previews, and uploads through presign -> PUT -> attach', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ fileId: 'f1', uploadUrl: 'https://upload.test/file' }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ id: 'a1', fileId: 'f1', entityType: 'estimate', entityId: 'e1', kind: 'photo' }, 201));
    const onAttached = vi.fn();

    render(<CaptureSheet entityType="estimate" entityId="e1" onAttached={onAttached} />);
    fireEvent.click(screen.getByText('Mock shutter done'));
    expect(screen.getByAltText('Captured photo 1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() => expect(onAttached).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), 'data:image/jpeg;base64,eA=='));
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/attachments/presign', expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://upload.test/file', expect.objectContaining({ method: 'PUT' }));
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/attachments', expect.any(Object));
  });

  it('persists the selected category only on chip click, not on open', () => {
    const { unmount } = render(<CaptureSheet entityType="estimate" entityId="e1" />);
    // After mount but before any chip click, nothing should be persisted
    expect(window.localStorage.setItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Mock shutter done'));
    // After advancing to review sheet, still no persistence until chip clicked
    expect(window.localStorage.setItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Before' }));
    expect(window.localStorage.getItem('serviceos.attachments.lastCategory')).toBe('before');
    unmount();

    render(<CaptureSheet entityType="invoice" entityId="i1" />);
    fireEvent.click(screen.getByText('Mock shutter done'));
    expect(screen.getByRole('button', { name: 'Before' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('chip aria-pressed reflects selection', () => {
    render(<CaptureSheet entityType="estimate" entityId="e1" />);
    fireEvent.click(screen.getByText('Mock shutter done'));

    const beforeBtn = screen.getByRole('button', { name: 'Before' });
    const otherBtn = screen.getByRole('button', { name: 'Other' });
    // Default is 'other' (no stored category)
    expect(otherBtn).toHaveAttribute('aria-pressed', 'true');
    expect(beforeBtn).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(beforeBtn);
    expect(beforeBtn).toHaveAttribute('aria-pressed', 'true');
    expect(otherBtn).toHaveAttribute('aria-pressed', 'false');
  });

  it('Escape key closes the sheet', () => {
    const onClose = vi.fn();
    render(<CaptureSheet entityType="estimate" entityId="e1" onClose={onClose} />);
    fireEvent.click(screen.getByText('Mock shutter done'));

    // useFocusTrap listens on the dialog node, not document
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the triggering element after the sheet closes', () => {
    const onClose = vi.fn();

    function Wrapper() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" id="trigger" onClick={() => setOpen(true)}>
            Open sheet
          </button>
          {open && (
            <CaptureSheet
              entityType="estimate"
              entityId="e1"
              onClose={() => {
                onClose();
                setOpen(false);
              }}
            />
          )}
        </>
      );
    }

    render(<Wrapper />);
    const trigger = screen.getByRole('button', { name: 'Open sheet' });
    // Explicitly focus the trigger so useFocusTrap can capture it as previouslyFocused
    trigger.focus();
    fireEvent.click(trigger);

    // advance past the camera mock to the review sheet
    fireEvent.click(screen.getByText('Mock shutter done'));

    const dialog = screen.getByRole('dialog');
    // Close via Escape
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Focus must have returned to the triggering button
    expect(document.activeElement).toBe(trigger);
  });

  it('sheet has role=dialog, aria-modal=true, and aria-labelledby pointing to title', () => {
    render(<CaptureSheet entityType="estimate" entityId="e1" />);
    fireEvent.click(screen.getByText('Mock shutter done'));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    const titleEl = document.getElementById(labelId!);
    expect(titleEl).toHaveTextContent('Attach photos');
  });

  it('shows optimistic uploading state and a retry affordance after an error', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ fileId: 'f1', uploadUrl: 'https://upload.test/file' }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ fileId: 'f2', uploadUrl: 'https://upload.test/file-2' }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ id: 'a2', fileId: 'f2', entityType: 'estimate', entityId: 'e1', kind: 'photo' }, 201));
    const onAttached = vi.fn();

    render(<CaptureSheet entityType="estimate" entityId="e1" onAttached={onAttached} />);
    fireEvent.click(screen.getByText('Mock shutter done'));
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    expect(await screen.findByText('Uploading')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Some uploads failed');
    fireEvent.click(screen.getByRole('button', { name: /retry failed/i }));

    await waitFor(() => expect(onAttached).toHaveBeenCalledWith(expect.objectContaining({ id: 'a2' }), expect.any(String)));
  });

  it('overlay label reads "Failed" (not "Retry") on error state', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ fileId: 'f1', uploadUrl: 'https://upload.test/file' }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));

    render(<CaptureSheet entityType="estimate" entityId="e1" />);
    fireEvent.click(screen.getByText('Mock shutter done'));
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(screen.queryByText('Retry')).not.toBeInTheDocument();
  });

  it('keeps mobile tap targets at min-h-11 and avoids horizontal viewport classes', () => {
    render(<CaptureSheet entityType="estimate" entityId="e1" />);
    fireEvent.click(screen.getByText('Mock shutter done'));

    expect(screen.getByRole('button', { name: /confirm/i }).className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: 'Before' }).className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: /add another photo/i }).className).toContain('min-h-11');
    expect(document.body.innerHTML).not.toContain('w-screen');
  });

  it('primary button in error state skips already-done items — no duplicate presign/PUT/attach', async () => {
    // Two captures: items run concurrently so both presigns fire before any PUT.
    // Item 0 succeeds, item 1 fails on first Confirm; primary re-click must only retry item 1.
    vi.mocked(fetch)
      // First Confirm (concurrent): item 0 presign, item 1 presign
      .mockResolvedValueOnce(jsonResponse({ fileId: 'f1', uploadUrl: 'https://upload.test/file-1' }, 201))
      .mockResolvedValueOnce(jsonResponse({ fileId: 'f2', uploadUrl: 'https://upload.test/file-2' }, 201))
      // First Confirm: item 0 PUT succeeds, item 1 PUT fails
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      // First Confirm: item 0 attach succeeds (item 1 threw at PUT, so no attach for it)
      .mockResolvedValueOnce(jsonResponse({ id: 'a1', fileId: 'f1', entityType: 'estimate', entityId: 'e1', kind: 'photo' }, 201))
      // Second Confirm (primary, only item 1): presign, PUT, attach
      .mockResolvedValueOnce(jsonResponse({ fileId: 'f3', uploadUrl: 'https://upload.test/file-3' }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ id: 'a3', fileId: 'f3', entityType: 'estimate', entityId: 'e1', kind: 'photo' }, 201));

    const onAttached = vi.fn();
    render(<CaptureSheet entityType="estimate" entityId="e1" onAttached={onAttached} />);

    // Capture item 0
    fireEvent.click(screen.getByText('Mock shutter done'));
    // Add item 1 via "Add another photo" -> mock camera -> done
    fireEvent.click(screen.getByRole('button', { name: /add another photo/i }));
    fireEvent.click(screen.getByText('Mock shutter done'));

    // First Confirm — item 0 succeeds, item 1 fails
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Some uploads failed');

    // onAttached called exactly once for the succeeded item
    await waitFor(() => expect(onAttached).toHaveBeenCalledTimes(1));
    expect(onAttached).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), expect.any(String));

    // Primary button re-click — must NOT re-upload item 0 (already done)
    const fetchCallsBeforeRetry = vi.mocked(fetch).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() => expect(onAttached).toHaveBeenCalledTimes(2));
    expect(onAttached).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a3' }), expect.any(String));

    // Exactly 3 more fetch calls (presign + PUT + attach) for the one failed item only
    const fetchCallsForRetry = vi.mocked(fetch).mock.calls.length - fetchCallsBeforeRetry;
    expect(fetchCallsForRetry).toBe(3);

    // Ensure item 0's upload URL was NOT called again
    const allUrls = vi.mocked(fetch).mock.calls.map((call) => call[0] as string);
    expect(allUrls.filter((url) => url === 'https://upload.test/file-1')).toHaveLength(1);
  });
});
