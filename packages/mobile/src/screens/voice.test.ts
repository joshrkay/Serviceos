// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  startRecording: vi.fn(),
  stopAndTranscribe: vi.fn(),
  reset: vi.fn(),
  captureJobId: vi.fn(),
  jobId: undefined as string | string[] | undefined,
  phase: 'idle' as 'idle' | 'listening' | 'transcribing' | 'transcript' | 'error',
  transcript: '',
  error: null as string | null,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  useLocalSearchParams: () => ({ jobId: h.jobId }),
}));
vi.mock('../voice/useVoiceCapture', () => ({
  useVoiceCapture: (jobId?: string) => {
    h.captureJobId(jobId);
    return {
      phase: h.phase,
      transcript: h.transcript,
      error: h.error,
      startRecording: h.startRecording,
      stopAndTranscribe: h.stopAndTranscribe,
      reset: h.reset,
    };
  },
}));

// eslint-disable-next-line import/first
import VoiceScreen from '../../app/(tabs)/voice';

beforeEach(() => {
  vi.clearAllMocks();
  h.phase = 'idle';
  h.transcript = '';
  h.error = null;
  h.jobId = undefined;
});

afterEach(() => cleanup());

describe('Voice screen', () => {
  it('renders a mic target well above 44px (h-44 = 176px)', () => {
    const { container } = render(createElement(VoiceScreen));
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].className).toMatch(/\bh-44\b/);
    expect(buttons[0].className).toMatch(/\bw-44\b/);
  });

  it('starts recording on press-in and stops on release (hold-to-talk)', () => {
    const { container } = render(createElement(VoiceScreen));
    const mic = container.querySelector('button')!;
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
    const { getByText, container } = render(createElement(VoiceScreen));
    expect(getByText('Listening…')).toBeTruthy();
    expect(container.querySelector('button')!.className).toMatch(/\bbg-destructive\b/);
  });

  it('shows the transcript and a >=44px "Speak again" target after capture', () => {
    h.phase = 'transcript';
    h.transcript = 'reschedule the Tuesday job';
    const { getByText, container } = render(createElement(VoiceScreen));
    expect(getByText('reschedule the Tuesday job')).toBeTruthy();
    const again = getByText('Speak again').closest('button')!;
    expect(again.className).toMatch(/\bmin-h-11\b/);
    expect(container.querySelectorAll('button')).toHaveLength(2);
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
