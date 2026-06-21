import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../utils/api-fetch', () => ({ apiFetch: (...a: unknown[]) => apiFetchMock(...a) }));

import { useDeepgramDictation, dictationSupported } from './useDeepgramDictation';

// ── Browser API fakes ───────────────────────────────────────────
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

const trackStop = vi.fn();
const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] }));

beforeEach(() => {
  apiFetchMock.mockReset();
  trackStop.mockReset();
  FakeWebSocket.instances = [];
  FakeMediaRecorder.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okToken() {
  apiFetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ token: 'dg-temp', expiresIn: 30, model: 'nova-3' }),
  });
}

describe('Story 3.2 — useDeepgramDictation', () => {
  it('reports support when the browser APIs exist', () => {
    expect(dictationSupported()).toBe(true);
  });

  it('fetches a temp token, opens a bearer-authed WS to Deepgram nova-3, and starts recording', async () => {
    okToken();
    const { result } = renderHook(() => useDeepgramDictation({}));
    await act(async () => { await result.current.start(); });

    expect(apiFetchMock).toHaveBeenCalledWith('/api/voice/stream-token', { method: 'POST' });
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toContain('wss://api.deepgram.com/v1/listen');
    expect(ws.url).toContain('model=nova-3');
    expect(ws.url).toContain('interim_results=true');
    // Short-lived token rides the WS subprotocol, never a header.
    expect(ws.protocols).toEqual(['bearer', 'dg-temp']);

    act(() => { ws.onopen?.(); });
    await waitFor(() => expect(result.current.isRecording).toBe(true));
    expect(FakeMediaRecorder.instances[0].state).toBe('recording');
  });

  it('renders interim transcripts live and delivers the final transcript to onFinal on stop', async () => {
    okToken();
    const onFinal = vi.fn();
    const { result } = renderHook(() => useDeepgramDictation({ onFinal }));
    await act(async () => { await result.current.start(); });
    const ws = FakeWebSocket.instances[0];
    act(() => { ws.onopen?.(); });

    // Interim → partial updates live, no final yet.
    act(() => { ws.emit({ is_final: false, channel: { alternatives: [{ transcript: 'invoice the' }] } }); });
    await waitFor(() => expect(result.current.partial).toBe('invoice the'));
    expect(onFinal).not.toHaveBeenCalled();

    // Final segment commits.
    act(() => { ws.emit({ is_final: true, channel: { alternatives: [{ transcript: 'invoice the Rodriguez job' }] } }); });

    act(() => { result.current.stop(); });
    expect(onFinal).toHaveBeenCalledWith('invoice the Rodriguez job');
    expect(result.current.isRecording).toBe(false);
    // Mic tracks released.
    expect(trackStop).toHaveBeenCalled();
  });

  it('surfaces a 503 (not configured) as an error and does not record', async () => {
    apiFetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const { result } = renderHook(() => useDeepgramDictation({}));
    await act(async () => { await result.current.start(); });
    expect(result.current.error).toMatch(/not available/i);
    expect(result.current.isRecording).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('reports an unsupported browser without throwing', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    const { result } = renderHook(() => useDeepgramDictation({}));
    await act(async () => { await result.current.start(); });
    expect(result.current.error).toMatch(/not supported/i);
  });
});
