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
import { toast } from 'sonner';

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
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe('CallQualityCard', () => {
  it('shows the 7-day and 30-day pass rates against the 85% gate and the last graded calls', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(QUALITY));

    render(<CallQualityCard />);

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

    render(<CallQualityCard />);

    expect(await screen.findByText('No calls graded yet')).toBeInTheDocument();
  });

  it('flags a 7-day pass rate under the gate', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...QUALITY,
        windows: { ...QUALITY.windows, last7d: { graded: 10, passed: 7, passRate: 0.7 } },
      }),
    );

    render(<CallQualityCard />);

    expect(await screen.findByText('Below the 85% gate')).toBeInTheDocument();
  });

  it('lets the owner start a grading pass: 202 accepted, a toast that it runs in the background, and a refetch', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(QUALITY))
      .mockResolvedValueOnce(jsonResponse({ accepted: true }, 202))
      .mockResolvedValueOnce(
        jsonResponse({ ...QUALITY, windows: { ...QUALITY.windows, last7d: { graded: 13, passed: 12, passRate: 12 / 13 } } }),
      );

    render(<CallQualityCard />);

    fireEvent.click(await screen.findByRole('button', { name: /grade a sample now/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(3));
    expect(apiFetchMock.mock.calls[1][0]).toBe('/api/voice/quality/grade');
    expect(apiFetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' });
    expect(toast.info).toHaveBeenCalledWith(
      'Grading started — new grades appear here within a few minutes',
    );
    expect(await screen.findByText('12 of 13 graded calls passed in the last 7 days (92%)')).toBeInTheDocument();
  });

  it('tells the owner when a grading pass is already running (409)', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(QUALITY))
      .mockResolvedValueOnce(jsonResponse({ accepted: false, alreadyRunning: true }, 409));

    render(<CallQualityCard />);
    fireEvent.click(await screen.findByRole('button', { name: /grade a sample now/i }));

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('A grading pass is already running'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('renders each graded call\'s date in the tenant timezone, not the viewer\'s', async () => {
    // 2026-10-05T03:30Z is still Oct 4 in America/New_York (the hook's default
    // without a provider) but Oct 5 in UTC / Europe.
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...QUALITY,
        recent: [{ ...QUALITY.recent[0], callEndedAt: '2026-10-05T03:30:00.000Z' }],
      }),
    );
    render(<CallQualityCard />);
    expect(await screen.findByText('Oct 4')).toBeInTheDocument();
  });

  it('stays hidden when the API answers with something that is not a quality report (partial adapters)', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { container } = render(<CallQualityCard />);
    // Let the fetch + json() + state update settle inside act so a render
    // crash on the unexpected shape surfaces here rather than being swallowed.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps tap targets at least 44px (min-h-11) and never forces a horizontal scroll at 320px', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(QUALITY));
    render(<CallQualityCard />);
    expect(await screen.findByRole('button', { name: /grade a sample now/i })).toHaveClass('min-h-11');
    // Class contract for the 320px viewport: text containers shrink (min-w-0)
    // and the call rows wrap instead of fixing a width.
    for (const row of screen.getAllByTestId('call-quality-row')) {
      expect(row).toHaveClass('flex-wrap');
      expect(row).toHaveClass('min-w-0');
    }
  });
});

const LATENCY = {
  p50ReplyGapMs: 850,
  p95ReplyGapMs: 1400,
  p95EndpointDelayMs: 1000,
  p95FirstAudibleMs: 600,
  unacked: { rate: 0.0476, total: 2, byReason: { clear_echo: 1, ack_timeout: 1, stream_closed: 0 } },
  gatherShare: { calls: 0.25 },
  enough: true,
};

