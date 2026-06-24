// @vitest-environment jsdom
// Screen tests live under src/ (NOT app/) so expo-router's file-based routing
// doesn't treat them as routes and Metro doesn't bundle vitest into the app.
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MoneySummary } from '../hooks/useMoneyDashboard';
import type { PendingProposalSummary } from '../proposals/proposalEvents';

const h = vi.hoisted(() => ({
  push: vi.fn(),
  showErrorToast: vi.fn(),
  refetch: vi.fn(),
  switchMode: vi.fn().mockResolvedValue(undefined),
  me: {
    user_id: 'u',
    tenant_id: 't1',
    role: 'supervisor',
    can_field_serve: true,
    current_mode: 'both',
    mode_changed_at: null,
    permissions: [] as string[],
    backup_supervisor_user_id: null,
    unsupervised_proposal_routing: 'queue_only' as const,
  } as unknown,
  isLoading: false,
  error: null as Error | null,
  // approvals
  approvalsCount: 0,
  proposals: [] as PendingProposalSummary[],
  // money
  summary: {
    month: '2026-06',
    revenueCents: 1_250_000,
    outstandingCents: 340_000,
    overdueCents: 50_000,
    revenueTrendCents: 120_000,
  } as MoneySummary | null,
  moneyLoading: false,
  moneyError: null as string | null,
  notConfigured: false,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: h.push, back: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../components/Toast', () => ({
  useToast: () => ({ showToast: vi.fn(), showErrorToast: h.showErrorToast, hideToast: vi.fn() }),
}));
vi.mock('../lib/useReconnectRetry', () => ({ useReconnectRetry: vi.fn() }));
vi.mock('../push/pushStatusContext', () => ({ usePushStatus: () => null }));
vi.mock('../hooks/useMe', () => ({
  useMe: () => ({
    me: h.me,
    isLoading: h.isLoading,
    error: h.error,
    switchMode: h.switchMode,
    refetch: h.refetch,
  }),
}));
vi.mock('../hooks/usePendingProposals', () => ({
  usePendingProposals: () => ({
    count: h.approvalsCount,
    proposals: h.proposals,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock('../hooks/useMoneyDashboard', () => ({
  useMoneyDashboard: () => ({
    summary: h.summary,
    isLoading: h.moneyLoading,
    error: h.moneyError,
    notConfigured: h.notConfigured,
  }),
}));

// eslint-disable-next-line import/first
import Home from '../../app/index';

beforeEach(() => {
  vi.clearAllMocks();
  h.isLoading = false;
  h.error = null;
  h.switchMode = vi.fn().mockResolvedValue(undefined);
  h.approvalsCount = 0;
  h.proposals = [];
  h.summary = {
    month: '2026-06',
    revenueCents: 1_250_000,
    outstandingCents: 340_000,
    overdueCents: 50_000,
    revenueTrendCents: 120_000,
  };
  h.moneyLoading = false;
  h.moneyError = null;
  h.notConfigured = false;
});

afterEach(() => cleanup());

describe('Home / Today dashboard', () => {
  it('greets by time of day with the date', () => {
    const { getByText } = render(createElement(Home));
    expect(getByText(/^Good (morning|afternoon|evening)$/)).toBeTruthy();
  });

  it('renders every tap target at the >=44px contract (min-h-11)', () => {
    const { container } = render(createElement(Home));
    const buttons = Array.from(container.querySelectorAll('button'));
    // speak + approval-inbox + money + 3 modes + 4 quick links
    expect(buttons.length).toBeGreaterThanOrEqual(8);
    for (const b of buttons) {
      expect(b.className).toMatch(/\bmin-h-11\b/);
    }
  });

  it('navigates to the voice screen from "Speak an action"', () => {
    fireEvent.click(render(createElement(Home)).getByText('Speak an action').closest('button')!);
    expect(h.push).toHaveBeenCalledWith('/voice');
  });

  it('shows the live approval count and opens the inbox', () => {
    h.approvalsCount = 3;
    const { getByText } = render(createElement(Home));
    expect(getByText('3 waiting for your tap')).toBeTruthy();
    expect(getByText('3')).toBeTruthy(); // badge
    fireEvent.click(getByText('Approval inbox').closest('button')!);
    expect(h.push).toHaveBeenCalledWith('/approvals');
  });

  it('previews the top of the queue and opens a proposal for review', () => {
    h.approvalsCount = 2;
    h.proposals = [
      { id: 'p1', summary: 'Invoice · Smith $197', proposalType: 'send_invoice', createdAt: '2026-06-20T00:00:00Z' },
      { id: 'p2', summary: 'Job · Mrs. Lee tune-up', proposalType: 'create_appointment', createdAt: '2026-06-20T00:00:00Z' },
    ];
    const { getByText, getAllByText } = render(createElement(Home));
    expect(getByText('Invoice · Smith $197')).toBeTruthy();
    expect(getByText('Job · Mrs. Lee tune-up')).toBeTruthy();
    expect(getAllByText('Review').length).toBe(2);
    fireEvent.click(getByText('Invoice · Smith $197').closest('button')!);
    expect(h.push).toHaveBeenCalledWith('/proposals/p1');
  });

  it('caps the preview at three rows even when more are pending', () => {
    h.approvalsCount = 5;
    h.proposals = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`,
      summary: `Proposal ${i}`,
      proposalType: 'add_note',
      createdAt: '2026-06-20T00:00:00Z',
    }));
    const { getAllByText, queryByText } = render(createElement(Home));
    expect(getAllByText('Review').length).toBe(3);
    expect(queryByText('Proposal 4')).toBeNull();
  });

  it('shows the caught-up state with no badge when nothing is waiting', () => {
    h.approvalsCount = 0;
    const { getByText, queryByText } = render(createElement(Home));
    expect(getByText(/caught up/)).toBeTruthy();
    expect(queryByText('0')).toBeNull(); // no badge at zero
  });

  it('caps the badge at 9+', () => {
    h.approvalsCount = 12;
    const { getByText } = render(createElement(Home));
    expect(getByText('9+')).toBeTruthy();
  });

  it('renders this month money (rounded dollars + trend) and opens invoices', () => {
    const { getByText } = render(createElement(Home));
    expect(getByText(/\$12,500 collected \(\+\$1,200 vs last month\)/)).toBeTruthy();
    expect(getByText(/\$3,400 outstanding.*\$500 overdue/)).toBeTruthy();
    fireEvent.click(getByText('This month').closest('button')!);
    expect(h.push).toHaveBeenCalledWith('/invoices');
  });

  it('hides the money card entirely when the report is not configured', () => {
    h.notConfigured = true;
    const { queryByText } = render(createElement(Home));
    expect(queryByText('This month')).toBeNull();
  });

  it('surfaces a money load failure without breaking the screen', () => {
    h.summary = null;
    h.moneyError = 'HTTP 500';
    const { getByText } = render(createElement(Home));
    expect(getByText(/Couldn.t load money summary/)).toBeTruthy();
  });

  it('navigates to the quick-link read screens not on the tab bar', () => {
    const { getByText } = render(createElement(Home));
    fireEvent.click(getByText('Schedule').closest('button')!);
    expect(h.push).toHaveBeenCalledWith('/schedule');
    fireEvent.click(getByText('Estimates').closest('button')!);
    expect(h.push).toHaveBeenCalledWith('/estimates');
  });

  it('shows a loading spinner and no actions while /api/me is loading', () => {
    h.isLoading = true;
    const { container } = render(createElement(Home));
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('renders a friendly error state with a Retry when /api/me fails', () => {
    h.error = new Error('me failed');
    const { getByText } = render(createElement(Home));
    // copyForError surfaces the message as the body; the Retry calls refetch.
    expect(getByText('me failed')).toBeTruthy();
    const retry = getByText('Try again').closest('button')!;
    expect(retry.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(retry);
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces a mode-switch failure as a toast instead of swallowing it', async () => {
    const failure = new Error('Not allowed for your role');
    h.switchMode = vi.fn().mockRejectedValue(failure);
    const { getByText } = render(createElement(Home));
    fireEvent.click(getByText('tech').closest('button')!);
    await waitFor(() => expect(h.showErrorToast).toHaveBeenCalledWith(failure));
  });
});
