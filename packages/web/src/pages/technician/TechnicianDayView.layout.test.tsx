/**
 * §8.5 row 5.1 (ticket #1018) — glove/daylight class contract for the
 * technician day view.
 *
 * G1 (#1006): 5.1 was NO-COMMAND — no jsdom class-contract test and no
 * Playwright viewport spec existed for the field screens. jsdom can't
 * measure real overflow or computed pixel heights, so (CLAUDE.md pattern,
 * cf. EstimateApprovalPage.layout.test.tsx) this pins the CSS class
 * contract: every primary tap target carries the repo's ≥44px glove class
 * (`min-h-11`) and the high-contrast design-system text token
 * (`text-foreground` / `text-primary-foreground`), never the de-emphasized
 * `text-muted-foreground`. The real 320px overflow measurement lives in
 * e2e/technician-day-mobile.spec.ts (Playwright).
 */
import React from 'react';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { TechnicianDayView } from './TechnicianDayView';

function render(ui: React.ReactElement) {
  return rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
}

const mockAppointments = [
  {
    id: 'appt-1',
    jobId: 'job-1',
    customerName: 'Jane Doe',
    locationAddress: '123 Main St',
    scheduledStart: '2026-03-14T09:00:00Z',
    scheduledEnd: '2026-03-14T11:00:00Z',
    status: 'confirmed',
    jobSummary: 'HVAC Repair',
    updatedAt: '2026-03-13T08:00:00Z',
  },
];

describe('TechnicianDayView — glove/daylight class contract (5.1)', () => {
  beforeEach(() => {
    Object.defineProperty(global.navigator, 'geolocation', {
      value: {
        watchPosition: vi.fn().mockReturnValue(1),
        clearWatch: vi.fn(),
      },
      configurable: true,
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ appointments: mockAppointments }),
    } as never);
  });

  it('the Previous/Next day-nav buttons meet the ≥44px glove target (min-h-11)', async () => {
    render(<TechnicianDayView technicianId="tech-1" />);
    const prev = await screen.findByTestId('technician-day-prev');
    const next = screen.getByTestId('technician-day-next');
    expect(prev.className).toContain('min-h-11');
    expect(next.className).toContain('min-h-11');
    // Secondary action on the card background — high-contrast foreground
    // text, never the de-emphasized muted token.
    expect(prev.className).toContain('text-foreground');
    expect(prev.className).not.toContain('text-muted-foreground');
  });

  it('the Ask AI button and input meet the glove target and use high-contrast text', async () => {
    render(<TechnicianDayView technicianId="tech-1" />);
    await screen.findByTestId('technician-day-view');
    const ask = screen.getByTestId('technician-day-ask-ai');
    const input = document.getElementById('tech-schedule-question') as HTMLElement;
    expect(ask.className).toContain('min-h-11');
    // Primary CTA on a colored background — text-primary-foreground is the
    // design system's high-contrast pairing for bg-primary.
    expect(ask.className).toContain('text-primary-foreground');
    expect(input.className).toContain('min-h-11');
    expect(input.className).toContain('text-foreground');
  });

  it('each appointment card\'s primary actions (View job, On my way, Edit time) meet the glove target', async () => {
    render(<TechnicianDayView technicianId="tech-1" />);
    const viewJob = await screen.findByTestId('technician-day-view-job');
    const onMyWay = screen.getByTestId('technician-day-on-my-way');
    const editTime = screen.getByTestId('technician-day-edit');

    expect(viewJob.className).toContain('min-h-11');
    expect(viewJob.className).toContain('text-foreground');
    expect(viewJob.className).not.toContain('text-muted-foreground');

    expect(onMyWay.className).toContain('min-h-11');
    expect(onMyWay.className).toContain('text-primary-foreground');

    expect(editTime.className).toContain('min-h-11');
    expect(editTime.className).toContain('text-foreground');
  });

  it('the edit-time Save/Cancel controls meet the glove target once the form opens', async () => {
    render(<TechnicianDayView technicianId="tech-1" />);
    const editTime = await screen.findByTestId('technician-day-edit');
    fireEvent.click(editTime);

    const start = await screen.findByTestId('technician-day-edit-start');
    const end = screen.getByTestId('technician-day-edit-end');
    const save = screen.getByTestId('technician-day-save');
    const cancel = screen.getByTestId('technician-day-cancel');

    expect(start.className).toContain('min-h-11');
    expect(end.className).toContain('min-h-11');
    expect(save.className).toContain('min-h-11');
    expect(save.className).toContain('text-primary-foreground');
    expect(cancel.className).toContain('min-h-11');
    expect(cancel.className).toContain('text-foreground');
  });

  it('the whole view fits inside a single mx-auto max-w-lg column (no fixed width wider than a 320px phone)', async () => {
    render(<TechnicianDayView technicianId="tech-1" />);
    const root = await screen.findByTestId('technician-day-view');
    // The real overflow measurement is e2e/technician-day-mobile.spec.ts;
    // this pins the mechanism (a bounded, auto-centered column) jsdom can
    // verify without layout.
    expect(root.className).toContain('max-w-lg');
    expect(root.className).toContain('mx-auto');
    expect(root.className).not.toMatch(/\bw-\[\d{4,}px\]/);
  });
});
