import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PortalAgreementList } from '../PortalAgreementList';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

describe('Portal — PortalAgreementList (P10-001)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders an agreement card with name, status, and price', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        agreements: [
          {
            id: 'agr-1',
            name: 'Gold HVAC Maintenance',
            description: 'Twice-yearly tune-ups',
            status: 'active',
            priceCents: 19900,
            recurrenceRule: 'FREQ=MONTHLY',
            nextRunAt: new Date('2026-07-01T15:00:00Z').toISOString(),
            startsOn: '2026-01-01',
            endsOn: null,
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<PortalAgreementList token="tok-1" />);

    await waitFor(() => {
      expect(screen.getByText('Gold HVAC Maintenance')).toBeInTheDocument();
    });
    expect(screen.getByText('Status: active')).toBeInTheDocument();
    expect(screen.getByText('$199.00')).toBeInTheDocument();
    expect(screen.getByText('Twice-yearly tune-ups')).toBeInTheDocument();
    expect(screen.getByText(/ongoing/)).toBeInTheDocument();
  });

  it('shows an empty state when there are no agreements', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ agreements: [] }));
    vi.stubGlobal('fetch', fetchMock);

    render(<PortalAgreementList token="tok-1" />);

    await waitFor(() => {
      expect(screen.getByText('No agreements yet.')).toBeInTheDocument();
    });
  });
});
