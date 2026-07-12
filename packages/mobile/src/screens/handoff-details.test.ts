// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setLinkingOpenURL } from '../../test/stubs/react-native';

const h = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  api: vi.fn(),
  clockTimeEntry: vi.fn(),
  updateCustomer: vi.fn(),
  run: vi.fn(),
  openURL: vi.fn(),
  phase: 'idle' as 'idle' | 'saving' | 'saved' | 'error',
  saveError: null as string | null,
  data: null as Record<string, unknown> | null,
  isLoading: false,
  error: null as string | null,
  endpoint: null as string | null,
  routeId: 'abc123',
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: h.routeId }),
  useRouter: () => ({ push: h.push, back: h.back, replace: vi.fn() }),
}));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('../hooks/useDetailQuery', () => ({
  useDetailQuery: (endpoint: string | null) => {
    h.endpoint = endpoint;
    return { data: h.data, isLoading: h.isLoading, error: h.error, refetch: vi.fn() };
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
vi.mock('../api/customers', () => ({
  updateCustomer: (...args: unknown[]) => h.updateCustomer(...args),
}));
vi.mock('../api/jobs', () => ({
  clockTimeEntry: (...args: unknown[]) => h.clockTimeEntry(...args),
}));

// eslint-disable-next-line import/first
import EditCustomer from '../../app/customers/[id]/edit';
// eslint-disable-next-line import/first
import InvoiceDetail from '../../app/invoices/[id]';
// eslint-disable-next-line import/first
import JobDetail from '../../app/jobs/[id]';
// eslint-disable-next-line import/first
import JobTime from '../../app/jobs/[id]/time';
// eslint-disable-next-line import/first
import LeadDetail from '../../app/leads/[id]';

beforeEach(() => {
  vi.clearAllMocks();
  h.data = null;
  h.isLoading = false;
  h.error = null;
  h.endpoint = null;
  h.routeId = 'abc123';
  h.phase = 'idle';
  h.saveError = null;
  h.run.mockImplementation(async (fn: () => Promise<void>) => {
    await fn();
  });
  h.updateCustomer.mockResolvedValue({ id: 'abc123' });
  h.clockTimeEntry.mockResolvedValue(undefined);
  h.openURL = vi.fn().mockResolvedValue(undefined);
  __setLinkingOpenURL(h.openURL);
});

afterEach(() => cleanup());

describe('Handoff detail screens', () => {
  it('JobDetail fetches by route id and renders job tools', () => {
    h.data = {
      id: 'abc123',
      jobNumber: 'JOB-99',
      summary: 'Replace filter',
      status: 'scheduled',
      customer: { displayName: 'Acme HVAC', primaryPhone: '555-010-0200' },
      location: { street1: '1 Main St', city: 'Springfield', state: 'IL' },
    };
    const { getByText } = render(createElement(JobDetail));
    expect(h.endpoint).toBe('/api/jobs/abc123');
    expect(getByText('Photos')).toBeTruthy();
    const photos = getByText('Photos').closest('button')!;
    expect(photos.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(photos);
    expect(h.push).toHaveBeenCalledWith('/jobs/abc123/photos');
    fireEvent.click(getByText('Time').closest('button')!);
    expect(h.push).toHaveBeenCalledWith('/jobs/abc123/time');
  });

  it('JobDetail Message texts the customer and Navigate opens maps (iOS)', () => {
    h.data = {
      id: 'abc123',
      customer: { displayName: 'Acme HVAC', primaryPhone: '(555) 010-0200' },
      location: { street1: '1 Main St', city: 'Springfield', state: 'IL' },
    };
    const { getByText } = render(createElement(JobDetail));
    fireEvent.click(getByText('Message').closest('button')!);
    expect(h.openURL).toHaveBeenCalledWith('sms:5550100200');
    fireEvent.click(getByText('Navigate').closest('button')!);
    expect(h.openURL).toHaveBeenCalledWith(
      'http://maps.apple.com/?q=1%20Main%20St%2C%20Springfield%2C%20IL',
    );
  });

  it('JobDetail disables Message with no phone and Navigate with no address', () => {
    h.data = { id: 'abc123', customer: { displayName: 'Acme HVAC' } };
    const { getByText } = render(createElement(JobDetail));
    const message = getByText('Message').closest('button')!;
    const navigate = getByText('Navigate').closest('button')!;
    expect(message.hasAttribute('disabled')).toBe(true);
    expect(navigate.hasAttribute('disabled')).toBe(true);
    fireEvent.click(message);
    fireEvent.click(navigate);
    expect(h.openURL).not.toHaveBeenCalled();
  });

  it('InvoiceDetail fetches by route id and shows formatted total', () => {
    h.data = {
      id: 'abc123',
      invoiceNumber: 'INV-200',
      status: 'open',
      dueDate: '2026-07-01T00:00:00Z',
      totals: { totalCents: 9900, subtotalCents: 9000, taxCents: 900 },
      customer: { displayName: 'Beta Builders', email: 'beta@example.com' },
    };
    const { getByText } = render(createElement(InvoiceDetail));
    expect(h.endpoint).toBe('/api/invoices/abc123');
    expect(getByText('$99.00')).toBeTruthy();
    expect(getByText('open')).toBeTruthy();
  });

  it('LeadDetail fetches by route id and renders lead fields', () => {
    h.data = {
      id: 'abc123',
      companyName: 'Gamma Corp',
      stage: 'qualified',
      source: 'referral',
      primaryPhone: '555-0200',
      estimatedValueCents: 150000,
    };
    const { getByText } = render(createElement(LeadDetail));
    expect(h.endpoint).toBe('/api/leads/abc123');
    expect(getByText('Gamma Corp')).toBeTruthy();
    expect(getByText('qualified')).toBeTruthy();
    expect(getByText('$1,500.00')).toBeTruthy();
  });

  it('LeadDetail Call/Text/Email deep-link the lead phone and email', () => {
    h.data = {
      id: 'abc123',
      companyName: 'Gamma Corp',
      primaryPhone: '(555) 020-0300',
      email: 'sales@gamma.example',
    };
    const { getByText, getAllByText } = render(createElement(LeadDetail));
    // 'Email' also appears as a LabelValueTable row label; pick the button node.
    const emailButton = getAllByText('Email')
      .map((n) => n.closest('button'))
      .find(Boolean)!;
    fireEvent.click(getByText('Call').closest('button')!);
    expect(h.openURL).toHaveBeenCalledWith('tel:5550200300');
    fireEvent.click(getByText('Text').closest('button')!);
    expect(h.openURL).toHaveBeenCalledWith('sms:5550200300');
    fireEvent.click(emailButton);
    expect(h.openURL).toHaveBeenCalledWith('mailto:sales%40gamma.example');
  });

  it('LeadDetail disables Call/Text/Email when phone and email are absent', () => {
    h.data = { id: 'abc123', companyName: 'Gamma Corp' };
    const { getByText, getAllByText } = render(createElement(LeadDetail));
    const emailButton = getAllByText('Email')
      .map((n) => n.closest('button'))
      .find(Boolean)!;
    expect(getByText('Call').closest('button')!.hasAttribute('disabled')).toBe(true);
    expect(getByText('Text').closest('button')!.hasAttribute('disabled')).toBe(true);
    expect(emailButton.hasAttribute('disabled')).toBe(true);
    fireEvent.click(getByText('Call').closest('button')!);
    expect(h.openURL).not.toHaveBeenCalled();
  });

  it('EditCustomer fetches by route id and renders the edit form', () => {
    h.data = {
      id: 'abc123',
      firstName: 'Jane',
      lastName: 'Doe',
      primaryPhone: '555-0100',
      email: 'jane@example.com',
    };
    const { getByText } = render(createElement(EditCustomer));
    expect(h.endpoint).toBe('/api/customers/abc123');
    expect(getByText('Edit customer')).toBeTruthy();
    const save = getByText('Save changes').closest('button')!;
    expect(save.className).toMatch(/\bmin-h-11\b/);
  });

  it('EditCustomer saves changes and navigates back', async () => {
    h.data = {
      id: 'abc123',
      firstName: 'Jane',
      lastName: 'Doe',
      primaryPhone: '555-0100',
      email: 'jane@example.com',
    };
    const { getByText, container } = render(createElement(EditCustomer));
    const inputs = container.querySelectorAll('input');
    fireEvent.change(inputs[1]!, { target: { value: 'Smith' } });
    fireEvent.click(getByText('Save changes').closest('button')!);
    await waitFor(() =>
      expect(h.updateCustomer).toHaveBeenCalledWith(h.api, 'abc123', {
        firstName: 'Jane',
        lastName: 'Smith',
        primaryPhone: '555-0100',
        email: 'jane@example.com',
      }),
    );
    await waitFor(() => expect(h.back).toHaveBeenCalledTimes(1));
  });

  it('JobTime clocks in and out through the API', async () => {
    const { getByText } = render(createElement(JobTime));
    fireEvent.click(getByText('Clock in').closest('button')!);
    await waitFor(() => expect(h.clockTimeEntry).toHaveBeenCalledWith(h.api, 'abc123', 'clock_in'));
    fireEvent.click(getByText('Clock out').closest('button')!);
    await waitFor(() => expect(h.clockTimeEntry).toHaveBeenCalledWith(h.api, 'abc123', 'clock_out'));
  });
});
