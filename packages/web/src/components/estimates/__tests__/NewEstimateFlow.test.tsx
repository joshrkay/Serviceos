import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { NewEstimateFlow } from '../NewEstimateFlow';

// NewEstimateFlow is the AI/manual estimate builder wizard. As of U1 (E1) it
// persists a real estimate via POST /api/estimates and (on Send) POST
// /api/estimates/:id/send, threading a real jobId. These tests drive the
// manual build path end-to-end and assert the API wiring + cents body.

vi.mock('@clerk/clerk-react', () => ({
  useUser: () => ({
    user: { fullName: 'Sam Owner', primaryEmailAddress: { emailAddress: 'sam@example.com' } },
  }),
}));
vi.mock('../../../lib/apiClient', () => ({
  // The /api/settings effect is non-fatal; resolve a not-ok response.
  useApiClient: () => vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
}));
vi.mock('../../../hooks/useEstimateTerm', () => ({ useEstimateTerm: () => 'Estimate' }));

const CUSTOMERS = [
  {
    id: 'cust-1',
    displayName: 'Pat Customer',
    primaryPhone: '5551234567',
    email: 'pat@example.com',
    locations: [
      { id: 'loc-1', label: 'Home', street1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', isPrimary: true, serviceTypes: ['HVAC'] },
    ],
  },
];

const CATALOG = [
  { id: 'cat-1', name: 'Service call fee', unitPriceCents: 8500, category: 'Service' },
];

vi.mock('../../../hooks/useListQuery', () => ({
  useListQuery: (endpoint: string) => {
    if (endpoint === '/api/customers') {
      return { data: CUSTOMERS, isLoading: false, error: null, setSearch: vi.fn() };
    }
    if (endpoint === '/api/catalog/items') {
      return { data: CATALOG, isLoading: false, error: null, setSearch: vi.fn() };
    }
    return { data: [], isLoading: false, error: null, setSearch: vi.fn() };
  },
}));

// apiFetch is the network seam. Each test installs its own implementation.
const apiFetchMock = vi.fn();
vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function renderFlow(props: Partial<React.ComponentProps<typeof NewEstimateFlow>> = {}) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <MemoryRouter>
      <NewEstimateFlow onClose={onClose} onCreated={onCreated} {...props} />
    </MemoryRouter>,
  );
  return { onClose, onCreated };
}

// Drive the manual build path to the Review step for a pre-selected customer.
async function reachReview(props: Partial<React.ComponentProps<typeof NewEstimateFlow>> = {}) {
  const ctx = renderFlow({ preSelectedCustomerId: 'cust-1', ...props });
  // Start screen → "Start new" (manual catalog path).
  fireEvent.click(screen.getByText('Start new'));
  // Tap the catalog item to add it as a line item.
  await screen.findByText('Service call fee');
  fireEvent.click(screen.getByText('Service call fee'));
  // "Review estimate · …" CTA inside the manual cart.
  fireEvent.click(await screen.findByRole('button', { name: /Review estimate/i }));
  // Footer "Review estimate →" advances to the review step.
  fireEvent.click(await screen.findByRole('button', { name: /Review estimate →/i }));
  // Review step is up once "Send to customer" shows.
  await screen.findByRole('button', { name: /Send to customer/i });
  return ctx;
}

