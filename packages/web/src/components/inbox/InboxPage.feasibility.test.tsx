/**
 * #1015 row 3.12 — "warn me when back-to-back jobs aren't drivable". The API
 * stamps the drive-time check on the booking card: `sourceContext.slotFeasibility`
 * on a non-held create_appointment draft, `sourceContext.holdFeasibility` on a
 * held create_booking (api ai/scheduling/place-hold.ts `HoldFeasibility`). The
 * owner must SEE it on the card, flagged unverified when the estimate is the
 * great-circle fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { InboxPage } from './InboxPage';

const apiFetch = vi.fn();
vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => apiFetch,
}));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function row(id: string, proposalType: string, summary: string, sourceContext?: Record<string, unknown>) {
  return {
    proposal: {
      id,
      proposalType,
      summary,
      status: 'ready_for_review',
      createdAt: new Date().toISOString(),
      ...(sourceContext ? { sourceContext } : {}),
    },
    urgency: 'normal' as const,
    reason: 'Awaiting review',
  };
}

function feed(...rows: ReturnType<typeof row>[]) {
  return jsonResponse({
    data: rows,
    summary: { totalCount: rows.length, criticalCount: 0, highCount: 0, normalCount: rows.length, lowCount: 0, truncated: false },
  });
}

// The shape `checkFeasibility` emits for a back-to-back pair
// (api scheduling/feasibility.ts travel_time warning): 20 min of driving,
// 5 min of gap, great-circle fallback.
const HAVERSINE_WARNING = {
  check: 'travel_time',
  severity: 'warning',
  message: 'Travel from previous appointment requires ~1200s but only 300s available.',
  metadata: { travelSeconds: 1200, gapSeconds: 300, source: 'haversine', kind: 'fromPrev', technicianId: 'tech-1' },
};

describe('InboxPage — scheduling feasibility warning (#1015 row 3.12)', () => {
  beforeEach(() => apiFetch.mockReset());

  it('a create_appointment draft whose slot is not drivable shows the drive-time warning, flagged unverified for a great-circle estimate', async () => {
    apiFetch.mockResolvedValueOnce(
      feed(
        row('p-tight', 'create_appointment', 'Book the Oakland tune-up', {
          slotFeasibility: { checked: true, warnings: [HAVERSINE_WARNING] },
        }),
      ),
    );

    render(<InboxPage />);
    await waitFor(() => screen.getByText('Book the Oakland tune-up'));

    const card = screen.getByTestId('inbox-row');
    const warning = within(card).getByTestId('proposal-feasibility-warning');
    expect(warning).toHaveTextContent('~20 min drive');
    expect(warning).toHaveTextContent('only 5 min');
    expect(warning).toHaveTextContent(/unverified/i);
  });

  it('a held create_booking card surfaces its holdFeasibility warning; a road-routed estimate is not flagged unverified', async () => {
    apiFetch.mockResolvedValueOnce(
      feed(
        row('p-held', 'create_booking', 'Hold Tuesday 9am for the Garcia leak', {
          holdFeasibility: {
            checked: true,
            warnings: [{ ...HAVERSINE_WARNING, metadata: { ...HAVERSINE_WARNING.metadata, travelSeconds: 1800, gapSeconds: 600, source: 'google' } }],
          },
        }),
      ),
    );

    render(<InboxPage />);
    await waitFor(() => screen.getByText('Hold Tuesday 9am for the Garcia leak'));

    const warning = within(screen.getByTestId('inbox-row')).getByTestId('proposal-feasibility-warning');
    expect(warning).toHaveTextContent('~30 min drive');
    expect(warning).toHaveTextContent('only 10 min');
    expect(warning).not.toHaveTextContent(/unverified/i);
  });

  it('an unchecked slot says drive time was not checked (never a silent all-clear); a checked clean slot shows nothing', async () => {
    apiFetch.mockResolvedValueOnce(
      feed(
        row('p-unchecked', 'create_appointment', 'Book the unchecked visit', { slotFeasibility: { checked: false, warnings: [] } }),
        row('p-clean', 'create_appointment', 'Book the clean visit', { slotFeasibility: { checked: true, warnings: [] } }),
      ),
    );

    render(<InboxPage />);
    await waitFor(() => screen.getByText('Book the unchecked visit'));

    const [unchecked, clean] = screen.getAllByTestId('inbox-row');
    expect(within(unchecked!).getByTestId('proposal-feasibility-warning')).toHaveTextContent(/drive time not checked/i);
    expect(within(clean!).queryByTestId('proposal-feasibility-warning')).toBeNull();
  });
});
