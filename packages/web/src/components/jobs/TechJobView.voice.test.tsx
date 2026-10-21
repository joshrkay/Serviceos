/**
 * The technician job screen's voice update goes through the assistant with
 * this job pinned (tech-voice.ts): no hard-coded parts list, no guessed status
 * applied behind the tech's back, and no placeholder note when transcription
 * fails.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router';

const mockFetcher = vi.fn();
vi.mock('../../lib/apiClient', () => ({ useApiClient: () => mockFetcher }));
vi.mock('@clerk/clerk-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/clerk-react')>();
  return { ...actual, useAuth: () => ({ isLoaded: true, isSignedIn: true, getToken: async () => 'tok' }) };
});

import { TechJobView } from './TechJobView';

const JOB = { id: 'j1', jobNumber: '1001', summary: 'Fix HVAC', status: 'in_progress' };

class FakeMediaRecorder {
  static isTypeSupported = () => true;
  state = 'recording';
  mimeType = 'audio/webm';
  stream = { getTracks: () => [] as Array<{ stop: () => void }> };
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {}
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
}

function routes(opts: {
  transcript?: string;
  transcribeStatus?: number;
  chat?: { status: number; body: unknown };
  notesStatus?: number;
}) {
  mockFetcher.mockImplementation((path: string) => {
    if (path.includes('/transition')) return Promise.resolve(new Response('{}', { status: 200 }));
    if (path.startsWith('/api/jobs/')) return Promise.resolve(new Response(JSON.stringify(JOB), { status: 200 }));
    if (path === '/api/voice/transcribe') {
      return Promise.resolve(
        new Response(JSON.stringify({ transcript: opts.transcript ?? '' }), { status: opts.transcribeStatus ?? 200 }),
      );
    }
    if (path === '/api/assistant/chat') {
      const chat = opts.chat ?? { status: 200, body: { message: { content: 'Noted.' } } };
      return Promise.resolve(new Response(JSON.stringify(chat.body), { status: chat.status }));
    }
    if (path === '/api/notes') {
      const status = opts.notesStatus ?? 201;
      return Promise.resolve(new Response(JSON.stringify(status < 300 ? { id: 'n-new' } : {}), { status }));
    }
    return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
  });
}

const calls = (match: (path: string) => boolean) =>
  mockFetcher.mock.calls.filter(([p]) => match(String(p)));
const posts = (path: string) =>
  calls((p) => p === path).filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');

async function speak() {
  render(
    <MemoryRouter>
      <TechJobView id="j1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByText('Tap to add by voice'));
  fireEvent.click(await screen.findByRole('button', { name: /Done talking/ }));
}

beforeEach(() => {
  mockFetcher.mockReset();
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  Object.defineProperty(window.navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
    configurable: true,
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('TechJobView voice update', () => {
  it('sends the words to the assistant with this job pinned and shows its answer', async () => {
    routes({
      transcript: 'used a 45/5 capacitor and two hours labor',
      chat: {
        status: 200,
        body: {
          message: {
            content: 'Invoice: Ana Garcia, capacitor + 2h labor, $412. Ready for review.',
            proposal: { id: 'p1', title: 'Invoice', proposalType: 'draft_invoice' },
          },
        },
      },
    });
    await speak();
    // No status in these words, so no status line on the confirm card.
    expect(await screen.findByRole('textbox', { name: 'What you said' })).toHaveValue(
      'used a 45/5 capacitor and two hours labor',
    );
    expect(screen.queryByText(/Also mark the job/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Send to Rivet/ }));

    expect(await screen.findByTestId('tech-voice-reply')).toHaveTextContent('$412. Ready for review.');
    const [[, init]] = posts('/api/assistant/chat');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      messages: [{ role: 'user', content: 'used a 45/5 capacitor and two hours labor' }],
      inputMode: 'voice',
      pageContext: { entityType: 'job', entityId: 'j1' },
    });
    // The words are kept as the field note, and nothing invented a parts list.
    expect(posts('/api/notes')).toHaveLength(1);
    expect(screen.queryByText('Materials & Parts')).toBeNull();
    expect(calls((p) => p.includes('/transition'))).toHaveLength(0);
  });

  it('lets the tech fix the words before sending', async () => {
    routes({ transcript: 'gate code for 471' });
    await speak();
    fireEvent.change(await screen.findByRole('textbox', { name: 'What you said' }), {
      target: { value: 'gate code 4471' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Send to Rivet/ }));
    await screen.findByTestId('tech-voice-reply');
    const [[, init]] = posts('/api/assistant/chat');
    expect(JSON.parse((init as RequestInit).body as string).messages[0].content).toBe('gate code 4471');
  });

  it('offers "waiting", not "complete", for "waiting on parts, should be done tomorrow"', async () => {
    routes({ transcript: 'waiting on parts, should be done tomorrow' });
    await speak();
    expect(await screen.findByText(/Also mark the job/)).toHaveTextContent('Waiting');
    expect(screen.queryByText('Job complete!')).toBeNull();
  });

  it('leaves the status alone when the tech unticks the suggestion', async () => {
    routes({ transcript: "all done here, system's cooling" });
    await speak();
    const tick = await screen.findByRole('checkbox');
    expect(tick).toBeChecked();
    fireEvent.click(tick);
    fireEvent.click(screen.getByRole('button', { name: /Send to Rivet/ }));
    await screen.findByTestId('tech-voice-reply');
    expect(calls((p) => p.includes('/transition'))).toHaveLength(0);
    expect(screen.queryByText('Job complete!')).toBeNull();
  });

  it('applies a ticked "complete" through the job transition', async () => {
    routes({ transcript: "all done here, system's cooling" });
    await speak();
    await screen.findByRole('checkbox');
    fireEvent.click(screen.getByRole('button', { name: /Send to Rivet/ }));
    await waitFor(() => expect(calls((p) => p.includes('/transition'))).toHaveLength(1));
    const [[, init]] = calls((p) => p.includes('/transition'));
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ status: 'completed' });
  });

  it('follows the edited words: fixing "all done" to "waiting on parts" never completes the job', async () => {
    routes({ transcript: "all done here, system's cooling" });
    await speak();
    expect(await screen.findByText(/Also mark the job/)).toHaveTextContent('Complete');
    fireEvent.change(screen.getByRole('textbox', { name: 'What you said' }), {
      target: { value: 'not done, waiting on parts' },
    });
    expect(screen.getByText(/Also mark the job/)).toHaveTextContent('Waiting');
    fireEvent.click(screen.getByRole('button', { name: /Send to Rivet/ }));
    await screen.findByTestId('tech-voice-reply');
    for (const [, init] of calls((p) => p.includes('/transition'))) {
      expect(JSON.parse((init as RequestInit).body as string).status).not.toBe('completed');
    }
  });

  it('drops the suggestion when the edited words no longer name a status', async () => {
    routes({ transcript: "all done here, system's cooling" });
    await speak();
    await screen.findByRole('checkbox');
    fireEvent.change(screen.getByRole('textbox', { name: 'What you said' }), {
      target: { value: 'replaced the capacitor' },
    });
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Send to Rivet/ }));
    await screen.findByTestId('tech-voice-reply');
    expect(calls((p) => p.includes('/transition'))).toHaveLength(0);
  });

  it('saves nothing when transcription fails, and says so', async () => {
    routes({ transcribeStatus: 502 });
    await speak();
    expect(await screen.findByText(/Couldn't transcribe that, and nothing was saved/)).toBeInTheDocument();
    expect(posts('/api/notes')).toHaveLength(0);
    expect(posts('/api/assistant/chat')).toHaveLength(0);
  });

  it('does not save the note twice when the assistant already approved it as a note', async () => {
    routes({
      transcript: 'note: customer prefers mornings',
      chat: {
        status: 200,
        body: {
          message: { content: 'Note added.', proposal: { id: 'p2', title: 'Note', proposalType: 'add_note', status: 'Approved' } },
        },
      },
    });
    await speak();
    fireEvent.click(await screen.findByRole('button', { name: /Send to Rivet/ }));
    await screen.findByTestId('tech-voice-reply');
    expect(posts('/api/notes')).toHaveLength(0);
  });

  it('saves the note when the assistant only drafted it, because this screen has no card to approve it', async () => {
    routes({
      transcript: 'note: customer prefers mornings',
      chat: {
        status: 200,
        body: {
          message: { content: 'Note drafted.', proposal: { id: 'p2', title: 'Note', proposalType: 'add_note', status: 'Pending' } },
        },
      },
    });
    await speak();
    fireEvent.click(await screen.findByRole('button', { name: /Send to Rivet/ }));
    await screen.findByTestId('tech-voice-reply');
    expect(posts('/api/notes')).toHaveLength(1);
  });

  it('keeps the words as a note when the assistant is unavailable', async () => {
    routes({ transcript: 'compressor is short cycling', chat: { status: 503, body: {} } });
    await speak();
    fireEvent.click(await screen.findByRole('button', { name: /Send to Rivet/ }));
    expect(await screen.findByTestId('tech-voice-reply')).toHaveTextContent("Saved as a job note. Rivet couldn't draft");
    expect(posts('/api/notes')).toHaveLength(1);
  });

  it('does not claim the note saved when the assistant and the note save both fail', async () => {
    routes({ transcript: 'compressor is short cycling', chat: { status: 503, body: {} }, notesStatus: 500 });
    await speak();
    fireEvent.click(await screen.findByRole('button', { name: /Send to Rivet/ }));
    const reply = await screen.findByTestId('tech-voice-reply');
    expect(reply).not.toHaveTextContent('Saved as a job note');
    expect(reply).toHaveTextContent(`The job note didn't save, so please try again: "compressor is short cycling"`);
  });

  it('says the note did not save even when the assistant answered', async () => {
    routes({ transcript: 'gate code 4471', notesStatus: 500 });
    await speak();
    fireEvent.click(await screen.findByRole('button', { name: /Send to Rivet/ }));
    expect(await screen.findByTestId('tech-voice-reply')).toHaveTextContent("Noted. The job note didn't save");
  });

  it('keeps the confirm controls at a 44px tap target', async () => {
    routes({ transcript: "all done here" });
    await speak();
    await screen.findByRole('checkbox');
    for (const name of [/Send to Rivet/, /Discard/]) {
      expect(screen.getByRole('button', { name }).className).toContain('min-h-11');
    }
    expect(screen.getByRole('checkbox').closest('label')!.className).toContain('min-h-11');
  });
});
