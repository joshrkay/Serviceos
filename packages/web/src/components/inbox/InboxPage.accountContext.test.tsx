/**
 * #1252 (PRD row 2.12) — a property-manager caller's proposal carries
 * `sourceContext.accountContext` ({ priority, accountType, managedPropertyCount }),
 * stamped by the voice turn processor. The owner must SEE the difference: the
 * inbox card flags it, and a residential caller's card in the same feed does not.
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

function row(id: string, summary: string, sourceContext?: Record<string, unknown>) {
  return {
    proposal: {
      id,
      proposalType: 'create_job',
      summary,
      status: 'ready_for_review',
      createdAt: new Date().toISOString(),
      ...(sourceContext ? { sourceContext } : {}),
    },
    urgency: 'normal' as const,
    reason: 'Awaiting review',
  };
}

describe('InboxPage — B2B account context (#1252)', () => {
  beforeEach(() => apiFetch.mockReset());

  it('flags the property-manager proposal as a priority account; the residential one carries no flag', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          row('p-pm', 'Leak at unit 4B', {
            accountContext: { priority: true, accountType: 'property_manager', managedPropertyCount: 12 },
          }),
          row('p-res', 'Leak under the kitchen sink'),
        ],
        summary: { totalCount: 2, criticalCount: 0, highCount: 0, normalCount: 2, lowCount: 0, truncated: false },
      }),
    );

    render(<InboxPage />);
    await waitFor(() => screen.getByText('Leak at unit 4B'));

    const [pmRow, resRow] = screen.getAllByTestId('inbox-row');
    const flag = within(pmRow!).getByTestId('proposal-account-priority');
    expect(flag).toHaveTextContent('Priority');
    expect(flag).toHaveTextContent('Property manager');
    expect(flag).toHaveTextContent('12 properties');
    expect(within(resRow!).queryByTestId('proposal-account-priority')).toBeNull();
  });
});
