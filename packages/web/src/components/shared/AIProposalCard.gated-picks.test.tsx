/**
 * #1277 (QA 2026-09-16) — the in-chat card said "Tap Edit to fill before
 * approval" over a gated catalog pick but offered only Approve (disabled) and
 * Dismiss; picks resolved only on /inbox. And the chat Edit for a customerId
 * gate saved a typed name → PUT 400 with no message.
 *
 * Seam: AIProposalCard, as the chat renders it. Tap targets ≥44px (min-h-11)
 * and nothing wider than a 320px column are pinned as class contracts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AIProposalCard } from './AIProposalCard';
import type { AIProposal } from '../../types/assistant-ui';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('react-router', async (orig) => {
  const actual = await (orig() as Promise<typeof import('react-router')>);
  return { ...actual, useNavigate: () => vi.fn() };
});

function gatedEstimate(overrides: Partial<AIProposal> = {}): AIProposal {
  return {
    id: 'prop-1',
    title: 'Estimate: water heater for Priya',
    summary: 'One line needs a catalog pick.',
    explanation: 'Drafted from chat.',
    confidence: 'Medium',
    type: 'Estimate',
    status: 'Pending',
    proposalType: 'draft_estimate',
    missingFields: ['lineItems[0].catalogItemId'],
    linePicks: [
      {
        lineIndex: 0,
        description: 'Water heater',
        candidates: [
          { id: 'cat-40', name: 'Water heater 40 gal', unitPriceCents: 110000, score: 0.8 },
          { id: 'cat-50', name: 'Water heater 50 gal', unitPriceCents: 130000, score: 0.8 },
        ],
      },
    ],
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('#1277 — gated catalog picks resolve in the chat card', () => {
  it('offers the candidates as ≥44px picks and resolves the line with the one tapped', async () => {
    const onResolveLine = vi.fn(async () => []);
    render(<AIProposalCard proposal={gatedEstimate()} onResolveLine={onResolveLine} />);

    const options = screen.getAllByTestId('ambiguity-option');
    expect(options).toHaveLength(2);
    for (const option of options) expect(option.className).toContain('min-h-11');

    fireEvent.click(screen.getByRole('button', { name: /Water heater 50 gal/ }));
    await waitFor(() => expect(onResolveLine).toHaveBeenCalledWith(0, 'cat-50'));
  });

  it('does not promise an Edit the card does not have', () => {
    render(<AIProposalCard proposal={gatedEstimate()} onResolveLine={vi.fn(async () => [])} />);
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Tap Edit/)).not.toBeInTheDocument();
    expect(screen.getByText(/Pick below to fill before approval/)).toBeInTheDocument();
  });

  it('a customerId gate with a pending question offers its candidates; a pick saves the real id', async () => {
    const onSaveEdits = vi.fn(async () => []);
    render(
      <AIProposalCard
        proposal={gatedEstimate({
          missingFields: ['customerId'],
          linePicks: undefined,
          referencePick: {
            field: 'customerId',
            reference: 'Ashworth',
            candidates: [
              { id: 'cust-morgan', label: 'Morgan Ashworth', score: 0.9 },
              { id: 'cust-riley', label: 'Riley Ashworth', score: 0.9 },
            ],
          },
        })}
        onSaveEdits={onSaveEdits}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Riley Ashworth/ }));

    await waitFor(() => expect(onSaveEdits).toHaveBeenCalledWith({ customerId: 'cust-riley' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /approve/i })).toBeEnabled());
  });

  it('a refused edit shows the server\'s reason on the card instead of failing silently', async () => {
    const reason = 'Invalid payload after edit: customerId: Invalid uuid';
    const onApprove = vi.fn(async () => {
      throw new Error(reason);
    });
    render(
      <AIProposalCard
        proposal={gatedEstimate({
          missingFields: ['customerId'],
          linePicks: undefined,
          editFields: [{ label: 'Customer name or ID', key: 'customerId', value: 'Priya' }],
        })}
        onApprove={onApprove}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    fireEvent.click(screen.getByRole('button', { name: /save & apply/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(reason);
    expect(alert.className).toContain('break-words');
  });

  it('a refused pick shows the server\'s reason and keeps the picker', async () => {
    const onResolveLine = vi.fn(async () => {
      throw new Error('Line 1 is no longer ambiguous');
    });
    render(<AIProposalCard proposal={gatedEstimate()} onResolveLine={onResolveLine} />);

    fireEvent.click(screen.getByRole('button', { name: /Water heater 40 gal/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Line 1 is no longer ambiguous');
    expect(screen.getByTestId('ambiguity-picker')).toBeInTheDocument();
  });

  it('once the last pick resolves, the picker goes and Approve is live', async () => {
    render(<AIProposalCard proposal={gatedEstimate()} onResolveLine={vi.fn(async () => [])} />);
    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Water heater 40 gal/ }));

    await waitFor(() => expect(screen.queryByTestId('ambiguity-picker')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /approve/i })).toBeEnabled();
    expect(screen.queryByText(/Tap Edit/)).not.toBeInTheDocument();
  });
});
