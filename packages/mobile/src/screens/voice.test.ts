// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The aliased in-memory keychain stub (vitest.config.ts) persists across
// cases in this file, so the spoken-answer preference is reset per test.
import * as SecureStore from 'expo-secure-store';
import { SPEAK_ANSWERS_KEY } from '../voice/speakAnswers';

const h = vi.hoisted(() => ({
  startRecording: vi.fn(),
  stopAndTranscribe: vi.fn(),
  reset: vi.fn(),
  captureJobId: vi.fn(),
  push: vi.fn(),
  jobId: undefined as string | string[] | undefined,
  phase: 'idle' as 'idle' | 'listening' | 'transcribing' | 'transcript' | 'error',
  transcript: '',
  outcome: null as unknown,
  error: null as string | null,
  // #1603 — system boundaries for the spoken answer: the API (network) and
  // the device audio player (expo-audio, device-only module).
  apiFetch: vi.fn(),
  play: vi.fn(),
  me: null as unknown,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: h.push, back: vi.fn(), replace: vi.fn() }),
  useLocalSearchParams: () => ({ jobId: h.jobId }),
}));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.apiFetch }));
vi.mock('../assistant/nativeAssistantDeps', () => ({
  assistantAudioPlayer: { play: h.play },
}));
// #1603 — the screen reads the persona for its approval copy (technicians'
// proposals go to the office). Owner by default so the owner cases above hold.
vi.mock('../hooks/useMe', () => ({
  useMe: () => ({ me: h.me, isLoading: false, error: null, switchMode: vi.fn(), refetch: vi.fn() }),
}));

const OWNER_ME = {
  user_id: 'user_clerk_owner',
  internal_user_id: '059f1a36-2d09-4698-954f-e640d61a9237',
  tenant_id: 'tenant-1',
  role: 'owner',
  can_field_serve: false,
  current_mode: 'supervisor',
  mode_changed_at: null,
  permissions: [],
  backup_supervisor_user_id: null,
  timezone: undefined,
  unsupervised_proposal_routing: 'queue_only',
};
const TECH_ME = { ...OWNER_ME, user_id: 'user_clerk_tech', role: 'technician', can_field_serve: true, current_mode: 'tech' };
vi.mock('../voice/useVoiceCapture', () => ({
  useVoiceCapture: (jobId?: string) => {
    h.captureJobId(jobId);
    return {
      phase: h.phase,
      transcript: h.transcript,
      outcome: h.outcome,
      error: h.error,
      startRecording: h.startRecording,
      stopAndTranscribe: h.stopAndTranscribe,
      reset: h.reset,
    };
  },
}));

// eslint-disable-next-line import/first
import VoiceScreen from '../../app/(tabs)/voice';

beforeEach(async () => {
  vi.clearAllMocks();
  await SecureStore.deleteItemAsync(SPEAK_ANSWERS_KEY);
  h.phase = 'idle';
  h.transcript = '';
  h.outcome = null;
  h.error = null;
  h.jobId = undefined;
  h.me = { ...OWNER_ME };
  // Default: the server speaks (200 with a clip); tests override per case.
  h.apiFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ audio: 'bXAzLWJ5dGVzLTE2MDM=', contentType: 'audio/mpeg' }),
  });
});

afterEach(() => cleanup());

describe('Voice screen', () => {
  it('renders a mic target well above 44px (h-44 = 176px)', () => {
    const { container } = render(createElement(VoiceScreen));
    // The "Speak answers aloud" label row (#1603) + the mic.
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons).toHaveLength(2);
    const mic = buttons[1];
    expect(mic.className).toMatch(/\bh-44\b/);
    expect(mic.className).toMatch(/\bw-44\b/);
  });

  it('starts recording on press-in and stops on release (hold-to-talk)', () => {
    const { container } = render(createElement(VoiceScreen));
    const mic = Array.from(container.querySelectorAll('button')).find((b) => /\bh-44\b/.test(b.className))!;
    fireEvent.mouseDown(mic);
    expect(h.startRecording).toHaveBeenCalledTimes(1);
    fireEvent.mouseUp(mic);
    expect(h.stopAndTranscribe).toHaveBeenCalledTimes(1);
  });

  it('shows job-update copy and scopes capture to the route job id', () => {
    h.jobId = ['3b6cbf1a-bd8a-45f7-8b84-ce6b43a231d1'];

    const { getByText } = render(createElement(VoiceScreen));

    expect(getByText('Update this job')).toBeTruthy();
    expect(getByText(/Describe what happened on this job/)).toBeTruthy();
    expect(h.captureJobId).toHaveBeenLastCalledWith('3b6cbf1a-bd8a-45f7-8b84-ce6b43a231d1');
  });

  it('preserves the generic voice experience without a job id', () => {
    const { getByText } = render(createElement(VoiceScreen));

    expect(getByText('Speak an action')).toBeTruthy();
    expect(h.captureJobId).toHaveBeenLastCalledWith(undefined);
  });

  it('reflects the listening state on the mic while recording', () => {
    h.phase = 'listening';
    const { getByText } = render(createElement(VoiceScreen));
    expect(getByText('Listening…')).toBeTruthy();
    expect(getByText('Listening…').closest('button')!.className).toMatch(/\bbg-destructive\b/);
  });

  it('shows the transcript and a >=44px "Speak again" target after capture', () => {
    h.phase = 'transcript';
    h.transcript = 'reschedule the Tuesday job';
    const { getByText, container } = render(createElement(VoiceScreen));
    expect(getByText('reschedule the Tuesday job')).toBeTruthy();
    const again = getByText('Speak again').closest('button')!;
    expect(again.className).toMatch(/\bmin-h-11\b/);
    // Toggle row + "View approvals" + "Speak again".
    expect(container.querySelectorAll('button')).toHaveLength(3);
  });

  it('surfaces an error with a >=44px retry target', () => {
    h.phase = 'error';
    h.error = 'Microphone permission is required to record.';
    const { getByText } = render(createElement(VoiceScreen));
    expect(getByText('Microphone permission is required to record.')).toBeTruthy();
    const retry = getByText('Try again').closest('button')!;
    expect(retry.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(retry);
    expect(h.reset).toHaveBeenCalledTimes(1);
  });
});

