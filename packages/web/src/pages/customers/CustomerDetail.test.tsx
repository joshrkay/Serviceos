import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomerDetail } from './CustomerDetail';

vi.mock('../../hooks/useDetailQuery', () => ({
  useDetailQuery: vi.fn(),
}));

import { useDetailQuery } from '../../hooks/useDetailQuery';

describe('CustomerDetail', () => {
  beforeEach(() => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: {
        id: '1', displayName: 'Alice', firstName: 'Alice', lastName: 'Smith',
        companyName: 'Acme', email: 'alice@test.com', primaryPhone: '555-0100',
        secondaryPhone: '555-0200', preferredChannel: 'email', isArchived: false,
      },
      isLoading: false, error: null, refetch: vi.fn(),
    });
  });

  it('renders customer details', () => {
    render(<CustomerDetail customerId="1" />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Contact Information')).toBeInTheDocument();
  });

  it('shows loading state when no data', () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: null, isLoading: true, error: null, refetch: vi.fn(),
    });
    render(<CustomerDetail customerId="1" />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows error state', () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: null, isLoading: false, error: 'Not found', refetch: vi.fn(),
    });
    render(<CustomerDetail customerId="1" />);
    expect(screen.getByText('Not found')).toBeInTheDocument();
  });
});
