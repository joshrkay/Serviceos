/**
 * Layer 4 — Full API Thread Integration Tests
 *
 * These tests render REAL components (no vi.mock of hooks) and mock fetch at
 * the HTTP level. This proves the complete chain:
 *
 *   Component → useListQuery/useDetailQuery → fetch() → rendered DOM
 *
 * If any link in this chain breaks — wrong endpoint called, field name
 * mismatch, broken render — the test fails.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { JobList } from '../pages/jobs/JobList';
import { EstimateList } from '../pages/estimates/EstimateList';
import { InvoiceList } from '../pages/invoices/InvoiceList';
import { CustomerList } from '../pages/customers/CustomerList';

// ─── Helper: mock fetch with a static JSON response ─────────────────────────

function mockFetchOnce(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

function getCalledUrls(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Thread 1: JobList ───────────────────────────────────────────────────────

describe('Thread 1 — JobList → /api/jobs → rendered rows', () => {
  it('fetches from /api/jobs on mount', async () => {
    const fetchSpy = mockFetchOnce([]);
    render(<JobList />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const urls = getCalledUrls(fetchSpy);
    expect(urls.some((u) => u.includes('/api/jobs'))).toBe(true);
  });

  it('renders job rows from API response', async () => {
    mockFetchOnce([
      {
        id: 'j1',
        jobNumber: 'JOB-0042',
        summary: 'Fix the condensate drain',
        status: 'scheduled',
        priority: 'high',
        customerId: 'c1',
      },
    ]);

    render(<JobList />);
    await screen.findByText('JOB-0042');
    expect(screen.getByText('Fix the condensate drain')).toBeInTheDocument();
  });

  it('renders multiple job rows', async () => {
    mockFetchOnce([
      { id: 'j1', jobNumber: 'JOB-0001', summary: 'Job one', status: 'new', priority: 'normal', customerId: 'c1' },
      { id: 'j2', jobNumber: 'JOB-0002', summary: 'Job two', status: 'completed', priority: 'low', customerId: 'c2' },
    ]);

    render(<JobList />);
    await screen.findByText('JOB-0001');
    expect(screen.getByText('JOB-0002')).toBeInTheDocument();
    expect(screen.getByText('Job one')).toBeInTheDocument();
    expect(screen.getByText('Job two')).toBeInTheDocument();
  });

  it('shows empty state when API returns empty array', async () => {
    mockFetchOnce([]);
    render(<JobList />);
    await screen.findByText('No jobs yet');
  });
});

// ─── Thread 2: EstimateList ──────────────────────────────────────────────────

describe('Thread 2 — EstimateList → /api/estimates → rendered rows', () => {
  it('fetches from /api/estimates on mount', async () => {
    const fetchSpy = mockFetchOnce([]);
    render(<EstimateList />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const urls = getCalledUrls(fetchSpy);
    expect(urls.some((u) => u.includes('/api/estimates'))).toBe(true);
  });

  it('renders estimate rows with formatted totalCents', async () => {
    mockFetchOnce([
      {
        id: 'e1',
        estimateNumber: 'EST-0007',
        status: 'draft',
        totalCents: 150000,
        jobId: 'j1',
      },
    ]);

    render(<EstimateList />);
    await screen.findByText('EST-0007');
    // centsToDisplay(150000) = '$1500.00'
    expect(screen.getByText('$1500.00')).toBeInTheDocument();
  });

  it('formats different cent amounts correctly', async () => {
    mockFetchOnce([
      { id: 'e1', estimateNumber: 'EST-0001', status: 'sent', totalCents: 9500, jobId: 'j1' },
      { id: 'e2', estimateNumber: 'EST-0002', status: 'accepted', totalCents: 100, jobId: 'j2' },
    ]);

    render(<EstimateList />);
    await screen.findByText('EST-0001');
    expect(screen.getByText('$95.00')).toBeInTheDocument();   // 9500 cents
    expect(screen.getByText('$1.00')).toBeInTheDocument();    // 100 cents
  });

  it('shows empty state when API returns empty array', async () => {
    mockFetchOnce([]);
    render(<EstimateList />);
    await screen.findByText('No estimates yet');
  });
});

// ─── Thread 3: InvoiceList ───────────────────────────────────────────────────

describe('Thread 3 — InvoiceList → /api/invoices → rendered rows', () => {
  it('fetches from /api/invoices on mount', async () => {
    const fetchSpy = mockFetchOnce([]);
    render(<InvoiceList />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const urls = getCalledUrls(fetchSpy);
    expect(urls.some((u) => u.includes('/api/invoices'))).toBe(true);
  });

  it('renders invoice rows with totalCents and amountDueCents formatted', async () => {
    mockFetchOnce([
      {
        id: 'i1',
        invoiceNumber: 'INV-0003',
        status: 'open',
        totalCents: 50000,
        amountDueCents: 50000,
        dueDate: '2026-04-01',
      },
    ]);

    render(<InvoiceList />);
    await screen.findByText('INV-0003');
    // totalCents = 50000 → $500.00 (shown in "Total" column)
    // amountDueCents = 50000 → $500.00 (shown in "Amount Due" column)
    const amounts = screen.getAllByText('$500.00');
    expect(amounts.length).toBeGreaterThanOrEqual(1);
  });

  it('correctly formats partial payment scenario', async () => {
    mockFetchOnce([
      {
        id: 'i1',
        invoiceNumber: 'INV-0010',
        status: 'partially_paid',
        totalCents: 20000,
        amountDueCents: 10000,
      },
    ]);

    render(<InvoiceList />);
    await screen.findByText('INV-0010');
    expect(screen.getByText('$200.00')).toBeInTheDocument();  // total
    expect(screen.getByText('$100.00')).toBeInTheDocument();  // amount due
  });

  it('shows empty state when API returns empty array', async () => {
    mockFetchOnce([]);
    render(<InvoiceList />);
    await screen.findByText('No invoices yet');
  });
});

// ─── Thread 4: CustomerList ──────────────────────────────────────────────────

describe('Thread 4 — CustomerList → /api/customers → rendered rows', () => {
  it('fetches from /api/customers on mount', async () => {
    const fetchSpy = mockFetchOnce([]);
    render(<CustomerList />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const urls = getCalledUrls(fetchSpy);
    expect(urls.some((u) => u.includes('/api/customers'))).toBe(true);
  });

  it('renders customer rows using displayName', async () => {
    mockFetchOnce([
      {
        id: 'c1',
        displayName: 'Alice Smith',
        firstName: 'Alice',
        lastName: 'Smith',
        email: 'alice@example.com',
        primaryPhone: '555-0101',
        isArchived: false,
      },
    ]);

    render(<CustomerList />);
    await screen.findByText('Alice Smith');
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('555-0101')).toBeInTheDocument();
  });

  it('renders multiple customers', async () => {
    mockFetchOnce([
      { id: 'c1', displayName: 'Alice Smith', email: 'alice@example.com', isArchived: false },
      { id: 'c2', displayName: 'Bob Jones', email: 'bob@example.com', isArchived: false },
    ]);

    render(<CustomerList />);
    await screen.findByText('Alice Smith');
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
  });

  it('shows empty state when API returns empty array', async () => {
    mockFetchOnce([]);
    render(<CustomerList />);
    await screen.findByText('No customers yet');
  });
});

// ─── Thread 5: Multiple pages hit distinct endpoints ─────────────────────────

describe('Thread 5 — Each list page targets a distinct API endpoint', () => {
  it('JobList does not call /api/estimates or /api/invoices', async () => {
    const fetchSpy = mockFetchOnce([]);
    render(<JobList />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const urls = getCalledUrls(fetchSpy);
    expect(urls.every((u) => u.includes('/api/jobs'))).toBe(true);
  });

  it('EstimateList does not call /api/jobs or /api/invoices', async () => {
    const fetchSpy = mockFetchOnce([]);
    render(<EstimateList />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const urls = getCalledUrls(fetchSpy);
    expect(urls.every((u) => u.includes('/api/estimates'))).toBe(true);
  });

  it('InvoiceList does not call /api/jobs or /api/estimates', async () => {
    const fetchSpy = mockFetchOnce([]);
    render(<InvoiceList />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const urls = getCalledUrls(fetchSpy);
    expect(urls.every((u) => u.includes('/api/invoices'))).toBe(true);
  });
});
