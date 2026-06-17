import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContactsPanel } from './ContactsPanel';

vi.mock('../../api/customers', () => ({
  listContacts: vi.fn(),
  createContact: vi.fn(),
  updateContact: vi.fn(),
  archiveContact: vi.fn(),
}));

import {
  listContacts,
  createContact,
  updateContact,
  archiveContact,
} from '../../api/customers';

const contact = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'c1',
  customerId: '1',
  name: 'Bill ToContact',
  role: 'billing',
  phone: '555-0100',
  email: 'bill@example.com',
  isPrimary: false,
  isArchived: false,
  ...over,
});

describe('ContactsPanel (U1)', () => {
  beforeEach(() => {
    vi.mocked(listContacts).mockReset().mockResolvedValue([]);
    vi.mocked(createContact).mockReset().mockResolvedValue(contact() as never);
    vi.mocked(updateContact).mockReset().mockResolvedValue(contact() as never);
    vi.mocked(archiveContact).mockReset().mockResolvedValue(undefined as never);
  });

  it('renders contacts with role and primary badges', async () => {
    vi.mocked(listContacts).mockResolvedValue([
      contact({ id: 'c1', name: 'Pat Primary', role: 'primary', isPrimary: true }),
      contact({ id: 'c2', name: 'Bill ToContact', role: 'billing' }),
    ] as never);

    render(<ContactsPanel customerId="1" />);

    // Scope badge assertions to each contact row — the add-form role <select>
    // also contains "Primary"/"Billing" <option>s.
    const primaryRow = (await screen.findByText('Pat Primary')).closest('div')!;
    expect(within(primaryRow).getByText('Primary')).toBeInTheDocument();
    const billingRow = screen.getByText('Bill ToContact').closest('div')!;
    expect(within(billingRow).getByText('Billing')).toBeInTheDocument();
  });

  it('shows an empty state when there are no contacts', async () => {
    render(<ContactsPanel customerId="1" />);
    expect(await screen.findByText('No additional contacts yet.')).toBeInTheDocument();
  });

  it('adds a contact with the chosen role', async () => {
    render(<ContactsPanel customerId="1" />);
    await screen.findByText('No additional contacts yet.');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dana Decider' } });
    fireEvent.change(screen.getByLabelText('Contact role'), { target: { value: 'primary' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add contact' }));

    await waitFor(() => {
      expect(vi.mocked(createContact)).toHaveBeenCalledWith('1', {
        name: 'Dana Decider',
        role: 'primary',
        phone: undefined,
        email: undefined,
      });
    });
  });

  it('promotes a contact to primary', async () => {
    vi.mocked(listContacts).mockResolvedValue([contact({ id: 'c2', isPrimary: false })] as never);
    render(<ContactsPanel customerId="1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make primary' }));
    await waitFor(() => {
      expect(vi.mocked(updateContact)).toHaveBeenCalledWith('1', 'c2', { isPrimary: true });
    });
  });

  it('removes a contact', async () => {
    vi.mocked(listContacts).mockResolvedValue([contact({ id: 'c2', name: 'Gone' })] as never);
    render(<ContactsPanel customerId="1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Gone' }));
    await waitFor(() => {
      expect(vi.mocked(archiveContact)).toHaveBeenCalledWith('1', 'c2');
    });
  });
});
