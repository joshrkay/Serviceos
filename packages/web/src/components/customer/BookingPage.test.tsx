import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../api/public-booking', () => ({
  fetchBookingAvailability: vi.fn(),
  submitBooking: vi.fn(),
}));
vi.mock('../../api/public-intake', () => ({
  fetchIntakeTenantInfo: vi.fn(),
}));

import { fetchBookingAvailability, submitBooking } from '../../api/public-booking';
import { fetchIntakeTenantInfo } from '../../api/public-intake';
import { BookingPage } from './BookingPage';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

// A fixed future slot so the day/time formatting is deterministic under UTC.
const SLOT = { start: '2099-06-01T15:00:00.000Z', end: '2099-06-01T16:00:00.000Z' };

function setTenantQueryParam(t: string | null): void {
  window.history.pushState({}, '', t ? `/book?t=${t}` : '/book');
}

function fillDetails(): void {
  fireEvent.change(screen.getByTestId('booking-field-name'), { target: { value: 'Sandra Wu' } });
  fireEvent.change(screen.getByTestId('booking-field-phone'), { target: { value: '5125550100' } });
  fireEvent.change(screen.getByTestId('booking-field-street1'), { target: { value: '123 Maple St' } });
  fireEvent.change(screen.getByTestId('booking-field-city'), { target: { value: 'Phoenix' } });
  fireEvent.change(screen.getByTestId('booking-field-state'), { target: { value: 'AZ' } });
  fireEvent.change(screen.getByTestId('booking-field-postalCode'), { target: { value: '85001' } });
  fireEvent.change(screen.getByTestId('booking-field-summary'), { target: { value: 'AC not cooling' } });
}

describe('BookingPage', () => {
  beforeEach(() => {
    setTenantQueryParam(TENANT_ID);
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

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads slots and submits a booking end-to-end', async () => {
    vi.mocked(submitBooking).mockResolvedValue({
      status: 'pending_confirmation',
      proposalId: 'prop-1',
      appointmentId: 'appt-1',
      scheduledStart: SLOT.start,
      scheduledEnd: SLOT.end,
      timezone: 'UTC',
      message: 'ok',
    });

    render(<BookingPage />);

    // Slot loads, then the customer picks it and advances.
    const slotBtn = await screen.findByTestId(`booking-slot-${SLOT.start}`);
    fireEvent.click(slotBtn);
    fireEvent.click(screen.getByTestId('booking-cta'));

    // Details step.
    await screen.findByTestId('booking-field-name');
    fillDetails();
    fireEvent.click(screen.getByTestId('booking-cta'));

    await waitFor(() => {
      expect(submitBooking).toHaveBeenCalledWith(
        TENANT_ID,
        expect.objectContaining({
          firstName: 'Sandra',
          lastName: 'Wu',
          primaryPhone: '5125550100',
          street1: '123 Maple St',
          slotStart: SLOT.start,
          slotEnd: SLOT.end,
          _company_url: '',
        }),
      );
    });
    expect(await screen.findByText('Request received!')).toBeInTheDocument();
  });

  it('bounces back to slot selection with a message when the slot was just taken', async () => {
    const alt = { start: '2099-06-02T15:00:00.000Z', end: '2099-06-02T16:00:00.000Z' };
    vi.mocked(submitBooking).mockResolvedValue({
      error: 'SLOT_TAKEN',
      message: 'taken',
      alternatives: [alt],
    });

    render(<BookingPage />);
    fireEvent.click(await screen.findByTestId(`booking-slot-${SLOT.start}`));
    fireEvent.click(screen.getByTestId('booking-cta'));
    await screen.findByTestId('booking-field-name');
    fillDetails();
    fireEvent.click(screen.getByTestId('booking-cta'));

    // Re-rendered slot picker now shows the alternative slot.
    expect(await screen.findByTestId(`booking-slot-${alt.start}`)).toBeInTheDocument();
    expect(screen.getByText(/just booked/i)).toBeInTheDocument();
  });

  it('shows an error and no slots when the tenant id is missing from the URL', async () => {
    setTenantQueryParam(null);
    render(<BookingPage />);
    expect(await screen.findByText(/missing its business id/i)).toBeInTheDocument();
    expect(fetchBookingAvailability).not.toHaveBeenCalled();
  });
});
