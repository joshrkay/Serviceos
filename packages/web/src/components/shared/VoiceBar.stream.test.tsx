/**
 * VoiceBar live words + hand-off: words stream in while you talk, "Done"
 * turns them into an editable transcript, Send hands off to the assistant
 * carrying the record on screen, and a browser/server that cannot stream
 * falls back to record-then-transcribe.
 */
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceBar } from './VoiceBar';

vi.mock('../../hooks/useTTS', () => ({
  useTTS: () => ({ speak: vi.fn(), stop: vi.fn() }),
}));

// A controllable stand-in for the Deepgram hook.
const fake = vi.hoisted(() => ({
  startResult: 'connecting' as string,
  partial: '',
  finalText: '',
  opts: null as null | { onFinal?: (t: string) => void; onClose?: (i: { opened: boolean }) => void },
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('../../hooks/useDeepgramDictation', () => ({
  dictationSupported: () => true,
  useDeepgramDictation: (opts: typeof fake.opts) => {
    fake.opts = opts;
    return {
      isRecording: false,
      partial: fake.partial,
      error: null,
      supported: true,
      start: fake.start,
      stop: fake.stop,
    };
  },
}));

class FakeMediaRecorder {
  static isTypeSupported = () => true;
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: unknown) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
}

const JOB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.search}</p>;
}

