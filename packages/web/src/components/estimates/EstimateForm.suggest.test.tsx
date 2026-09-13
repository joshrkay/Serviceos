import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EstimateForm } from './EstimateForm';

// Defect: the "AI Suggestions" sparkle button faked AI — a setTimeout over a
// bundled 3-item HVAC price list (AI_SUGGESTIONS) that never called the API.
// The real catalog-grounded endpoint exists (POST /api/estimates/suggest,
// already consumed by NewEstimateFlow via the same apiFetch client) and is
// what this form must use. Contract pinned here:
//   - clicking the button POSTs { description, jobId? } to
//     /api/estimates/suggest through apiFetch (auth-aware client);
//   - returned lineItems (unitPrice in INTEGER CENTS per the estimate task
//     contract) map into the editor's dollars-string drafts;
//   - failure renders a visible error affordance and NEVER the old canned
//     item names — no silent mock fallback (same class as the NewEstimateFlow
//     catalog-error blocker).

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Per-test behavior for POST /api/estimates/suggest. vi.hoisted so the
// api-fetch mock factory (hoisted above imports) can close over it.
const harness = vi.hoisted(() => ({
  suggest: (): Promise<Response> => Promise.reject(new Error('harness.suggest not set')),
  suggestCalls: [] as Array<{ url: string; init?: RequestInit }>,
}));

// Route the form's non-hook fetches. The suggest endpoint does whatever the
// test installs; job detail + agreements (fired by the job-picker effect)
// resolve with fixture data so the form reaches a realistic selected-job state.
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/estimates/suggest' && init?.method === 'POST') {
      harness.suggestCalls.push({ url, init });
      return harness.suggest();
    }
    if (url.startsWith('/api/jobs/job-1')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'job-1',
          jobNumber: 'J-1001',
          summary: 'AC not cooling upstairs',
          customerId: 'cust-1',
          customer: { id: 'cust-1', displayName: 'Pat Customer' },
          location: { street1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701' },
        }),
      } as Response;
    }
    if (url.startsWith('/api/agreements')) {
      return { ok: true, status: 200, json: async () => [] } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }),
}));

// The jobs picker goes through the real useListQuery → useApiClient.
vi.mock('../../lib/apiClient', () => {
  const routedFetch = async (url: string): Promise<Response> => {
    if (url.startsWith('/api/jobs')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 'job-1', jobNumber: 'J-1001', summary: 'AC not cooling upstairs', customerId: 'cust-1' }],
          total: 1,
        }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  };
  return { useApiClient: () => routedFetch };
});

// Canned AI_SUGGESTIONS item names that must never render again — a failed
// (or slow) suggest call must not invent hardcoded HVAC prices.
const CANNED_ITEM_NAMES = [
  'Labor – 2 hrs at $95/hr',
  'Service call fee',
  'R-410A refrigerant (1 lb)',
  'Labor – 2 hrs',
];

function okSuggest(body: {
  proposalId?: string;
  lineItems: Array<{ description: string; quantity: number; unitPrice: number; category?: string }>;
  notes?: string;
}) {
  return async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ confidenceScore: 0.82, status: 'draft', ...body }),
    }) as Response;
}

async function renderWithJobSelected() {
  render(<EstimateForm onCreated={vi.fn()} onCancel={vi.fn()} />);
  // Pick the job once the jobs list has loaded.
  await screen.findByRole('option', { name: /J-1001/ });
  fireEvent.change(screen.getByLabelText('Job *'), { target: { value: 'job-1' } });
  // Job-detail effect settled (customer box rendered) before we click AI.
  await screen.findByText('Pat Customer');
}

