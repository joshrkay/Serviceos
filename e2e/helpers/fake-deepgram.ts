/**
 * Scripted speech for the real-stack onboarding lane (e2e/onboarding-v3.config.ts).
 *
 * The lane's API runs with STT_PROVIDER=fixture, so POST /api/voice/stream-token
 * really answers (a fixture token, audited like a real mint). This helper takes
 * the other end: Playwright intercepts the browser's Deepgram socket
 * (`page.routeWebSocket`, nothing reaches Deepgram), drops the microphone audio
 * the page streams into it, and plays back transcripts in Deepgram's own message
 * shape, so the page's listening code runs unchanged from the token mint onward.
 *
 * Needs a microphone the page can open: the lane's Chromium runs with a fake
 * device, and the test grants `microphone`.
 */
import type { Page, WebSocketRoute } from '@playwright/test';

export interface FakeDeepgram {
  /** Every socket the page opened, oldest first, with the URL it asked for (model, language, keyterms). */
  readonly urls: string[];
  /** Says `text` on the newest socket: an interim result, then the final with Deepgram's end-of-speech mark. */
  say: (text: string) => void;
}

const DEEPGRAM_LISTEN = /^wss:\/\/api\.deepgram\.com\/v1\/listen/;

const result = (transcript: string, final: boolean) =>
  JSON.stringify({
    type: 'Results',
    is_final: final,
    speech_final: final,
    channel: { alternatives: [{ transcript, confidence: 0.99 }] },
  });

/** Install before the page opens a socket (before the turn that listens). */
export async function fakeDeepgram(page: Page): Promise<FakeDeepgram> {
  const urls: string[] = [];
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(DEEPGRAM_LISTEN, (ws) => {
    urls.push(ws.url());
    sockets.push(ws);
    // Not connected to a server: the page's socket opens against this mock, and its audio stops here.
    ws.onMessage(() => undefined);
  });
  return {
    urls,
    say(text: string) {
      const ws = sockets.at(-1);
      if (!ws) throw new Error('fakeDeepgram.say: the page has not opened a Deepgram socket yet');
      ws.send(result(text.split(' ').slice(0, 2).join(' '), false));
      ws.send(result(text, true));
    },
  };
}
