import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureSheet } from './CaptureSheet';

vi.mock('../shared/CameraCapture', () => ({
  CameraCapture: ({ onClose }: { onClose: (media: Array<{ id: string; type: 'photo'; url: string; capturedAt: string }>) => void }) => (
    <button
      type="button"
      onClick={() => onClose([{
        id: 'capture-1',
        type: 'photo',
        url: 'data:image/jpeg;base64,eA==',
        capturedAt: '2026-06-11T00:00:00.000Z',
      }])}
    >
      Mock shutter done
    </button>
  ),
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

    await waitFor(() => expect(onAttached).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' })));
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/attachments/presign', expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://upload.test/file', expect.objectContaining({ method: 'PUT' }));
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/attachments', expect.any(Object));
  });

  it('persists the selected category and defaults the next sheet to it', () => {
    const { unmount } = render(<CaptureSheet entityType="estimate" entityId="e1" />);
    fireEvent.click(screen.getByText('Mock shutter done'));
    fireEvent.click(screen.getByRole('button', { name: 'Before' }));
    expect(window.localStorage.getItem('serviceos.attachments.lastCategory')).toBe('before');
    unmount();

    render(<CaptureSheet entityType="invoice" entityId="i1" />);
    fireEvent.click(screen.getByText('Mock shutter done'));
    expect(screen.getByRole('button', { name: 'Before' }).className).toContain('bg-blue-600');
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

    await waitFor(() => expect(onAttached).toHaveBeenCalledWith(expect.objectContaining({ id: 'a2' })));
  });

  it('keeps mobile tap targets at min-h-11 and avoids horizontal viewport classes', () => {
    render(<CaptureSheet entityType="estimate" entityId="e1" />);
    fireEvent.click(screen.getByText('Mock shutter done'));

    expect(screen.getByRole('button', { name: /confirm/i }).className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: 'Before' }).className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: /add another photo/i }).className).toContain('min-h-11');
    expect(document.body.innerHTML).not.toContain('w-screen');
  });
});
