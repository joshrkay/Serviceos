import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BrandVoiceSheet,
  cooldownMinutesRemaining,
  type BrandVoiceSheetApi,
} from './BrandVoiceSheet';
import type { BrandVoiceState } from '../../api/brandVoice';

function state(over: Partial<BrandVoiceState> = {}): BrandVoiceState {
  return {
    register: 'friendly',
    opening_lines: ['Thanks for reaching out'],
    signoff: '— The team',
    banned_phrases: ['cheapest in town'],
    persona_name: "M&R Mechanical's office",
    pronoun: 'we',
    version: 2,
    locked: true,
    updated_at: null,
    cooldown_until: null,
    ...over,
  };
}

function mockApi(over: Partial<BrandVoiceSheetApi> = {}): BrandVoiceSheetApi {
  return {
    fetch: vi.fn().mockResolvedValue(state()),
    save: vi.fn().mockResolvedValue(state({ version: 3 })),
    ...over,
  };
}

describe('N-011 — BrandVoiceSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the version badge and a locked (read-only) surface with an Edit action', async () => {
    render(<BrandVoiceSheet onClose={() => {}} api={mockApi()} />);
    expect(await screen.findByTestId('brand-voice-version-badge')).toHaveTextContent('v2');
    // Locked: the Save button is not shown; Edit is.
    expect(screen.getByRole('button', { name: /edit brand voice/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
  });

  it('unlocks on Edit and saves all six fields via the explicit web action', async () => {
    const api = mockApi();
    render(<BrandVoiceSheet onClose={() => {}} api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /edit brand voice/i }));

    // Change register to formal and save.
    fireEvent.click(screen.getByRole('button', { name: /formal/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    const arg = (api.save as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({
      register: 'formal',
      pronoun: 'we',
      persona_name: "M&R Mechanical's office",
      signoff: '— The team',
      opening_lines: ['Thanks for reaching out'],
      banned_phrases: ['cheapest in town'],
    });
  });

  it('shows the cool-down countdown and disables Save while cooling down', async () => {
    const future = new Date(Date.now() + 14 * 60_000).toISOString();
    render(
      <BrandVoiceSheet
        onClose={() => {}}
        api={mockApi({ fetch: vi.fn().mockResolvedValue(state({ cooldown_until: future })) })}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /edit brand voice/i }));
    expect(screen.getByTestId('brand-voice-cooldown')).toHaveTextContent(/edit again in ~1[45] min/i);
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('interactive controls meet the 44px glove target (min-h-11)', async () => {
    render(<BrandVoiceSheet onClose={() => {}} api={mockApi()} />);
    const close = await screen.findByRole('button', { name: /close/i });
    expect(close.className).toContain('min-h-11');
    // A register control (rendered even in read-only mode) carries the target.
    const formal = screen.getByRole('button', { name: /formal/i });
    expect(formal.className).toContain('min-h-11');
  });

  it('cooldownMinutesRemaining rounds up and clamps at zero', () => {
    const base = Date.parse('2026-07-10T12:00:00.000Z');
    expect(cooldownMinutesRemaining('2026-07-10T12:14:00.000Z', base)).toBe(14);
    expect(cooldownMinutesRemaining('2026-07-10T11:00:00.000Z', base)).toBe(0);
    expect(cooldownMinutesRemaining(null, base)).toBe(0);
  });
});
