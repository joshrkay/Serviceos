import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../../lib/apiClient', () => ({ useApiClient: () => apiFetchMock }));
vi.mock('../../../lib/analytics', () => ({ trackFunnel: vi.fn() }));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ userId: 'u1' }) }));

import * as analytics from '../../../lib/analytics';
import { CalendarChoicePanel } from './CalendarChoicePanel';

describe('CalendarChoicePanel funnel instrumentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  it('records the provider and fires wizard_step_calendar when built-in is chosen', async () => {
    render(<CalendarChoicePanel tenantId="t1" />);
    fireEvent.click(screen.getByRole('button', { name: /built-in/i }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/onboarding/calendar/choose',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(analytics.trackFunnel).toHaveBeenCalledWith(
      'wizard_step_calendar',
      { tenantId: 't1', userId: 'u1' },
      { provider: 'builtin' },
    );
  });

  it('fires wizard_step_calendar with provider=google when Google is chosen', async () => {
    render(<CalendarChoicePanel tenantId="t1" />);
    fireEvent.click(screen.getByRole('button', { name: /google calendar/i }));
    await waitFor(() =>
      expect(analytics.trackFunnel).toHaveBeenCalledWith(
        'wizard_step_calendar',
        { tenantId: 't1', userId: 'u1' },
        { provider: 'google' },
      ),
    );
  });
});
