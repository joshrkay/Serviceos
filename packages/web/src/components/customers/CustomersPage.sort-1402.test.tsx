/**
 * #1402 (QA §6) — the customers directory gets the shared server-side sort
 * control; the choice composes with the service-type / archived filters.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useMutation', () => ({ useMutation: vi.fn() }));
vi.mock('../estimates/NewEstimateFlow', () => ({ NewEstimateFlow: () => null }));
vi.mock('../jobs/NewJobFlow', () => ({ NewJobFlow: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

import { CustomersPage } from './CustomersPage';
import { useListQuery } from '../../hooks/useListQuery';
import { useMutation } from '../../hooks/useMutation';
import { listQueryResult } from '../../test-utils/list-query-result';

let result = listQueryResult([
  { id: 'c1', displayName: 'Alice Smith', firstName: 'Alice', lastName: 'Smith', tags: [], locations: [] },
]);

beforeEach(() => {
  result = listQueryResult([
    { id: 'c1', displayName: 'Alice Smith', firstName: 'Alice', lastName: 'Smith', tags: [], locations: [] },
  ]);
  vi.mocked(useListQuery).mockReturnValue(result as never);
  vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(), isLoading: false, error: null } as never);
});

describe('CustomersPage sort (#1402)', () => {
  it('choosing "Newest first" asks the API for sortBy=created desc, and a service chip keeps it', () => {
    render(<MemoryRouter><CustomersPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Sort customers'), { target: { value: 'created:desc' } });
    expect(result.setFilters).toHaveBeenLastCalledWith({ sortBy: 'created', sort: 'desc' });

    fireEvent.click(screen.getByRole('button', { name: /HVAC/ }));
    expect(result.setFilters).toHaveBeenLastCalledWith({ serviceType: 'HVAC', sortBy: 'created', sort: 'desc' });
  });

  it('Name Z–A flips the default field', () => {
    render(<MemoryRouter><CustomersPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Sort customers'), { target: { value: 'name:desc' } });
    expect(result.setFilters).toHaveBeenLastCalledWith({ sortBy: 'name', sort: 'desc' });
  });
});
