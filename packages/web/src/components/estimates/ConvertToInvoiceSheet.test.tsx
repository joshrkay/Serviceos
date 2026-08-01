import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConvertToInvoiceSheet, type ConvertToInvoiceInput } from './ConvertToInvoiceSheet';

vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '../../utils/api-fetch';

const baseInput: ConvertToInvoiceInput = {
  estimateId: 'est-1',
  jobId: 'job-1',
  estimateNumber: 'EST-001',
  customerName: 'Alice Smith',
  description: 'Water heater swap',
  lineItems: [
    { description: 'Labor', qty: 2, rate: 100 },
    { description: 'Parts', qty: 1, rate: 50 },
  ],
};

function renderSheet(over: Partial<ConvertToInvoiceInput> = {}) {
  const onClose = vi.fn();
  const onConverted = vi.fn();
  render(
    <ConvertToInvoiceSheet
      input={{ ...baseInput, ...over }}
      onClose={onClose}
      onConverted={onConverted}
    />,
  );
  return { onClose, onConverted };
}

describe('ConvertToInvoiceSheet', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('renders the summary with customer, line items, and the dollar total', () => {
    renderSheet();
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('Labor')).toBeInTheDocument();
    expect(screen.getByText('2 line items')).toBeInTheDocument();
    // 2*100 + 1*50 = 250 — appears in summary, footer total, and the CTA label.
    expect(screen.getAllByText(/\$250/).length).toBeGreaterThan(0);
  });

  it('POSTs convert-to-invoice with an empty body (backend bills the locked selection) and reports the new invoice id', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'inv-9' }),
    } as unknown as Response);

    const { onConverted } = renderSheet();
    fireEvent.click(screen.getByRole('button', { name: /create invoice/i }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/estimates/est-1/convert-to-invoice',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
      );
    });
    await waitFor(() => expect(onConverted).toHaveBeenCalledWith('inv-9'));
  });

  it('blocks conversion when the estimate has no linked job and makes no request', () => {
    const { onConverted } = renderSheet({ jobId: '' });
    fireEvent.click(screen.getByRole('button', { name: /create invoice/i }));
    expect(screen.getByText(/not linked to a job/i)).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(onConverted).not.toHaveBeenCalled();
  });

  it('surfaces a server error message', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ message: 'deposit already credited' }),
    } as unknown as Response);

    renderSheet();
    fireEvent.click(screen.getByRole('button', { name: /create invoice/i }));
    expect(await screen.findByText('deposit already credited')).toBeInTheDocument();
  });
});
