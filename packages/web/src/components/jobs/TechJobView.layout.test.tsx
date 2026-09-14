/**
 * §8.5 row 5.1 (ticket #1018) — glove/daylight class contract for the
 * technician job-detail screen (TechJobView, reached via `/jobs/:id?view=tech`
 * — JobsPage.tsx: `if (id && viewMode === 'tech') return <TechJobView .../>`).
 *
 * G1 (#1006): 5.1 was NO-COMMAND. Same convention as
 * TechnicianDayView.layout.test.tsx / EstimateApprovalPage.layout.test.tsx:
 * pin the `min-h-11` (≥44px) glove-target class and the high-contrast
 * design-system text token on the primary actions that carry them today.
 *
 * KNOWN GAPS (found while pinning, not fixed — product code is out of
 * scope for this test-only lane; see docs/audit/lane-reports/1018-execute.md):
 *   - the main status-advance CTA (`advanceStatus`, mid-page and in the
 *     bottom bar) has no explicit `min-h-11` class (py-3.5/py-3 + text-sm
 *     likely clears 44px in a real browser, but the class contract this
 *     repo's convention checks for is absent);
 *   - the "Note/Photo/Parts/Issue" quick-action chip grid has no explicit
 *     `min-h-11` class either.
 * Both are pinned below as the CURRENT (non-compliant) state, not
 * asserted as compliant, so a future fix trips these assertions instead
 * of going unnoticed.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';

const mockFetcher = vi.fn();

vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => mockFetcher,
}));

vi.mock('@clerk/clerk-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/clerk-react')>();
  return {
    ...actual,
    useAuth: () => ({
      isLoaded: true,
      isSignedIn: true,
      getToken: async () => 'tok',
    }),
  };
});

import { TechJobView } from './TechJobView';

const mockJob = {
  id: 'j1',
  jobNumber: '1001',
  summary: 'Fix HVAC',
  status: 'in_progress',
};

function renderView() {
  return render(
    <MemoryRouter>
      <TechJobView id="j1" />
    </MemoryRouter>,
  );
}

describe('TechJobView — glove/daylight class contract (5.1)', () => {
  beforeEach(() => {
    mockFetcher.mockReset();
    mockFetcher.mockImplementation((path: string) => {
      if (path.startsWith('/api/jobs/')) {
        return Promise.resolve(new Response(JSON.stringify(mockJob), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });
  });

  it('the bottom action bar\'s call/camera icon buttons meet the ≥44px glove target (size-12 = 48px)', async () => {
    const { container } = renderView();
    await waitFor(() => expect(screen.getByText('Fix HVAC')).toBeInTheDocument());

    // The hero contact row ALSO has a phone icon (text-success, no
    // size-12) — scope to the fixed bottom bar specifically so this pins
    // the glove-target buttons, not the hero's contact chip.
    const bottomBar = container.querySelector('.fixed.bottom-0') as HTMLElement;
    expect(bottomBar).not.toBeNull();
    const bottomButtons = Array.from(bottomBar.querySelectorAll('button'));
    const callBtn = bottomButtons.find((b) => b.querySelector('svg.lucide-phone'));
    const cameraBtn = bottomButtons.find((b) => b.querySelector('svg.lucide-camera'));
    expect(callBtn).toBeTruthy();
    expect(cameraBtn).toBeTruthy();
    expect(callBtn!.className).toContain('size-12');
    expect(cameraBtn!.className).toContain('size-12');
    // High-contrast foreground icon color on the neutral secondary chip.
    expect(callBtn!.querySelector('svg')?.getAttribute('class')).toContain('text-foreground');
  });

  it('the "Add photo" action in the Photos section meets the glove target', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Fix HVAC')).toBeInTheDocument());

    const addPhoto = screen.getByText('Add photo').closest('button') as HTMLElement;
    expect(addPhoto.className).toContain('min-h-11');
  });

  it('KNOWN GAP: the primary status-advance CTA has no explicit ≥44px class today', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Fix HVAC')).toBeInTheDocument());

    // Both the mid-page status bar and the bottom fixed bar render a
    // "Mark Complete" CTA for this status; check every instance.
    const ctas = screen.getAllByRole('button', { name: /mark complete/i });
    expect(ctas.length).toBeGreaterThan(0);
    for (const cta of ctas) {
      // Pinning the CURRENT state (no min-h-11) — see file header. NOT a
      // compliance claim; a future fix to TechJobView.tsx should add
      // min-h-11 here and flip this assertion.
      expect(cta.className).not.toContain('min-h-11');
      expect(cta.className).toContain('text-primary-foreground');
    }
  });

  it('KNOWN GAP: the quick-action chip grid (Note/Photo/Parts/Issue) has no explicit ≥44px class today', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Fix HVAC')).toBeInTheDocument());

    const noteChip = screen.getByText('Note').closest('button') as HTMLElement;
    expect(noteChip.className).not.toContain('min-h-11');
  });

  it('the job hero and status bar do not force a fixed width wider than a 320px phone', async () => {
    renderView();
    const hero = await screen.findByText('Fix HVAC');
    const container = hero.closest('div.flex-1.overflow-y-auto') as HTMLElement | null;
    expect(container).not.toBeNull();
    expect(container!.className).not.toMatch(/\bw-\[\d{4,}px\]/);
    const inner = container!.querySelector('div.max-w-lg');
    expect(inner).not.toBeNull();
  });
});
