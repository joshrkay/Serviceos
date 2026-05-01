/**
 * P9-002 — Tests for CommunicationTimeline.
 *
 * Covers initial render, filter chips, "Load older" pagination, and the
 * empty/error states. The fetcher is injected as a prop so tests do not
 * touch the network layer.
 */
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { CommunicationTimeline } from '../CommunicationTimeline';
import type {
  CustomerTimelineResponse,
  TimelineEvent,
  TimelineKind,
} from '../../../api/customers';

function ev(
  kind: TimelineKind,
  occurredAt: string,
  overrides: Partial<TimelineEvent> = {}
): TimelineEvent {
  return {
    kind,
    occurredAt,
    summary: `${kind} @ ${occurredAt}`,
    metadata: {},
    sourceEntityId: `${kind}-${occurredAt}`,
    sourceEntityType:
      kind === 'note'
        ? 'note'
        : kind.startsWith('job')
          ? 'job'
          : kind.startsWith('estimate')
            ? 'estimate'
            : kind.startsWith('invoice')
              ? 'invoice'
              : kind === 'payment_received'
                ? 'payment'
                : kind.startsWith('appointment')
                  ? 'appointment'
                  : 'message',
    ...overrides,
  };
}

describe('P9-002 — CommunicationTimeline', () => {
  it('renders an empty state for customers with no events', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ events: [], nextCursor: null } as CustomerTimelineResponse);
    render(<CommunicationTimeline customerId="c1" fetcher={fetcher} />);
    await waitFor(() =>
      expect(screen.getByTestId('timeline-empty')).toBeInTheDocument()
    );
  });

  it('renders icons + summaries + "view source" links for events', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      events: [
        ev('note', '2026-04-01T10:00:00Z', { summary: 'Customer prefers texts' }),
        ev('job_created', '2026-04-02T10:00:00Z', {
          summary: 'Job JOB-0001 created: Replace heater',
          sourceEntityId: 'job-1',
        }),
        ev('invoice_paid', '2026-04-03T10:00:00Z', {
          summary: 'Invoice INV-0001 paid in full',
          sourceEntityId: 'inv-1',
        }),
      ],
      nextCursor: null,
    } as CustomerTimelineResponse);

    render(<CommunicationTimeline customerId="c1" fetcher={fetcher} />);

    await waitFor(() =>
      expect(screen.getByText('Customer prefers texts')).toBeInTheDocument()
    );
    expect(
      screen.getByText('Job JOB-0001 created: Replace heater')
    ).toBeInTheDocument();
    expect(screen.getByText('Invoice INV-0001 paid in full')).toBeInTheDocument();

    expect(screen.getByTestId('timeline-icon-note')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-icon-job_created')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-icon-invoice_paid')).toBeInTheDocument();

    const links = screen.getAllByTestId('timeline-source-link');
    // Notes have no source link; job + invoice do.
    expect(links.length).toBe(2);
    expect(links[0].getAttribute('href')).toContain('/jobs/job-1');
  });

  it('filter chips toggle visible kinds', async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn().mockResolvedValue({
      events: [
        ev('note', '2026-04-01T10:00:00Z', { summary: 'A note' }),
        ev('sms_sent', '2026-04-02T10:00:00Z', { summary: 'Sent SMS' }),
        ev('payment_received', '2026-04-03T10:00:00Z', { summary: 'Payment received' }),
      ],
      nextCursor: null,
    } as CustomerTimelineResponse);

    render(<CommunicationTimeline customerId="c1" fetcher={fetcher} />);

    await waitFor(() => expect(screen.getByText('A note')).toBeInTheDocument());

    const noteChip = screen.getByTestId('timeline-filter-note');
    await user.click(noteChip);

    // Activating the `note` chip narrows the list to notes only.
    expect(screen.getByText('A note')).toBeInTheDocument();
    expect(screen.queryByText('Sent SMS')).not.toBeInTheDocument();
    expect(screen.queryByText('Payment received')).not.toBeInTheDocument();

    // Click again to clear the filter — full list returns.
    await user.click(noteChip);
    expect(screen.getByText('Sent SMS')).toBeInTheDocument();
    expect(screen.getByText('Payment received')).toBeInTheDocument();
  });

  it('Load older paginates with the `before` cursor', async () => {
    const fetcher = vi.fn();
    fetcher
      .mockResolvedValueOnce({
        events: [
          ev('note', '2026-04-03T10:00:00Z', { summary: 'Newest note' }),
        ],
        nextCursor: '2026-04-03T10:00:00Z',
      } as CustomerTimelineResponse)
      .mockResolvedValueOnce({
        events: [
          ev('note', '2026-04-01T10:00:00Z', { summary: 'Older note' }),
        ],
        nextCursor: null,
      } as CustomerTimelineResponse);

    const user = userEvent.setup();
    render(<CommunicationTimeline customerId="c1" fetcher={fetcher} />);

    await waitFor(() =>
      expect(screen.getByText('Newest note')).toBeInTheDocument()
    );

    const loadMore = screen.getByTestId('timeline-load-older');
    await user.click(loadMore);

    await waitFor(() =>
      expect(screen.getByText('Older note')).toBeInTheDocument()
    );

    // The second call must include the cursor returned from the first.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1]).toMatchObject({
      before: '2026-04-03T10:00:00Z',
    });

    // Cursor exhausted — Load older button is gone.
    expect(screen.queryByTestId('timeline-load-older')).not.toBeInTheDocument();
  });

  it('renders an error state when the fetcher rejects', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('boom'));
    render(<CommunicationTimeline customerId="c1" fetcher={fetcher} />);
    await waitFor(() =>
      expect(screen.getByTestId('timeline-error')).toHaveTextContent('boom')
    );
  });

  it('does not crash when initial load returns no events', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ events: [], nextCursor: null } as CustomerTimelineResponse);
    expect(() =>
      render(<CommunicationTimeline customerId="c1" fetcher={fetcher} />)
    ).not.toThrow();
    await waitFor(() =>
      expect(screen.getByTestId('timeline-empty')).toBeInTheDocument()
    );
  });
});

// Ensure act() warnings don't fire from teardown.
afterEach(async () => {
  await act(async () => {
    await Promise.resolve();
  });
});
