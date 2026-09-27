/**
 * #1389 / O-2 — the owner's form for the reviewed E1 life-safety script and
 * its two sign-offs (a licensed trade professional AND counsel). Public seam:
 * the page, with GET/PUT /api/settings/e1-script answered by a mocked client.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';

const apiFetchMock = vi.fn();
vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => (...args: unknown[]) => apiFetchMock(...args),
}));

import { E1ScriptSettingsPage } from './E1ScriptSettingsPage';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const PLACEHOLDER = {
  status: 'placeholder',
  reviewedScript: null,
  reviewedByName: null,
  reviewedByRole: null,
  reviewedAt: null,
  reviewers: [],
  missingReviewerKinds: ['trade_professional', 'counsel'],
};

const SCRIPT = 'If anyone is in danger, hang up and dial 911 now. Get everyone out and wait outside.';

function renderPage() {
  return render(
    <MemoryRouter>
      <E1ScriptSettingsPage />
    </MemoryRouter>,
  );
}

function fill(label: RegExp | string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function fillWholeForm() {
  fill(/^emergency script/i, SCRIPT);
  fill('Trade professional name', 'Pat Reviewer');
  fill('Trade professional license', 'Master Plumber M-00000 (TX)');
  fill('Trade professional review date', '2026-09-20');
  fill('Counsel name', 'Robin Counsel');
  fill('Counsel bar number', 'State Bar 00000000 (TX)');
  fill('Counsel review date', '2026-09-21');
  fireEvent.click(screen.getByRole('checkbox', { name: /both reviewers signed off/i }));
}

describe('E1ScriptSettingsPage (#1389)', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('saves the script with a trade professional AND counsel sign-off and then shows it live', async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return json({ ...PLACEHOLDER, status: 'reviewed', reviewedScript: SCRIPT, missingReviewerKinds: [] });
      }
      return json(PLACEHOLDER);
    });
    renderPage();
    expect(await screen.findByText(/placeholder script is in use/i)).toBeInTheDocument();

    await fillWholeForm();
    fireEvent.click(screen.getByRole('button', { name: /save reviewed script/i }));

    await waitFor(() => expect(screen.getByText(/reviewed script is live/i)).toBeInTheDocument());
    const put = apiFetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')!;
    expect(put[0]).toBe('/api/settings/e1-script');
    const body = JSON.parse((put[1] as RequestInit).body as string);
    expect(body.script).toBe(SCRIPT);
    expect(body.reviewers).toHaveLength(2);
    expect(body.reviewers[0]).toMatchObject({
      kind: 'trade_professional',
      name: 'Pat Reviewer',
      credential: 'Master Plumber M-00000 (TX)',
    });
    expect(body.reviewers[1]).toMatchObject({
      kind: 'counsel',
      name: 'Robin Counsel',
      credential: 'State Bar 00000000 (TX)',
    });
    // Local midnight of the picked day, sent as an ISO instant.
    expect(new Date(body.reviewers[0].reviewedAt).getDate()).toBe(20);
    expect(new Date(body.reviewers[1].reviewedAt).getDate()).toBe(21);
  });

  it('keeps Save disabled until the script, BOTH reviewers and the confirmation are all filled in', async () => {
    apiFetchMock.mockResolvedValue(json(PLACEHOLDER));
    renderPage();
    const save = await screen.findByRole('button', { name: /save reviewed script/i });
    fill(/^emergency script/i, SCRIPT);
    fill('Trade professional name', 'Pat Reviewer');
    fill('Trade professional license', 'Master Plumber M-00000 (TX)');
    fill('Trade professional review date', '2026-09-20');
    fireEvent.click(screen.getByRole('checkbox', { name: /both reviewers signed off/i }));
    // Counsel still blank: one sign-off is not enough (O-2).
    expect(save).toBeDisabled();
    fill('Counsel name', 'Robin Counsel');
    fill('Counsel bar number', 'State Bar 00000000 (TX)');
    fill('Counsel review date', '2026-09-21');
    expect(save).toBeEnabled();
  });

  it('shows an owner-only message when the server refuses a non-owner (403)', async () => {
    apiFetchMock.mockImplementation(async (_path: string, init?: RequestInit) =>
      init?.method === 'PUT' ? json({ error: 'FORBIDDEN' }, 403) : json(PLACEHOLDER),
    );
    renderPage();
    await screen.findByText(/placeholder script is in use/i);
    await fillWholeForm();
    fireEvent.click(screen.getByRole('button', { name: /save reviewed script/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/only the account owner/i);
  });

  it('prefills the saved script and both sign-offs from GET', async () => {
    apiFetchMock.mockResolvedValue(
      json({
        ...PLACEHOLDER,
        status: 'reviewed',
        reviewedScript: SCRIPT,
        reviewers: [
          { kind: 'trade_professional', name: 'Pat Reviewer', credential: 'M-00000', reviewedAt: new Date(2026, 8, 20).toISOString() },
          { kind: 'counsel', name: 'Robin Counsel', credential: 'Bar 00000000', reviewedAt: new Date(2026, 8, 21).toISOString() },
        ],
        missingReviewerKinds: [],
      }),
    );
    renderPage();
    expect(await screen.findByText(/reviewed script is live/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^emergency script/i)).toHaveValue(SCRIPT);
    expect(screen.getByLabelText('Trade professional name')).toHaveValue('Pat Reviewer');
    expect(screen.getByLabelText('Counsel bar number')).toHaveValue('Bar 00000000');
    expect(screen.getByLabelText('Counsel review date')).toHaveValue('2026-09-21');
  });
});

describe('E1ScriptSettingsPage — mobile class contract (measured in e2e/e1-script-mobile.spec.ts)', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('every input, the confirmation row and Save are ≥44px (min-h-11) and fields are full-width with no fixed width', async () => {
    apiFetchMock.mockResolvedValue(json(PLACEHOLDER));
    renderPage();
    const save = await screen.findByRole('button', { name: /save reviewed script/i });
    const fields = [
      screen.getByLabelText(/^emergency script/i),
      screen.getByLabelText('Trade professional name'),
      screen.getByLabelText('Trade professional license'),
      screen.getByLabelText('Trade professional review date'),
      screen.getByLabelText('Counsel name'),
      screen.getByLabelText('Counsel bar number'),
      screen.getByLabelText('Counsel review date'),
    ];
    for (const field of fields) {
      expect(field.className).toMatch(/\bmin-h-(11|32)\b/);
      expect(field.className).toMatch(/\bw-full\b/);
      expect(field.className).toMatch(/\bmin-w-0\b/);
    }
    expect(screen.getByRole('checkbox', { name: /both reviewers signed off/i }).closest('label')!.className).toMatch(
      /\bmin-h-11\b/,
    );
    expect(save.className).toMatch(/\bmin-h-11\b/);
    expect(screen.getByTestId('e1-script-settings').className).not.toMatch(/\bw-\[\d/);
  });
});