// U3 — routed-outcome branches after capture.
describe('Voice screen routed outcomes', () => {
  const answer = {
    version: 1,
    intent: 'lookup_balance',
    result: 'found',
    summary: 'Your current balance is $123.45.',
    rows: [{ kind: 'money', label: 'Outstanding balance', amountCents: 12345 }],
    entityRef: { kind: 'customer', id: '3b6cbf1a-bd8a-45f7-8b84-ce6b43a231d1' },
  };

  it("renders an AnswerCard for the 'answered' outcome — no approvals routing", () => {
    h.phase = 'transcript';
    h.transcript = 'what is my balance';
    h.outcome = { kind: 'answered', answer };
    const { getByText, queryByText } = render(createElement(VoiceScreen));

    expect(getByText('Your current balance is $123.45.')).toBeTruthy();
    expect(getByText('$123.45')).toBeTruthy();
    expect(queryByText('View approvals')).toBeNull();
    // Deep link comes from the AnswerCard; Speak again stays available.
    expect(getByText('View customer')).toBeTruthy();
    expect(getByText('Speak again')).toBeTruthy();
  });

  it("keeps today's approvals routing for 'proposal' and 'clarification' outcomes", () => {
    for (const kind of ['proposal', 'clarification'] as const) {
      h.phase = 'transcript';
      h.transcript = 'invoice the Hendersons';
      h.outcome = { kind };
      const { getByText, unmount } = render(createElement(VoiceScreen));
      expect(getByText(/proposals will appear in approvals/)).toBeTruthy();
      const btn = getByText('View approvals').closest('button')!;
      fireEvent.click(btn);
      expect(h.reset).toHaveBeenCalled();
      expect(h.push).toHaveBeenCalledWith('/approvals');
      unmount();
      vi.clearAllMocks();
    }
  });

  it("keeps today's behavior for 'skipped' and 'timeout' (and a null outcome)", () => {
    for (const outcome of [{ kind: 'skipped' }, { kind: 'timeout' }, null]) {
      h.phase = 'transcript';
      h.transcript = 'note for the file';
      h.outcome = outcome;
      const { getByText, unmount } = render(createElement(VoiceScreen));
      expect(getByText(/proposals will appear in approvals/)).toBeTruthy();
      expect(getByText('Speak again')).toBeTruthy();
      unmount();
    }
  });

  it("offers a retry affordance for the 'failed' outcome", () => {
    h.phase = 'transcript';
    h.transcript = 'what is my balance';
    h.outcome = { kind: 'failed' };
    const { getByText, queryByText } = render(createElement(VoiceScreen));

    expect(getByText(/Couldn't get that answer/)).toBeTruthy();
    expect(queryByText('View approvals')).toBeNull();
    const retry = getByText('Try again').closest('button')!;
    expect(retry.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(retry);
    expect(h.reset).toHaveBeenCalledTimes(1);
  });
});

// #1603 — technicians now have this tab; their drafts go to the office.
describe('Voice screen for a technician', () => {
  it("tells a technician their draft goes to the office — never 'your approval' or a View approvals button", () => {
    h.me = { ...TECH_ME };
    h.phase = 'transcript';
    h.transcript = 'replaced the condenser fan on the Patel unit';
    h.outcome = { kind: 'proposal' };
    const { getByText, queryByText } = render(createElement(VoiceScreen));

    expect(getByText(/send it to your office for approval/)).toBeTruthy();
    expect(getByText(/Drafting — sent to your office for approval/)).toBeTruthy();
    expect(queryByText('View approvals')).toBeNull();
    expect(queryByText(/your approval/)).toBeNull();
    expect(getByText('Speak again')).toBeTruthy();
  });
});

// #1603 — hands-free step 1: a memo answer is spoken back, text stays visible.
describe('Voice screen speaks memo answers', () => {
  const answer = {
    version: 1,
    intent: 'lookup_my_day',
    result: 'found',
    summary: 'You have one visit today: Rivera Family at 9:00 AM.',
    rows: [{ kind: 'text', label: '9:00 AM', text: 'Repair upstairs air conditioner' }],
    entityRef: null,
  };

  it("speaks an 'answered' outcome through the server TTS and keeps the text on screen", async () => {
    h.phase = 'transcript';
    h.transcript = "what's my next job";
    h.outcome = { kind: 'answered', answer };
    const { getByText } = render(createElement(VoiceScreen));

    await waitFor(() => expect(h.play).toHaveBeenCalledWith('bXAzLWJ5dGVzLTE2MDM='));
    expect(h.apiFetch).toHaveBeenCalledWith(
      '/api/voice/tts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'You have one visit today: Rivera Family at 9:00 AM.' }),
      }),
    );
    expect(getByText('You have one visit today: Rivera Family at 9:00 AM.')).toBeTruthy();
    expect(getByText('Repair upstairs air conditioner')).toBeTruthy();
  });

  it('has a per-device "speak answers" toggle — on by default — that silences and persists when turned off', async () => {
    h.phase = 'transcript';
    h.transcript = "what's my next job";
    h.outcome = { kind: 'answered', answer };
    const first = render(createElement(VoiceScreen));

    const toggle = (await first.findByLabelText('Speak answers aloud')) as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(true));
    await waitFor(() => expect(h.play).toHaveBeenCalledTimes(1));

    fireEvent.click(toggle);
    await waitFor(() =>
      expect((first.getByLabelText('Speak answers aloud') as HTMLInputElement).checked).toBe(false),
    );
    first.unmount();
    vi.clearAllMocks();

    // A fresh mount (next app open) with a NEW answer: the preference was
    // persisted off, so nothing is requested or played — the text still shows.
    h.outcome = {
      kind: 'answered',
      answer: { ...answer, summary: 'Nothing is scheduled tomorrow.', rows: [] },
    };
    const second = render(createElement(VoiceScreen));
    await waitFor(() =>
      expect((second.getByLabelText('Speak answers aloud') as HTMLInputElement).checked).toBe(false),
    );
    expect(second.getByText('Nothing is scheduled tomorrow.')).toBeTruthy();
    expect(h.apiFetch).not.toHaveBeenCalled();
    expect(h.play).not.toHaveBeenCalled();
  });

  it('the "Speak answers aloud" label row is itself a >=44px target that toggles speech (gloved tap, not just the switch)', async () => {
    const { getByText, getByLabelText } = render(createElement(VoiceScreen));
    await waitFor(() =>
      expect((getByLabelText('Speak answers aloud') as HTMLInputElement).checked).toBe(true),
    );
    const row = getByText('Speak answers aloud').closest('button')!;
    expect(row.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(row);
    await waitFor(() =>
      expect((getByLabelText('Speak answers aloud') as HTMLInputElement).checked).toBe(false),
    );
  });

  it('does not play a clip that arrives after the toggle was switched off mid-fetch', async () => {
    let resolveTts!: (value: unknown) => void;
    h.apiFetch.mockReturnValue(new Promise((resolve) => { resolveTts = resolve; }));
    h.phase = 'transcript';
    h.transcript = "what's my next job";
    h.outcome = { kind: 'answered', answer };
    const { getByLabelText } = render(createElement(VoiceScreen));

    // The fetch is in flight (field connection) …
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalledTimes(1));
    // … the technician flips speech off …
    fireEvent.click(getByLabelText('Speak answers aloud'));
    await waitFor(() =>
      expect((getByLabelText('Speak answers aloud') as HTMLInputElement).checked).toBe(false),
    );
    // … and only then does the server answer.
    resolveTts({
      ok: true,
      status: 200,
      json: async () => ({ audio: 'bXAzLWJ5dGVzLTE2MDM=', contentType: 'audio/mpeg' }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.play).not.toHaveBeenCalled();
  });

  it('keeps the answer on screen and never throws when the device player fails (best-effort contract)', async () => {
    h.play.mockRejectedValue(new Error('cache write failed: disk full'));
    h.phase = 'transcript';
    h.transcript = "what's my next job";
    h.outcome = { kind: 'answered', answer };
    const { getByText, queryByText } = render(createElement(VoiceScreen));

    await waitFor(() => expect(h.play).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(getByText('You have one visit today: Rivera Family at 9:00 AM.')).toBeTruthy();
    expect(queryByText(/Couldn't/)).toBeNull();
  });

  it('stays silent — with the answer still on screen and no error copy — when the server has no TTS (501)', async () => {
    h.apiFetch.mockResolvedValue({
      ok: false,
      status: 501,
      json: async () => ({ error: 'NOT_CONFIGURED' }),
    });
    h.phase = 'transcript';
    h.transcript = "what's my next job";
    h.outcome = { kind: 'answered', answer };
    const { getByText, queryByText } = render(createElement(VoiceScreen));

    await waitFor(() => expect(h.apiFetch).toHaveBeenCalledWith('/api/voice/tts', expect.anything()));
    expect(getByText('You have one visit today: Rivera Family at 9:00 AM.')).toBeTruthy();
    expect(h.play).not.toHaveBeenCalled();
    expect(queryByText(/Couldn't/)).toBeNull();
  });
});
