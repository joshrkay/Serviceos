import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiFetchMock, apiClient } = vi.hoisted(() => {
  const mock = vi.fn();
  // Stable across renders, like the real useApiClient (a useCallback): a new
  // function per render would re-run the roster effect on every render.
  return { apiFetchMock: mock, apiClient: (...args: unknown[]) => mock(...args) };
});
vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => apiClient,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SupervisorBackupSection } from './SupervisorBackupSection';

describe('SupervisorBackupSection', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  // #1463 — the API refuses a suspended (deactivated) member as backup
  // supervisor, so the picker must not offer one.
  it('offers only active supervise-capable members', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'u-owner', email: 'owner@example.com', role: 'owner', status: 'active' },
          { id: 'u-disp-off', email: 'gone@example.com', role: 'dispatcher', status: 'suspended' },
          { id: 'u-tech', email: 'tech@example.com', role: 'technician', status: 'active' },
        ],
      }),
    });

    render(<SupervisorBackupSection initialBackupUserId={null} initialRouting="queue_and_sms" />);

    const select = (await screen.findByTestId('backup-supervisor-select')) as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(select.options).map((o) => o.value)).toContain('u-owner');
    });
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'u-owner']);
  });

  // B1 follow-up — a backup named before B1 can be a technician (who cannot
  // approve work). The picker offered no option for them, so the select
  // silently showed "None", and every save re-sent their id and got a 400.
  describe('a current backup who is not an eligible option', () => {
    const ROSTER = {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'u-owner', email: 'owner@example.com', role: 'owner', status: 'active' },
          { id: 'u-tech', email: 'tech@example.com', role: 'technician', status: 'active', firstName: 'Tess', lastName: 'Tech' },
        ],
      }),
    };

    function routeFetch(saves: unknown[]) {
      apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/settings') {
          saves.push(JSON.parse(String(init?.body)));
          return { ok: true, status: 200, json: async () => ({}) };
        }
        return ROSTER;
      });
    }

    it('shows them as the selected backup, with a plain note to pick someone who can approve', async () => {
      routeFetch([]);
      render(<SupervisorBackupSection initialBackupUserId="u-tech" initialRouting="queue_and_sms" />);

      const select = (await screen.findByTestId('backup-supervisor-select')) as HTMLSelectElement;
      const note = await screen.findByTestId('backup-supervisor-ineligible-note');
      expect(select.value).toBe('u-tech');
      expect(select.selectedOptions[0].textContent).toContain('Tess Tech');
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'u-owner', 'u-tech']);
      expect(note.textContent).toBe("Tess Tech can't approve work, so they can't be your backup. Pick someone who can.");
      expect(note.textContent).not.toMatch(/\bAI\b|agent|dashboard|verify|proposal/i);
      // Class contract — the note wraps (no horizontal overflow at 320px) and
      // the select keeps its 44px tap target.
      expect(note.className).toContain('break-words');
      expect(select.className).toMatch(/min-h-(11|\[44px\])/);
    });

    it('a routing-only save does not re-send the unchanged backup', async () => {
      const saves: unknown[] = [];
      routeFetch(saves);
      render(<SupervisorBackupSection initialBackupUserId="u-tech" initialRouting="queue_and_sms" />);
      await screen.findByText('owner@example.com'); // the roster has loaded

      fireEvent.click(screen.getByDisplayValue('queue_only'));
      fireEvent.click(screen.getByTestId('supervisor-backup-save'));

      await waitFor(() => expect(saves).toHaveLength(1));
      expect(saves[0]).toEqual({ unsupervisedProposalRouting: 'queue_only' });
    });

    it('picking an eligible member sends them and the note goes away', async () => {
      const saves: unknown[] = [];
      routeFetch(saves);
      render(<SupervisorBackupSection initialBackupUserId="u-tech" initialRouting="queue_and_sms" />);
      const select = (await screen.findByTestId('backup-supervisor-select')) as HTMLSelectElement;
      await screen.findByTestId('backup-supervisor-ineligible-note');

      fireEvent.change(select, { target: { value: 'u-owner' } });
      expect(screen.queryByTestId('backup-supervisor-ineligible-note')).toBeNull();
      fireEvent.click(screen.getByTestId('supervisor-backup-save'));

      await waitFor(() => expect(saves).toHaveLength(1));
      expect(saves[0]).toEqual({ backupSupervisorUserId: 'u-owner', unsupervisedProposalRouting: 'queue_and_sms' });
    });

    it('an eligible current backup shows no note', async () => {
      routeFetch([]);
      render(<SupervisorBackupSection initialBackupUserId="u-owner" initialRouting="queue_and_sms" />);
      const select = (await screen.findByTestId('backup-supervisor-select')) as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe('u-owner'));
      expect(screen.queryByTestId('backup-supervisor-ineligible-note')).toBeNull();
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'u-owner']);
    });
  });
});
