import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PortalRequestService } from '../PortalRequestService';

describe('Portal — PortalRequestService (P10-001)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects an empty summary with an inline error', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<PortalRequestService token="tok-1" />);
    fireEvent.click(screen.getByRole('button', { name: /send request/i }));

    expect(
      await screen.findByText(/please describe what you need/i),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs the form and shows the success state', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ leadId: 'lead-7', message: 'ok' }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    render(<PortalRequestService token="tok-1" />);
    fireEvent.change(screen.getByLabelText(/what do you need help with/i), {
      target: { value: 'Furnace not heating' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send request/i }));

    await waitFor(() => {
      expect(screen.getByText(/Request received/)).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/public/portal/tok-1/request-service');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.summary).toBe('Furnace not heating');
  });

  it('surfaces a server error message', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad input',
      statusText: 'Bad Request',
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    render(<PortalRequestService token="tok-1" />);
    fireEvent.change(screen.getByLabelText(/what do you need help with/i), {
      target: { value: 'Need help' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send request/i }));

    await waitFor(() => {
      expect(screen.getByText(/Portal request failed/)).toBeInTheDocument();
    });
  });
});
