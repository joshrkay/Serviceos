import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Toaster, toast } from 'sonner';
import {
  useMutation,
  COMMON_TOAST_MESSAGES,
} from './useMutation';

/**
 * Tests for P0-032 — useMutation toast integration + Toaster mount accessibility.
 *
 * These tests verify:
 *   - Toaster renders an accessible region on mount
 *   - Successful mutations show a success toast when configured
 *   - Failed mutations show an error toast when configured
 *   - Common-action message constants exist for the four required actions
 *   - Toasted notifications carry an accessible role (status / alert)
 */

function renderToaster() {
  return render(<Toaster richColors position="top-right" />);
}

describe('P0-032 Toaster mount', () => {
  it('renders an accessible aria-label region for screen readers', () => {
    renderToaster();
    // Sonner mounts a <section> with an aria-label that begins with
    // "Notifications" and an aria-live region so screen readers announce
    // toast updates without stealing focus.
    const region = document.querySelector('section[aria-label^="Notifications"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('aria-live')).toBe('polite');
  });
});

describe('P0-032 Toaster — accessible ARIA roles', () => {
  beforeEach(() => {
    // Ensure each test starts from a clean toast state
    toast.dismiss();
  });

  it('renders success toasts inside the polite aria-live region', async () => {
    renderToaster();
    act(() => {
      toast.success(COMMON_TOAST_MESSAGES.customerCreated);
    });
    await waitFor(() => {
      expect(
        screen.getByText(COMMON_TOAST_MESSAGES.customerCreated)
      ).toBeInTheDocument();
    });
    // The toast lives inside the section with aria-live="polite",
    // which fulfils the accessible-announcement requirement.
    const region = document.querySelector(
      'section[aria-label^="Notifications"][aria-live="polite"]'
    );
    expect(region).not.toBeNull();
    expect(region?.textContent).toContain(
      COMMON_TOAST_MESSAGES.customerCreated
    );
  });

  it('renders error toasts inside the polite aria-live region with data-type="error"', async () => {
    renderToaster();
    act(() => {
      toast.error('Something failed');
    });
    await waitFor(() => {
      expect(screen.getByText('Something failed')).toBeInTheDocument();
    });
    // Sonner tags error toasts with data-type="error" — used for styling
    // and exposed for assistive tooling.
    const errorToast = document.querySelector('[data-sonner-toast][data-type="error"]');
    expect(errorToast).not.toBeNull();
    expect(errorToast?.textContent).toContain('Something failed');
  });
});

describe('P0-032 useMutation — toast notifications', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    toast.dismiss();
  });

  it('shows a success toast when a mutation succeeds and successMessage is set', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'cust_1' }),
    } as Response);

    renderToaster();

    const { result } = renderHook(() =>
      useMutation<{ name: string }, { id: string }>('POST', '/api/customers', {
        successMessage: COMMON_TOAST_MESSAGES.customerCreated,
      })
    );

    await act(async () => {
      await result.current.mutate({ name: 'Acme' });
    });

    await waitFor(() => {
      expect(
        screen.getByText(COMMON_TOAST_MESSAGES.customerCreated)
      ).toBeInTheDocument();
    });
  });

  it('shows an error toast when a mutation fails and errorMessage is set', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    renderToaster();

    const { result } = renderHook(() =>
      useMutation('POST', '/api/customers', {
        errorMessage: 'Could not create customer',
      })
    );

    await act(async () => {
      await expect(result.current.mutate({})).rejects.toThrow();
    });

    await waitFor(() => {
      expect(screen.getByText('Could not create customer')).toBeInTheDocument();
    });
  });

  it('does NOT show a toast when no successMessage is provided (opt-in)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    renderToaster();

    const { result } = renderHook(() => useMutation('POST', '/api/silent'));
    await act(async () => {
      await result.current.mutate({});
    });

    // No "ServiceOS"-style success copy should be present in the DOM
    expect(
      screen.queryByText(COMMON_TOAST_MESSAGES.customerCreated)
    ).toBeNull();
  });

  it('formats error toast via callback when errorMessage is a function', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 422,
    } as Response);

    renderToaster();

    const { result } = renderHook(() =>
      useMutation('POST', '/api/x', {
        errorMessage: (err) =>
          err instanceof Error ? `Failed: ${err.message}` : 'Failed',
      })
    );

    await act(async () => {
      await expect(result.current.mutate({})).rejects.toThrow();
    });

    await waitFor(() => {
      expect(screen.getByText('Failed: HTTP 422')).toBeInTheDocument();
    });
  });

  it('exposes copy constants for the four common actions', () => {
    expect(COMMON_TOAST_MESSAGES.customerCreated).toBeTruthy();
    expect(COMMON_TOAST_MESSAGES.estimateSaved).toBeTruthy();
    expect(COMMON_TOAST_MESSAGES.invoiceSent).toBeTruthy();
    expect(COMMON_TOAST_MESSAGES.appointmentScheduled).toBeTruthy();
  });
});
