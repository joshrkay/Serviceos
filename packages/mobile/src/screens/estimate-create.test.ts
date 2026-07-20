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
  api: vi.fn(),
  createEstimate: vi.fn(),
  sendEstimate: vi.fn(),
  createJob: vi.fn(),
  run: vi.fn(),
  phase: 'idle' as 'idle' | 'saving' | 'saved' | 'error',
  error: null as string | null,
  customers: [] as Row[],
  jobs: [] as Row[],
  jobsRefetch: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ replace: h.replace, push: vi.fn(), back: vi.fn() }),
}));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('../hooks/useListQuery', () => ({
  useListQuery: (endpoint: string) => {
    if (endpoint === '/api/jobs') {
      return { data: h.jobs, total: h.jobs.length, isLoading: false, error: null, refetch: h.jobsRefetch };
    }
    return { data: h.customers, total: h.customers.length, isLoading: false, error: null, refetch: vi.fn() };
  },
}));
vi.mock('../api/estimates', () => ({
  createEstimate: (...args: unknown[]) => h.createEstimate(...args),
  sendEstimate: (...args: unknown[]) => h.sendEstimate(...args),
}));
vi.mock('../api/jobs', () => ({
  createJob: (...args: unknown[]) => h.createJob(...args),
}));
vi.mock('../hooks/useSavePhase', () => ({
  useSavePhase: () => ({ phase: h.phase, error: h.error, run: h.run, reset: vi.fn() }),
}));
// Stub the catalog sheet so a test can add a grounded line item with one tap.
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
            onAdd({ description: 'Labor', quantity: 2, unitPriceCents: 5000, catalogItemId: 'cat-1' }),
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
  h.customers = [{ id: 'c1', displayName: 'Acme Co' }];
  h.jobs = [{ id: 'job-1', jobNumber: 'JOB-9', summary: 'Fix sink', status: 'scheduled' }];
  h.run.mockImplementation(async (fn: () => Promise<void>) => {
    await fn();
  });
  h.createEstimate.mockResolvedValue({ id: 'est-new' });
  h.sendEstimate.mockResolvedValue(undefined);
  h.createJob.mockResolvedValue({ id: 'job-new' });
});

afterEach(() => cleanup());

function pickCustomerThenJob(getByText: (t: string | RegExp) => HTMLElement) {
  fireEvent.click(getByText('Acme Co').closest('button')!);
  fireEvent.click(getByText('Next: job').closest('button')!);
}

