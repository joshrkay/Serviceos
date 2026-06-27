// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
  id: string;
  displayName?: string;
  jobNumber?: string;
  summary?: string;
  status?: string;
}

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  api: vi.fn(),
  params: {} as Record<string, string>,
  createEstimate: vi.fn(),
  sendEstimate: vi.fn(),
  getEstimate: vi.fn(),
  updateEstimate: vi.fn(),
  createJob: vi.fn(),
  run: vi.fn(),
  phase: 'idle' as 'idle' | 'saving' | 'saved' | 'error',
  error: null as string | null,
  customers: [] as Row[],
  jobs: [] as Row[],
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => h.params,
  useRouter: () => ({ replace: h.replace, push: h.push, back: vi.fn() }),
}));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('../hooks/useListQuery', () => ({
  useListQuery: (endpoint: string) => {
    if (endpoint === '/api/jobs') {
      return { data: h.jobs, total: h.jobs.length, isLoading: false, error: null, refetch: vi.fn() };
    }
    return { data: h.customers, total: h.customers.length, isLoading: false, error: null, refetch: vi.fn() };
  },
}));
vi.mock('../api/estimates', () => ({
  createEstimate: (...args: unknown[]) => h.createEstimate(...args),
  sendEstimate: (...args: unknown[]) => h.sendEstimate(...args),
  getEstimate: (...args: unknown[]) => h.getEstimate(...args),
  updateEstimate: (...args: unknown[]) => h.updateEstimate(...args),
}));
vi.mock('../api/jobs', () => ({
  createJob: (...args: unknown[]) => h.createJob(...args),
}));
vi.mock('../hooks/useSavePhase', () => ({
  useSavePhase: () => ({ phase: h.phase, error: h.error, run: h.run, reset: vi.fn() }),
}));
vi.mock('../components/LineItemSheet', async () => {
  const real = await vi.importActual<typeof import('../components/LineItemSheet')>(
    '../components/LineItemSheet',
  );
  return {
    ...real,
    LineItemSheet: ({ onAdd }: { onAdd: (item: unknown) => void }) =>
      createElement(
        'button',
        {
          onClick: () =>
            onAdd({ description: 'Extra', quantity: 1, unitPriceCents: 2500, catalogItemId: 'cat-9' }),
        },
        'Stub add line',
      ),
  };
});

// eslint-disable-next-line import/first
import NewEstimate from '../../app/estimates/new';

beforeEach(() => {
  vi.clearAllMocks();
  h.phase = 'idle';
  h.error = null;
  h.params = { id: 'est-draft-1' };
  h.customers = [{ id: 'c1', displayName: 'Acme Co' }];
  h.jobs = [{ id: 'job-1', jobNumber: 'JOB-9', summary: 'Fix sink', status: 'scheduled' }];
  h.run.mockImplementation(async (fn: () => Promise<void>) => {
    await fn();
  });
  // Estimate response: carries jobId + totals + lineItems but NOT customerId.
  h.getEstimate.mockResolvedValue({
    id: 'est-draft-1',
    jobId: 'job-1',
    status: 'draft',
    version: 4,
    lineItems: [
      { description: 'Labor', quantity: 2, unitPriceCents: 5000, totalCents: 10000, catalogItemId: 'cat-1' },
    ],
    totals: { discountCents: 500, taxRateBps: 825 },
    customerMessage: 'Thanks!',
  });
  // Customer is resolved via the job → customer lookup.
  h.api.mockImplementation(async (path: string) => {
    if (path === '/api/jobs/job-1') {
      return new Response(JSON.stringify({ id: 'job-1', customerId: 'c1' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  h.updateEstimate.mockResolvedValue({ id: 'est-draft-1' });
});

afterEach(() => cleanup());

describe('Estimate edit screen — draft hydration', () => {
  it('GETs the estimate by id and hydrates line items with exact integer cents', async () => {
    const { getByText } = render(createElement(NewEstimate));

    await waitFor(() => expect(h.getEstimate).toHaveBeenCalledWith(h.api, 'est-draft-1'));
    // Lands on the line-item step with the draft's item shown (cents round-tripped).
    await waitFor(() => expect(getByText('Labor')).toBeTruthy());
    // 5000 cents → "$50" at list altitude (formatMoneyShort). Exact-cents
    // preservation is pinned on the save path (updateEstimate sends 5000).
    expect(getByText(/2 × \$50/)).toBeTruthy();
    // Title reflects editing, not a new estimate.
    expect(getByText('Edit estimate')).toBeTruthy();
  });

  it('resolves customerId from the job → customer lookup (estimate has no customerId)', async () => {
    render(createElement(NewEstimate));
    await waitFor(() => expect(h.api).toHaveBeenCalledWith('/api/jobs/job-1'));
  });

  it('saves via updateEstimate (PATCH) with expectedVersion and updated items — not create', async () => {
    const { getByText } = render(createElement(NewEstimate));
    await waitFor(() => expect(getByText('Labor')).toBeTruthy());

    // Add a line item, then go to review and save.
    fireEvent.click(getByText('Stub add line'));
    fireEvent.click(getByText('Review').closest('button')!);
    fireEvent.click(getByText('Save changes').closest('button')!);

    await waitFor(() =>
      expect(h.updateEstimate).toHaveBeenCalledWith(h.api, 'est-draft-1', {
        lineItems: [
          { catalogItemId: 'cat-1', description: 'Labor', quantity: 2, unitPriceCents: 5000 },
          { description: 'Extra', quantity: 1, unitPriceCents: 2500, catalogItemId: 'cat-9' },
        ],
        discountCents: 500,
        taxRateBps: 825,
        customerMessage: 'Thanks!',
        expectedVersion: 4,
      }),
    );
    expect(h.createEstimate).not.toHaveBeenCalled();
    expect(h.sendEstimate).not.toHaveBeenCalled();
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/estimates'));
  });

  it('surfaces the server edit-lock error (deposit paid) instead of silently failing', async () => {
    // Simulate the deposit-paid lock: useSavePhase surfaces the thrown message.
    h.phase = 'error';
    h.error = 'Estimate is locked: a deposit has already been paid. Clone it to a new estimate to make changes.';
    const { getByText } = render(createElement(NewEstimate));
    await waitFor(() => expect(getByText('Labor')).toBeTruthy());

    fireEvent.click(getByText('Review').closest('button')!);
    expect(getByText(/a deposit has already been paid/)).toBeTruthy();
  });

  it('surfaces a hydrate error when the draft fails to load', async () => {
    h.getEstimate.mockRejectedValueOnce(new Error('Draft not found'));
    const { getByText } = render(createElement(NewEstimate));
    await waitFor(() => expect(getByText('Draft not found')).toBeTruthy());
  });

  it('opens a blank create form (no GET) when no id param is present', () => {
    h.params = {};
    const { getByText } = render(createElement(NewEstimate));
    expect(h.getEstimate).not.toHaveBeenCalled();
    expect(getByText('New estimate')).toBeTruthy();
    expect(getByText('Pick a customer')).toBeTruthy();
  });
});
