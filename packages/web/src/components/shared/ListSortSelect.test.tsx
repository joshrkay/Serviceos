/**
 * #1402 — the shared list-sort control: ≥44px tap target, fills its row
 * without overflowing at 320px, and default ordering adds no query params.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { INVOICE_LIST_SORT } from '@ai-service-os/shared';
import { ListSortSelect, listSortParams } from './ListSortSelect';

describe('ListSortSelect (#1402)', () => {
  it('is a ≥44px, full-width, shrinkable control that reports the chosen field + direction', () => {
    const onChange = vi.fn();
    render(
      <ListSortSelect
        label="Sort invoices"
        options={[
          { field: 'created', direction: 'desc', label: 'Newest first' },
          { field: 'due', direction: 'asc', label: 'Due soonest' },
        ]}
        value={{ field: 'created', direction: 'desc' }}
        onChange={onChange}
      />,
    );
    const select = screen.getByLabelText('Sort invoices');
    expect(select.className).toMatch(/\bmin-h-11\b/);
    expect(select.className).toMatch(/\bw-full\b/);
    expect(select.className).toMatch(/\bmin-w-0\b/);
    fireEvent.change(select, { target: { value: 'due:asc' } });
    expect(onChange).toHaveBeenCalledWith({ field: 'due', direction: 'asc' });
  });

  it("the list's default ordering sends no sort params; anything else sends sortBy + sort", () => {
    expect(listSortParams(INVOICE_LIST_SORT, { field: 'created', direction: 'desc' })).toEqual({});
    expect(listSortParams(INVOICE_LIST_SORT, { field: 'created', direction: 'asc' })).toEqual({ sortBy: 'created', sort: 'asc' });
  });
});
