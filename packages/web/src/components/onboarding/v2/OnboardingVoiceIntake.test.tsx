import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../../lib/apiClient', () => ({
  useApiClient: () => apiFetchMock,
}));

const toastSuccess = vi.fn();
const toastMessage = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    message: (...a: unknown[]) => toastMessage(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

import {
  OnboardingVoiceIntake,
  submitOnboardingVoice,
} from './OnboardingVoiceIntake';
import type { ApiFetch } from '../../../lib/apiClient';

describe('submitOnboardingVoice', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('POSTs the transcript to /api/onboarding/voice and returns the result', async () => {
    const apiFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ proposalIds: ['p1', 'p2'], needsClarification: false, clarificationQuestions: [] }),
    })) as unknown as ApiFetch;

    const result = await submitOnboardingVoice(apiFetch, "Bob's HVAC, AC repair");

    expect((apiFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/api/onboarding/voice');
    const init = (apiFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ transcript: "Bob's HVAC, AC repair" });
    expect(result.proposalIds).toHaveLength(2);
  });

  it('throws on a non-ok response', async () => {
    const apiFetch = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as ApiFetch;
    await expect(submitOnboardingVoice(apiFetch, 'x')).rejects.toThrow();
  });
});

describe('OnboardingVoiceIntake — dispatch + mobile contract', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders a voice trigger with a ≥44px tap target (min-h-11) and no fixed width', () => {
    const { container } = render(<MemoryRouter><OnboardingVoiceIntake /></MemoryRouter>);
    const trigger = screen.getByRole('button');
    // CLAUDE.md: mobile tap targets must be ≥44px.
    expect(trigger.className).toContain('min-h-11');
    // No fixed pixel width that would overflow a 320px viewport.
    expect(container.innerHTML).not.toMatch(/w-\[\d{3,}px\]/);
  });

  it('shows the onboarding intake prompt (not the generic assistant ask)', () => {
    render(<MemoryRouter><OnboardingVoiceIntake /></MemoryRouter>);
    expect(screen.getByText('Tell me about your business…')).toBeInTheDocument();
    expect(screen.getByText('Set up by voice — just talk')).toBeInTheDocument();
  });
});
