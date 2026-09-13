import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { NewEstimateFlow } from '../NewEstimateFlow';

// Defect: the manual-build catalog fell back to the bundled MANUAL_CATALOG
// starter prices whenever GET /api/catalog/items settled without rows — and
// "settled" included a fetch FAILURE. Rendering invented starter prices when
// the Price Book fetch errored masks the outage and lets an operator quote
// hardcoded prices (same class as the EstimateApprovalPage mock-fallback
// blocker). Contract pinned here by driving the REAL useListQuery hook with
// a routed apiClient, so an actual fetch rejection maps through to the UI:
//   - fetch REJECTION  → ErrorState with a working Retry, no starter items
//   - empty Price Book → starter catalog keeps rendering (unchanged behavior)

vi.mock('@clerk/clerk-react', () => ({
  useUser: () => ({
    user: { fullName: 'Sam Owner', primaryEmailAddress: { emailAddress: 'sam@example.com' } },
  }),
}));
vi.mock('../../../hooks/useEstimateTerm', () => ({ useEstimateTerm: () => 'Estimate' }));
// Fetches outside useListQuery (jobs picker, create/send) are not under
// test — resolve them empty.
vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })),
}));

// Per-test behavior for GET /api/catalog/items. vi.hoisted so the apiClient
// mock factory (hoisted above imports) can close over it.
const harness = vi.hoisted(() => ({
  catalog: (): Promise<Response> => Promise.reject(new Error('harness.catalog not set')),
}));

// Route the real useListQuery's fetches: customers resolve, /api/settings is
// non-fatal 404, and the catalog endpoint does whatever the test installs.
vi.mock('../../../lib/apiClient', () => {
  const routedFetch = async (url: string): Promise<Response> => {
    if (url.startsWith('/api/catalog/items')) return harness.catalog();
    if (url.startsWith('/api/customers')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{
            id: 'cust-1',
            displayName: 'Pat Customer',
            primaryPhone: '5551234567',
            email: 'pat@example.com',
            locations: [
              { id: 'loc-1', label: 'Home', street1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', isPrimary: true, serviceTypes: ['HVAC'] },
            ],
          }],
          total: 1,
        }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  };
  return { useApiClient: () => routedFetch };
});

// Bundled starter-catalog (MANUAL_CATALOG) item names that must never render
// on a failed Price Book fetch. Sampled across all three service types.
const STARTER_ITEM_NAMES = [
  'Diagnostic fee',             // HVAC
  'AC tune-up & inspection',    // HVAC
  'Nest thermostat',            // HVAC
  'Drain cleaning (main line)', // Plumbing
  'SW Cashmere interior (gal)', // Painting
];

function okCatalog(items: Array<{ id: string; name: string; unitPriceCents: number; category?: string }>) {
  return async () =>
    ({ ok: true, status: 200, json: async () => ({ data: items, total: items.length }) }) as Response;
}

function openManualBuild() {
  render(
    <MemoryRouter>
      <NewEstimateFlow onClose={vi.fn()} onCreated={vi.fn()} preSelectedCustomerId="cust-1" />
    </MemoryRouter>,
  );
  // Start screen → "Start new" (manual catalog path).
  fireEvent.click(screen.getByText('Start new'));
}

describe('NewEstimateFlow — catalog fetch failure vs empty Price Book', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetch rejection: renders the error state with Retry and NO starter-catalog items', async () => {
    harness.catalog = () => Promise.reject(new TypeError('Failed to fetch'));
    openManualBuild();

    // ErrorState (EstimatesPage / EstimateApprovalPage pattern) with retry.
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    // No invented starter prices on failure.
    for (const name of STARTER_ITEM_NAMES) {
      expect(screen.queryByText(name)).not.toBeInTheDocument();
    }

    // Switching service type must not resurrect the starter catalog either.
    fireEvent.click(screen.getByRole('button', { name: /Plumbing/ }));
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByText('Drain cleaning (main line)')).not.toBeInTheDocument();
  });

  it('Retry refetches and renders the real Price Book once the API recovers', async () => {
    harness.catalog = () => Promise.reject(new TypeError('Failed to fetch'));
    openManualBuild();
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();

    harness.catalog = okCatalog([
      { id: 'cat-1', name: 'Real price book item', unitPriceCents: 12300, category: 'Service' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Real price book item')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
    // Recovered rows are the tenant's real items — still no starter fallback.
    expect(screen.queryByText('Diagnostic fee')).not.toBeInTheDocument();
  });

  it('genuinely empty Price Book: keeps the bundled starter-catalog experience', async () => {
    harness.catalog = okCatalog([]);
    openManualBuild();

    // Starter catalog for the customer's service type (HVAC) renders.
    expect(await screen.findByText('Diagnostic fee')).toBeInTheDocument();
    expect(screen.getByText('AC tune-up & inspection')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });
});
