/**
 * #1736 — CallReviewCard: opt-in switch, scored-call list with flagged moments,
 * "correct this call". Mocks apiFetch; asserts on the DOM, plus the mobile
 * class contract (>=44px tap targets, no horizontal overflow at 320px).
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallReviewCard } from './CallReviewCard';

const apiFetchMock = vi.fn();

vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
import { toast } from 'sonner';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const BAD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GOOD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const SCORING = {
  enabled: true,
  calls: [
    {
      sessionId: BAD,
      score: 30,
      callEndedAt: '2026-10-04T16:00:00.000Z',
      summary: 'Caller wanted Thursday; no slot was offered.',
      needsReview: true,
      items: [{ id: 'booked', verdict: 'fail', rationale: 'No slot offered' }],
      flags: [
        { kind: 'missed_opportunity', turnIndex: 0, excerpt: 'Caller: can you come Thursday? / Agent: Let me check.', note: 'No slot offered' },
        { kind: 'strength', turnIndex: 1, excerpt: 'x', note: 'Polite close' },
      ],
      correction: null,
    },
    {
      sessionId: GOOD,
      score: 100,
      callEndedAt: '2026-10-04T15:00:00.000Z',
      summary: 'Booked a flush at the catalog price.',
      needsReview: false,
      items: [],
      flags: [],
      correction: null,
    },
  ],
};

beforeEach(() => {
  apiFetchMock.mockReset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe('CallReviewCard', () => {
  it('lists only the calls that need a look, with the flagged moment, and can show every call', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(SCORING));
    render(<CallReviewCard />);

    expect(await screen.findByText('30/100')).toBeInTheDocument();
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/voice/scoring');
    expect(screen.getByText('Caller wanted Thursday; no slot was offered.')).toBeInTheDocument();
    const flags = screen.getAllByTestId('call-review-flag');
    expect(flags).toHaveLength(1); // the strength flag is not a problem to review
    expect(flags[0]).toHaveTextContent('Missed opportunity');
    expect(flags[0]).toHaveTextContent('Caller: can you come Thursday? / Agent: Let me check.');
    expect(screen.queryByText('100/100')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /showing calls to review/i }));
    expect(screen.getByText('100/100')).toBeInTheDocument();
  });

  it('is off by default: offers to turn scoring on, and turning it on PUTs the setting and reloads', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ enabled: false, calls: [] }))
      .mockResolvedValueOnce(jsonResponse({ enabled: true }))
      .mockResolvedValueOnce(jsonResponse({ enabled: true, calls: [] }));
    render(<CallReviewCard />);

    fireEvent.click(await screen.findByRole('switch', { name: /turn on call scoring/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(3));
    expect(apiFetchMock.mock.calls[1][0]).toBe('/api/voice/scoring/settings');
    expect(apiFetchMock.mock.calls[1][1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ enabled: true }) });
    expect(await screen.findByTestId('call-review-empty')).toBeInTheDocument();
  });

  it('"Correct this call" sends the chosen correction and note, then reloads', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(SCORING))
      .mockResolvedValueOnce(jsonResponse({ correction: { kind: 'should_have_booked' } }, 201))
      .mockResolvedValueOnce(jsonResponse(SCORING));
    render(<CallReviewCard />);

    fireEvent.click(await screen.findByRole('button', { name: /correct this call/i }));
    const form = screen.getByTestId('correction-form');
    fireEvent.change(within(form).getByLabelText(/what should have happened/i), {
      target: { value: 'should_have_booked' },
    });
    fireEvent.change(within(form).getByLabelText(/anything else/i), { target: { value: 'Offer Thursday morning' } });
    fireEvent.click(within(form).getByRole('button', { name: /send correction/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(3));
    expect(apiFetchMock.mock.calls[1][0]).toBe(`/api/voice/scoring/${BAD}/correct`);
    expect(JSON.parse(apiFetchMock.mock.calls[1][1].body)).toEqual({
      kind: 'should_have_booked',
      note: 'Offer Thursday morning',
    });
    expect(toast.success).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('correction-form')).not.toBeInTheDocument());
  });

  it('toasts an error and keeps the form when the correction fails', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(SCORING)).mockResolvedValueOnce(jsonResponse({}, 500));
    render(<CallReviewCard />);

    fireEvent.click(await screen.findByRole('button', { name: /correct this call/i }));
    fireEvent.click(screen.getByRole('button', { name: /send correction/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not save the correction'));
    expect(screen.getByTestId('correction-form')).toBeInTheDocument();
  });

  it('renders nothing when the API is unavailable', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}, 403));
    const { container } = render(<CallReviewCard />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  describe('mobile class contract (320px)', () => {
    it('every button and the select are >=44px tall (min-h-11), and long text wraps instead of overflowing', async () => {
      apiFetchMock.mockResolvedValueOnce(jsonResponse(SCORING));
      render(<CallReviewCard />);
      fireEvent.click(await screen.findByRole('button', { name: /correct this call/i }));

      const controls = [...screen.getAllByRole('button'), ...screen.getAllByRole('switch'), screen.getByRole('combobox')];
      expect(controls.length).toBeGreaterThanOrEqual(4);
      for (const el of new Set(controls)) expect(el.className, el.textContent ?? el.tagName).toContain('min-h-11');

      const row = screen.getByTestId('call-review-row');
      expect(row.className).toContain('flex-wrap');
      expect(row.className).toContain('min-w-0');
      expect(screen.getByTestId('call-review-flag').className).toContain('min-w-0');
      expect(screen.getByText('Caller wanted Thursday; no slot was offered.').className).toContain('break-words');
      expect(screen.getByTestId('correction-form').className).toContain('min-w-0');
    });
  });
});
