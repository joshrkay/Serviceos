import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeadList } from '../LeadList';

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

function mockListOnce(leads = sampleLeads) {
  vi.mocked(apiFetch).mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ data: leads, total: leads.length }),
  } as unknown as Response);
}

describe('Leads — LeadList kanban (P9-001)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
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
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

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
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

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
});
