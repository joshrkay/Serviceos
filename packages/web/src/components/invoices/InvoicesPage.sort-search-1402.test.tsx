/**
 * #1402 (QA §5) — the invoices list gets the shared server-side sort control
 * and a search box (the API matches invoice number + customer name).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { InvoicesPage } from './InvoicesPage';
import { listQueryResult } from '../../test-utils/list-query-result';
import { apiInvoice } from '../../test-utils/money-fixtures';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useListQuery } from '../../hooks/useListQuery';

let result = listQueryResult([apiInvoice({ invoiceNumber: 'INV-0001' })]);

beforeEach(() => {
  result = listQueryResult([apiInvoice({ invoiceNumber: 'INV-0001' })]);
  vi.mocked(useListQuery).mockReturnValue(result);
});

const renderList = () => render(<MemoryRouter><InvoicesPage /></MemoryRouter>);

describe('InvoicesPage sort + search (#1402)', () => {
  it('choosing "Due soonest" asks the API for sortBy=due asc, and a tab change keeps it', () => {
    renderList();
    fireEvent.change(screen.getByLabelText('Sort invoices'), { target: { value: 'due:asc' } });
    expect(result.setFilters).toHaveBeenLastCalledWith({ sortBy: 'due', sort: 'asc' });

    fireEvent.click(screen.getByRole('button', { name: 'Paid' }));
    expect(result.setFilters).toHaveBeenLastCalledWith({ status: 'paid', sortBy: 'due', sort: 'asc' });
  });

  it('the search box sends the typed text to the server-side search', () => {
    renderList();
    fireEvent.change(screen.getByLabelText('Search invoices'), { target: { value: 'Anders' } });
    expect(result.setSearch).toHaveBeenLastCalledWith('Anders');
  });
});