describe('EstimateForm — AI Suggestions call the real /api/estimates/suggest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.suggestCalls = [];
    harness.suggest = () => Promise.reject(new Error('harness.suggest not set'));
  });

  it('clicking the button POSTs the form context to /api/estimates/suggest and renders the returned items', async () => {
    harness.suggest = okSuggest({
      proposalId: 'prop-1',
      lineItems: [
        { description: 'Blower motor replacement (OEM)', quantity: 1, unitPrice: 34500, category: 'material' },
        { description: 'Diagnostic & install labor', quantity: 2, unitPrice: 9500, category: 'labor' },
      ],
      notes: 'Grounded in tenant catalog',
    });
    await renderWithJobSelected();

    fireEvent.change(screen.getByLabelText('Customer message'), {
      target: { value: 'Blower motor squealing; weak airflow' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'AI Suggestions' }));

    // Real endpoint hit — same authenticated client + request contract as
    // NewEstimateFlow.suggestEstimate: free-text description (+ jobId here,
    // which the suggest schema accepts for grounding).
    await waitFor(() => expect(harness.suggestCalls).toHaveLength(1));
    const body = JSON.parse(harness.suggestCalls[0].init?.body as string) as {
      description: string;
      jobId?: string;
    };
    expect(body.description).toContain('AC not cooling upstairs');
    expect(body.description).toContain('Blower motor squealing; weak airflow');
    expect(body.jobId).toBe('job-1');

    // Returned line items land in the editor with unitPrice CENTS converted
    // to the editor's dollars string (34500 → "345.00", not "34500.00").
    expect(await screen.findByDisplayValue('Blower motor replacement (OEM)')).toBeInTheDocument();
    expect(screen.getByDisplayValue('345.00')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Diagnostic & install labor')).toBeInTheDocument();
    expect(screen.getByDisplayValue('95.00')).toBeInTheDocument();

    // The fresh form's sole blank row was replaced, not left dangling —
    // exactly the two suggested rows remain.
    expect(screen.getAllByLabelText(/^description-\d+$/)).toHaveLength(2);

    // Button reflects completion.
    expect(screen.getByRole('button', { name: 'Suggestions added' })).toBeDisabled();

    // Canned list is gone for good — even on success nothing hardcoded renders.
    for (const name of CANNED_ITEM_NAMES) {
      expect(screen.queryByDisplayValue(name)).not.toBeInTheDocument();
    }
  });

  it('endpoint failure renders a visible error and never the old canned items', async () => {
    harness.suggest = async () =>
      ({
        ok: false,
        status: 503,
        json: async () => ({ error: 'NOT_CONFIGURED', message: 'AI estimate suggestions are not configured for this environment' }),
      }) as Response;
    await renderWithJobSelected();

    fireEvent.click(screen.getByRole('button', { name: 'AI Suggestions' }));

    // Server-provided message surfaces in a real error affordance.
    expect(
      await screen.findByText('AI estimate suggestions are not configured for this environment'),
    ).toBeInTheDocument();

    // No silent fallback: none of the old AI_SUGGESTIONS rows may render.
    for (const name of CANNED_ITEM_NAMES) {
      expect(screen.queryByDisplayValue(name)).not.toBeInTheDocument();
    }
    // Only the untouched blank row remains.
    expect(screen.getAllByLabelText(/^description-\d+$/)).toHaveLength(1);
    expect((screen.getByLabelText('description-0') as HTMLInputElement).value).toBe('');

    // The button recovers so the user can retry.
    expect(screen.getByRole('button', { name: 'AI Suggestions' })).toBeEnabled();
  });

  it('network rejection surfaces an error state too — no invented prices', async () => {
    harness.suggest = () => Promise.reject(new TypeError('Failed to fetch'));
    await renderWithJobSelected();

    fireEvent.click(screen.getByRole('button', { name: 'AI Suggestions' }));

    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument();
    for (const name of CANNED_ITEM_NAMES) {
      expect(screen.queryByDisplayValue(name)).not.toBeInTheDocument();
    }
  });

  it('empty lineItems from the API is an error, not a success', async () => {
    harness.suggest = okSuggest({ proposalId: 'prop-2', lineItems: [] });
    await renderWithJobSelected();

    fireEvent.click(screen.getByRole('button', { name: 'AI Suggestions' }));

    expect(
      await screen.findByText(/AI returned no line items/i),
    ).toBeInTheDocument();
    // Button did not latch into the used state — retry stays available.
    expect(screen.getByRole('button', { name: 'AI Suggestions' })).toBeEnabled();
  });
});
