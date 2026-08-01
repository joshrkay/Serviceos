/**
 * U6 — inbox review-response approval card.
 *
 * A `review_response_proposal`'s components are drafted `approved: false`
 * and the execution handler dispatches PER FLAG, so before this card the
 * draft dead-ended: nothing rendered the reply text, and a bare approve
 * would have "succeeded" while posting nothing. These tests pin:
 *   - the drafted public reply (the words that go public) renders verbatim,
 *     with the follow-up body and the credit amount;
 *   - Approve PUTs the flag flips through the EXISTING edit endpoint BEFORE
 *     POSTing the approval (same order contract as the address completion);
 *   - excluded components keep `approved: false` (mix-and-match);
 *   - approving with nothing selected is blocked, not a silent no-op;
 *   - the CLAUDE.md mobile class contract (min-h-11 targets, wrap-safe
 *     draft text) — the Playwright viewport spec measures the pixels
 *     (e2e/review-response-approval-mobile.spec.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { InboxPage } from './InboxPage';
import {
  anyReviewComponentSelected,
  initialReviewResponseSelection,
  reviewResponseEditsFrom,
} from './ReviewResponseReview';

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

const DRAFT_REPLY =
  'Thanks so much for the kind words, Dana — the team loved working on your tankless install!';
const FOLLOWUP_BODY = 'Hi Dana, thank you again — call us any time if the unit needs a look.';

/** Full 3-component payload exactly as `reputation/build-proposal.ts` drafts
 *  it: every `approved` flag false. */
function fullPayload() {
  return {
    reviewId: 'rev-1',
    classification: 'praise',
    publicResponse: { text: DRAFT_REPLY, approved: false },
    privateFollowUp: {
      customerId: 'c0000000-0000-4000-8000-000000000001',
      channel: 'sms',
      body: FOLLOWUP_BODY,
      approved: false,
    },
    serviceCredit: {
      customerId: 'c0000000-0000-4000-8000-000000000001',
      amountCents: 2500,
      approved: false,
    },
  };
}

function inboxWith(
  payload: Record<string, unknown>,
  proposalType = 'review_response_proposal',
) {
  return jsonResponse({
    data: [
      {
        proposal: {
          id: 'p-rev',
          proposalType,
          summary: 'Respond to Dana Diaz’s 5-star review',
          status: 'ready_for_review',
          createdAt: new Date().toISOString(),
          payload,
        },
        urgency: 'normal',
        reason: 'Awaiting review',
      },
    ],
    summary: {
      totalCount: 1,
      criticalCount: 0,
      highCount: 0,
      normalCount: 1,
      lowCount: 0,
      truncated: false,
    },
  });
}

