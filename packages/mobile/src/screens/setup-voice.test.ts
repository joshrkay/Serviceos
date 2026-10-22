// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingProposalSummary } from '../proposals/proposalEvents';
import { heldForReviewCopy, MIC_DENIED_COPY, MIC_FAILED_COPY, type UseOnboardingTalk } from '../onboarding/useOnboardingTalk';

const h = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  skip: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
  startRecording: vi.fn(),
  stopRecording: vi.fn().mockResolvedValue('file:///clip.m4a'),
  proposals: [] as PendingProposalSummary[],
  talk: null as unknown as UseOnboardingTalk,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: h.push, replace: h.replace, back: vi.fn() }),
}));
vi.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: 'user_owner' }) }));
vi.mock('../hooks/useOnboardingStatus', () => ({ skipSetupGateForSession: h.skip }));
vi.mock('../hooks/usePendingProposals', () => ({
  usePendingProposals: () => ({ proposals: h.proposals, count: h.proposals.length, isLoading: false, error: null, refresh: h.refresh }),
}));
vi.mock('../voice/useRecorder', () => ({
  useRecorder: () => ({ startRecording: h.startRecording, stopRecording: h.stopRecording, cancel: vi.fn() }),
}));
vi.mock('../onboarding/useOnboardingTalkController', () => ({
  useOnboardingTalkController: () => h.talk,
}));

import SetupVoiceScreen from '../../app/(onboarding)/setup-voice';
import Onboarding from '../../app/(onboarding)/onboarding';

function talk(overrides: Partial<UseOnboardingTalk> = {}): UseOnboardingTalk {
  return {
    status: 'ready',
    turns: [{ id: 't1', role: 'rivet', text: 'What do you call the business?' }],
    proposalIds: [],
    error: null,
    sttUnavailable: false,
    sendText: vi.fn().mockResolvedValue(undefined),
    sendAudio: vi.fn().mockResolvedValue(undefined),
    hush: vi.fn(),
    recover: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const button = (name: string) => screen.getByText(name).closest('button') as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  h.startRecording.mockResolvedValue('recording');
  h.proposals = [];
  h.talk = talk();
});
afterEach(cleanup);

describe('welcome screen', () => {
  it('"Start" opens the spoken setup, not the general voice tab the setup gate bounces back from', () => {
    render(createElement(Onboarding));
    fireEvent.click(button('Start'));
    expect(h.push).toHaveBeenCalledWith('/setup-voice');
  });
});