function renderBar(path = `/jobs/${JOB}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<><VoiceBar /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fake.startResult = 'connecting';
  fake.partial = '';
  fake.finalText = '';
  fake.start.mockImplementation(async () => fake.startResult);
  fake.stop.mockImplementation(() => {
    if (fake.finalText) fake.opts?.onFinal?.(fake.finalText);
  });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('VoiceBar — live words', () => {
  it('shows the words as they arrive, then an editable transcript', async () => {
    const view = renderBar();
    fireEvent.click(screen.getByTestId('voice-example-hint'));
    expect(await screen.findByText('Listening…')).toBeTruthy();
    expect(fake.start).toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();

    fake.partial = 'add a note gate code';
    view.rerender(
      <MemoryRouter initialEntries={[`/jobs/${JOB}`]}>
        <Routes>
          <Route path="*" element={<><VoiceBar /><Where /></>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('voice-live-text').textContent).toBe('add a note gate code');

    fake.finalText = 'add a note: gate code 4471';
    fireEvent.click(screen.getByRole('button', { name: 'Done talking' }));
    expect(fake.stop).toHaveBeenCalled();
    expect((screen.getByRole('textbox', { name: 'What you said' }) as HTMLInputElement).value).toBe(
      'add a note: gate code 4471',
    );
  });

  it('hands off to the assistant with the record on screen and the spoken flag', async () => {
    renderBar();
    fireEvent.click(screen.getByTestId('voice-example-hint'));
    await screen.findByText('Listening…');
    fake.finalText = 'add a note: gate code 4471';
    fireEvent.click(screen.getByRole('button', { name: 'Done talking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByTestId('where').textContent).toContain('/assistant?'));
    const params = new URLSearchParams(screen.getByTestId('where').textContent!.split('?')[1]);
    expect(params.get('q')).toBe('add a note: gate code 4471');
    expect(params.get('ctx')).toBe(`job:${JOB}`);
    expect(params.get('via')).toBe('voice');
  });

  it('keeps the record that was on screen when the mic opened, even after moving pages', async () => {
    const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    function GoElsewhere() {
      const navigate = useNavigate();
      return <button onClick={() => navigate(`/jobs/${OTHER}`)}>go elsewhere</button>;
    }
    render(
      <MemoryRouter initialEntries={[`/jobs/${JOB}`]}>
        <Routes>
          <Route path="*" element={<><VoiceBar /><GoElsewhere /><Where /></>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('voice-example-hint'));
    await screen.findByText('Listening…');
    fireEvent.click(screen.getByRole('button', { name: 'go elsewhere' }));
    expect(screen.getByTestId('where').textContent).toBe(`/jobs/${OTHER}`);
    fake.finalText = 'add a note: gate code 4471';
    fireEvent.click(screen.getByRole('button', { name: 'Done talking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByTestId('where').textContent).toContain('/assistant?'));
    const params = new URLSearchParams(screen.getByTestId('where').textContent!.split('?')[1]);
    expect(params.get('ctx')).toBe(`job:${JOB}`);
  });

  it('sends a detailed create to the assistant instead of opening a blank form', async () => {
    renderBar('/');
    fireEvent.click(screen.getByTestId('voice-example-hint'));
    await screen.findByText('Listening…');
    fake.finalText = 'New customer Maria Alvarez, 480-555-0102';
    fireEvent.click(screen.getByRole('button', { name: 'Done talking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toContain('/assistant?'));
    expect(screen.getByTestId('where').textContent).not.toContain('/customers/new');
  });

  it('says so when nothing was heard', async () => {
    renderBar();
    fireEvent.click(screen.getByTestId('voice-example-hint'));
    await screen.findByText('Listening…');
    fireEvent.click(screen.getByRole('button', { name: 'Done talking' }));
    expect(screen.getByText(/didn't catch anything/)).toBeTruthy();
  });

  it('keeps the words heard so far when the connection drops', async () => {
    const view = renderBar();
    fireEvent.click(screen.getByTestId('voice-example-hint'));
    await screen.findByText('Listening…');
    fake.partial = 'invoice the Martins';
    view.rerender(
      <MemoryRouter initialEntries={[`/jobs/${JOB}`]}>
        <Routes>
          <Route path="*" element={<><VoiceBar /><Where /></>} />
        </Routes>
      </MemoryRouter>,
    );
    act(() => fake.opts?.onClose?.({ opened: true }));
    expect((screen.getByRole('textbox', { name: 'What you said' }) as HTMLInputElement).value).toBe(
      'invoice the Martins',
    );
  });

  it('falls back to record-then-transcribe when live transcription is unavailable', async () => {
    fake.startResult = 'unavailable';
    renderBar();
    fireEvent.click(screen.getByTestId('voice-example-hint'));
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true }));
    expect(screen.getByText('Listening…')).toBeTruthy();
  });

  it('returns to idle when the fallback recorder has no supported format', async () => {
    fake.startResult = 'unavailable';
    const supported = vi.spyOn(FakeMediaRecorder, 'isTypeSupported').mockReturnValue(false);
    try {
      renderBar();
      fireEvent.click(screen.getByTestId('voice-example-hint'));
      expect(await screen.findByText(/compatible recording format/)).toBeTruthy();
      expect(screen.queryByText('Listening…')).toBeNull();
      expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    } finally {
      supported.mockRestore();
    }
  });

  it('falls back when the socket is refused before it opens', async () => {
    renderBar();
    fireEvent.click(screen.getByTestId('voice-example-hint'));
    await screen.findByText('Listening…');
    act(() => fake.opts?.onClose?.({ opened: false }));
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true }));
  });

  it('asks for the microphone when it was refused, without falling back', async () => {
    fake.startResult = 'denied';
    renderBar();
    fireEvent.click(screen.getByTestId('voice-example-hint'));
    expect(await screen.findByText(/Microphone permission is required/)).toBeTruthy();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('a start the user cancelled while it was still connecting never opens later', async () => {
    let resolveStart: (r: string) => void = () => {};
    fake.start.mockImplementation(() => new Promise<string>((r) => { resolveStart = r; }));
    renderBar();
    fireEvent.click(screen.getByTestId('voice-example-hint'));
    await screen.findByText('Listening…');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const stopsBefore = fake.stop.mock.calls.length;

    // The hook releases what the stale start opened and reports it cancelled;
    // the bar must not stop the hook again, and stays idle.
    await act(async () => resolveStart('cancelled'));
    expect(fake.stop.mock.calls.length).toBe(stopsBefore);
    expect(screen.queryByText('Listening…')).toBeNull();
  });

  it('a stale start finishing late does not stop the retry that replaced it', async () => {
    let resolveFirst: (r: string) => void = () => {};
    fake.start.mockImplementationOnce(() => new Promise<string>((r) => { resolveFirst = r; }));
    renderBar();
    fireEvent.click(screen.getByTestId('voice-example-hint'));
    await screen.findByText('Listening…');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Retry: this start connects.
    fireEvent.click(screen.getByTestId('voice-example-hint'));
    await screen.findByText('Listening…');
    const stopsBefore = fake.stop.mock.calls.length;

    await act(async () => resolveFirst('cancelled'));
    expect(fake.stop.mock.calls.length).toBe(stopsBefore);
    expect(screen.getByText('Listening…')).toBeTruthy();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('leaving the page while the stream is still starting never opens the recorder', async () => {
    let resolveStart: (r: string) => void = () => {};
    fake.start.mockImplementation(() => new Promise<string>((r) => { resolveStart = r; }));
    const view = renderBar();
    fireEvent.click(screen.getByTestId('voice-example-hint'));
    await screen.findByText('Listening…');
    view.unmount();
    const stopsBefore = fake.stop.mock.calls.length;

    await act(async () => resolveStart('cancelled'));
    expect(fake.stop.mock.calls.length).toBe(stopsBefore);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('a cancelled start does not fall back to the recorder when streaming turns out to be unavailable', async () => {
    let resolveStart: (r: string) => void = () => {};
    fake.start.mockImplementation(() => new Promise<string>((r) => { resolveStart = r; }));
    renderBar();
    fireEvent.click(screen.getByTestId('voice-example-hint'));
    await screen.findByText('Listening…');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await act(async () => resolveStart('unavailable'));
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(screen.queryByText('Listening…')).toBeNull();
  });

  it('keeps every listening and transcript control at a 44px tap target', async () => {
    renderBar();
    fireEvent.click(screen.getByTestId('voice-example-hint'));
    await screen.findByText('Listening…');
    for (const name of ['Done talking', 'Cancel']) {
      expect(screen.getByRole('button', { name }).className).toContain('size-11');
    }
    fake.finalText = 'open invoices';
    fireEvent.click(screen.getByRole('button', { name: 'Done talking' }));
    for (const name of ['Discard', 'Send']) {
      expect(screen.getByRole('button', { name }).className).toContain('size-11');
    }
  });
});
