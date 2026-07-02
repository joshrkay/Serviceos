import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
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

describe('InboxPage', () => {
  beforeEach(() => apiFetch.mockReset());

  it('renders the prioritized proposals sorted by urgency', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            proposal: { id: 'p-crit', proposalType: 'create_booking', summary: 'Hold expires in 30 min', status: 'ready_for_review', createdAt: new Date().toISOString() },
            urgency: 'critical',
            reason: 'Expiring within 2 hours',
          },
          {
            proposal: { id: 'p-norm', proposalType: 'draft_invoice', summary: 'Invoice for the Johnson job', status: 'ready_for_review', createdAt: new Date().toISOString() },
            urgency: 'normal',
            reason: 'Awaiting review',
          },
        ],
        summary: { totalCount: 2, criticalCount: 1, highCount: 0, normalCount: 1, lowCount: 0, truncated: false },
      }),
    );

    render(<InboxPage />);

    await waitFor(() => {
      expect(screen.getByText('Hold expires in 30 min')).toBeInTheDocument();
      expect(screen.getByText('Invoice for the Johnson job')).toBeInTheDocument();
    });
    const rows = screen.getAllByTestId('inbox-row');
    expect(rows[0]).toHaveTextContent('Hold expires in 30 min');
    expect(rows[1]).toHaveTextContent('Invoice for the Johnson job');
    expect(screen.getByText(/critical/i)).toBeInTheDocument();
  });

  it('shows an empty-state when there are zero proposals', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [],
        summary: { totalCount: 0, criticalCount: 0, highCount: 0, normalCount: 0, lowCount: 0, truncated: false },
      }),
    );
    render(<InboxPage />);
    await waitFor(() => {
      expect(screen.getByText(/nothing waiting/i)).toBeInTheDocument();
    });
  });

  it('approves a proposal and removes it from the list optimistically', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { proposal: { id: 'p-1', proposalType: 'add_note', summary: 'Add a note', status: 'ready_for_review', createdAt: new Date().toISOString() }, urgency: 'low', reason: 'Standard priority' },
        ],
        summary: { totalCount: 1, criticalCount: 0, highCount: 0, normalCount: 0, lowCount: 1, truncated: false },
      }),
    );
    apiFetch.mockResolvedValueOnce(jsonResponse({ data: { id: 'p-1', status: 'approved' } }));

    render(<InboxPage />);
    await waitFor(() => screen.getByText('Add a note'));
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => {
      expect(screen.queryByText('Add a note')).not.toBeInTheDocument();
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/proposals/p-1/approve',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('§5.5 — marks expired schedule cards and re-proposes one optimistically', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [],
        summary: { totalCount: 0, criticalCount: 0, highCount: 0, normalCount: 0, lowCount: 0, truncated: false },
        expired: [
          { id: 'exp-1', proposalType: 'create_appointment', summary: 'Tuesday 2pm with Jordan', status: 'expired', createdAt: new Date().toISOString() },
        ],
      }),
    );
    apiFetch.mockResolvedValueOnce(jsonResponse({ id: 'new-1', status: 'draft' }, { status: 201 }));

    render(<InboxPage />);
    await waitFor(() => screen.getByTestId('expired-section'));
    expect(screen.getByText('Tuesday 2pm with Jordan')).toBeInTheDocument();
    // the "Expired" badge marks the card (distinct from the section heading)
    expect(screen.getByText('Expired')).toBeInTheDocument();
    // not the empty-state, even though there are no pending rows
    expect(screen.queryByText(/nothing waiting/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /re-propose/i }));

    await waitFor(() => {
      expect(screen.queryByText('Tuesday 2pm with Jordan')).not.toBeInTheDocument();
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/proposals/exp-1/re-propose',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('journey QA bug 10 — surfaces execution-failed proposals with their executionError', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [],
        summary: { totalCount: 0, criticalCount: 0, highCount: 0, normalCount: 0, lowCount: 0, truncated: false },
        failed: [
          {
            id: 'p-fail',
            proposalType: 'draft_estimate',
            summary: 'Estimate for Dana — $424.00',
            status: 'execution_failed',
            executionError: 'Estimate draft has no jobId and job auto-creation is not configured — pick a job before approving',
            failedAt: new Date().toISOString(),
          },
        ],
      }),
    );

    render(<InboxPage />);
    await waitFor(() => screen.getByTestId('failed-section'));
    expect(screen.getByText('Estimate for Dana — $424.00')).toBeInTheDocument();
    expect(screen.getByTestId('execution-error')).toHaveTextContent(/no jobId/);
    // A failed card means something needs attention — not the empty state.
    expect(screen.queryByText(/nothing waiting/i)).not.toBeInTheDocument();
  });

  it('renders confidence + pricing-source markers and a one-tap picker for an ambiguous line (U2)', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            proposal: {
              id: 'p-amb',
              proposalType: 'draft_estimate',
              summary: 'Estimate for the Lee job',
              status: 'draft',
              createdAt: new Date().toISOString(),
              payload: {
                _meta: { overallConfidence: 'low', markers: [{ path: 'lineItems[0]', reason: 'Wasn’t sure which flush valve' }] },
                lineItems: [{ id: 'l1', description: 'flush valve', pricingSource: 'ambiguous' }],
              },
              sourceContext: {
                missingFields: ['lineItems[0].catalogItemId'],
                catalogResolution: {
                  0: [
                    { id: 'cat-a', name: 'Flush valve (standard)', unitPriceCents: 4500, score: 0.7 },
                    { id: 'cat-b', name: 'Flush valve (premium)', unitPriceCents: 8200, score: 0.6 },
                  ],
                },
              },
            },
            urgency: 'normal',
            reason: 'Awaiting review',
          },
        ],
        summary: { totalCount: 1, criticalCount: 0, highCount: 0, normalCount: 1, lowCount: 0, truncated: false },
      }),
    );

    render(<InboxPage />);

    await waitFor(() => screen.getByText('Estimate for the Lee job'));
    expect(screen.getByTestId('confidence-signal')).toHaveTextContent('Low confidence');
    expect(screen.getByTestId('pricing-source-badge')).toHaveTextContent('Needs a pick');
    expect(screen.getByText(/Wasn’t sure which flush valve/)).toBeInTheDocument();
    // The picker surfaces the candidates.
    expect(screen.getAllByTestId('ambiguity-option')).toHaveLength(2);
  });

  it('surfaces the §6.4-B severity badge on an MMS photo draft in the inbox (U5)', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            proposal: {
              id: 'p-mms',
              proposalType: 'draft_estimate',
              summary: 'Photo quote for the Ruiz job',
              status: 'draft',
              createdAt: new Date().toISOString(),
              payload: {
                _meta: { overallConfidence: 'medium', severity: 'TIER_2_EMERGENCY_DISPATCH' },
                lineItems: [{ id: 'l1', description: 'Burst pipe repair', pricingSource: 'catalog' }],
              },
              sourceContext: { source: 'customer_mms' },
            },
            urgency: 'high',
            reason: 'Awaiting review',
          },
        ],
        summary: { totalCount: 1, criticalCount: 0, highCount: 1, normalCount: 0, lowCount: 0, truncated: false },
      }),
    );

    render(<InboxPage />);

    await waitFor(() => screen.getByText('Photo quote for the Ruiz job'));
    // The urgency badge must appear where MMS drafts are actually reviewed.
    expect(screen.getByTestId('severity-badge')).toHaveTextContent('Emergency');
  });

  it('renders a "Standing instruction applied" chip per applied instruction (UB-A3)', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            proposal: {
              id: 'p-si',
              proposalType: 'draft_estimate',
              summary: 'Estimate for the Nguyen job',
              status: 'draft',
              createdAt: new Date().toISOString(),
              payload: {
                _meta: {
                  overallConfidence: 'high',
                  appliedStandingInstructions: [
                    { id: 'si-1', text: 'Always add a $50 trip fee' },
                    { id: 'si-2', text: 'Mention the referral discount' },
                  ],
                },
                lineItems: [{ id: 'l1', description: 'Water heater install', pricingSource: 'catalog' }],
              },
            },
            urgency: 'normal',
            reason: 'Awaiting review',
          },
        ],
        summary: { totalCount: 1, criticalCount: 0, highCount: 0, normalCount: 1, lowCount: 0, truncated: false },
      }),
    );

    render(<InboxPage />);

    await waitFor(() => screen.getByText('Estimate for the Nguyen job'));
    const chips = screen.getAllByTestId('standing-instruction-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent('Standing instruction applied: Always add a $50 trip fee');
    expect(chips[1]).toHaveTextContent('Standing instruction applied: Mention the referral discount');
  });

  it('renders no standing-instruction chip when _meta carries none (UB-A3)', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            proposal: {
              id: 'p-no-si',
              proposalType: 'draft_estimate',
              summary: 'Estimate without instructions',
              status: 'draft',
              createdAt: new Date().toISOString(),
              payload: { _meta: { overallConfidence: 'high' } },
            },
            urgency: 'normal',
            reason: 'Awaiting review',
          },
        ],
        summary: { totalCount: 1, criticalCount: 0, highCount: 0, normalCount: 1, lowCount: 0, truncated: false },
      }),
    );

    render(<InboxPage />);

    await waitFor(() => screen.getByText('Estimate without instructions'));
    expect(screen.queryByTestId('standing-instruction-chip')).not.toBeInTheDocument();
  });

  it('resolving an ambiguous line POSTs resolve-line and merges the returned proposal (U2)', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            proposal: {
              id: 'p-amb',
              proposalType: 'draft_estimate',
              summary: 'Estimate for the Lee job',
              status: 'draft',
              createdAt: new Date().toISOString(),
              payload: { lineItems: [{ id: 'l1', description: 'flush valve', pricingSource: 'ambiguous' }] },
              sourceContext: {
                missingFields: ['lineItems[0].catalogItemId'],
                catalogResolution: { 0: [{ id: 'cat-b', name: 'Flush valve (premium)', unitPriceCents: 8200, score: 0.6 }] },
              },
            },
            urgency: 'normal',
          },
        ],
        summary: { totalCount: 1, criticalCount: 0, highCount: 0, normalCount: 1, lowCount: 0, truncated: false },
      }),
    );
    // resolve-line returns the patched proposal: line grounded, no candidates left.
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        id: 'p-amb',
        proposalType: 'draft_estimate',
        summary: 'Estimate for the Lee job',
        status: 'ready_for_review',
        createdAt: new Date().toISOString(),
        payload: { lineItems: [{ id: 'l1', description: 'Flush valve (premium)', pricingSource: 'catalog' }] },
        sourceContext: { missingFields: [], catalogResolution: {} },
      }),
    );

    render(<InboxPage />);
    await waitFor(() => screen.getByText('Estimate for the Lee job'));
    fireEvent.click(screen.getByText('Flush valve (premium)'));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/proposals/p-amb/resolve-line',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ lineIndex: 0, catalogItemId: 'cat-b' }),
        }),
      );
    });
    // After resolution the picker is gone (the line is now catalog-grounded).
    await waitFor(() => {
      expect(screen.queryByTestId('ambiguity-picker')).not.toBeInTheDocument();
    });
  });

  it('resolving an ambiguous entity ("which Bob?") POSTs resolve-entity and merges the re-drafted proposal (U8/E9)', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            proposal: {
              id: 'p-bob',
              proposalType: 'voice_clarification',
              summary: 'Which customer? "Bob" matched 2 records',
              status: 'draft',
              createdAt: new Date().toISOString(),
              payload: {
                reason: 'ambiguous_entity',
                entityReference: 'Bob',
                entityCandidates: [
                  { id: 'cust-a', label: 'Bob Smith', hint: '555-0100', score: 0.82 },
                  { id: 'cust-b', label: 'Bob Jones', score: 0.81 },
                ],
              },
              sourceContext: { entityKind: 'customer', entityReference: 'Bob' },
            },
            urgency: 'normal',
            reason: 'Awaiting review',
          },
        ],
        summary: { totalCount: 1, criticalCount: 0, highCount: 0, normalCount: 1, lowCount: 0, truncated: false },
      }),
    );
    // resolve-entity returns the re-drafted proposal: chosen id stamped, no
    // candidates left, surfaced for review (never approved).
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        id: 'p-bob',
        proposalType: 'voice_clarification',
        summary: 'Which customer? "Bob" matched 2 records',
        status: 'ready_for_review',
        createdAt: new Date().toISOString(),
        payload: { customerId: 'cust-b' },
        sourceContext: { resolvedEntity: { id: 'cust-b', kind: 'customer' } },
      }),
    );

    render(<InboxPage />);
    await waitFor(() => screen.getByText('Bob Jones'));
    // The picker surfaces both candidates by label (no price column).
    expect(screen.getAllByTestId('ambiguity-option')).toHaveLength(2);
    fireEvent.click(screen.getByText('Bob Jones'));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/proposals/p-bob/resolve-entity',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ candidateId: 'cust-b' }),
        }),
      );
    });
    // After resolution the picker is gone (the reference is resolved).
    await waitFor(() => {
      expect(screen.queryByTestId('ambiguity-picker')).not.toBeInTheDocument();
    });
  });

  it('rejects a proposal and removes it from the list', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { proposal: { id: 'p-2', proposalType: 'add_note', summary: 'Add another note', status: 'ready_for_review', createdAt: new Date().toISOString() }, urgency: 'low', reason: 'Standard priority' },
        ],
        summary: { totalCount: 1, criticalCount: 0, highCount: 0, normalCount: 0, lowCount: 1, truncated: false },
      }),
    );
    apiFetch.mockResolvedValueOnce(jsonResponse({ data: { id: 'p-2', status: 'rejected' } }));

    render(<InboxPage />);
    await waitFor(() => screen.getByText('Add another note'));
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));

    await waitFor(() => {
      expect(screen.queryByText('Add another note')).not.toBeInTheDocument();
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/proposals/p-2/reject',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  // ── U6: "approve all eligible" (capture-class + high-confidence only) ──
  describe('approve all eligible (U6)', () => {
    interface RowOpts {
      id: string;
      proposalType: string;
      summary: string;
      confidenceScore?: number;
      overallConfidence?: 'high' | 'medium' | 'low' | 'very_low';
    }

    function row(opts: RowOpts) {
      const proposal: Record<string, unknown> = {
        id: opts.id,
        proposalType: opts.proposalType,
        summary: opts.summary,
        status: 'ready_for_review',
        createdAt: new Date().toISOString(),
      };
      if (opts.confidenceScore !== undefined) proposal.confidenceScore = opts.confidenceScore;
      if (opts.overallConfidence) proposal.payload = { _meta: { overallConfidence: opts.overallConfidence } };
      return { proposal, urgency: 'normal', reason: 'Awaiting review' };
    }

    function inbox(rows: ReturnType<typeof row>[]) {
      return jsonResponse({
        data: rows,
        summary: { totalCount: rows.length, criticalCount: 0, highCount: 0, normalCount: rows.length, lowCount: 0, truncated: false },
      });
    }

    it('counts only capture-class, ≥0.8-confidence rows as eligible — incl. the no-_meta numeric path, and excludes money/comms/irreversible', async () => {
      apiFetch.mockResolvedValueOnce(
        inbox([
          // eligible: capture + explicit _meta:'high' (no numeric score)
          row({ id: 'cap-meta-high', proposalType: 'add_note', summary: 'Note: gate code is 4821', overallConfidence: 'high' }),
          // eligible: capture + numeric 0.9, NO _meta (the common path a string-only gate would miss)
          row({ id: 'cap-num-high', proposalType: 'create_customer', summary: 'New customer: Dana Lee', confidenceScore: 0.9 }),
          // excluded: capture but only 0.6
          row({ id: 'cap-mid', proposalType: 'draft_estimate', summary: 'Estimate for the Park job', confidenceScore: 0.6 }),
          // excluded: non-capture (money) even at 0.95
          row({ id: 'money', proposalType: 'record_payment', summary: 'Record $200 cash', confidenceScore: 0.95 }),
          // excluded: non-capture (comms) even at _meta:'high'
          row({ id: 'comms', proposalType: 'send_invoice', summary: 'Send invoice to the Ruiz job', overallConfidence: 'high' }),
          // excluded: non-capture (irreversible) even at 0.99
          row({ id: 'irrev', proposalType: 'cancel_appointment', summary: 'Cancel Tuesday 2pm', confidenceScore: 0.99 }),
        ]),
      );
      apiFetch.mockResolvedValueOnce(jsonResponse({ approved: ['cap-meta-high', 'cap-num-high'], failed: [] }));

      render(<InboxPage />);
      await waitFor(() => screen.getByText('Note: gate code is 4821'));

      const hero = screen.getByTestId('approve-all-eligible');
      // Exactly the two capture-class high-confidence rows are counted.
      expect(within(hero).getByRole('button')).toHaveTextContent('Approve all 2');

      fireEvent.click(within(hero).getByRole('button'));

      await waitFor(() => {
        expect(apiFetch).toHaveBeenCalledWith(
          '/api/proposals/approve-batch',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ proposalIds: ['cap-meta-high', 'cap-num-high'] }),
          }),
        );
      });
      // The two eligible rows are removed; the four excluded ones remain.
      await waitFor(() => {
        expect(screen.queryByText('Note: gate code is 4821')).not.toBeInTheDocument();
      });
      expect(screen.getByText('Record $200 cash')).toBeInTheDocument();
      expect(screen.getByText('Send invoice to the Ruiz job')).toBeInTheDocument();
      expect(screen.getByText('Cancel Tuesday 2pm')).toBeInTheDocument();
    });

    it('does not show the hero when nothing is eligible', async () => {
      apiFetch.mockResolvedValueOnce(
        inbox([
          row({ id: 'money', proposalType: 'record_payment', summary: 'Record $200 cash', confidenceScore: 0.95 }),
          row({ id: 'cap-mid', proposalType: 'draft_estimate', summary: 'Estimate for the Park job', confidenceScore: 0.6 }),
        ]),
      );
      render(<InboxPage />);
      await waitFor(() => screen.getByText('Record $200 cash'));
      expect(screen.queryByTestId('approve-all-eligible')).not.toBeInTheDocument();
    });

    it('partial failure restores ONLY the failed row and leaves the approved one gone', async () => {
      apiFetch.mockResolvedValueOnce(
        inbox([
          row({ id: 'a', proposalType: 'add_note', summary: 'Note A', overallConfidence: 'high' }),
          row({ id: 'b', proposalType: 'create_customer', summary: 'Customer B', confidenceScore: 0.9 }),
        ]),
      );
      // Server approved a but rejected b (e.g. a concurrent state change).
      apiFetch.mockResolvedValueOnce(
        jsonResponse({ approved: ['a'], failed: [{ id: 'b', reason: 'no longer pending' }] }),
      );

      render(<InboxPage />);
      await waitFor(() => screen.getByText('Note A'));
      fireEvent.click(within(screen.getByTestId('approve-all-eligible')).getByRole('button'));

      await waitFor(() => {
        // a is approved → gone; b failed → restored and still visible.
        expect(screen.queryByText('Note A')).not.toBeInTheDocument();
        expect(screen.getByText('Customer B')).toBeInTheDocument();
      });
      expect(screen.getByText(/1 couldn't be approved.*still waiting/i)).toBeInTheDocument();
    });

    it('a 400 (the journey-QA duplicate-header repro) restores the whole batch and shows an error', async () => {
      apiFetch.mockResolvedValueOnce(
        inbox([
          row({ id: 'a', proposalType: 'add_note', summary: 'Note A', overallConfidence: 'high' }),
          row({ id: 'b', proposalType: 'create_customer', summary: 'Customer B', confidenceScore: 0.9 }),
        ]),
      );
      apiFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'VALIDATION_ERROR', message: 'proposalIds Required' }, { status: 400 }),
      );

      render(<InboxPage />);
      await waitFor(() => screen.getByText('Note A'));
      fireEvent.click(within(screen.getByTestId('approve-all-eligible')).getByRole('button'));

      // Both optimistically-removed rows come back, with a visible error.
      await waitFor(() => {
        expect(screen.getByText('Note A')).toBeInTheDocument();
        expect(screen.getByText('Customer B')).toBeInTheDocument();
        expect(screen.getByText(/HTTP 400/)).toBeInTheDocument();
      });
    });

    it('a transport error restores the whole batch', async () => {
      apiFetch.mockResolvedValueOnce(
        inbox([row({ id: 'a', proposalType: 'add_note', summary: 'Note A', overallConfidence: 'high' })]),
      );
      apiFetch.mockResolvedValueOnce(jsonResponse({ message: 'boom' }, { status: 500 }));

      render(<InboxPage />);
      await waitFor(() => screen.getByText('Note A'));
      fireEvent.click(within(screen.getByTestId('approve-all-eligible')).getByRole('button'));

      // Optimistically removed, then restored when the POST fails.
      await waitFor(() => {
        expect(screen.getByText('Note A')).toBeInTheDocument();
        expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
      });
    });

    it('per-chain "Approve all" still batch-approves a chain (unaffected by the hero)', async () => {
      apiFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [
            { proposal: { id: 'c1', proposalType: 'create_customer', summary: 'Create customer Pat', status: 'draft', createdAt: new Date().toISOString(), chainId: 'chain-1', sourceContext: { chainIndex: 0 } }, urgency: 'normal' },
            { proposal: { id: 'c2', proposalType: 'draft_estimate', summary: 'Estimate for Pat', status: 'draft', createdAt: new Date().toISOString(), chainId: 'chain-1', sourceContext: { chainIndex: 1, dependsOnChainIndices: [0] } }, urgency: 'normal' },
          ],
          summary: { totalCount: 2, criticalCount: 0, highCount: 0, normalCount: 2, lowCount: 0, truncated: false },
        }),
      );
      apiFetch.mockResolvedValueOnce(jsonResponse({ approved: ['c1', 'c2'], failed: [] }));

      render(<InboxPage />);
      await waitFor(() => screen.getByTestId('inbox-chain'));
      // No confidence on the chain members → no hero affordance.
      expect(screen.queryByTestId('approve-all-eligible')).not.toBeInTheDocument();

      fireEvent.click(within(screen.getByTestId('inbox-chain')).getByRole('button', { name: /approve all/i }));

      await waitFor(() => {
        expect(apiFetch).toHaveBeenCalledWith(
          '/api/proposals/approve-batch',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ proposalIds: ['c1', 'c2'] }),
          }),
        );
      });
      await waitFor(() => expect(screen.queryByTestId('inbox-chain')).not.toBeInTheDocument());
    });
  });
});
