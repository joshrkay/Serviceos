import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NewJobFlow } from './NewJobFlow';

function renderFlow() {
  return render(
    <NewJobFlow
      onClose={vi.fn()}
      onCreated={vi.fn()}
    />
  );
}

describe('NewJobFlow', () => {
  it('allows creating and selecting a new customer from the customer step', () => {
    renderFlow();

    fireEvent.click(screen.getByText('Fill it in'));
    fireEvent.click(screen.getByRole('button', { name: /create new customer/i }));

    fireEvent.change(screen.getByPlaceholderText('Full name *'), { target: { value: 'Taylor Rivera' } });
    fireEvent.change(screen.getByPlaceholderText('Address *'), { target: { value: '99 Test Lane, Austin TX' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save customer' }));

    expect(screen.getByText('Taylor Rivera')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next: job details/i })).toBeEnabled();
  });

  it('marks an existing customer address as old when a new customer is created with the same address', () => {
    renderFlow();

    fireEvent.click(screen.getByText('Fill it in'));
    fireEvent.click(screen.getByRole('button', { name: /create new customer/i }));

    fireEvent.change(screen.getByPlaceholderText('Full name *'), { target: { value: 'Jordan Lopez' } });
    fireEvent.change(screen.getByPlaceholderText('Address *'), { target: { value: '412 Maple Drive, Austin TX' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save customer' }));

    const existingCustomerRow = screen.getByText('Roberto Rodriguez').closest('button');
    expect(existingCustomerRow).not.toBeNull();
    expect(within(existingCustomerRow as HTMLElement).getByText('old address')).toBeInTheDocument();
  });
});
