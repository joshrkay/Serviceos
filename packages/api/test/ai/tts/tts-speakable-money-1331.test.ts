import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsTtsProvider, OpenAiTtsProvider } from '../../../src/ai/tts/tts-provider';

/**
 * #1331 — Layer 2 run 36925905917: the balance line "Your current balance is
 * $972.00, due May 15." came back from speech recognition as "$972 sellers".
 * A "$N.NN" token leaves the reading of the cents to the speech engine; the
 * text sent for synthesis spells the amount out instead.
 */
function captureSpokenInput(): { sent: string[] } {
  const sent: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body).input);
      return new Response(Buffer.from([1, 2, 3]), { status: 200 });
    }),
  );
  return { sent };
}

describe('OpenAiTtsProvider — dollar amounts are spelled out for synthesis (#1331)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('speaks a whole-dollar amount as "N dollars"', async () => {
    const { sent } = captureSpokenInput();
    await new OpenAiTtsProvider('key').synthesize({ text: 'Your current balance is $972.00, due May 15.' });
    expect(sent).toEqual(['Your current balance is 972 dollars, due May 15.']);
  });
});

describe('OpenAiTtsProvider — amounts with cents (#1331)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('speaks dollars and cents, and a one-dollar amount in the singular', async () => {
    const { sent } = captureSpokenInput();
    await new OpenAiTtsProvider('key').synthesize({
      text: 'You have 2 open invoices totaling $1,250.50. The earliest is INV-1 for $1.00, plus a $0.75 fee.',
    });
    expect(sent).toEqual([
      'You have 2 open invoices totaling 1,250 dollars and 50 cents. The earliest is INV-1 for 1 dollar, plus a 75 cents fee.',
    ]);
  });

  it('leaves a Spanish session\'s amounts unchanged', async () => {
    const { sent } = captureSpokenInput();
    await new OpenAiTtsProvider('key').synthesize({ text: 'Su saldo es $972.00.', language: 'es' });
    expect(sent).toEqual(['Su saldo es $972.00.']);
  });
});

describe('ElevenLabsTtsProvider streaming (the live media-streams path) — dollar amounts spelled out (#1331)', () => {
  const original = global.WebSocket;
  afterEach(() => {
    global.WebSocket = original;
  });

  it('sends "N dollars" to the speech socket, not "$N.NN"', async () => {
    const sent: string[] = [];
    const listeners: Record<string, Array<(e: unknown) => void>> = {};
    const fakeWs = {
      readyState: 0,
      addEventListener: (ev: string, fn: (e: unknown) => void) => (listeners[ev] ??= []).push(fn),
      send: (d: string) => sent.push(d),
      close: () => {
        for (const fn of listeners.close ?? []) fn({});
      },
    };
    global.WebSocket = vi.fn(function () {
      queueMicrotask(() => {
        fakeWs.readyState = 1;
        for (const fn of listeners.open ?? []) fn({});
      });
      return fakeWs as unknown as WebSocket;
    }) as unknown as typeof WebSocket;

    const iter = new ElevenLabsTtsProvider('k')
      .synthesizeStream({ text: 'Your current balance is $972.00, due May 15.' })
      [Symbol.asyncIterator]();
    const done = iter.next();
    await new Promise((r) => setTimeout(r, 0));
    fakeWs.close();
    await done;

    const spokenText = sent.map((f) => JSON.parse(f).text as string | undefined).join('');
    expect(spokenText).toContain('Your current balance is 972 dollars, due May 15.');
    expect(spokenText).not.toContain('$972.00');
  });
});
