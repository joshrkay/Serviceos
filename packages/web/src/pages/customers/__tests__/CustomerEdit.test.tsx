import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomerEdit } from '../CustomerEdit';

vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../../utils/api-fetch';

const baseCustomer = {
  id: 'c-1',
  firstName: 'Alice',
  lastName: 'Smith',
  companyName: 'Acme',
  primaryPhone: '555-0100',
  secondaryPhone: '',
  email: 'alice@example.com',
  preferredChannel: 'email',
  communicationNotes: 'Prefers afternoon appointments.',
};

describe('P11-007 CustomerEdit', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('loads customer and pre-fills form', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => baseCustomer,
    } as unknown as Response);

    render(<CustomerEdit customerId="c-1" />);

    await waitFor(() => {
      expect(screen.getByLabelText('firstName')).toHaveValue('Alice');
    });
    expect(screen.getByLabelText('email')).toHaveValue('alice@example.com');
    expect(screen.getByLabelText('companyName')).toHaveValue('Acme');
  });

  it('PUTs the updated customer on save', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => baseCustomer,
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ...baseCustomer, firstName: 'Alicia' }),
      } as unknown as Response);

    const onSaved = vi.fn();
    render(<CustomerEdit customerId="c-1" onSaved={onSaved} />);

    await waitFor(() => {
      expect(screen.getByLabelText('firstName')).toHaveValue('Alice');
    });

    fireEvent.change(screen.getByLabelText('firstName'), { target: { value: 'Alicia' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith('c-1');
    });

    const putCall = vi.mocked(apiFetch).mock.calls[1];
    expect(putCall[0]).toBe('/api/customers/c-1');
    expect(putCall[1]?.method).toBe('PUT');
    const body = JSON.parse(putCall[1]?.body as string);
    expect(body.firstName).toBe('Alicia');
  });

  it('PUTs an empty string when clearing customer notes', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => baseCustomer,
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ...baseCustomer, communicationNotes: '' }),
      } as unknown as Response);

    render(<CustomerEdit customerId="c-1" />);

    await waitFor(() => {
      expect(screen.getByLabelText('communicationNotes')).toHaveValue('Prefers afternoon appointments.');
    });

    fireEvent.change(screen.getByLabelText('communicationNotes'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      const body = JSON.parse(vi.mocked(apiFetch).mock.calls[1][1]?.body as string);
      expect(body.communicationNotes).toBe('');
    });
  });

  it('shows error when neither name nor company is set', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...baseCustomer, firstName: '', companyName: '' }),
    } as unknown as Response);

    render(<CustomerEdit customerId="c-1" />);

    await waitFor(() => {
      expect(screen.getByLabelText('firstName')).toHaveValue('');
    });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/required/i);
  });

  it('shows API error when PUT fails', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => baseCustomer,
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ message: 'oh no' }),
      } as unknown as Response);

    render(<CustomerEdit customerId="c-1" />);

    await waitFor(() => {
      expect(screen.getByLabelText('firstName')).toHaveValue('Alice');
    });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('oh no');
  });

  // U7b — kit migration contract: the form is built on the shared UI kit
  // (Field + Input/Select/Textarea + Button), so the controls carry the kit's
  // id/label wiring and meet the ≥44px tap-target rule, with no behaviour drift.
  it('wires each field via the kit Field (real htmlFor/id) and meets the 44px tap target', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => baseCustomer,
    } as unknown as Response);

    render(<CustomerEdit customerId="c-1" />);

    const firstName = await screen.findByLabelText('firstName');
    // Field generates a stable id and an associated <label htmlFor> — the
    // pairing the hand-rolled form lacked.
    expect(firstName).toHaveAttribute('id');
    expect(document.querySelector(`label[for="${firstName.id}"]`)).toBeTruthy();
    // Controls and actions are ≥44px (min-h-11) for touch.
    expect(firstName.className).toContain('min-h-11');
    expect(screen.getByLabelText('communicationNotes').className).toContain('min-h-11');
    for (const name of [/save/i, /cancel/i]) {
      expect(screen.getByRole('button', { name }).className).toContain('min-h-11');
    }
  });

  it('carries the preferredChannel select selection into the PUT body', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => baseCustomer,
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ...baseCustomer, preferredChannel: 'sms' }),
      } as unknown as Response);

    render(<CustomerEdit customerId="c-1" />);

    await waitFor(() => {
      expect(screen.getByLabelText('firstName')).toHaveValue('Alice');
    });

    fireEvent.change(screen.getByLabelText('preferredChannel'), { target: { value: 'sms' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      const body = JSON.parse(vi.mocked(apiFetch).mock.calls[1][1]?.body as string);
      expect(body.preferredChannel).toBe('sms');
    });
  });
});
