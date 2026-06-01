/**
 * Layer 4 — Full API Thread Integration Tests
 *
 * These render the REAL, route-wired list pages (no vi.mock of the data
 * hooks) and mock fetch at the HTTP level. They prove the complete chain:
 *
 *   LivePage → useListQuery → useApiClient → fetch() → rendered DOM
 *
 * If any link breaks — wrong endpoint, field-name mismatch, broken render
 * — these fail. Clerk auth is stubbed globally in src/test-setup.ts, so the
 * live pages mount and useApiClient resolves a token without a provider.
 *
 * These replace the earlier apiThreads suite that exercised now-deleted
 * duplicate list pages; the assertions target the live surfaces instead.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { JobsList } from '../components/jobs/JobsList';
import { CustomersPage } from '../components/customers/CustomersPage';
import { EstimatesPage } from '../components/estimates/EstimatesPage';
import { InvoicesPage } from '../components/invoices/InvoicesPage';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Mock every fetch() to resolve with the same JSON body (a bare array). */
function mockFetch(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function calledUrls(spy: ReturnType<typeof mockFetch>): string[] {
  return spy.mock.calls.map((c) => String(c[0]));
}

function renderPage(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Thread 1: JobsList → /api/jobs ──────────────────────────────────────────

describe('Thread 1 — JobsList → /api/jobs → rendered rows', () => {
  it('fetches from /api/jobs on mount', async () => {
    const spy = mockFetch([]);
    renderPage(<JobsList />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(calledUrls(spy).some((u) => u.includes('/api/jobs'))).toBe(true);
  });

  it('renders a job row from the API response', async () => {
    mockFetch([
      {
        id: 'j1',
        jobNumber: 'JOB-0042',
        summary: 'Fix the condensate drain',
        status: 'scheduled',
        serviceType: 'HVAC',
        customer: { id: 'c1', displayName: 'Acme Co' },
      },
    ]);
    renderPage(<JobsList />);
    expect(await screen.findByText('Acme Co')).toBeInTheDocument();
  });
});

// ─── Thread 2: CustomersPage → /api/customers ────────────────────────────────

describe('Thread 2 — CustomersPage → /api/customers → rendered rows', () => {
  it('fetches from /api/customers on mount', async () => {
    const spy = mockFetch([]);
    renderPage(<CustomersPage />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(calledUrls(spy).some((u) => u.includes('/api/customers'))).toBe(true);
  });

  it('renders a customer row using displayName', async () => {
    mockFetch([
      {
        id: 'c1',
        displayName: 'Alice Smith',
        firstName: 'Alice',
        lastName: 'Smith',
        isArchived: false,
      },
    ]);
    renderPage(<CustomersPage />);
    expect(await screen.findByText('Alice Smith')).toBeInTheDocument();
  });
});

// ─── Thread 3: EstimatesPage → /api/estimates ────────────────────────────────

describe('Thread 3 — EstimatesPage → /api/estimates → rendered rows', () => {
  it('fetches from /api/estimates on mount', async () => {
    const spy = mockFetch([]);
    renderPage(<EstimatesPage />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(calledUrls(spy).some((u) => u.includes('/api/estimates'))).toBe(true);
  });

  it('renders an estimate row from the API response', async () => {
    mockFetch([
      {
        id: 'e1',
        estimateNumber: 'EST-0007',
        status: 'draft',
        totalCents: 150000,
        customer: { id: 'c1', displayName: 'Beth Carter' },
      },
    ]);
    renderPage(<EstimatesPage />);
    expect(await screen.findByText('Beth Carter')).toBeInTheDocument();
  });
});

// ─── Thread 4: InvoicesPage → /api/invoices ──────────────────────────────────

describe('Thread 4 — InvoicesPage → /api/invoices → rendered rows', () => {
  it('fetches from /api/invoices on mount', async () => {
    const spy = mockFetch([]);
    renderPage(<InvoicesPage />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(calledUrls(spy).some((u) => u.includes('/api/invoices'))).toBe(true);
  });

  it('renders an invoice row from the API response', async () => {
    mockFetch([
      {
        id: 'i1',
        invoiceNumber: 'INV-0003',
        status: 'open',
        // Money under nested `totals` to match the API's serialized Invoice entity.
        totals: {
          subtotalCents: 50000,
          discountCents: 0,
          taxRateBps: 0,
          taxableSubtotalCents: 50000,
          taxCents: 0,
          totalCents: 50000,
        },
        amountDueCents: 50000,
        customer: { id: 'c1', displayName: 'Carl Diaz' },
      },
    ]);
    renderPage(<InvoicesPage />);
    expect(await screen.findByText('Carl Diaz')).toBeInTheDocument();
  });
});

// ─── Thread 5: endpoint isolation ────────────────────────────────────────────

describe('Thread 5 — each list page targets its own API endpoint', () => {
  it('JobsList hits /api/jobs and not /api/estimates or /api/invoices', async () => {
    const spy = mockFetch([]);
    renderPage(<JobsList />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const urls = calledUrls(spy);
    expect(urls.some((u) => u.includes('/api/jobs'))).toBe(true);
    expect(urls.some((u) => u.includes('/api/estimates'))).toBe(false);
    expect(urls.some((u) => u.includes('/api/invoices'))).toBe(false);
  });
});
