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

  it("serializes cleared optional fields as '' so the clear persists", async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => baseCustomer,
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ...baseCustomer, lastName: '', email: '' }),
      } as unknown as Response);

    const onSaved = vi.fn();
    render(<CustomerEdit customerId="c-1" onSaved={onSaved} />);

    await waitFor(() => {
      expect(screen.getByLabelText('email')).toHaveValue('alice@example.com');
    });

    fireEvent.change(screen.getByLabelText('email'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('lastName'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith('c-1');
    });

    // The PUT body must CARRY the cleared keys as '' — a dropped key
    // (`|| undefined`) makes the server keep the old value silently.
    const body = JSON.parse(vi.mocked(apiFetch).mock.calls[1][1]?.body as string);
    expect(Object.keys(body)).toEqual(expect.arrayContaining(['email', 'lastName']));
    expect(body.email).toBe('');
    expect(body.lastName).toBe('');
    // The successful save reflects the cleared values in the form.
    expect(screen.getByLabelText('email')).toHaveValue('');
    expect(screen.getByLabelText('lastName')).toHaveValue('');
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

// Root-cause fix for the `/customers/new` 500: the web app had no create
// route, so "new" was captured as `:id` by CustomerDetail and the API was
// asked for GET /api/customers/new. This is the page the new customers/new
// route (routes.ts) renders: CustomerEdit without a customerId.
describe('CustomerEdit — create mode (no customerId)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('renders a blank create form immediately, with no fetch-on-mount', async () => {
    render(<CustomerEdit />);

    expect(await screen.findByTestId('customer-edit-form')).toBeInTheDocument();
    expect(screen.getByText('New Customer')).toBeInTheDocument();
    expect(screen.getByLabelText('firstName')).toHaveValue('');
    // The bug this guards against: CustomerDetail fetching GET
    // /api/customers/new. The create form must never call apiFetch until
    // the user submits.
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('POSTs a new customer on save and never calls /api/customers/new', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: 'c-new', firstName: 'Grace', lastName: 'Hopper' }),
    } as unknown as Response);

    const onSaved = vi.fn();
    render(<CustomerEdit onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText('firstName'), { target: { value: 'Grace' } });
    fireEvent.change(screen.getByLabelText('lastName'), { target: { value: 'Hopper' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith('c-new');
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(apiFetch).mock.calls[0];
    expect(url).toBe('/api/customers');
    expect(url).not.toBe('/api/customers/new');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.firstName).toBe('Grace');
    expect(body.lastName).toBe('Hopper');
  });

  it('shows a first-name-required error on a fully blank submit', () => {
    render(<CustomerEdit />);
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/first name is required/i);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  // createCustomerSchema (packages/api/src/shared/contracts.ts) requires
  // BOTH firstName and lastName — unlike edit mode's PUT, which allows
  // company-only. AddCustomerSheet (CustomersPage.tsx), the other create
  // path, agrees: it has no company field at all and always derives both
  // firstName and lastName from its single "Full name" input before
  // POSTing. Company-only must not reach the server here either — a
  // company-only submit would otherwise pass this form's client check,
  // POST, and come back as a 400 the user never asked for.
  it('rejects a company-only submit with a last-name-required error and never calls POST /api/customers', () => {
    render(<CustomerEdit />);

    fireEvent.change(screen.getByLabelText('firstName'), { target: { value: 'Acme Plumbing' } });
    fireEvent.change(screen.getByLabelText('companyName'), { target: { value: 'Acme Plumbing' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/last name is required/i);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('shows the API error when the POST fails (server 400 is surfaced, not swallowed)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ message: 'firstName and lastName are required' }),
    } as unknown as Response);

    render(<CustomerEdit />);
    fireEvent.change(screen.getByLabelText('firstName'), { target: { value: 'Grace' } });
    fireEvent.change(screen.getByLabelText('lastName'), { target: { value: 'Hopper' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('firstName and lastName are required');
  });

  it('Cancel and Create controls are present and full-size for the create form', () => {
    render(<CustomerEdit />);
    expect(screen.getByRole('button', { name: /create/i }).className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: /cancel/i }).className).toContain('min-h-11');
  });
});
