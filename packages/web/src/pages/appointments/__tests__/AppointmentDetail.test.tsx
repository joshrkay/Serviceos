import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppointmentDetail } from '../AppointmentDetail';
import { TenantTimezoneProvider } from '../../../hooks/useTenantTimezone';

// AppointmentDetail loads via useDetailQuery → useApiClient → fetch(path).
// The global Clerk mock (src/test-setup.ts) supplies a token, so we only need
// to stub the network layer.
const baseAppt = {
  id: 'a-1',
  jobId: 'j-1',
  status: 'scheduled',
  // 03:30 UTC on Jun 1 is the day BEFORE (8:30 PM) in Phoenix (UTC-7, no DST).
  scheduledStart: '2026-06-01T03:30:00Z',
  scheduledEnd: '2026-06-01T05:00:00Z',
  timezone: 'America/Phoenix',
  assignments: [],
};

function renderInTz(timezone: string) {
  return render(
    <TenantTimezoneProvider overrideTimezone={timezone}>
      <AppointmentDetail appointmentId="a-1" />
    </TenantTimezoneProvider>,
  );
}

describe('Finding 4 (WS6) — AppointmentDetail tenant-tz rendering', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => baseAppt,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Regression: start/end were rendered with `new Date(iso).toLocaleString()`
  // (browser-local tz), so the same instant showed a different time — and often
  // a different DAY — for every viewer. They must render in the TENANT tz,
  // deterministically, regardless of the JS runtime timezone.
  it('renders start/end in the tenant timezone (Phoenix), not browser-local', async () => {
    renderInTz('America/Phoenix');

    // Phoenix wall clock: May 31, 2026, 8:30 PM / 10:00 PM.
    expect(await screen.findByText(/Start:\s*May 31, 2026, 8:30\s*PM/)).toBeInTheDocument();
    expect(screen.getByText(/End:\s*May 31, 2026, 10:00\s*PM/)).toBeInTheDocument();
  });

  it('renders the SAME instant differently under a different tenant tz (Sydney)', async () => {
    renderInTz('Australia/Sydney');

    // Sydney (UTC+10) renders the same 03:30Z instant as Jun 1, 1:30 PM.
    await waitFor(() => {
      expect(screen.getByText(/Start:\s*Jun 1, 2026, 1:30\s*PM/)).toBeInTheDocument();
    });
    expect(screen.getByText(/End:\s*Jun 1, 2026, 3:00\s*PM/)).toBeInTheDocument();
  });

  it('renders the arrival window in the tenant timezone', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ...baseAppt,
        arrivalWindowStart: '2026-06-01T03:30:00Z',
        arrivalWindowEnd: '2026-06-01T04:30:00Z',
      }),
    } as never);

    renderInTz('America/Phoenix');

    expect(await screen.findByText(/From:\s*May 31, 2026, 8:30\s*PM/)).toBeInTheDocument();
    expect(screen.getByText(/To:\s*May 31, 2026, 9:30\s*PM/)).toBeInTheDocument();
  });
});
