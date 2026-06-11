/**
 * P4-014 — Live templates section coverage.
 *
 * Tests focus on the backend-wired part of the page (LiveTemplatesSection
 * and LiveTemplateDetailModal). The surrounding mock UI is intentionally
 * untouched because its hard-coded TEMPLATES array does not map to the
 * `EstimateTemplate` backend entity — see the comment on
 * LiveTemplatesSection.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: apiFetchMock,
}));
vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => apiFetchMock,
}));

// useMe controls the owner gate; default to owner unless a test overrides.
const meRef: { current: { role: string } | null } = { current: { role: 'owner' } };
vi.mock('../../hooks/useMe', () => ({
  useMe: () => ({ me: meRef.current, isLoading: false, error: null, switchMode: vi.fn(), refetch: vi.fn() }),
}));

import { LiveTemplatesSection, LiveTemplateDetailModal } from './TemplatesPage';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const hvacTemplate = {
  id: 't-hvac-1',
  tenantId: 'tenant-1',
  verticalType: 'hvac',
  categoryId: 'cat-hvac-tune',
  name: 'AC Tune-Up',
  description: 'Standard summer maintenance',
  lineItemTemplates: [
    {
      description: 'Diagnostic fee',
      category: 'labor',
      defaultQuantity: 1,
      defaultUnitPriceCents: 8500,
      taxable: false,
      sortOrder: 0,
      isOptional: false,
    },
    {
      description: 'Refrigerant top-up',
      category: 'material',
      defaultQuantity: 1,
      defaultUnitPriceCents: 12500,
      taxable: true,
      sortOrder: 1,
      isOptional: true,
    },
  ],
  defaultDiscountCents: 0,
  defaultTaxRateBps: 0,
  defaultCustomerMessage: 'Thanks for choosing us.',
  isActive: true,
  usageCount: 14,
  updatedAt: '2026-05-01T00:00:00.000Z',
};

const plumbingTemplate = {
  ...hvacTemplate,
  id: 't-plumb-1',
  verticalType: 'plumbing',
  categoryId: 'cat-plumb-leak',
  name: 'Leak Inspection',
  description: 'Initial diagnostic',
  usageCount: 3,
  defaultCustomerMessage: 'Talk soon.',
};

beforeEach(() => {
  apiFetchMock.mockReset();
  meRef.current = { role: 'owner' };
});

describe('LiveTemplatesSection — fetch + filter by active vertical packs', () => {
  it('fetches /api/settings then /api/templates per active pack and renders them ordered by usageCount', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ activeVerticalPacks: ['hvac', 'plumbing'] }))
      .mockResolvedValueOnce(jsonResponse([hvacTemplate]))
      .mockResolvedValueOnce(jsonResponse([plumbingTemplate]));

    render(<LiveTemplatesSection />);

    await waitFor(() => expect(screen.getByText('AC Tune-Up')).toBeInTheDocument());
    expect(screen.getByText('Leak Inspection')).toBeInTheDocument();

    const settingsCall = apiFetchMock.mock.calls[0];
    expect(settingsCall[0]).toBe('/api/settings');
    expect(apiFetchMock.mock.calls.some((c) => c[0] === '/api/templates?verticalType=hvac')).toBe(true);
    expect(apiFetchMock.mock.calls.some((c) => c[0] === '/api/templates?verticalType=plumbing')).toBe(true);

    // Usage-count ordering: hvac (14) before plumbing (3).
    const allItems = screen.getAllByText(/used \d+×/);
    expect(allItems[0]).toHaveTextContent('used 14×');
    expect(allItems[1]).toHaveTextContent('used 3×');
  });

  it('renders the activation nudge when no vertical pack is active', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ activeVerticalPacks: [] }));

    render(<LiveTemplatesSection />);

    expect(await screen.findByText(/No vertical pack is active/i)).toBeInTheDocument();
    // No template fetches should have fired.
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows an error alert if /api/settings fails', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500 }));

    render(<LiveTemplatesSection />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Settings load failed/i);
  });

  it('dedupes templates registered against multiple verticals', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ activeVerticalPacks: ['hvac', 'plumbing'] }))
      .mockResolvedValueOnce(jsonResponse([hvacTemplate]))
      // plumbing call returns the SAME template id (rare but possible).
      .mockResolvedValueOnce(jsonResponse([hvacTemplate]));

    render(<LiveTemplatesSection />);

    await waitFor(() => expect(screen.getAllByText('AC Tune-Up')).toHaveLength(1));
  });
});

describe('LiveTemplateDetailModal — preview + wording edit', () => {
  it('renders line items read-only and the editable wording field for an owner', () => {
    render(
      <LiveTemplateDetailModal
        template={hvacTemplate}
        canEdit
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByText('Diagnostic fee')).toBeInTheDocument();
    expect(screen.getByText('Refrigerant top-up')).toBeInTheDocument();
    expect(screen.getByText('$85.00')).toBeInTheDocument();
    expect(screen.getByText('$125.00')).toBeInTheDocument();

    const textarea = screen.getByLabelText(/Customer message/i) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe('Thanks for choosing us.');
    expect(screen.getByRole('button', { name: /Save wording/i })).toBeInTheDocument();
  });

  it('disables the textarea and hides the Save button for non-owner roles', () => {
    render(
      <LiveTemplateDetailModal
        template={hvacTemplate}
        canEdit={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const textarea = screen.getByLabelText(/Customer message/i) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Save wording/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Only owners can edit/i)).toBeInTheDocument();
  });

  it('PUTs /api/templates/:id with the edited wording and calls onSaved + onClose', async () => {
    const updated = { ...hvacTemplate, defaultCustomerMessage: 'New wording.' };
    apiFetchMock.mockResolvedValueOnce(jsonResponse(updated));
    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(
      <LiveTemplateDetailModal
        template={hvacTemplate}
        canEdit
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    const textarea = screen.getByLabelText(/Customer message/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'New wording.' } });
    fireEvent.click(screen.getByRole('button', { name: /Save wording/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated));
    expect(onClose).toHaveBeenCalled();

    const [url, init] = apiFetchMock.mock.calls[0];
    expect(url).toBe('/api/templates/t-hvac-1');
    expect((init as RequestInit).method).toBe('PUT');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ defaultCustomerMessage: 'New wording.' });
  });

  it('keeps the modal open and shows an error if the PUT fails', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));
    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(
      <LiveTemplateDetailModal
        template={hvacTemplate}
        canEdit
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Save wording/i }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Save failed/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('LiveTemplatesSection — non-owner viewing a live template', () => {
  it('opens the modal in read-only mode when role is not owner', async () => {
    meRef.current = { role: 'technician' };
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ activeVerticalPacks: ['hvac'] }))
      .mockResolvedValueOnce(jsonResponse([hvacTemplate]));

    render(<LiveTemplatesSection />);
    fireEvent.click(await screen.findByText('AC Tune-Up'));

    const textarea = screen.getByLabelText(/Customer message/i) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Save wording/i })).not.toBeInTheDocument();
  });
});
