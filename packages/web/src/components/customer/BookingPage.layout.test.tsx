/**
 * Mobile/glove layout contract for the public online-booking page (/book).
 *
 * jsdom can't measure real pixel heights, so these assertions pin the CSS
 * class contract the glove-friendly targets depend on (min-h-11 ≥44px on the
 * slot buttons, detail inputs, the back link, and the submit CTA). The real
 * height + overflow measurement lives in e2e/booking-mobile.spec.ts
 * (Playwright, 320px/390px viewports), mirroring the estimate-approval pair.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../api/public-booking', () => ({
  fetchBookingAvailability: vi.fn(),
  submitBooking: vi.fn(),
}));
vi.mock('../../api/public-intake', () => ({
  fetchIntakeTenantInfo: vi.fn(),
}));

import { fetchBookingAvailability } from '../../api/public-booking';
import { fetchIntakeTenantInfo } from '../../api/public-intake';
import { BookingPage } from './BookingPage';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
// Fixed far-future slot → deterministic day/time rendering under UTC.
const SLOT = { start: '2099-06-01T15:00:00.000Z', end: '2099-06-01T16:00:00.000Z' };

describe('BookingPage — mobile glove layout contract', () => {
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

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('slot buttons carry the 44px glove target (min-h-11)', async () => {
    render(<BookingPage />);
    const slot = await screen.findByTestId(`booking-slot-${SLOT.start}`);
    expect(slot.className).toContain('min-h-11');
  });

  it('details inputs, the back link, and the CTA carry the 44px glove target', async () => {
    render(<BookingPage />);
    // slot step → details step
    fireEvent.click(await screen.findByTestId(`booking-slot-${SLOT.start}`));
    fireEvent.click(screen.getByTestId('booking-cta'));

    const name = await screen.findByTestId('booking-field-name');
    expect(name.className).toContain('min-h-11');
    expect(screen.getByTestId('booking-field-postalCode').className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: /back to times/i }).className).toContain('min-h-11');
    expect(screen.getByTestId('booking-cta').className).toContain('min-h-11');
  });
});
