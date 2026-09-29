/**
 * #1481 item 3 — the 2026-09-28 mobile sweep measured settings-sheet controls
 * under the 44px bar at 320px (Close 28×28, Cancel/Save 36px, inputs 42px,
 * deposit radios 13px, Connect Stripe 36px, …). Seam: each rendered sheet,
 * API mocked at apiFetch; class contract via expectAllTapTargets (the
 * measured check is e2e/page-tap-targets-mobile.spec.ts).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, vi, beforeEach } from 'vitest';
import { expectAllTapTargets } from '../../test-utils/tap-target';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('../../hooks/useTenantTimezone', () => ({ useTenantTimezone: () => 'America/Phoenix' }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { TeamMembersSheet } from './TeamMembersSheet';
import { BusinessProfileSheet } from './BusinessProfileSheet';
import { TerminologySheet } from './TerminologySheet';
import { DepositRulesSheet } from './DepositRulesSheet';
import { DncListSheet } from './DncListSheet';
import { PaymentMethodsSheet } from './PaymentMethodsSheet';
import { TechnicianPhoneSheet } from './TechnicianPhoneSheet';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('settings sheets meet the 44px tap-target bar (#1481)', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('Team members: Invite, Close and every Edit role control', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/users') {
        return jsonResponse({
          data: [
            { id: 'u1', email: 'owner@example.com', role: 'owner', canFieldServe: true },
            { id: 'u2', email: 'alex@example.com', role: 'technician', canFieldServe: false },
          ],
        });
      }
      return jsonResponse({ data: [] });
    });
    render(<TeamMembersSheet onClose={() => {}} canEditRoles />);
    await screen.findByTestId('team-members-list');
    expectAllTapTargets(screen.getByRole('dialog'), 'Team members sheet');

    // The role editor that Edit role opens (select + Save + Cancel).
    fireEvent.click(screen.getByRole('button', { name: 'Edit role for alex@example.com' }));
    expectAllTapTargets(screen.getByRole('dialog'), 'Team members role editor');
  });

  it('Business profile: Close, every input and Cancel/Save', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({ businessName: 'Acme HVAC', timezone: 'America/Phoenix' }));
    render(<BusinessProfileSheet onClose={() => {}} />);
    await screen.findByDisplayValue('Acme HVAC');
    expectAllTapTargets(screen.getByRole('dialog'), 'Business profile sheet');
  });

  it('Terminology: Close, every term input and Cancel/Save', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({ terminologyPreferences: { jobTerm: 'Ticket' } }));
    render(<TerminologySheet onClose={() => {}} />);
    await screen.findByDisplayValue('Ticket');
    expectAllTapTargets(screen.getByRole('dialog'), 'Terminology sheet');
  });

  it('Deposit rules: Close, the strategy radios (via their labels) and Cancel/Save', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({ depositStrategy: 'percentage', depositPercentageBps: 2500 }));
    render(<DepositRulesSheet onClose={() => {}} />);
    await screen.findByDisplayValue('25');
    expectAllTapTargets(screen.getByRole('dialog'), 'Deposit rules sheet');
  });

  it('Do-Not-Call list: Close, phone input, Add and every Remove', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({ entries: [{ phone: '15555550199', source: 'manual_settings', createdAt: '2026-09-28T00:00:00Z' }] }),
    );
    render(<DncListSheet open onOpenChange={() => {}} />);
    await screen.findByTestId('dnc-entries');
    expectAllTapTargets(screen.getByRole('dialog'), 'Do-Not-Call sheet');
  });

  it('Payment methods: Close and Connect Stripe account', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({ accountId: null, status: 'pending', chargesEnabled: false, payoutsEnabled: false }),
    );
    render(<PaymentMethodsSheet onClose={() => {}} />);
    await screen.findByTestId('payment-methods-not-connected');
    expectAllTapTargets(screen.getByRole('dialog'), 'Payment methods sheet');
  });

  it('Payment methods (connected): Disconnect', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({ accountId: 'acct_test', status: 'active', chargesEnabled: true, payoutsEnabled: true }),
    );
    render(<PaymentMethodsSheet onClose={() => {}} />);
    await screen.findByTestId('payment-methods-active');
    expectAllTapTargets(screen.getByRole('dialog'), 'Payment methods sheet (connected)');
  });

  it('On-call phone: Close (measured 36×44)', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({ mobileNumber: '+15125550199' }));
    render(<TechnicianPhoneSheet onClose={() => {}} />);
    await screen.findByLabelText(/Your cell phone/i);
    expectAllTapTargets(screen.getByRole('dialog'), 'On-call phone sheet');
  });
});
