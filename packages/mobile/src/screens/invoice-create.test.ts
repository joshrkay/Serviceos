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
  createInvoice: vi.fn(),
  sendInvoice: vi.fn(),
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
vi.mock('../api/invoices', () => ({
  createInvoice: (...args: unknown[]) => h.createInvoice(...args),
  sendInvoice: (...args: unknown[]) => h.sendInvoice(...args),
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
            onAdd({ description: 'Service call', quantity: 1, unitPriceCents: 9900, catalogItemId: 'cat-2' }),
        },
        'Stub add line',
      ),
  };
});

// eslint-disable-next-line import/first
import NewInvoice from '../../app/invoices/new';

beforeEach(() => {
  vi.clearAllMocks();
  h.phase = 'idle';
  h.error = null;
  h.customers = [{ id: 'c1', displayName: 'Acme Co' }];
  h.jobs = [{ id: 'job-1', jobNumber: 'JOB-9', summary: 'Fix sink', status: 'scheduled' }];
  h.run.mockImplementation(async (fn: () => Promise<void>) => {
    await fn();
  });
  h.createInvoice.mockResolvedValue({ id: 'inv-new' });
  h.sendInvoice.mockResolvedValue(undefined);
  h.createJob.mockResolvedValue({ id: 'job-new' });
});

afterEach(() => cleanup());

function pickCustomerThenJob(getByText: (t: string | RegExp) => HTMLElement) {
  fireEvent.click(getByText('Acme Co').closest('button')!);
  fireEvent.click(getByText('Next: job').closest('button')!);
}

describe('New invoice screen — job selection', () => {
  it('blocks advancing past the job step until a job is selected', () => {
    const { getByText } = render(createElement(NewInvoice));
    pickCustomerThenJob(getByText);
    expect(getByText('Next: line items').closest('button')!.disabled).toBe(true);
    fireEvent.click(getByText(/Fix sink/).closest('button')!);
    expect(getByText('Next: line items').closest('button')!.disabled).toBe(false);
  });

  it('creates with jobId + unitPriceCents (no customerId), sends, then opens the detail', async () => {
    const { getByText } = render(createElement(NewInvoice));
    pickCustomerThenJob(getByText);
    fireEvent.click(getByText(/Fix sink/).closest('button')!);
    fireEvent.click(getByText('Next: line items').closest('button')!);
    fireEvent.click(getByText('Stub add line'));
    fireEvent.click(getByText('Review').closest('button')!);
    fireEvent.click(getByText('Create & send').closest('button')!);

    await waitFor(() =>
      expect(h.createInvoice).toHaveBeenCalledWith(h.api, {
        jobId: 'job-1',
        lineItems: [
          { description: 'Service call', quantity: 1, unitPriceCents: 9900, catalogItemId: 'cat-2' },
        ],
      }),
    );
    const [, input] = h.createInvoice.mock.calls[0] as [unknown, { jobId: string }];
    expect(input).not.toHaveProperty('customerId');
    await waitFor(() => expect(h.sendInvoice).toHaveBeenCalledWith(h.api, 'inv-new'));
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/invoices/inv-new'));
  });

  it('offers a create-job affordance when the customer has no jobs', async () => {
    h.jobs = [];
    const { getByText, container } = render(createElement(NewInvoice));
    pickCustomerThenJob(getByText);
    const createBtn = getByText('+ Create a job for this customer').closest('button')!;
    fireEvent.click(createBtn);
    const jobInput = container.querySelector('textarea, input')!;
    fireEvent.change(jobInput, { target: { value: 'Annual service' } });
    h.api.mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: 'loc-1', isPrimary: true }]), { status: 200 }),
    );
    fireEvent.click(getByText('Create job').closest('button')!);

    await waitFor(() =>
      expect(h.createJob).toHaveBeenCalledWith(h.api, {
        customerId: 'c1',
        locationId: 'loc-1',
        summary: 'Annual service',
      }),
    );
  });

  it('surfaces a create error on the save button', () => {
    h.phase = 'error';
    h.error = 'createInvoice: 400';
    const { getByText } = render(createElement(NewInvoice));
    pickCustomerThenJob(getByText);
    fireEvent.click(getByText(/Fix sink/).closest('button')!);
    fireEvent.click(getByText('Next: line items').closest('button')!);
    fireEvent.click(getByText('Stub add line'));
    fireEvent.click(getByText('Review').closest('button')!);
    expect(getByText('createInvoice: 400')).toBeTruthy();
  });
});
