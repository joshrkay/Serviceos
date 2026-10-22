import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { LatestTextStatus, type LatestTextFilter } from './LatestTextStatus';
import { expectTapTarget } from '../../test-utils/tap-target';

vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '../../utils/api-fetch';
const mockApiFetch = vi.mocked(apiFetch);

function response(status: number, body: unknown = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function renderBubble(filter: LatestTextFilter) {
  return render(
    <MemoryRouter>
      <LatestTextStatus filter={filter} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('LatestTextStatus', () => {
  it('asks for the latest record for the job', async () => {
    mockApiFetch.mockResolvedValue(response(200, { dispatches: [], total: 0 }));
    renderBubble({ jobId: 'job-1' });
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(String(mockApiFetch.mock.calls[0][0])).toBe('/api/interactions/dispatches?jobId=job-1&limit=1');
  });

  it('shows a blocked text with its reason and links to that customer\'s texts', async () => {
    mockApiFetch.mockResolvedValue(
      response(200, {
        dispatches: [{
          id: 'd1', entityType: 'thank_you', entityId: 'job-1', channel: 'sms', recipient: '',
          provider: 'unknown', status: 'blocked', blockReason: 'no_phone', sentAt: '2026-10-21T18:00:00Z',
        }],
        total: 1,
      }),
    );
    renderBubble({ customerId: 'cust-1' });
    expect(await screen.findByText('Text not sent: there is no phone number on file')).toBeInTheDocument();
    const link = screen.getByTestId('latest-text-status');
    expect(link.getAttribute('href')).toBe('/interactions/dispatch?customerId=cust-1');
    expectTapTarget(link, 'status bubble');
  });

  it('shows nothing when nothing has been texted', async () => {
    mockApiFetch.mockResolvedValue(response(200, { dispatches: [], total: 0 }));
    const { container } = renderBubble({ jobId: 'job-1' });
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing to a viewer without access to messages', async () => {
    mockApiFetch.mockResolvedValue(response(403));
    const { container } = renderBubble({ jobId: 'job-1' });
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('says it could not load rather than hiding a failure', async () => {
    mockApiFetch.mockResolvedValue(response(500));
    renderBubble({ jobId: 'job-1' });
    expect(await screen.findByTestId('latest-text-status-error')).toHaveTextContent(
      "Couldn't load the latest text status.",
    );
  });
});
