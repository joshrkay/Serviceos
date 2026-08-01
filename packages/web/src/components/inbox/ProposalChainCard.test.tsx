import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { InboxPage } from './InboxPage';

const apiFetch = vi.fn();
vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => apiFetch,
}));

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function chainProposal(
  id: string,
  proposalType: string,
  summary: string,
  chainIndex: number,
  dependsOn: number[],
) {
  return {
    proposal: {
      id,
      proposalType,
      summary,
      status: 'draft',
      createdAt: new Date().toISOString(),
      chainId: 'chain-1',
      sourceContext: {
        chainId: 'chain-1',
        chainIndex,
        chainLength: 3,
        dependsOnChainIndices: dependsOn,
      },
    },
    urgency: 'normal' as const,
    reason: 'Awaiting review',
  };
}

describe('InboxPage — multi-action chains', () => {
  beforeEach(() => apiFetch.mockReset());

  it('groups proposals sharing a chainId into one chain card, ordered by chainIndex', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          // Deliberately out of order to prove sorting by chainIndex.
          chainProposal('p-est', 'draft_estimate', 'Estimate for Jane — $300', 2, [0]),
          chainProposal('p-cust', 'create_customer', 'Create customer Jane Doe', 0, []),
          chainProposal('p-job', 'create_job', 'Open a job for Jane', 1, [0]),
        ],
        summary: { totalCount: 3, criticalCount: 0, highCount: 0, normalCount: 3, lowCount: 0, truncated: false },
      }),
    );

    render(<InboxPage />);

    await waitFor(() => screen.getByTestId('inbox-chain'));

    // One chain card, three steps, no standalone rows.
    expect(screen.getAllByTestId('inbox-chain')).toHaveLength(1);
    expect(screen.queryAllByTestId('inbox-row')).toHaveLength(0);
    const steps = screen.getAllByTestId('inbox-chain-step');
    expect(steps).toHaveLength(3);

    // Ordered by chainIndex: customer (0) → job (1) → estimate (2).
    expect(steps[0]).toHaveTextContent('Create customer Jane Doe');
    expect(steps[1]).toHaveTextContent('Open a job for Jane');
    expect(steps[2]).toHaveTextContent('Estimate for Jane — $300');

    // Dependency hint references the 1-based parent step.
    expect(steps[1]).toHaveTextContent('Uses what step 1 creates');

    expect(screen.getByText('3 linked actions')).toBeInTheDocument();
  });

  it('surfaces good-better-best tiers inside a chained draft estimate step (EE-1)', async () => {
    // The autonomous voice close stages draft_estimate → send_estimate →
    // create_booking, so a tiered estimate is approved inside a chain; the
    // operator must still see the options before Approve all.
    const estStep: ReturnType<typeof chainProposal> & {
      proposal: { payload?: unknown };
    } = chainProposal('p-est', 'draft_estimate', 'Water heater options for Jane', 1, [0]);
    estStep.proposal.payload = {
      lineItems: [
        { id: 'l1', description: 'Builder heater', unitPrice: 90000, groupKey: 'wh', groupLabel: 'Water heater', isOptional: true, isDefaultSelected: true },
        { id: 'l2', description: 'Premium heater', unitPrice: 140000, groupKey: 'wh', groupLabel: 'Water heater', isOptional: true },
        { id: 'l3', description: 'Surge protector', unitPrice: 8000, isOptional: true },
      ],
    };

    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          chainProposal('p-cust', 'create_customer', 'Create customer Jane Doe', 0, []),
          estStep,
        ],
        summary: { totalCount: 2, criticalCount: 0, highCount: 0, normalCount: 2, lowCount: 0, truncated: false },
      }),
    );

    render(<InboxPage />);
    await waitFor(() => screen.getByTestId('inbox-chain'));

    // The tier group (label + both options, default marked) and the add-on
    // render inside the chain step, not just the flat summary.
    const group = screen.getByTestId('tier-group');
    expect(group).toHaveTextContent('Water heater');
    expect(group).toHaveTextContent('Builder heater');
    expect(group).toHaveTextContent('Premium heater');
    expect(screen.getByTestId('tier-default')).toBeInTheDocument();
    expect(screen.getByTestId('tier-addons')).toHaveTextContent('Surge protector');
  });

  it('approve-all calls the batch endpoint with every chain member id', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          chainProposal('p-cust', 'create_customer', 'Create customer Jane Doe', 0, []),
          chainProposal('p-job', 'create_job', 'Open a job for Jane', 1, [0]),
        ],
        summary: { totalCount: 2, criticalCount: 0, highCount: 0, normalCount: 2, lowCount: 0, truncated: false },
      }),
    );
    apiFetch.mockResolvedValueOnce(jsonResponse({ approved: ['p-cust', 'p-job'], failed: [] }));

    render(<InboxPage />);
    await waitFor(() => screen.getByTestId('inbox-chain'));

    fireEvent.click(screen.getByRole('button', { name: /approve all/i }));

    await waitFor(() => {
      expect(screen.queryByTestId('inbox-chain')).not.toBeInTheDocument();
    });

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/proposals/approve-batch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ proposalIds: ['p-cust', 'p-job'] }),
      }),
    );
  });

  it('renders standalone proposals as normal rows alongside chains', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          chainProposal('p-cust', 'create_customer', 'Create customer Jane Doe', 0, []),
          chainProposal('p-job', 'create_job', 'Open a job for Jane', 1, [0]),
          {
            proposal: { id: 'p-solo', proposalType: 'add_note', summary: 'Add a standalone note', status: 'draft', createdAt: new Date().toISOString() },
            urgency: 'low' as const,
            reason: 'Standard priority',
          },
        ],
        summary: { totalCount: 3, criticalCount: 0, highCount: 0, normalCount: 2, lowCount: 1, truncated: false },
      }),
    );

    render(<InboxPage />);
    await waitFor(() => screen.getByTestId('inbox-chain'));

    expect(screen.getAllByTestId('inbox-chain')).toHaveLength(1);
    expect(screen.getAllByTestId('inbox-row')).toHaveLength(1);
    expect(screen.getByText('Add a standalone note')).toBeInTheDocument();
  });
});