describe('InboxPage — review-response approval card', () => {
  beforeEach(() => apiFetch.mockReset());

  it('renders the drafted reply, follow-up, credit, and classification', async () => {
    apiFetch.mockResolvedValueOnce(inboxWith(fullPayload()));
    render(<InboxPage />);

    await waitFor(() =>
      expect(screen.getByTestId('review-response-review')).toBeInTheDocument(),
    );
    // The exact words that will post publicly, verbatim.
    expect(screen.getByTestId('review-public-draft')).toHaveTextContent(DRAFT_REPLY);
    expect(screen.getByTestId('review-private-draft')).toHaveTextContent(FOLLOWUP_BODY);
    expect(screen.getByTestId('review-classification')).toHaveTextContent('Praise');
    // Integer cents → display dollars ($25.00, never float math).
    expect(screen.getByLabelText(/Apply \$25\.00 service credit/)).toBeInTheDocument();
    // Everything the draft carries is included by default.
    const toggles = screen.getAllByTestId('review-component-toggle');
    expect(toggles).toHaveLength(3);
    for (const checkbox of screen.getAllByRole('checkbox')) {
      expect(checkbox).toBeChecked();
    }
  });

  it('renders no card on other proposal types even if keys collide', async () => {
    apiFetch.mockResolvedValueOnce(
      inboxWith({ publicResponse: { text: 'not a review reply' } }, 'create_customer'),
    );
    render(<InboxPage />);
    await waitFor(() => expect(screen.getAllByTestId('inbox-row')).toHaveLength(1));
    expect(screen.queryByTestId('review-response-review')).toBeNull();
  });

  it('renders no card when the payload carries no reply text (malformed-safe)', async () => {
    apiFetch.mockResolvedValueOnce(inboxWith({ publicResponse: { text: '   ' } }));
    render(<InboxPage />);
    await waitFor(() => expect(screen.getAllByTestId('inbox-row')).toHaveLength(1));
    expect(screen.queryByTestId('review-response-review')).toBeNull();
  });

  it('PUTs the approved-flag flips BEFORE POSTing the approval', async () => {
    apiFetch
      .mockResolvedValueOnce(inboxWith(fullPayload()))
      .mockResolvedValueOnce(jsonResponse({ ok: true })) // PUT edit
      .mockResolvedValue(jsonResponse({ id: 'p-rev', status: 'approved' }));

    render(<InboxPage />);
    await waitFor(() =>
      expect(screen.getByTestId('review-response-review')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(apiFetch.mock.calls.some((c) => c[0] === '/api/proposals/p-rev/approve')).toBe(true),
    );

    const editIndex = apiFetch.mock.calls.findIndex(
      (c) => c[0] === '/api/proposals/p-rev' && c[1]?.method === 'PUT',
    );
    const approveIndex = apiFetch.mock.calls.findIndex(
      (c) => c[0] === '/api/proposals/p-rev/approve',
    );
    // The approve endpoint applies the proposal AS STORED — the flag flips
    // must land first or the handler executes nothing.
    expect(editIndex).toBeGreaterThanOrEqual(0);
    expect(editIndex).toBeLessThan(approveIndex);

    // Components ride WHOLE (the edit endpoint re-validates the merged
    // payload against the Zod contract), flags flipped verbatim.
    const payload = fullPayload();
    expect(JSON.parse(apiFetch.mock.calls[editIndex][1].body as string)).toEqual({
      edits: {
        publicResponse: { ...payload.publicResponse, approved: true },
        privateFollowUp: { ...payload.privateFollowUp, approved: true },
        serviceCredit: { ...payload.serviceCredit, approved: true },
      },
    });
    expect(apiFetch.mock.calls[approveIndex][1].method).toBe('POST');
  });

  it('keeps an excluded component at approved:false (mix-and-match)', async () => {
    apiFetch
      .mockResolvedValueOnce(inboxWith(fullPayload()))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValue(jsonResponse({ id: 'p-rev', status: 'approved' }));

    render(<InboxPage />);
    await waitFor(() =>
      expect(screen.getByTestId('review-response-review')).toBeInTheDocument(),
    );
    // Post the reply and send the follow-up, but skip the credit.
    fireEvent.click(screen.getByLabelText(/Apply \$25\.00 service credit/));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(apiFetch.mock.calls.some((c) => c[0] === '/api/proposals/p-rev/approve')).toBe(true),
    );
    const editIndex = apiFetch.mock.calls.findIndex(
      (c) => c[0] === '/api/proposals/p-rev' && c[1]?.method === 'PUT',
    );
    const payload = fullPayload();
    // The credit's stored flag is already false — no edit for it at all.
    expect(JSON.parse(apiFetch.mock.calls[editIndex][1].body as string)).toEqual({
      edits: {
        publicResponse: { ...payload.publicResponse, approved: true },
        privateFollowUp: { ...payload.privateFollowUp, approved: true },
      },
    });
  });

  it('approves a public-only draft (null follow-up and credit)', async () => {
    apiFetch
      .mockResolvedValueOnce(
        inboxWith({
          reviewId: 'rev-1',
          classification: 'vague_complaint',
          publicResponse: { text: DRAFT_REPLY, approved: false },
          privateFollowUp: null,
          serviceCredit: null,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValue(jsonResponse({ id: 'p-rev', status: 'approved' }));

    render(<InboxPage />);
    await waitFor(() =>
      expect(screen.getByTestId('review-response-review')).toBeInTheDocument(),
    );
    expect(screen.getAllByTestId('review-component-toggle')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(apiFetch.mock.calls.some((c) => c[0] === '/api/proposals/p-rev/approve')).toBe(true),
    );
    const editIndex = apiFetch.mock.calls.findIndex(
      (c) => c[0] === '/api/proposals/p-rev' && c[1]?.method === 'PUT',
    );
    expect(JSON.parse(apiFetch.mock.calls[editIndex][1].body as string)).toEqual({
      edits: { publicResponse: { text: DRAFT_REPLY, approved: true } },
    });
  });

  it('blocks approve when every component is excluded — never a silent no-op', async () => {
    apiFetch.mockResolvedValueOnce(inboxWith(fullPayload()));
    render(<InboxPage />);
    await waitFor(() =>
      expect(screen.getByTestId('review-response-review')).toBeInTheDocument(),
    );

    for (const checkbox of screen.getAllByRole('checkbox')) {
      fireEvent.click(checkbox);
    }
    expect(screen.getByTestId('review-nothing-selected')).toBeInTheDocument();

    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve).toBeDisabled();
    fireEvent.click(approve);
    // Only the initial inbox GET — no PUT, no approve POST.
    expect(apiFetch).toHaveBeenCalledTimes(1);
    // The row is still there for a reject instead.
    expect(screen.getAllByTestId('inbox-row')).toHaveLength(1);
  });

  it('restores the row and does not approve when saving the flags fails', async () => {
    apiFetch
      .mockResolvedValueOnce(inboxWith(fullPayload()))
      .mockResolvedValueOnce(jsonResponse({ error: 'nope' }, { status: 400 }));

    render(<InboxPage />);
    await waitFor(() =>
      expect(screen.getByTestId('review-response-review')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(apiFetch.mock.calls.some((c) => String(c[0]).endsWith('/approve'))).toBe(false);
    await waitFor(() => expect(screen.getAllByTestId('inbox-row')).toHaveLength(1));
  });

  it('rejects through the plain reject endpoint with no edit', async () => {
    // The reject triggers a background inbox reload (emitProposalsChanged),
    // so the catch-all mock must stay inbox-shaped for the re-fetch.
    apiFetch
      .mockResolvedValueOnce(inboxWith(fullPayload()))
      .mockResolvedValueOnce(jsonResponse({ id: 'p-rev', status: 'rejected' }))
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            data: [],
            summary: {
              totalCount: 0,
              criticalCount: 0,
              highCount: 0,
              normalCount: 0,
              lowCount: 0,
              truncated: false,
            },
          }),
        ),
      );

    render(<InboxPage />);
    await waitFor(() =>
      expect(screen.getByTestId('review-response-review')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() =>
      expect(apiFetch.mock.calls.some((c) => c[0] === '/api/proposals/p-rev/reject')).toBe(true),
    );
    expect(apiFetch.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(false);
  });

  it('meets the mobile class contract: min-h-11 targets and wrap-safe draft text', async () => {
    // CLAUDE.md mobile rules — ≥44px tap targets, no horizontal overflow at
    // 320px. jsdom can't measure pixels, so this pins the class contract; the
    // Playwright spec (e2e/review-response-approval-mobile.spec.ts) measures.
    apiFetch.mockResolvedValueOnce(inboxWith(fullPayload()));
    render(<InboxPage />);
    await waitFor(() =>
      expect(screen.getByTestId('review-response-review')).toBeInTheDocument(),
    );

    for (const toggle of screen.getAllByTestId('review-component-toggle')) {
      expect(toggle.className).toContain('min-h-11');
    }
    expect(screen.getByRole('button', { name: 'Approve' }).className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: 'Reject' }).className).toContain('min-h-11');

    // A long unbroken token in the reply must wrap, not push the row wide.
    const draft = screen.getByTestId('review-public-draft');
    expect(draft.className).toContain('break-words');
    expect(draft.className).toContain('whitespace-pre-wrap');
  });
});

describe('review-response pure helpers', () => {
  it('defaults the selection to every component the draft carries', () => {
    expect(initialReviewResponseSelection(fullPayload())).toEqual({
      publicResponse: true,
      privateFollowUp: true,
      serviceCredit: true,
    });
    expect(
      initialReviewResponseSelection({
        publicResponse: { text: 'hi', approved: false },
        privateFollowUp: null,
        serviceCredit: null,
      }),
    ).toEqual({ publicResponse: true, privateFollowUp: false, serviceCredit: false });
  });

  it('returns null edits when every stored flag already matches the selection', () => {
    const payload = fullPayload();
    payload.publicResponse.approved = true;
    payload.privateFollowUp.approved = true;
    payload.serviceCredit.approved = true;
    expect(
      reviewResponseEditsFrom(payload, {
        publicResponse: true,
        privateFollowUp: true,
        serviceCredit: true,
      }),
    ).toBeNull();
  });

  it('never counts a selection against an absent component', () => {
    expect(
      anyReviewComponentSelected(
        { publicResponse: { text: '', approved: false }, privateFollowUp: null, serviceCredit: null },
        { publicResponse: true, privateFollowUp: true, serviceCredit: true },
      ),
    ).toBe(false);
  });
});
