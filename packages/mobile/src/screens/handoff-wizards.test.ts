// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  api: vi.fn(),
  customers: [] as Array<{ id: string; displayName?: string; firstName?: string; lastName?: string }>,
  jobs: [] as Array<{ id: string; jobNumber?: string; summary?: string; status?: string }>,
  isLoading: false,
  listError: null as string | null,
  phase: 'idle' as 'idle' | 'saving' | 'saved' | 'error',
  saveError: null as string | null,
  run: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ replace: h.replace, push: vi.fn(), back: vi.fn() }),
}));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('../hooks/useListQuery', () => ({
  useListQuery: (endpoint: string) =>
    endpoint === '/api/jobs'
      ? { data: h.jobs, total: h.jobs.length, isLoading: false, error: null, refetch: vi.fn() }
      : {
          data: h.customers,
          total: h.customers.length,
          isLoading: h.isLoading,
          error: h.listError,
          refetch: vi.fn(),
        },
}));
vi.mock('../hooks/useSavePhase', () => ({
  useSavePhase: () => ({
    phase: h.phase,
    error: h.saveError,
    run: h.run,
    reset: vi.fn(),
  }),
}));
vi.mock('../api/estimates', () => ({
  createEstimate: vi.fn().mockResolvedValue({ id: 'est-1' }),
  sendEstimate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../api/invoices', () => ({
  createInvoice: vi.fn().mockResolvedValue({ id: 'inv-1' }),
  sendInvoice: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../api/jobs', () => ({
  createJob: vi.fn().mockResolvedValue({ id: 'job-1' }),
}));
vi.mock('../components/LineItemSheet', () => ({
  LineItemSheet: ({
    visible,
    onAdd,
    onClose,
  }: {
    visible: boolean;
    onAdd: (item: { description: string; quantity: number; unitPriceCents: number }) => void;
    onClose: () => void;
  }) =>
    visible
      ? createElement(
          'button',
          {
            type: 'button',
            onClick: () => {
              onAdd({ description: 'Labor', quantity: 1, unitPriceCents: 5000 });
              onClose();
            },
          },
          'Mock add item',
        )
      : null,
  LineItemList: ({ items }: { items: Array<{ description: string }> }) =>
    createElement('div', null, items.map((item) => item.description).join(', ')),
}));

// eslint-disable-next-line import/first
import NewEstimate from '../../app/estimates/new';
// eslint-disable-next-line import/first
import NewInvoice from '../../app/invoices/new';
// eslint-disable-next-line import/first
import NewJob from '../../app/jobs/new';

beforeEach(() => {
  vi.clearAllMocks();
  h.customers = [{ id: 'c1', displayName: 'Acme Plumbing' }];
  h.jobs = [{ id: 'job-1', jobNumber: 'JOB-1', summary: 'Service call', status: 'scheduled' }];
  h.isLoading = false;
  h.listError = null;
  h.phase = 'idle';
  h.saveError = null;
  h.run.mockImplementation(async (fn: () => Promise<void>) => {
    await fn();
  });
});

afterEach(() => cleanup());

describe('Handoff wizard screens', () => {
  it('NewEstimate walks through the wizard steps', async () => {
    h.customers = [{ id: 'c2', firstName: 'Beta', lastName: 'Builders' }];
    const { getByText } = render(createElement(NewEstimate));
    fireEvent.click(getByText('Beta Builders').closest('button')!);
    fireEvent.click(getByText('Next: job').closest('button')!);
    fireEvent.click(getByText(/Service call/).closest('button')!);
    fireEvent.click(getByText('Next: line items').closest('button')!);
    fireEvent.click(getByText('Add line item').closest('button')!);
    fireEvent.click(getByText('Mock add item'));
    fireEvent.click(getByText('Review').closest('button')!);
    expect(getByText(/1 line item · \$50\.00/)).toBeTruthy();
    fireEvent.click(getByText('Create & send').closest('button')!);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/estimates'));
  });

  it('NewInvoice walks through the wizard steps', async () => {
    const { getByText } = render(createElement(NewInvoice));
    fireEvent.click(getByText('Acme Plumbing').closest('button')!);
    fireEvent.click(getByText('Next: job').closest('button')!);
    fireEvent.click(getByText(/Service call/).closest('button')!);
    fireEvent.click(getByText('Next: line items').closest('button')!);
    fireEvent.click(getByText('Add line item').closest('button')!);
    fireEvent.click(getByText('Mock add item'));
    fireEvent.click(getByText('Review').closest('button')!);
    expect(getByText(/Customer: Acme Plumbing/)).toBeTruthy();
    fireEvent.click(getByText('Create & send').closest('button')!);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/invoices/inv-1'));
  });

  it('NewJob creates a job after selecting customer and summary', async () => {
    h.api.mockResolvedValue(
      new Response(JSON.stringify([{ id: 'loc-1', isPrimary: true }]), { status: 200 }),
    );
    const { getByText, getByPlaceholderText } = render(createElement(NewJob));
    fireEvent.click(getByText('Acme Plumbing').closest('button')!);
    fireEvent.change(getByPlaceholderText('What needs to be done?'), {
      target: { value: 'Replace filter' },
    });
    fireEvent.click(getByText('Create job').closest('button')!);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/jobs/job-1'));
  });
});
