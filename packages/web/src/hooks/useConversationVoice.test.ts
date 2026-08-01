/**
 * UB-B2 — useConversationVoice: continuous STT + spoken replies + barge-in.
 *
 * Drives the REAL useDeepgramDictation underneath with the same mocked
 * WebSocket/MediaRecorder fakes as useDeepgramDictation.test.ts, plus a fake
 * speechSynthesis for the TTS side and fake timers for the debounce/silence
 * windows. Pins:
 *   - per-utterance finals auto-submit after the continuation debounce,
 *   - a final followed by more speech within the debounce concatenates
 *     (never a double submit),
 *   - barge-in: a non-empty partial while TTS is speaking stops speech,
 *   - 60s of silence ends the session.
 */
import { renderHook, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../utils/api-fetch', () => ({ apiFetch: (...a: unknown[]) => apiFetchMock(...a) }));

import { useConversationVoice, stripMarkdownForSpeech } from './useConversationVoice';

// ── Browser API fakes (mirrors useDeepgramDictation.test.ts) ────
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  url: string;
  protocols?: string | string[];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }
  send(data: unknown) { this.sent.push(data); }
  close() { this.readyState = 3; }
  emit(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: { size: number } }) => void) | null = null;
  constructor(_stream: unknown) { FakeMediaRecorder.instances.push(this); }
  start(_ms?: number) { this.state = 'recording'; }
  stop() { this.state = 'inactive'; }
}

class FakeUtterance {
  static instances: FakeUtterance[] = [];
  text: string;
  rate = 1;
  pitch = 1;
  lang = '';
  voice: unknown = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
    FakeUtterance.instances.push(this);
  }
}

const trackStop = vi.fn();
const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] }));
const synthCancel = vi.fn();
const synthSpeak = vi.fn((u: FakeUtterance) => { u.onstart?.(); });

beforeEach(() => {
  vi.useFakeTimers();
  apiFetchMock.mockReset();
  trackStop.mockReset();
  synthCancel.mockReset();
  synthSpeak.mockClear();
  FakeWebSocket.instances = [];
  FakeMediaRecorder.instances = [];
  FakeUtterance.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('speechSynthesis', {
    cancel: synthCancel,
    speak: synthSpeak,
    getVoices: () => [],
  });
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance as unknown as typeof SpeechSynthesisUtterance);
  apiFetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ token: 'dg-temp', expiresIn: 30, model: 'nova-3' }),
  });
});

afterEach(() => {
  // Unmount the hook BEFORE unstubbing globals so useTTS's cleanup effect
  // still sees the stubbed `speechSynthesis` when it calls `.cancel()`.
  // vitest 4 runs this afterEach ahead of Testing Library's auto-cleanup,
  // so without an explicit unmount here the deferred unmount would hit a
  // torn-down `speechSynthesis` and throw during passive-effect flush.
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function startSession(onSubmit = vi.fn(), onSessionEnd = vi.fn()) {
  const rendered = renderHook(() => useConversationVoice({ onSubmit, onSessionEnd }));
  await act(async () => { await rendered.result.current.start(); });
  const ws = FakeWebSocket.instances[0];
  act(() => { ws.onopen?.(); });
  return { ...rendered, ws, onSubmit, onSessionEnd };
}

function emitFinal(ws: FakeWebSocket, transcript: string) {
  act(() => {
    ws.emit({ is_final: true, speech_final: true, channel: { alternatives: [{ transcript }] } });
  });
}

function emitPartial(ws: FakeWebSocket, transcript: string) {
  act(() => {
    ws.emit({ is_final: false, channel: { alternatives: [{ transcript }] } });
  });
}

describe('UB-B2 — useConversationVoice', () => {
  it('opens a continuous stream and auto-submits a settled utterance after the debounce', async () => {
    const { result, ws, onSubmit } = await startSession();
    expect(result.current.active).toBe(true);
    expect(ws.url).toContain('utterance_end_ms=');

    emitFinal(ws, 'invoice the Rodriguez job');
    // Not yet — the continuation window is still open.
    expect(onSubmit).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(800); });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('invoice the Rodriguez job');
    // Session stays live for the next turn.
    expect(result.current.active).toBe(true);
  });

  it('concatenates a final followed by more speech within the debounce — never a double submit', async () => {
    const { ws, onSubmit } = await startSession();

    emitFinal(ws, 'invoice the Rodriguez job');
    act(() => { vi.advanceTimersByTime(400); });
    // The owner keeps talking inside the window: hold the pending submit …
    emitPartial(ws, 'and');
    act(() => { vi.advanceTimersByTime(800); });
    expect(onSubmit).not.toHaveBeenCalled();

    // … and the continuation utterance concatenates into ONE submission.
    emitFinal(ws, 'and send it to her email');
    act(() => { vi.advanceTimersByTime(800); });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('invoice the Rodriguez job and send it to her email');
  });

  it('speaks replies with markdown stripped, and barge-in stops TTS', async () => {
    const { result, ws } = await startSession();

    act(() => { result.current.speak('**Done.** Invoice `INV-12` sent.'); });
    expect(synthSpeak).toHaveBeenCalledTimes(1);
    expect(FakeUtterance.instances[0].text).toBe('Done. Invoice INV-12 sent.');
    expect(result.current.isSpeaking).toBe(true);
    const cancelsBefore = synthCancel.mock.calls.length;

    // The owner talks over the assistant → speech stops immediately.
    emitPartial(ws, 'wait actually');
    expect(synthCancel.mock.calls.length).toBeGreaterThan(cancelsBefore);
    expect(result.current.isSpeaking).toBe(false);
    // Session still live — barge-in interrupts the reply, not the conversation.
    expect(result.current.active).toBe(true);
  });

  it('ends the session after 60s of silence (mic + speech released)', async () => {
    const { result, ws, onSubmit, onSessionEnd } = await startSession();

    // Speech activity keeps the session alive past the raw timeout …
    act(() => { vi.advanceTimersByTime(30_000); });
    emitPartial(ws, 'hmm');
    act(() => { vi.advanceTimersByTime(59_000); });
    expect(result.current.active).toBe(true);

    // … but a full silent minute ends it.
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(result.current.active).toBe(false);
    expect(onSessionEnd).toHaveBeenCalledWith('silence');
    expect(onSubmit).not.toHaveBeenCalled();
    // Mic tracks released and any speech cancelled.
    expect(trackStop).toHaveBeenCalled();
    expect(synthCancel).toHaveBeenCalled();
  });

  it('manual stop ends the session and clears any pending submission', async () => {
    const { result, ws, onSubmit, onSessionEnd } = await startSession();

    emitFinal(ws, 'never mind');
    act(() => { result.current.stop(); });
    act(() => { vi.advanceTimersByTime(2_000); });

    expect(result.current.active).toBe(false);
    expect(onSessionEnd).toHaveBeenCalledWith('manual');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('UB-B2 — stripMarkdownForSpeech', () => {
  it('strips bold/italic/code/links/headings/bullets', () => {
    expect(
      stripMarkdownForSpeech('## Done\n- **Invoice** [INV-12](https://x.test) `sent`\n- _All good_'),
    ).toBe('Done Invoice INV-12 sent All good');
  });

  it('leaves plain text untouched', () => {
    expect(stripMarkdownForSpeech('Sent the invoice to Maria.')).toBe('Sent the invoice to Maria.');
  });
});
