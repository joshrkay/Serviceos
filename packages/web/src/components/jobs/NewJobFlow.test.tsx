import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  it('allows creating and selecting a new customer from the customer step', async () => {
    const user = userEvent.setup();
    renderFlow();

    await user.click(screen.getByText('Fill it in'));
    await user.click(screen.getByRole('button', { name: /create new customer/i }));

    await user.type(screen.getByPlaceholderText('Full name *'), 'Taylor Rivera');
    await user.type(screen.getByPlaceholderText('Address *'), '99 Test Lane, Austin TX');

    await user.click(screen.getByRole('button', { name: 'Save customer' }));

    expect(await screen.findByText('Taylor Rivera')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /next: job details/i })).toBeEnabled();
  });

  it('marks an existing customer address as old when a new customer is created with the same address', async () => {
    const user = userEvent.setup();
    renderFlow();

    await user.click(screen.getByText('Fill it in'));
    await user.click(screen.getByRole('button', { name: /create new customer/i }));

    await user.type(screen.getByPlaceholderText('Full name *'), 'Jordan Lopez');
    await user.type(screen.getByPlaceholderText('Address *'), '412 Maple Drive, Austin TX');

    await user.click(screen.getByRole('button', { name: 'Save customer' }));

    const existingCustomerRow = (await screen.findByText('Roberto Rodriguez')).closest('button');
    expect(existingCustomerRow).not.toBeNull();
    expect(await within(existingCustomerRow as HTMLElement).findByText('old address')).toBeInTheDocument();
  });
});
