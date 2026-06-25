/**
 * Tenant-neutral class contract for the public booking page (U13d).
 *
 * Walks slot → details → success so the guard sees the migrated kit form
 * fields and the success screen, not just the entry state (a jsdom guard only
 * covers the states it mounts). No raw palette, no ServiceOS brand blue.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../api/public-booking', () => ({
  fetchBookingAvailability: vi.fn(),
  submitBooking: vi.fn(),
}));
vi.mock('../../api/public-intake', () => ({ fetchIntakeTenantInfo: vi.fn() }));

import { fetchBookingAvailability, submitBooking } from '../../api/public-booking';
import { fetchIntakeTenantInfo } from '../../api/public-intake';
import { BookingPage } from './BookingPage';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SLOT = { start: '2099-06-01T15:00:00.000Z', end: '2099-06-01T16:00:00.000Z' };

const RAW_PALETTE =
  /(bg|text|border|border-l|border-r|border-t|border-b|placeholder|ring|divide|shadow|from|via|to)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/;

function expectNeutral(html: string) {
  expect(html).not.toMatch(RAW_PALETTE);
  expect(html).not.toMatch(/\b(bg|text|border|ring)-primary\b/);
  expect(html).not.toMatch(/\bring-ring\b/);
  expect(html).not.toMatch(/\b(bg|text|border)-accent\b|accent-foreground/);
}

describe('BookingPage — tenant-neutral class contract', () => {
  beforeEach(() => {
    window.history.pushState({}, '', `/book?t=${TENANT_ID}`);
    vi.mocked(fetchIntakeTenantInfo).mockResolvedValue({
      businessName: 'Rivera HVAC',
      businessPhone: '(602) 555-0100',
      serviceTypes: [],
    });
    vi.mocked(fetchBookingAvailability).mockResolvedValue({
      timezone: 'UTC',
      durationMin: 60,
      slots: [SLOT],
    });
  });
  afterEach(() => vi.clearAllMocks());

  it('stays neutral across slot, details (kit fields), and success states', async () => {
    vi.mocked(submitBooking).mockResolvedValue({
      status: 'pending_confirmation',
      proposalId: 'prop-1',
      appointmentId: 'appt-1',
      scheduledStart: SLOT.start,
      scheduledEnd: SLOT.end,
      timezone: 'UTC',
      message: 'ok',
    });

    const { container } = render(<BookingPage />);

    // Slot state.
    fireEvent.click(await screen.findByTestId(`booking-slot-${SLOT.start}`));
    expectNeutral(container.innerHTML);

    // Details state (migrated kit Input/Textarea).
    fireEvent.click(screen.getByTestId('booking-cta'));
    await screen.findByTestId('booking-field-name');
    expectNeutral(container.innerHTML);

    // Success state.
    fireEvent.change(screen.getByTestId('booking-field-name'), { target: { value: 'Sandra Wu' } });
    fireEvent.change(screen.getByTestId('booking-field-phone'), { target: { value: '5125550100' } });
    fireEvent.change(screen.getByTestId('booking-field-street1'), { target: { value: '123 Maple St' } });
    fireEvent.change(screen.getByTestId('booking-field-city'), { target: { value: 'Phoenix' } });
    fireEvent.change(screen.getByTestId('booking-field-state'), { target: { value: 'AZ' } });
    fireEvent.change(screen.getByTestId('booking-field-postalCode'), { target: { value: '85001' } });
    fireEvent.change(screen.getByTestId('booking-field-summary'), { target: { value: 'AC not cooling' } });
    fireEvent.click(screen.getByTestId('booking-cta'));
    await waitFor(() => expect(submitBooking).toHaveBeenCalled());
    await screen.findByText('Request received!');
    expectNeutral(container.innerHTML);
  });
});