describe('NewEstimateFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockReset();
  });

  it('renders the start screen with both build modes', () => {
    apiFetchMock.mockResolvedValue(jsonResponse([]));
    renderFlow();
    expect(screen.getByText(/How would you like to build this estimate/i)).toBeInTheDocument();
    expect(screen.getByText('Speak it')).toBeInTheDocument();
    expect(screen.getByText('Start new')).toBeInTheDocument();
  });

  it('does not call onCreated before the flow completes', () => {
    apiFetchMock.mockResolvedValue(jsonResponse([]));
    const { onCreated } = renderFlow();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('renders on Path A tokens — no raw Tailwind palette leaks', () => {
    apiFetchMock.mockResolvedValue(jsonResponse([]));
    const { container } = render(
      <MemoryRouter>
        <NewEstimateFlow onClose={vi.fn()} onCreated={vi.fn()} />
      </MemoryRouter>,
    );
    expect(container.innerHTML).not.toMatch(
      /(bg|text|border|border-l|border-t|placeholder|ring|divide|shadow)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/,
    );
  });

  it('Send: creates an estimate (cents body) then sends, and uses the returned viewUrl', async () => {
    // One existing job for the customer, so it auto-selects (length === 1).
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/jobs?customerId=')) {
        return Promise.resolve(jsonResponse([{ id: 'job-1', jobNumber: 'J-1', summary: 'Existing job' }]));
      }
      if (url === '/api/estimates' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: 'est-1' }, 201));
      }
      if (url === '/api/estimates/est-1/send' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ viewUrl: 'https://app.test/e/abc123', viewToken: 'abc123' }, 202));
      }
      return Promise.resolve(jsonResponse([]));
    });

    await reachReview();
    fireEvent.click(screen.getByRole('button', { name: /Send to customer/i }));
    // Send step preview shows the (placeholder) link, then send fires.
    fireEvent.click(await screen.findByRole('button', { name: /Send via/i }));

    // Success state renders once create + send resolve.
    expect(await screen.findByText(/Estimate sent!/i)).toBeInTheDocument();

    const calls = apiFetchMock.mock.calls.map(c => c[0]);
    expect(calls).toContain('/api/estimates');
    expect(calls).toContain('/api/estimates/est-1/send');

    // Assert the create body carried integer cents (Service call fee = 8500c).
    const createCall = apiFetchMock.mock.calls.find(c => c[0] === '/api/estimates');
    const body = JSON.parse((createCall![1] as RequestInit).body as string);
    expect(body.jobId).toBe('job-1');
    expect(body.lineItems[0].unitPriceCents).toBe(8500);
    expect(body.lineItems[0]).not.toHaveProperty('rate');
  });

  it('Save draft: creates the estimate only — no send call', async () => {
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/jobs?customerId=')) {
        return Promise.resolve(jsonResponse([{ id: 'job-1', summary: 'Existing job' }]));
      }
      if (url === '/api/estimates' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: 'est-2' }, 201));
      }
      return Promise.resolve(jsonResponse([]));
    });

    await reachReview();
    fireEvent.click(screen.getByRole('button', { name: /Save as draft/i }));

    expect(await screen.findByText(/Draft saved/i)).toBeInTheDocument();
    const calls = apiFetchMock.mock.calls.map(c => c[0]);
    expect(calls).toContain('/api/estimates');
    expect(calls.some((u: string) => String(u).includes('/send'))).toBe(false);
  });

  it('No job: submit is blocked until a job is created (create-job supplies jobId)', async () => {
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/jobs?customerId=')) {
        return Promise.resolve(jsonResponse([])); // customer has no jobs
      }
      if (url === '/api/jobs' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: 'job-new', summary: 'New job' }, 201));
      }
      if (url === '/api/estimates' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: 'est-3' }, 201));
      }
      return Promise.resolve(jsonResponse([]));
    });

    await reachReview();

    // With no job selected, the Save/Send buttons are disabled.
    const saveBtn = screen.getByRole('button', { name: /Save as draft/i });
    expect(saveBtn).toBeDisabled();
    expect(screen.getByText(/Select or create a job to continue/i)).toBeInTheDocument();

    // Create a job for this customer.
    fireEvent.click(screen.getByRole('button', { name: /Create a job for this customer/i }));
    await waitFor(() => {
      const calls = apiFetchMock.mock.calls.filter(c => c[0] === '/api/jobs' && (c[1] as RequestInit)?.method === 'POST');
      expect(calls.length).toBe(1);
    });

    // Now the Save button is enabled and creating the estimate works.
    await waitFor(() => expect(screen.getByRole('button', { name: /Save as draft/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Save as draft/i }));
    expect(await screen.findByText(/Draft saved/i)).toBeInTheDocument();
    const createCall = apiFetchMock.mock.calls.find(c => c[0] === '/api/estimates');
    expect(JSON.parse((createCall![1] as RequestInit).body as string).jobId).toBe('job-new');
  });

  it('Create error: surfaces the message and does NOT call onCreated', async () => {
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/jobs?customerId=')) {
        return Promise.resolve(jsonResponse([{ id: 'job-1', summary: 'Existing job' }]));
      }
      if (url === '/api/estimates' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ message: 'Validation failed: line items required' }, 400));
      }
      return Promise.resolve(jsonResponse([]));
    });

    const { onCreated } = await reachReview();
    fireEvent.click(screen.getByRole('button', { name: /Save as draft/i }));

    expect(await screen.findByText(/Validation failed/i)).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    // No "Draft saved" success state.
    expect(screen.queryByText(/Draft saved/i)).not.toBeInTheDocument();
  });
});
