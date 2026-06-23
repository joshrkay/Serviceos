// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseVoiceCaptureResult } from '../voice/useVoiceCapture';

const h = vi.hoisted(() => ({
  push: vi.fn(),
  capture: {
    phase: 'idle',
    transcript: '',
    error: null,
    startRecording: vi.fn(),
    stopAndTranscribe: vi.fn(),
    reset: vi.fn(),
  } as unknown as UseVoiceCaptureResult,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: h.push, navigate: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../voice/useVoiceCapture', () => ({ useVoiceCapture: () => h.capture }));

import { VoiceOverlay } from './VoiceOverlay';

beforeEach(() => {
  h.push.mockReset();
  h.capture = {
    phase: 'idle',
    transcript: '',
    error: null,
    startRecording: vi.fn(),
    stopAndTranscribe: vi.fn(),
    reset: vi.fn(),
  } as unknown as UseVoiceCaptureResult;
});
afterEach(cleanup);

describe('VoiceOverlay', () => {
  it('shows a >=44px mic affordance and keeps the sheet closed initially', () => {
    const { getByText, queryByText } = render(createElement(VoiceOverlay));
    const mic = getByText('Talk').closest('button')!;
    expect(mic.className).toMatch(/\bmin-h-11\b/);
    expect(mic.className).toMatch(/\bmin-w-11\b/);
    expect(queryByText('Assistant')).toBeNull();
  });

  it('opens the hold-to-talk sheet when the mic is tapped', () => {
    const { getByText } = render(createElement(VoiceOverlay));
    fireEvent.click(getByText('Talk').closest('button')!);
    expect(getByText('Assistant')).toBeTruthy();
    expect(getByText('Hold')).toBeTruthy();
  });

  it('drives the capture hook on press-in / press-out', () => {
    const { getByText } = render(createElement(VoiceOverlay));
    fireEvent.click(getByText('Talk').closest('button')!);
    const hold = getByText('Hold').closest('button')!;
    fireEvent.mouseDown(hold);
    expect(h.capture.startRecording).toHaveBeenCalled();
    fireEvent.mouseUp(hold);
    expect(h.capture.stopAndTranscribe).toHaveBeenCalled();
  });

  it('on a transcript, routes to approvals and closes', () => {
    h.capture = { ...h.capture, phase: 'transcript', transcript: 'Bill the Rodriguez job' };
    const { getByText, queryByText } = render(createElement(VoiceOverlay));
    fireEvent.click(getByText('Talk').closest('button')!);
    expect(getByText('Bill the Rodriguez job')).toBeTruthy();
    fireEvent.click(getByText('View approvals').closest('button')!);
    expect(h.push).toHaveBeenCalledWith('/approvals');
    // Sheet closed after navigating.
    expect(queryByText('Assistant')).toBeNull();
  });

  it('closes the sheet via the Close control', () => {
    const { getByText, queryByText } = render(createElement(VoiceOverlay));
    fireEvent.click(getByText('Talk').closest('button')!);
    fireEvent.click(getByText('Close').closest('button')!);
    expect(queryByText('Assistant')).toBeNull();
  });
});