describe('spoken setup screen', () => {
  it('shows Rivet\'s line, and holding the mic sends the recorded clip', async () => {
    render(createElement(SetupVoiceScreen));
    expect(screen.getByText('What do you call the business?')).toBeTruthy();
    const mic = button('Hold to talk');
    fireEvent.mouseDown(mic);
    fireEvent.mouseUp(mic);
    await vi.waitFor(() => expect(h.talk.sendAudio).toHaveBeenCalledWith('file:///clip.m4a'));
    expect(h.startRecording).toHaveBeenCalled();
    expect(h.talk.hush).toHaveBeenCalled();
  });

  it.each([
    ['denied', MIC_DENIED_COPY],
    ['error', MIC_FAILED_COPY],
  ])('a mic that will not open (%s) says why and stops "listening"', async (outcome, copy) => {
    h.startRecording.mockResolvedValue(outcome);
    render(createElement(SetupVoiceScreen));
    fireEvent.mouseDown(button('Hold to talk'));
    await vi.waitFor(() => expect(screen.getByText(copy)).toBeTruthy());
    expect(screen.getByText('Hold to talk')).toBeTruthy();
    expect(screen.getByPlaceholderText('Or type your answer')).toBeTruthy();
  });

  it('a typed answer is sent and the field clears', () => {
    render(createElement(SetupVoiceScreen));
    const input = screen.getByPlaceholderText('Or type your answer') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Walsh Plumbing' } });
    fireEvent.click(button('Send'));
    expect(h.talk.sendText).toHaveBeenCalledWith('Walsh Plumbing');
    expect(input.value).toBe('');
  });

  it('without transcription only typing is offered', () => {
    h.talk = talk({ sttUnavailable: true });
    render(createElement(SetupVoiceScreen));
    expect(screen.queryByText('Hold to talk')).toBeNull();
    expect(screen.getByPlaceholderText('Or type your answer')).toBeTruthy();
  });

  it('every error is shown with its way forward', () => {
    h.talk = talk({ error: { message: 'That setup conversation expired.', action: 'restart' } });
    render(createElement(SetupVoiceScreen));
    expect(screen.getByText('That setup conversation expired.')).toBeTruthy();
    fireEvent.click(button('Start again'));
    expect(h.talk.recover).toHaveBeenCalled();
  });

  it('an error with nothing to retry shows no button', () => {
    h.talk = talk({ error: { message: 'Only the account owner can set up the business.', action: 'none' } });
    render(createElement(SetupVoiceScreen));
    expect(screen.queryByText('Try again')).toBeNull();
    expect(screen.queryByText('Start again')).toBeNull();
  });

  it('a finished conversation lists what will be set up and saves on one tap', () => {
    h.talk = talk({ status: 'review', proposalIds: ['p1', 'p2'] });
    h.proposals = [
      { id: 'p1', summary: 'Business profile: Walsh Plumbing', proposalType: 'onboarding_tenant_settings', createdAt: '2026-10-22T00:00:00Z', confidenceScore: 0.95 },
      { id: 'other', summary: 'Unrelated invoice', proposalType: 'draft_invoice', createdAt: '2026-10-22T00:00:00Z' },
    ];
    render(createElement(SetupVoiceScreen));
    expect(screen.getByText('Business profile: Walsh Plumbing')).toBeTruthy();
    expect(screen.queryByText('Unrelated invoice')).toBeNull();
    expect(h.refresh).toHaveBeenCalled();
    fireEvent.click(button('Save my setup'));
    expect(h.talk.save).toHaveBeenCalledWith(['p1']);
  });

  it('an item it was unsure about is held out of the one-tap save and sent to Approvals', () => {
    h.talk = talk({ status: 'review', proposalIds: ['p1', 'p2'] });
    h.proposals = [
      { id: 'p1', summary: 'Business profile: Walsh Plumbing', proposalType: 'onboarding_tenant_settings', createdAt: '2026-10-22T00:00:00Z', confidenceScore: 0.95 },
      { id: 'p2', summary: 'Service: drain cleaning $150', proposalType: 'onboarding_service_category', createdAt: '2026-10-22T00:00:00Z', confidenceScore: 0.5 },
    ];
    render(createElement(SetupVoiceScreen));
    expect(screen.getByText('Service: drain cleaning $150 (needs a closer look)')).toBeTruthy();
    expect(screen.getByText(heldForReviewCopy(1))).toBeTruthy();
    fireEvent.click(button('Save my setup'));
    expect(h.talk.save).toHaveBeenCalledWith(['p1']);
    fireEvent.click(button('Check in Approvals'));
    expect(h.skip).toHaveBeenCalledWith('user_owner');
    expect(h.push).toHaveBeenCalledWith('/approvals');
  });

  it('with nothing safe to save in one tap, Save is off and Approvals is the way forward', () => {
    h.talk = talk({ status: 'review', proposalIds: ['p2'] });
    h.proposals = [
      { id: 'p2', summary: 'Service: drain cleaning $150', proposalType: 'onboarding_service_category', createdAt: '2026-10-22T00:00:00Z', confidenceScore: 0.5 },
    ];
    render(createElement(SetupVoiceScreen));
    expect(button('Save my setup').disabled).toBe(true);
    expect(button('Check in Approvals')).toBeTruthy();
  });

  it('once setup has applied, "Open my business" opens the app past the gate', () => {
    h.talk = talk({ status: 'finished' });
    render(createElement(SetupVoiceScreen));
    fireEvent.click(button('Open my business'));
    expect(h.skip).toHaveBeenCalledWith('user_owner');
    expect(h.replace).toHaveBeenCalledWith('/');
  });

  it('"Skip for now" defers setup for the session', () => {
    render(createElement(SetupVoiceScreen));
    fireEvent.click(button('Skip for now'));
    expect(h.skip).toHaveBeenCalledWith('user_owner');
    expect(h.replace).toHaveBeenCalledWith('/');
  });

  it('every control is at least 44px tall', () => {
    h.talk = talk({ error: { message: 'x', action: 'retry_turn' } });
    render(createElement(SetupVoiceScreen));
    for (const b of screen.getAllByRole('button')) {
      expect(b.className).toMatch(/min-h-(11|14)/);
    }
  });
});
