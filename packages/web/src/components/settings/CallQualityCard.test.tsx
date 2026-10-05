/**
 * #1602 — CallQualityCard: the owner's production call-quality card on
 * Settings (next to AI minutes). Mocks apiFetch for GET /api/voice/quality
 * and POST /api/voice/quality/grade; asserts on the DOM.
 */
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallQualityCard } from './CallQualityCard';

const apiFetchMock = vi.fn();

vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const QUALITY = {
  windows: {
    last7d: { graded: 10, passed: 9, passRate: 0.9 },
    last30d: { graded: 40, passed: 32, passRate: 0.8 },
  },
  gate: { passRateMin: 0.85 },
  quota: { sampleRatePct: 20, dailyCap: 20, gradedToday: 2 },
  recent: [
    {
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      gradedAt: '2026-10-05T08:00:00.000Z',
      passed: true,
      criteria: [
        { grader: 'perceived_completion', criterion: 12, name: 'rightCallerFacingAnswer', passed: true, rationale: 'Caller got the appointment time' },
      ],
      rubricVersion: 'v1',
      model: 'judge-mock-1',
      judgeCalls: 2,
      costMicroCents: 500000,
      trigger: 'nightly',
      callEndedAt: '2026-10-04T15:02:00.000Z',
      outcome: 'completed',
    },
    {
      sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      gradedAt: '2026-10-05T08:00:00.000Z',
      passed: false,
      criteria: [
        { grader: 'perceived_completion', criterion: 12, name: 'rightCallerFacingAnswer', passed: false, rationale: 'Caller hung up without an answer' },
        { grader: 'disposition_llm', criterion: 12, name: 'rightCallerFacingAnswer', passed: true, rationale: 'Answered the one question asked' },
      ],
      rubricVersion: 'v1',
      model: 'judge-mock-1',
      judgeCalls: 2,
      costMicroCents: 500000,
      trigger: 'nightly',
      callEndedAt: '2026-10-03T11:30:00.000Z',
      outcome: 'dropped',
    },
  ],
};

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('CallQualityCard', () => {
  it('shows the 7-day and 30-day pass rates against the 85% gate and the last graded calls', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(QUALITY));

    render(<CallQualityCard canManage />);

    expect(await screen.findByText('9 of 10 graded calls passed in the last 7 days (90%)')).toBeInTheDocument();
    expect(screen.getByText('32 of 40 passed in the last 30 days (80%) · gate 85%')).toBeInTheDocument();
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/voice/quality');
    // The failing call's reason is readable without opening anything.
    expect(screen.getByText('Caller hung up without an answer')).toBeInTheDocument();
    expect(screen.getAllByText(/passed|failed/i).length).toBeGreaterThanOrEqual(2);
  });

  it('says so plainly when no production call has been graded yet', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        windows: {
          last7d: { graded: 0, passed: 0, passRate: null },
          last30d: { graded: 0, passed: 0, passRate: null },
        },
        gate: { passRateMin: 0.85 },
        quota: { sampleRatePct: 20, dailyCap: 20, gradedToday: 0 },
        recent: [],
      }),
    );

    render(<CallQualityCard canManage />);

    expect(await screen.findByText('No calls graded yet')).toBeInTheDocument();
  });

  it('flags a 7-day pass rate under the gate', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...QUALITY,
        windows: { ...QUALITY.windows, last7d: { graded: 10, passed: 7, passRate: 0.7 } },
      }),
    );

    render(<CallQualityCard canManage />);

    expect(await screen.findByText('Below the 85% gate')).toBeInTheDocument();
  });

  it('lets the owner grade a sample now and refreshes the card', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(QUALITY))
      .mockResolvedValueOnce(jsonResponse({ ran: true, tenantsSwept: 1, graded: 3, skipped: 0, failures: 0 }, 202))
      .mockResolvedValueOnce(
        jsonResponse({ ...QUALITY, windows: { ...QUALITY.windows, last7d: { graded: 13, passed: 12, passRate: 12 / 13 } } }),
      );

    render(<CallQualityCard canManage />);

    fireEvent.click(await screen.findByRole('button', { name: /grade a sample now/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(3));
    expect(apiFetchMock.mock.calls[1][0]).toBe('/api/voice/quality/grade');
    expect(apiFetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' });
    expect(await screen.findByText('12 of 13 graded calls passed in the last 7 days (92%)')).toBeInTheDocument();
  });

  it('stays hidden when the API answers with something that is not a quality report (partial adapters)', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { container } = render(<CallQualityCard canManage />);
    // Let the fetch + json() + state update settle inside act so a render
    // crash on the unexpected shape surfaces here rather than being swallowed.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
  });

  it('hides the grading trigger from non-owners', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(QUALITY));
    render(<CallQualityCard canManage={false} />);
    await screen.findByText('9 of 10 graded calls passed in the last 7 days (90%)');
    expect(screen.queryByRole('button', { name: /grade a sample now/i })).not.toBeInTheDocument();
  });

  it('keeps tap targets at least 44px (min-h-11) and never forces a horizontal scroll at 320px', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(QUALITY));
    render(<CallQualityCard canManage />);
    expect(await screen.findByRole('button', { name: /grade a sample now/i })).toHaveClass('min-h-11');
    // Class contract for the 320px viewport: text containers shrink (min-w-0)
    // and the call rows wrap instead of fixing a width.
    for (const row of screen.getAllByTestId('call-quality-row')) {
      expect(row).toHaveClass('flex-wrap');
      expect(row).toHaveClass('min-w-0');
    }
  });
});
