import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { SettingsPage } from './SettingsPage';
import { expectTapTarget } from '../../test-utils/tap-target';

vi.mock('../../hooks/useMe', () => ({
  useMe: () => ({
    me: {
      tenant_id: '11111111-1111-4111-8111-111111111111',
      role: 'owner',
    },
    isLoading: false,
    error: null,
    switchMode: vi.fn(),
    refetch: vi.fn(),
  }),
}));

describe('SettingsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Price book settings item', () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    expect(screen.getByText('Price book')).toBeInTheDocument();
  });

  it('#1389: lists the Emergency safety script form under AI & Automation', () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    const previews = screen.getAllByRole('button', { name: /preview/i });
    const copies = screen.getAllByRole('button', { name: /copy link/i });
    expect(previews.length).toBe(2);
    expect(copies.length).toBe(2);
    for (const b of [...previews, ...copies]) expectTapTarget(b, b.textContent ?? 'link action');

    const google = screen.getByLabelText(/google review url/i);
    expectTapTarget(google, 'Google Review URL');
    expectTapTarget(screen.getByLabelText(/yelp review url/i), 'Yelp Review URL');
    const reviewsSave = google.closest('div')!.querySelector('button[type="button"]:last-of-type');
    expect(reviewsSave?.textContent).toMatch(/save/i);
    expectTapTarget(reviewsSave!, 'review URLs Save');
    expect(screen.getByText('Emergency safety script')).toBeInTheDocument();
  });

  // #1563 — Settings → Phone entry (owner role, per the mocked useMe).
  it('#1563: lists the Business phone number page with a 44px row', () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );
    const row = screen.getByText('Business phone number').closest('button')!;
    expectTapTarget(row, 'Business phone number row');
  });

  it('shows tenant-scoped intake link when me is loaded', () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    expect(
      screen.getByText(/\/intake\?t=11111111-1111-4111-8111-111111111111/),
    ).toBeInTheDocument();
  });

  it('shows AI answering minutes for the current period', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/billing/ai-usage')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            kind: 'period', usedMinutes: 12, includedMinutes: 20, overageMinutes: 0,
            overageCentsPerMinute: 125, projectedChargeCents: 0, capCents: 7900,
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('12 of 20 AI minutes used')).toBeInTheDocument();
  });

  it('surfaces an error with a retry when the main settings load fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/settings') && !url.includes('/api/settings/language')) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    // The error/retry affordance surfaces instead of a silent blank.
    expect(await screen.findByTestId('settings-load-error')).toBeInTheDocument();
    expect(screen.getByTestId('settings-load-retry')).toBeInTheDocument();
    // The page itself still renders (non-critical sub-loads don't block it).
    await waitFor(() => expect(screen.getByText('Price book')).toBeInTheDocument());
  });
});