describe('CallQualityCard reply gap row (U1)', () => {
  it('shows p50 / p95 reply gap, endpoint delay, unacked % and the degraded-call share', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ...QUALITY, latency: LATENCY }));
    render(<CallQualityCard />);

    expect(await screen.findByTestId('reply-gap-row')).toBeInTheDocument();
    expect(screen.getByTestId('reply-gap-p50')).toHaveTextContent('Typical reply850 ms');
    expect(screen.getByTestId('reply-gap-p95')).toHaveTextContent('Slowest 1 in 201.4 s');
    expect(screen.getByTestId('reply-gap-endpoint')).toHaveTextContent('1.0 s');
    expect(screen.getByTestId('reply-gap-first-audible')).toHaveTextContent('First sound (filler counts)600 ms');
    expect(screen.getByTestId('reply-gap-unacked')).toHaveTextContent('Replies that never played5%');
    // The per-reason split sits under the tile.
    expect(screen.getByTestId('reply-gap-unacked')).toHaveTextContent('timed out 1 · cleared 1 · call ended 0');
    // The call share is the figure shown.
    expect(screen.getByTestId('reply-gap-degraded')).toHaveTextContent('Unmeasured on 25% of calls');
    expect(screen.queryByTestId('reply-gap-not-enough')).not.toBeInTheDocument();
  });

  it('says "Not enough calls yet" instead of numbers below the sample, but still states degradation', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...QUALITY,
        latency: {
          ...LATENCY,
          p50ReplyGapMs: 900,
          p95ReplyGapMs: 900,
          enough: false,
        },
      }),
    );
    render(<CallQualityCard />);

    expect(await screen.findByTestId('reply-gap-not-enough')).toHaveTextContent('Not enough calls yet');
    expect(screen.queryByTestId('reply-gap-p50')).not.toBeInTheDocument();
    expect(screen.getByTestId('reply-gap-degraded')).toBeInTheDocument();
  });

  it('shows a dash for a missing number and omits the degraded note when no call ran on Gather', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...QUALITY,
        latency: {
          ...LATENCY,
          p95EndpointDelayMs: null,
          unacked: { rate: null, total: 0, byReason: { clear_echo: 0, ack_timeout: 0, stream_closed: 0 } },
          gatherShare: { calls: 0 },
        },
      }),
    );
    render(<CallQualityCard />);

    expect(await screen.findByTestId('reply-gap-endpoint')).toHaveTextContent('Wait before the AI starts—');
    expect(screen.getByTestId('reply-gap-unacked')).toHaveTextContent('—');
    // No unacked replies: no per-reason split under the tile.
    expect(screen.getByTestId('reply-gap-unacked')).not.toHaveTextContent('timed out');
    expect(screen.queryByTestId('reply-gap-degraded')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reply-gap-no-calls')).not.toBeInTheDocument();
  });

  it('a null Gather share is "no calls", stated rather than left blank', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ ...QUALITY, latency: { ...LATENCY, gatherShare: { calls: null }, enough: false } }),
    );
    render(<CallQualityCard />);

    expect(await screen.findByTestId('reply-gap-no-calls')).toHaveTextContent('No calls in the last 7 days');
    expect(screen.queryByTestId('reply-gap-degraded')).not.toBeInTheDocument();
  });

  it('a window where every reply went unacked still shows its tiles: dashes for the percentiles, 100% for the rate', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...QUALITY,
        latency: {
          ...LATENCY,
          p50ReplyGapMs: null,
          p95ReplyGapMs: null,
          p95FirstAudibleMs: null,
          unacked: { rate: 1, total: 12, byReason: { clear_echo: 2, ack_timeout: 10, stream_closed: 0 } },
        },
      }),
    );
    render(<CallQualityCard />);

    expect(await screen.findByTestId('reply-gap-p50')).toHaveTextContent('Typical reply—');
    expect(screen.getByTestId('reply-gap-first-audible')).toHaveTextContent('—');
    expect(screen.getByTestId('reply-gap-unacked')).toHaveTextContent('Replies that never played100%');
    expect(screen.getByTestId('reply-gap-unacked')).toHaveTextContent('timed out 10 · cleared 2 · call ended 0');
    expect(screen.queryByTestId('reply-gap-not-enough')).not.toBeInTheDocument();
  });

  it('hides the row when latency is null or absent, leaving the rest of the card intact', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ...QUALITY, latency: null }));
    const { unmount } = render(<CallQualityCard />);
    expect(await screen.findByText('9 of 10 graded calls passed in the last 7 days (90%)')).toBeInTheDocument();
    expect(screen.queryByTestId('reply-gap-row')).not.toBeInTheDocument();
    unmount();

    apiFetchMock.mockResolvedValueOnce(jsonResponse(QUALITY));
    render(<CallQualityCard />);
    expect(await screen.findByText('9 of 10 graded calls passed in the last 7 days (90%)')).toBeInTheDocument();
    expect(screen.queryByTestId('reply-gap-row')).not.toBeInTheDocument();
  });

  it('lays the tiles out two-up with shrinkable text so nothing scrolls sideways at 320px', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ...QUALITY, latency: LATENCY }));
    render(<CallQualityCard />);
    const p50 = await screen.findByTestId('reply-gap-p50');
    expect(p50).toHaveClass('min-w-0');
    expect(p50.parentElement).toHaveClass('grid', 'grid-cols-2');
  });
});
