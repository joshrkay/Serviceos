// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface LeadDetail {
  id: string;
  firstName?: string;
  stage?: string;
  lostReason?: string;
  street1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}

const h = vi.hoisted(() => ({
  refetch: vi.fn(),
  replace: vi.fn(),
  data: null as LeadDetail | null,
  endpoint: null as string | null,
  permissions: [] as string[],
  convertLead: vi.fn(),
  loseLead: vi.fn(),
  sheetProps: null as { onConverted?: (id: string) => void } | null,
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'lead-1' }),
  useRouter: () => ({ replace: h.replace, push: vi.fn(), back: vi.fn() }),
}));
vi.mock('../hooks/useDetailQuery', () => ({
  useDetailQuery: (endpoint: string | null) => {
    h.endpoint = endpoint;
    return { data: h.data, isLoading: false, error: null, refetch: h.refetch };
  },
}));
vi.mock('../hooks/useMe', () => ({ useMe: () => ({ me: { permissions: h.permissions } }) }));
vi.mock('../lib/useApiClient', () => {
  const client = vi.fn();
  return { useApiClient: () => client };
});
vi.mock('../api/leads', () => ({
  convertLead: (...args: unknown[]) => h.convertLead(...args),
  loseLead: (...args: unknown[]) => h.loseLead(...args),
}));
vi.mock('../components/ConvertLeadSheet', () => ({
  ConvertLeadSheet: (props: { visible: boolean; onConverted: (id: string) => void }) => {
    h.sheetProps = props;
    return props.visible ? createElement('div', { 'data-testid': 'convert-sheet' }, 'address form') : null;
  },
}));

// eslint-disable-next-line import/first
import LeadDetailScreen from '../../app/leads/[id]';

const FULL_PERMS = ['customers:create', 'customers:update'];

beforeEach(() => {
  vi.clearAllMocks();
  h.data = null;
  h.endpoint = null;
  h.permissions = [...FULL_PERMS];
  h.sheetProps = null;
  h.convertLead.mockResolvedValue({ customerId: 'cust-9' });
  h.loseLead.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('Lead detail screen', () => {
  it('fetches the lead by id', () => {
    h.data = { id: 'lead-1', stage: 'new' };
    render(createElement(LeadDetailScreen));
    expect(h.endpoint).toBe('/api/leads/lead-1');
  });

  it('converts directly when the lead has a complete address', async () => {
    h.data = { id: 'lead-1', stage: 'qualified', street1: '9 Elm', city: 'Austin', state: 'TX', postalCode: '78701' };
    const { getByText, queryByTestId } = render(createElement(LeadDetailScreen));

    fireEvent.click(getByText('Convert to customer'));
    await waitFor(() => expect(h.convertLead).toHaveBeenCalledWith(expect.anything(), 'lead-1'));
    // No address is passed (the lead already has one), and no sheet opens.
    expect(h.convertLead.mock.calls[0]).toHaveLength(2);
    expect(queryByTestId('convert-sheet')).toBeNull();
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/customers/cust-9'));
  });

  it('opens the address sheet when the lead has no complete address', () => {
    h.data = { id: 'lead-1', stage: 'qualified' };
    const { getByText, getByTestId } = render(createElement(LeadDetailScreen));

    fireEvent.click(getByText('Convert to customer'));
    expect(getByTestId('convert-sheet')).toBeTruthy();
    expect(h.convertLead).not.toHaveBeenCalled();
  });

  it('marks a lead lost with a required reason', async () => {
    h.data = { id: 'lead-1', stage: 'contacted' };
    const { getByText, getByLabelText } = render(createElement(LeadDetailScreen));

    fireEvent.click(getByText('Mark lost'));
    fireEvent.change(getByLabelText('Lost reason'), { target: { value: 'went with a competitor' } });
    fireEvent.click(getByText('Mark lost')); // the confirm button now

    await waitFor(() => expect(h.loseLead).toHaveBeenCalledWith(expect.anything(), 'lead-1', 'went with a competitor'));
    expect(h.refetch).toHaveBeenCalled();
  });

  it('shows the outcome and no actions for terminal leads', () => {
    h.data = { id: 'lead-1', stage: 'won' };
    const won = render(createElement(LeadDetailScreen));
    expect(won.getByText(/Converted to a customer/)).toBeTruthy();
    expect(won.queryByText('Convert to customer')).toBeNull();
    cleanup();

    h.data = { id: 'lead-1', stage: 'lost', lostReason: 'price' };
    const lost = render(createElement(LeadDetailScreen));
    expect(lost.getByText(/marked lost/)).toBeTruthy();
    expect(lost.queryByText('Mark lost')).toBeNull();
  });

  it('hides convert/lose actions without the permissions (e.g. technician)', () => {
    h.permissions = ['customers:view'];
    h.data = { id: 'lead-1', stage: 'new' };
    const { queryByText } = render(createElement(LeadDetailScreen));
    expect(queryByText('Convert to customer')).toBeNull();
    expect(queryByText('Mark lost')).toBeNull();
  });
});
