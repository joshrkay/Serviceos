import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  InvoiceFinancingPanel,
  type InvoiceFinancingPanelApi,
} from './InvoiceFinancingPanel';
import type { FinancingApplication } from '../../api/financing';

const app = (over: Partial<FinancingApplication> = {}): FinancingApplication => ({
  id: 'a1',
  tenantId: 'tn',
  invoiceId: 'inv1',
  customerId: 'c1',
  amountCents: 250_00,
  provider: 'wisetack',
  externalId: 'wt_1',
  applicationUrl: 'https://apply.example/wt_1',
  status: 'offered',
  statusReason: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

function mockApi(over: Partial<InvoiceFinancingPanelApi> = {}): InvoiceFinancingPanelApi {
  return {
    list: vi.fn().mockResolvedValue([]),
    offer: vi.fn().mockResolvedValue(app()),
    ...over,
  };
}

describe('InvoiceFinancingPanel (FIN)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hints when no financing has been offered', async () => {
    render(<InvoiceFinancingPanel invoiceId="inv1" api={mockApi()} />);
    expect(await screen.findByText(/pay over time/i)).toBeInTheDocument();
  });

  it('lists an offer with status and the consumer apply link', async () => {
    const api = mockApi({ list: vi.fn().mockResolvedValue([app({ status: 'approved' })]) });
    render(<InvoiceFinancingPanel invoiceId="inv1" api={api} />);
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    const link = screen.getByText('Customer application link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://apply.example/wt_1');
  });

  it('shows a manual-provider note when there is no link', async () => {
    const api = mockApi({
      list: vi.fn().mockResolvedValue([app({ provider: 'manual', applicationUrl: null })]),
    });
    render(<InvoiceFinancingPanel invoiceId="inv1" api={api} />);
    expect(await screen.findByText(/Arrange financing manually/)).toBeInTheDocument();
  });

  it('offers financing', async () => {
    const api = mockApi();
    render(<InvoiceFinancingPanel invoiceId="inv1" api={api} />);
    fireEvent.click(await screen.findByText('Offer financing'));
    await waitFor(() => expect(api.offer).toHaveBeenCalledWith('inv1', {}));
  });
});
