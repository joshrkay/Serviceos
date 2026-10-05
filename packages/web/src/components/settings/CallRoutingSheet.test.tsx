/**
 * CallRoutingSheet — after-hours control (#1595 / D-040).
 *
 * AI answering is the after-hours default; voicemail is the explicit opt-out.
 * A tenant whose settings never set the mode must see AI answering selected,
 * labelled as the default, with voicemail offered as the opt-out — never as
 * "recommended".
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallRoutingSheet } from './CallRoutingSheet';

const apiFetchMock = vi.fn();

vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function afterHoursSelect(): HTMLSelectElement {
  return screen.getByLabelText('Inbound call behavior') as HTMLSelectElement;
}

describe('CallRoutingSheet — when closed (after hours)', () => {
  it('shows AI answering selected and labelled as the default for a tenant that never set the mode, with voicemail as the opt-out', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));

    render(<CallRoutingSheet open onOpenChange={() => {}} />);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/settings'));
    const select = afterHoursSelect();
    expect(select.value).toBe('ai_answering');

    const options = Array.from(select.options);
    const ai = options.find((o) => o.value === 'ai_answering')!;
    const voicemail = options.find((o) => o.value === 'voicemail')!;
    expect(ai.textContent).toMatch(/default/i);
    expect(voicemail.textContent).toMatch(/opt out/i);
    expect(voicemail.textContent).not.toMatch(/recommended/i);
  });

  it("shows voicemail selected for a tenant who explicitly opted out", async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ escalationSettings: { after_hours_voice_mode: 'voicemail' } }),
    );

    render(<CallRoutingSheet open onOpenChange={() => {}} />);

    await waitFor(() => expect(afterHoursSelect().value).toBe('voicemail'));
  });

  it('the panel shrinks to the viewport instead of a fixed 384px, so the control is reachable at 320px', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));

    render(<CallRoutingSheet open onOpenChange={() => {}} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/settings'));

    const panel = afterHoursSelect().closest('.shadow-2xl') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.className).toContain('w-full');
    expect(panel.className).toContain('max-w-sm');
    expect(panel.className).not.toMatch(/\bw-96\b/);
    // Mobile tap bar (CLAUDE.md): the control itself clears 44px.
    expect(afterHoursSelect().className).toContain('min-h-11');
  });
});
