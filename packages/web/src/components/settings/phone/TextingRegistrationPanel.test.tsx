/**
 * #1564 — the owner's US A2P 10DLC texting-registration form + status panel
 * (Settings → Phone; mounted by #1563's page). Backed by
 * GET/PUT /api/settings/texting-registration.
 *
 * Seam: the rendered component, with apiFetch (the network boundary) stubbed.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { TextingRegistrationPanel } from './TextingRegistrationPanel';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const NOT_STARTED = {
  status: 'not_started',
  readiness: 'partial_readiness',
  details: null,
  failureReasons: [],
  submittedAt: null,
  approvedAt: null,
  updatedAt: null,
};

const SAVED_DETAILS = {
  legalBusinessName: 'Acme Plumbing LLC',
  einLast4: '6789',
  businessType: 'Limited Liability Corporation',
  businessIndustry: 'CONSTRUCTION',
  websiteUrl: 'https://acme-plumbing.example.com',
  address: { street: '1 Main St', street2: null, city: 'Austin', region: 'TX', postalCode: '78701' },
  contact: { firstName: 'Pat', lastName: 'Owner', email: 'pat@example.com', phone: '+15125550100', title: 'Owner', jobPosition: 'CEO' },
};

function fill(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('TextingRegistrationPanel', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('lets the owner submit their business details and then shows the registration as submitted', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(NOT_STARTED));
    render(<TextingRegistrationPanel />);

    await screen.findByLabelText(/legal business name/i);
    fill(/legal business name/i, 'Acme Plumbing LLC');
    fill(/^ein/i, '12-3456789');
    fireEvent.change(screen.getByLabelText(/business type/i), { target: { value: 'Limited Liability Corporation' } });
    fill(/website/i, 'https://acme-plumbing.example.com');
    fill(/^street address/i, '1 Main St');
    fill(/^city/i, 'Austin');
    fill(/^state/i, 'TX');
    fill(/zip/i, '78701');
    fill(/first name/i, 'Pat');
    fill(/last name/i, 'Owner');
    fill(/^email/i, 'pat@example.com');
    fill(/^mobile phone/i, '(512) 555-0100');
    fill(/^your title/i, 'Owner');

    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ ...NOT_STARTED, status: 'submitted', details: SAVED_DETAILS, submittedAt: '2026-10-01T00:00:00Z' }),
    );
    fireEvent.click(screen.getByRole('button', { name: /submit for registration/i }));

    await screen.findByText(/submitted/i);
    const put = apiFetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
    expect(put?.[0]).toBe('/api/settings/texting-registration');
    expect(JSON.parse((put![1] as RequestInit).body as string)).toEqual({
      legalBusinessName: 'Acme Plumbing LLC',
      ein: '12-3456789',
      businessType: 'Limited Liability Corporation',
      businessIndustry: 'CONSTRUCTION',
      websiteUrl: 'https://acme-plumbing.example.com',
      address: { street: '1 Main St', street2: '', city: 'Austin', region: 'TX', postalCode: '78701' },
      contact: { firstName: 'Pat', lastName: 'Owner', email: 'pat@example.com', phone: '(512) 555-0100', title: 'Owner', jobPosition: 'CEO' },
    });
    expect(screen.queryByRole('button', { name: /submit for registration/i })).toBeNull();
  });

  it('shows the carrier rejection reasons and a prefilled form (EIN left blank) when the registration failed', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...NOT_STARTED,
        status: 'failed',
        details: SAVED_DETAILS,
        failureReasons: ['Legal business name does not match the EIN on file.'],
      }),
    );
    render(<TextingRegistrationPanel />);

    expect(await screen.findByText('Legal business name does not match the EIN on file.')).toBeTruthy();
    expect((screen.getByLabelText(/legal business name/i) as HTMLInputElement).value).toBe('Acme Plumbing LLC');
    expect((screen.getByLabelText(/^ein/i) as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: /submit for registration/i })).toBeTruthy();
  });

  it('shows carrier review in progress with no form while the brand is being vetted', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ...NOT_STARTED, status: 'brand_pending', details: SAVED_DETAILS }));
    render(<TextingRegistrationPanel />);

    expect(await screen.findByText(/business under carrier review/i)).toBeTruthy();
    expect(screen.getByText(/EIN ending 6789/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /submit for registration/i })).toBeNull();
  });

  it('shows the registration as done once the campaign is approved', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ ...NOT_STARTED, status: 'approved', readiness: 'full_readiness', details: SAVED_DETAILS }),
    );
    render(<TextingRegistrationPanel />);

    expect(await screen.findByText(/texting registered/i)).toBeTruthy();
  });

  it('shows the server\'s field errors when a submission is refused', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(NOT_STARTED));
    render(<TextingRegistrationPanel />);
    await screen.findByLabelText(/legal business name/i);

    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'VALIDATION_ERROR', message: 'Check the highlighted fields', fields: [{ path: 'ein', message: 'EIN must be 9 digits' }] }, 400),
    );
    fireEvent.click(screen.getByRole('button', { name: /submit for registration/i }));

    expect(await screen.findByText(/EIN must be 9 digits/)).toBeTruthy();
  });

  it('keeps every control a ≥44px tap target (min-h-11)', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(NOT_STARTED));
    const { container } = render(<TextingRegistrationPanel />);
    await screen.findByLabelText(/legal business name/i);

    const controls = container.querySelectorAll('input, select, button');
    expect(controls.length).toBeGreaterThan(10);
    controls.forEach((el) => expect(el.className).toContain('min-h-11'));
  });
});
