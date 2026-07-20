// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Lead {
  id: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  primaryPhone?: string;
  email?: string;
  source?: string;
  stage?: string;
  convertedCustomerId?: string;
}

const h = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  api: vi.fn(),
  showToast: vi.fn(),
  refetch: vi.fn().mockResolvedValue(undefined),
  convertLead: vi.fn(),
  markLeadLost: vi.fn(),
  data: null as Lead | null,
  isLoading: false,
  error: null as string | null,
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'l1' }),
  useRouter: () => ({ push: h.push, back: h.back, replace: vi.fn() }),
}));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('../components/Toast', () => ({
  useToast: () => ({ showToast: h.showToast, showErrorToast: vi.fn(), hideToast: vi.fn() }),
}));
vi.mock('../hooks/useDetailQuery', () => ({
  useDetailQuery: () => ({ data: h.data, isLoading: h.isLoading, error: h.error, refetch: h.refetch }),
}));
vi.mock('../api/leads', () => ({
  convertLead: (...args: unknown[]) => h.convertLead(...args),
  markLeadLost: (...args: unknown[]) => h.markLeadLost(...args),
}));

// eslint-disable-next-line import/first
import LeadDetailScreen from '../../app/leads/[id]';

beforeEach(() => {
  vi.clearAllMocks();
  h.data = null;
  h.isLoading = false;
  h.error = null;
  h.refetch.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('Lead detail screen — convert + mark-lost (C4/C5)', () => {
  it('shows Convert and Mark-lost for an active lead', () => {
    h.data = { id: 'l1', companyName: 'Acme HVAC', stage: 'new' };
    const { getByText } = render(createElement(LeadDetailScreen));
    expect(getByText('Convert to customer').closest('button')!.className).toMatch(/\bmin-h-11\b/);
    expect(getByText('Mark lost')).toBeTruthy();
  });

  it('hides both lifecycle actions once the lead is converted', () => {
    h.data = { id: 'l1', companyName: 'Acme HVAC', stage: 'won', convertedCustomerId: 'c9' };
    const { queryByText } = render(createElement(LeadDetailScreen));
    expect(queryByText('Convert to customer')).toBeNull();
    expect(queryByText('Mark lost')).toBeNull();
  });

  it('hides both lifecycle actions once the lead is lost', () => {
    h.data = { id: 'l1', companyName: 'Acme HVAC', stage: 'lost' };
    const { queryByText } = render(createElement(LeadDetailScreen));
    expect(queryByText('Convert to customer')).toBeNull();
    expect(queryByText('Mark lost')).toBeNull();
  });

  it('converts through a capture confirm, then re-fetches and opens the new customer', async () => {
    h.data = { id: 'l1', companyName: 'Acme HVAC', stage: 'qualified' };
    h.convertLead.mockResolvedValue({ lead: { id: 'l1' }, customer: { id: 'c9' }, location: { id: 'loc1' } });
    const { getByText } = render(createElement(LeadDetailScreen));

    fireEvent.click(getByText('Convert to customer').closest('button')!);
    // Confirm sheet, then confirm.
    expect(getByText('Convert this lead to a customer?')).toBeTruthy();
    fireEvent.click(getByText('Convert').closest('button')!);

    await waitFor(() => expect(h.convertLead).toHaveBeenCalledWith(h.api, 'l1'));
    await waitFor(() => expect(h.refetch).toHaveBeenCalled());
    await waitFor(() => expect(h.push).toHaveBeenCalledWith('/customers/c9'));
  });

  it('surfaces an inline error when convert fails (e.g. already converted)', async () => {
    h.data = { id: 'l1', companyName: 'Acme HVAC', stage: 'qualified' };
    h.convertLead.mockRejectedValue(new Error('Lead has already been converted'));
    const { getByText } = render(createElement(LeadDetailScreen));

    fireEvent.click(getByText('Convert to customer').closest('button')!);
    fireEvent.click(getByText('Convert').closest('button')!);

    await waitFor(() => expect(getByText('Lead has already been converted')).toBeTruthy());
    expect(h.push).not.toHaveBeenCalled();
  });

  it('marks lost with a required reason (mirrors the reject-reason form)', async () => {
    h.data = { id: 'l1', companyName: 'Acme HVAC', stage: 'contacted' };
    h.markLeadLost.mockResolvedValue(undefined);
    const { getByText, getByPlaceholderText } = render(createElement(LeadDetailScreen));

    fireEvent.click(getByText('Mark lost').closest('button')!);
    fireEvent.change(getByPlaceholderText('e.g. went with a competitor'), {
      target: { value: 'chose a competitor' },
    });
    // The confirm button inside the reason form.
    fireEvent.click(getByText('Mark lost').closest('button')!);

    await waitFor(() => expect(h.markLeadLost).toHaveBeenCalledWith(h.api, 'l1', 'chose a competitor'));
    await waitFor(() => expect(h.refetch).toHaveBeenCalled());
  });

  it('does not mark lost with an empty reason', () => {
    h.data = { id: 'l1', companyName: 'Acme HVAC', stage: 'contacted' };
    const { getByText } = render(createElement(LeadDetailScreen));
    fireEvent.click(getByText('Mark lost').closest('button')!);
    // Confirm button is disabled with an empty reason → click is a no-op.
    fireEvent.click(getByText('Mark lost').closest('button')!);
    expect(h.markLeadLost).not.toHaveBeenCalled();
  });
});