describe('New estimate screen — job selection', () => {
  it('requires a customer before advancing to the job step', () => {
    const { getByText } = render(createElement(NewEstimate));
    expect(getByText('Next: job').closest('button')!.disabled).toBe(true);
  });

  it('blocks advancing past the job step until a job is selected', () => {
    const { getByText } = render(createElement(NewEstimate));
    pickCustomerThenJob(getByText);
    expect(getByText('Next: line items').closest('button')!.disabled).toBe(true);
    fireEvent.click(getByText(/Fix sink/).closest('button')!);
    expect(getByText('Next: line items').closest('button')!.disabled).toBe(false);
  });

  it('creates with jobId + unitPriceCents (no customerId) and sends', async () => {
    const { getByText } = render(createElement(NewEstimate));
    pickCustomerThenJob(getByText);
    fireEvent.click(getByText(/Fix sink/).closest('button')!);
    fireEvent.click(getByText('Next: line items').closest('button')!);
    fireEvent.click(getByText('Stub add line'));
    fireEvent.click(getByText('Review').closest('button')!);
    fireEvent.click(getByText('Create & send').closest('button')!);

    await waitFor(() =>
      expect(h.createEstimate).toHaveBeenCalledWith(h.api, {
        jobId: 'job-1',
        lineItems: [
          { description: 'Labor', quantity: 2, unitPriceCents: 5000, catalogItemId: 'cat-1' },
        ],
      }),
    );
    const [, input] = h.createEstimate.mock.calls[0] as [unknown, { jobId: string }];
    expect(input).not.toHaveProperty('customerId');
    await waitFor(() => expect(h.sendEstimate).toHaveBeenCalledWith(h.api, 'est-new'));
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/estimates'));
  });

  it('offers a create-job affordance when the customer has no jobs', async () => {
    h.jobs = [];
    const { getByText, container } = render(createElement(NewEstimate));
    pickCustomerThenJob(getByText);
    expect(getByText(/No jobs for this customer yet/)).toBeTruthy();
    const createBtn = getByText('+ Create a job for this customer').closest('button')!;
    expect(createBtn.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(createBtn);

    const input = container.querySelector('textarea, input')!;
    fireEvent.change(input, { target: { value: 'Replace faucet' } });
    h.api.mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: 'loc-1', isPrimary: true }]), { status: 200 }),
    );
    fireEvent.click(getByText('Create job').closest('button')!);

    await waitFor(() =>
      expect(h.createJob).toHaveBeenCalledWith(h.api, {
        customerId: 'c1',
        locationId: 'loc-1',
        summary: 'Replace faucet',
      }),
    );
  });

  it('builds a two-tier (good-better-best) estimate as a mutually-exclusive group', async () => {
    const { getByText } = render(createElement(NewEstimate));
    pickCustomerThenJob(getByText);
    fireEvent.click(getByText(/Fix sink/).closest('button')!);
    fireEvent.click(getByText('Next: line items').closest('button')!);

    // Turn on tier mode, then fill the Good and Better tiers via the catalog sheet.
    fireEvent.click(getByText('Offer good / better / best options').closest('button')!);
    fireEvent.click(getByText('Add Good item').closest('button')!);
    fireEvent.click(getByText('Stub add line'));
    fireEvent.click(getByText('Better').closest('button')!);
    fireEvent.click(getByText('Add Better item').closest('button')!);
    fireEvent.click(getByText('Stub add line'));

    fireEvent.click(getByText('Review').closest('button')!);
    fireEvent.click(getByText('Create & send').closest('button')!);

    await waitFor(() => expect(h.createEstimate).toHaveBeenCalled());
    const [, input] = h.createEstimate.mock.calls[0] as [
      unknown,
      { jobId: string; lineItems: Array<Record<string, unknown>> },
    ];
    expect(input.jobId).toBe('job-1');
    expect(input.lineItems).toHaveLength(2);
    // Both tiers share the group key and are selectable options...
    for (const li of input.lineItems) {
      expect(li.groupKey).toBe('tier');
      expect(li.isOptional).toBe(true);
    }
    // ...with exactly one default (the first/Good tier).
    expect(input.lineItems.filter((li) => li.isDefaultSelected === true)).toHaveLength(1);
    expect(input.lineItems[0].isDefaultSelected).toBe(true);
    await waitFor(() => expect(h.sendEstimate).toHaveBeenCalledWith(h.api, 'est-new'));
  });

  it('keeps Review disabled until at least two tiers are filled', () => {
    const { getByText } = render(createElement(NewEstimate));
    pickCustomerThenJob(getByText);
    fireEvent.click(getByText(/Fix sink/).closest('button')!);
    fireEvent.click(getByText('Next: line items').closest('button')!);
    fireEvent.click(getByText('Offer good / better / best options').closest('button')!);
    // No tiers filled yet → Review blocked.
    expect(getByText('Review').closest('button')!.disabled).toBe(true);
    fireEvent.click(getByText('Add Good item').closest('button')!);
    fireEvent.click(getByText('Stub add line'));
    // One tier filled is still not a group → still blocked.
    expect(getByText('Review').closest('button')!.disabled).toBe(true);
  });

  it('renders tier tabs as >=44px tap targets', () => {
    const { getByText } = render(createElement(NewEstimate));
    pickCustomerThenJob(getByText);
    fireEvent.click(getByText(/Fix sink/).closest('button')!);
    fireEvent.click(getByText('Next: line items').closest('button')!);
    fireEvent.click(getByText('Offer good / better / best options').closest('button')!);
    for (const label of ['Good', 'Better', 'Best']) {
      expect(getByText(label).closest('button')!.className).toMatch(/\bmin-h-11\b/);
    }
  });

  it('surfaces a create error on the save button', () => {
    h.phase = 'error';
    h.error = 'createEstimate: 400';
    const { getByText } = render(createElement(NewEstimate));
    pickCustomerThenJob(getByText);
    fireEvent.click(getByText(/Fix sink/).closest('button')!);
    fireEvent.click(getByText('Next: line items').closest('button')!);
    fireEvent.click(getByText('Stub add line'));
    fireEvent.click(getByText('Review').closest('button')!);
    expect(getByText('createEstimate: 400')).toBeTruthy();
  });
});
