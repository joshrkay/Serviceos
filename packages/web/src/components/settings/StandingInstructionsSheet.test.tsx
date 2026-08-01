import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  StandingInstructionsSheet,
  scopeSummary,
  type StandingInstructionsSheetApi,
} from './StandingInstructionsSheet';
import type { StandingInstruction } from '../../api/standing-instructions';

const instruction = (over: Partial<StandingInstruction> = {}): StandingInstruction => ({
  id: 'si-1',
  tenantId: 'tn',
  instruction: 'Always add a $50 trip fee',
  scope: {},
  active: true,
  source: 'settings',
  createdBy: 'u1',
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
  deactivatedAt: null,
  deactivatedBy: null,
  ...over,
});

function mockApi(over: Partial<StandingInstructionsSheetApi> = {}): StandingInstructionsSheetApi {
  return {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(instruction()),
    deactivate: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('StandingInstructionsSheet (UB-A4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists instructions with source badge and scope summary', async () => {
    const api = mockApi({
      list: vi.fn().mockResolvedValue([
        instruction(),
        instruction({
          id: 'si-2',
          instruction: 'Mention the referral discount',
          source: 'proposal',
          scope: { intents: ['draft_estimate'], customerSegment: 'new' },
        }),
      ]),
    });
    render(<StandingInstructionsSheet onClose={() => {}} api={api} />);

    expect(await screen.findByText('Always add a $50 trip fee')).toBeInTheDocument();
    expect(screen.getByText('Mention the referral discount')).toBeInTheDocument();
    // Source badges: settings-created vs voice-created (source 'proposal').
    const badges = screen.getAllByTestId('instruction-source-badge');
    expect(badges.map((b) => b.textContent)).toEqual(['Settings', 'Voice']);
    // Scope shown succinctly: unscoped → everywhere; scoped → intent + segment.
    const scopes = screen.getAllByTestId('instruction-scope');
    expect(scopes[0].textContent).toBe('Applies to all drafts');
    expect(scopes[1].textContent).toBe('draft estimate · new customers');
  });

  it('adds an instruction via POST', async () => {
    const api = mockApi();
    render(<StandingInstructionsSheet onClose={() => {}} api={api} />);
    fireEvent.change(await screen.findByLabelText('New standing instruction'), {
      target: { value: 'Never discount emergency calls' },
    });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({ instruction: 'Never discount emergency calls' }),
    );
  });

  it('blocks adding an empty instruction', async () => {
    const api = mockApi();
    render(<StandingInstructionsSheet onClose={() => {}} api={api} />);
    fireEvent.click(await screen.findByText('Add'));
    expect(await screen.findByText(/Write the instruction first/)).toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('deactivates an instruction via PATCH', async () => {
    const api = mockApi({ list: vi.fn().mockResolvedValue([instruction()]) });
    render(<StandingInstructionsSheet onClose={() => {}} api={api} />);
    fireEvent.click(await screen.findByLabelText('Deactivate Always add a $50 trip fee'));
    await waitFor(() => expect(api.deactivate).toHaveBeenCalledWith('si-1'));
  });

  it('surfaces the 422 active-cap error from the server', async () => {
    const capMessage =
      'Tenant already has 20 active standing instructions — deactivate one before adding another';
    const api = mockApi({ create: vi.fn().mockRejectedValue(new Error(capMessage)) });
    render(<StandingInstructionsSheet onClose={() => {}} api={api} />);
    fireEvent.change(await screen.findByLabelText('New standing instruction'), {
      target: { value: 'One too many' },
    });
    fireEvent.click(screen.getByText('Add'));
    expect(await screen.findByText(new RegExp('deactivate one before adding'))).toBeInTheDocument();
  });
});

describe('scopeSummary', () => {
  it('summarizes empty, intent, trade, and segment scopes', () => {
    expect(scopeSummary({})).toBe('Applies to all drafts');
    expect(scopeSummary(undefined)).toBe('Applies to all drafts');
    expect(scopeSummary({ intents: ['draft_estimate', 'create_invoice'] })).toBe(
      'draft estimate, create invoice',
    );
    expect(scopeSummary({ tradeCategories: ['hvac'] })).toBe('hvac');
    expect(scopeSummary({ customerSegment: 'existing' })).toBe('existing customers');
    expect(scopeSummary({ customerSegment: 'all' })).toBe('Applies to all drafts');
  });
});
