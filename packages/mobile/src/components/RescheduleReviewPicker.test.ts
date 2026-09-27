// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  api: vi.fn(),
  fetchAvailability: vi.fn(),
}));

vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('../api/appointments', () => ({
  fetchAvailability: (...a: unknown[]) => h.fetchAvailability(...a),
}));

// eslint-disable-next-line import/first
import { RescheduleReviewPicker } from './RescheduleReviewPicker';

afterEach(() => cleanup());

describe('RescheduleReviewPicker', () => {
  it('#1243: shows the availability defaults notes while the owner adjusts a proposed reschedule', async () => {
    const note = 'Timezone not configured — using America/New_York. Set it in Settings → Business profile.';
    h.fetchAvailability.mockResolvedValue({
      timezone: 'America/New_York',
      durationMin: 60,
      slots: [{ start: '2026-06-22T13:00:00Z', end: '2026-06-22T14:00:00Z' }],
      config: {
        timezoneSource: 'default',
        businessHoursSource: 'tenant',
        bufferSource: 'tenant',
        bufferMinutes: 30,
        notes: [note],
      },
    });
    const { findByText } = render(
      createElement(RescheduleReviewPicker, {
        payload: {
          newScheduledStart: '2026-06-22T15:00:00Z',
          newScheduledEnd: '2026-06-22T16:00:00Z',
        },
        timezone: 'America/New_York',
        onPick: vi.fn(),
        saving: false,
      }),
    );
    expect(await findByText(note)).toBeTruthy();
  });
});
