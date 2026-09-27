import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeadList } from '../LeadList';
import { expectAllTapTargets } from '../../../test-utils/tap-target';

vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../../utils/api-fetch';

const sampleLeads = [
  {
    id: 'lead-1',
    firstName: 'Alice',
    lastName: 'Wong',
    source: 'web_form',
    stage: 'new',
  },
  {
    id: 'lead-2',
    firstName: 'Bob',
    lastName: 'Smith',
    source: 'referral',
    stage: 'qualified',
  },
];

/**
 * Responses for the lead-list / PATCH calls, in call order. The #1416
 * assignee picker's GET /api/users is answered separately (empty team), so
 * it never consumes a response queued for the kanban.
 */
const queued: Response[] = [];

function enqueue(body: unknown) {
  queued.push({ ok: true, status: 200, json: async () => body } as unknown as Response);
}

function mockListOnce(leads = sampleLeads) {
  enqueue({ data: leads, total: leads.length });
}

describe('Leads — LeadList kanban (P9-001)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    queued.length = 0;
    vi.mocked(apiFetch).mockImplementation(async (input) =>
      String(input).startsWith('/api/users')
        ? ({ ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response)
        : (queued.shift() as Response),
    );
  });

  it('#1283 — source filter chips meet the 44px tap target (min-h-11)', async () => {
    mockListOnce();
    render(<LeadList />);
    await screen.findByText('Alice Wong');
    const all = screen.getByRole('button', { name: 'All' });
    const chips = Array.from(all.parentElement!.querySelectorAll('button'));
    expect(chips.length).toBeGreaterThan(1);
    for (const chip of chips) {
      expect(chip.className, chip.textContent ?? '').toMatch(/(^|\s)min-h-11(\s|$)/);
    }
  });

  it('#1398 — every page-level control (New Lead, chips, owner filter, cards) is a ≥44×44 tap target', async () => {
    mockListOnce();
    const { container } = render(<LeadList />);
    await screen.findByText('Alice Wong');
    expectAllTapTargets(container, 'LeadList');
  });

  it('renders kanban columns and lead cards from the API', async () => {
    mockListOnce();
    render(<LeadList />);
    await waitFor(() => {
      expect(screen.getByText('Alice Wong')).toBeInTheDocument();
      expect(screen.getByText('Bob Smith')).toBeInTheDocument();
    });
    expect(screen.getByTestId('lead-column-new')).toBeInTheDocument();
    expect(screen.getByTestId('lead-column-qualified')).toBeInTheDocument();
  });

  it('drag-drop between columns triggers PATCH /api/leads/:id with new stage', async () => {
    mockListOnce();
    // The PATCH call
    enqueue({});

    render(<LeadList />);
    const card = await screen.findByTestId('lead-card-lead-1');
    const targetColumn = screen.getByTestId('lead-column-contacted');

    const dataTransfer = {
      data: {} as Record<string, string>,
      effectAllowed: '',
      dropEffect: '',
      setData(this: { data: Record<string, string> }, key: string, value: string) {
        this.data[key] = value;
      },
      getData(this: { data: Record<string, string> }, key: string) {
        return this.data[key] ?? '';
      },
    };

    await act(async () => {
      fireEvent.dragStart(card, { dataTransfer });
      fireEvent.dragOver(targetColumn, { dataTransfer });
      fireEvent.drop(targetColumn, { dataTransfer });
    });

    await waitFor(() => {
      const patchCall = vi
        .mocked(apiFetch)
        .mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH');
      expect(patchCall).toBeDefined();
      expect(patchCall![0]).toBe('/api/leads/lead-1');
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({
        stage: 'contacted',
      });
    });
  });

  it('blocks dragging into the won column (must use Convert action)', async () => {
    mockListOnce();
    render(<LeadList />);
    const card = await screen.findByTestId('lead-card-lead-1');
    const wonColumn = screen.getByTestId('lead-column-won');

    const dataTransfer = {
      data: {} as Record<string, string>,
      effectAllowed: '',
      dropEffect: '',
      setData(this: { data: Record<string, string> }, k: string, v: string) {
        this.data[k] = v;
      },
      getData(this: { data: Record<string, string> }, k: string) {
        return this.data[k] ?? '';
      },
    };

    await act(async () => {
      fireEvent.dragStart(card, { dataTransfer });
      fireEvent.drop(wonColumn, { dataTransfer });
    });

    // No PATCH was called.
    const patchCalls = vi
      .mocked(apiFetch)
      .mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH');
    expect(patchCalls.length).toBe(0);
    // Won column is not a drop target — no alert needed when drop is ignored.
    expect(wonColumn).toHaveAttribute('data-droppable', 'false');
  });

  it('does not navigate when a card is clicked after a drag', async () => {
    mockListOnce();
    // PATCH for the drop
    enqueue({});

    const onSelectLead = vi.fn();
    render(<LeadList onSelectLead={onSelectLead} />);
    const card = await screen.findByTestId('lead-card-lead-1');
    const targetColumn = screen.getByTestId('lead-column-contacted');

    const dataTransfer = {
      data: {} as Record<string, string>,
      effectAllowed: '',
      dropEffect: '',
      setData(this: { data: Record<string, string> }, key: string, value: string) {
        this.data[key] = value;
      },
      getData(this: { data: Record<string, string> }, key: string) {
        return this.data[key] ?? '';
      },
    };

    await act(async () => {
      fireEvent.mouseDown(card);
      fireEvent.dragStart(card, { dataTransfer });
      fireEvent.dragOver(targetColumn, { dataTransfer });
      fireEvent.drop(targetColumn, { dataTransfer });
      fireEvent.dragEnd(card);
      // Browser often fires a click on the drag source after dragend.
      fireEvent.click(card);
    });

    expect(onSelectLead).not.toHaveBeenCalled();
  });

  it('still navigates on a plain click without drag', async () => {
    mockListOnce();
    const onSelectLead = vi.fn();
    render(<LeadList onSelectLead={onSelectLead} />);
    const card = await screen.findByTestId('lead-card-lead-1');

    fireEvent.mouseDown(card);
    fireEvent.click(card);

    expect(onSelectLead).toHaveBeenCalledWith('lead-1');
  });

  it('#1406 D10 — the source filter offers every lead source, including sms and customer_portal', async () => {
    mockListOnce();
    mockListOnce();
    render(<LeadList />);
    await screen.findByText('Alice Wong');

    fireEvent.click(screen.getByRole('button', { name: 'sms' }));

    await waitFor(() => {
      const urls = vi.mocked(apiFetch).mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes('source=sms'))).toBe(true);
    });
    expect(screen.getByRole('button', { name: 'customer_portal' })).toBeInTheDocument();
  });

  it('#1416 — the assignee filter is a picker of team members by NAME that filters by their id', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/api/users')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: 'user-carlos', firstName: 'Carlos', lastName: 'Reyes' },
              { id: 'user-dana', firstName: 'Dana', lastName: 'Ortiz' },
            ],
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: sampleLeads, total: sampleLeads.length }),
      } as unknown as Response;
    });
    render(<LeadList />);
    await screen.findByText('Alice Wong');

    expect(screen.queryByPlaceholderText(/user id/i)).not.toBeInTheDocument();
    const picker = screen.getByRole('combobox', { name: /assignee/i });
    await screen.findByRole('option', { name: 'Dana Ortiz' });
    expect(screen.getByRole('option', { name: 'Carlos Reyes' })).toBeInTheDocument();

    fireEvent.change(picker, { target: { value: 'user-dana' } });
    await waitFor(() => {
      const urls = vi.mocked(apiFetch).mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.startsWith('/api/leads?') && u.includes('assignedUserId=user-dana'))).toBe(true);
    });
  });
});
