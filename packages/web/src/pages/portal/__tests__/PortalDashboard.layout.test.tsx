/**
 * WS6 (QUALITY-2026-07-12) — PortalDashboard accessibility + timezone.
 *
 * 1. The reschedule / cancel / never-mind controls are the customer's only way
 *    to act on an appointment. They must meet the 44px glove target (min-h-11).
 * 2. The "Next appointment" time must render in the tenant timezone, not the
 *    viewer's browser locale — pinned against a fixed instant so the same
 *    instant renders identically regardless of process TZ.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PortalDashboard } from '../PortalDashboard';
import { formatDateTimeInTenantTz } from '../../../utils/formatInTenantTz';
import type { PortalCustomer } from '../../../api/portal';

const customer: PortalCustomer = {
  id: 'cust-1',
  displayName: 'Pat Customer',
  firstName: 'Pat',
  lastName: 'Customer',
  email: 'pat@example.com',
  preferredChannel: 'email',
  timezone: 'America/New_York',
};

const APPT_START = '2026-07-01T15:30:00.000Z';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function mockDashboardFetch(apptTimezone: string) {
  const appointment = {
    id: 'appt-1',
    jobId: 'job-1',
    status: 'scheduled',
    scheduledStart: APPT_START,
    scheduledEnd: '2026-07-01T16:30:00.000Z',
    arrivalWindowStart: null,
    arrivalWindowEnd: null,
    timezone: apptTimezone,
  };
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/invoices')) return Promise.resolve(jsonResponse({ invoices: [] }));
    if (url.includes('/estimates')) return Promise.resolve(jsonResponse({ estimates: [] }));
    if (url.includes('/appointments')) return Promise.resolve(jsonResponse({ appointments: [appointment] }));
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('PortalDashboard — WS6 tap targets', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockDashboardFetch('America/New_York');
  });

  it('Reschedule and Cancel meet the 44px glove target (min-h-11)', async () => {
    render(<PortalDashboard token="tok-1" customer={customer} timezone="America/New_York" />);
    const reschedule = await screen.findByRole('button', { name: 'Reschedule' });
    const cancel = screen.getByRole('button', { name: /Cancel this appointment/ });
    expect(reschedule.className).toContain('min-h-11');
    expect(cancel.className).toContain('min-h-11');
  });

  it('the "Never mind" control (inside the reschedule picker) is min-h-11', async () => {
    render(<PortalDashboard token="tok-1" customer={customer} timezone="America/New_York" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reschedule' }));
    const neverMind = await screen.findByRole('button', { name: 'Never mind' });
    expect(neverMind.className).toContain('min-h-11');
  });
});

describe('PortalDashboard — WS6 tenant timezone', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the next-appointment time in the appointment tenant timezone', async () => {
    mockDashboardFetch('America/New_York');
    render(<PortalDashboard token="tok-1" customer={customer} timezone="America/New_York" />);
    const expected = formatDateTimeInTenantTz(APPT_START, 'America/New_York');
    await waitFor(() => {
      expect(screen.getByText(expected)).toBeInTheDocument();
    });
    // Sanity: New York rendering of 15:30 UTC is 11:30 AM, never the raw UTC hour.
    expect(expected).toMatch(/11:30/);
  });

  it('falls back to the portal timezone prop when the appointment carries none', async () => {
    mockDashboardFetch('');
    render(<PortalDashboard token="tok-1" customer={customer} timezone="America/Los_Angeles" />);
    const expected = formatDateTimeInTenantTz(APPT_START, 'America/Los_Angeles');
    await waitFor(() => {
      expect(screen.getByText(expected)).toBeInTheDocument();
    });
    // 15:30 UTC is 8:30 AM in Los Angeles.
    expect(expected).toMatch(/8:30/);
  });
});
