/**
 * P8-012 — WebSocket upgrade handler tests.
 *
 * Drives the upgrade handler with raw HTTP requests to verify:
 *   - Unsigned upgrade requests are rejected with 403.
 *   - Wrong-path upgrades are NOT consumed (other listeners can handle them).
 *   - Properly-signed upgrades succeed and instantiate an adapter.
 *   - Feature flag off → upgrade handler is never registered (the flag
 *     truly bypasses the new path).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setDraining } from '../../../src/ws/drain-state';
import http from 'http';
import { AddressInfo } from 'net';
import twilio from 'twilio';
import {
  attachMediaStreamServer,
  MEDIA_STREAM_PATH,
} from '../../../src/telephony/media-streams/twilio-mediastream-server';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import type { StreamingTranscriptionProvider } from '../../../src/voice/transcription-providers';

const AUTH_TOKEN = 'test-tw-mediastream-token';

function makeStreamingProvider(): StreamingTranscriptionProvider {
  return {
    async openSession() {
      return {
        send: () => {},
        finish: () => {},
        destroy: () => {},
      };
    },
  };
}

interface UpgradeResult {
  statusCode: number | null;
  headers: Record<string, string>;
  closed: boolean;
}

/**
 * Send a raw HTTP upgrade request to the server and capture the
 * response status. The response is whatever the upgrade handler
 * writes back on the socket — typically `HTTP/1.1 <code> ...`.
 */
function sendUpgrade(
  port: number,
  path: string,
  signature: string | undefined,
  host: string,
): Promise<UpgradeResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: host,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
    };
    if (signature) headers['X-Twilio-Signature'] = signature;
    const req = http.request({
      port,
      path,
      method: 'GET',
      headers,
    });
    req.on('upgrade', (res) => {
      // We don't actually want to ws-handshake further; close.
      resolve({
        statusCode: res.statusCode ?? 101,
        headers: Object.fromEntries(
          Object.entries(res.headers).map(([k, v]) => [k, String(v)]),
        ),
        closed: false,
      });
      try {
        req.destroy();
      } catch {
        /* swallow */
      }
    });
    req.on('response', (res) => {
      resolve({
        statusCode: res.statusCode ?? null,
        headers: Object.fromEntries(
          Object.entries(res.headers).map(([k, v]) => [k, String(v)]),
        ),
        closed: false,
      });
      res.resume();
    });
    req.on('error', (err) => {
      // Server-side close → ECONNRESET. That counts as "rejected".
      resolve({ statusCode: null, headers: {}, closed: true });
      void err;
    });
    req.end();
  });
}

describe('P8-012 attachMediaStreamServer', () => {
  let server: http.Server;
  let port: number;
  let dispose: () => void = () => {};

  beforeEach(async () => {
    server = http.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    dispose();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('rejects upgrades without a Twilio signature with 403', async () => {
    const result = attachMediaStreamServer(server, {
      store: new VoiceSessionStore({ startInterval: false }),
      streamingProvider: makeStreamingProvider(),
      speechTurn: async () => [],
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: `http://127.0.0.1:${port}`,
    });
    dispose = result.dispose;

    const res = await sendUpgrade(port, MEDIA_STREAM_PATH, undefined, `127.0.0.1:${port}`);
    expect(res.statusCode === 403 || res.closed).toBe(true);
  });

  it('rejects upgrades with an invalid Twilio signature with 403', async () => {
    const result = attachMediaStreamServer(server, {
      store: new VoiceSessionStore({ startInterval: false }),
      streamingProvider: makeStreamingProvider(),
      speechTurn: async () => [],
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: `http://127.0.0.1:${port}`,
    });
    dispose = result.dispose;

    const res = await sendUpgrade(port, MEDIA_STREAM_PATH, 'totally-bogus', `127.0.0.1:${port}`);
    expect(res.statusCode === 403 || res.closed).toBe(true);
  });

  it('accepts properly-signed upgrades and switches protocols', async () => {
    const result = attachMediaStreamServer(server, {
      store: new VoiceSessionStore({ startInterval: false }),
      streamingProvider: makeStreamingProvider(),
      speechTurn: async () => [],
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: `http://127.0.0.1:${port}`,
    });
    dispose = result.dispose;

    // Compute a valid signature against the URL the handler reconstructs.
    const url = `http://127.0.0.1:${port}${MEDIA_STREAM_PATH}`;
    const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, {});
    const res = await sendUpgrade(port, MEDIA_STREAM_PATH, sig, `127.0.0.1:${port}`);
    // 101 Switching Protocols → ws handshake completed.
    expect(res.statusCode).toBe(101);
  });

  it('does not consume upgrades on a different path (returns from handler)', async () => {
    // Attach a sibling upgrade listener that responds 418 — this
    // proves our handler returned without destroying the socket
    // (otherwise the sibling listener would never fire).
    const sibling = vi.fn((req: http.IncomingMessage, socket: import('net').Socket) => {
      if (req.url === '/some-other-path') {
        socket.write('HTTP/1.1 418 I am a teapot\r\nConnection: close\r\n\r\n');
        socket.destroy();
      }
    });
    server.on('upgrade', sibling);

    const result = attachMediaStreamServer(server, {
      store: new VoiceSessionStore({ startInterval: false }),
      streamingProvider: makeStreamingProvider(),
      speechTurn: async () => [],
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: `http://127.0.0.1:${port}`,
    });
    dispose = result.dispose;

    const res = await sendUpgrade(port, '/some-other-path', undefined, `127.0.0.1:${port}`);
    expect(res.statusCode === 418 || res.closed).toBe(true);
    // Sibling was invoked at least once.
    expect(sibling).toHaveBeenCalled();
  });

  it('feature-flag off (enabled: false) does NOT register an upgrade handler', async () => {
    // Snapshot listener count before/after to verify nothing was added.
    const before = server.listenerCount('upgrade');
    const result = attachMediaStreamServer(
      server,
      {
        store: new VoiceSessionStore({ startInterval: false }),
        streamingProvider: makeStreamingProvider(),
        speechTurn: async () => [],
        authTokenGetter: () => AUTH_TOKEN,
      },
      { enabled: false },
    );
    dispose = result.dispose;
    const after = server.listenerCount('upgrade');
    expect(after).toBe(before);
  });

  it('returns 500 if upgrade arrives without an auth token configured (fail-closed)', async () => {
    const result = attachMediaStreamServer(server, {
      store: new VoiceSessionStore({ startInterval: false }),
      streamingProvider: makeStreamingProvider(),
      speechTurn: async () => [],
      authTokenGetter: () => undefined,
      publicBaseUrl: `http://127.0.0.1:${port}`,
    });
    dispose = result.dispose;

    const res = await sendUpgrade(port, MEDIA_STREAM_PATH, 'any-sig', `127.0.0.1:${port}`);
    expect(res.statusCode === 500 || res.closed).toBe(true);
  });

  // VQ2-007 — auth-test-mode flag for Layer 2 voice-quality tests.
  describe('VQ2-007 authTestMode bypass', () => {
    it('VQ2-007 — authTestMode: false (default) → unsigned upgrade is rejected', async () => {
      const result = attachMediaStreamServer(server, {
        store: new VoiceSessionStore({ startInterval: false }),
        streamingProvider: makeStreamingProvider(),
        speechTurn: async () => [],
        authTokenGetter: () => AUTH_TOKEN,
        publicBaseUrl: `http://127.0.0.1:${port}`,
        // authTestMode intentionally omitted — should default to false.
      });
      dispose = result.dispose;

      const res = await sendUpgrade(port, MEDIA_STREAM_PATH, undefined, `127.0.0.1:${port}`);
      // With auth on and no signature, signature validation rejects the upgrade.
      expect(res.statusCode === 403 || res.closed).toBe(true);
      expect(res.statusCode).not.toBe(101);
    });

    it('VQ2-007 — authTestMode: true → unsigned upgrade is accepted (101 Switching Protocols)', async () => {
      const result = attachMediaStreamServer(server, {
        store: new VoiceSessionStore({ startInterval: false }),
        streamingProvider: makeStreamingProvider(),
        speechTurn: async () => [],
        authTokenGetter: () => AUTH_TOKEN,
        publicBaseUrl: `http://127.0.0.1:${port}`,
        authTestMode: true,
      });
      dispose = result.dispose;

      const res = await sendUpgrade(port, MEDIA_STREAM_PATH, undefined, `127.0.0.1:${port}`);
      expect(res.statusCode).toBe(101);
    });

    it('P4 — rejects the upgrade with 503 while the replica is draining', async () => {
      const result = attachMediaStreamServer(server, {
        store: new VoiceSessionStore({ startInterval: false }),
        streamingProvider: makeStreamingProvider(),
        speechTurn: async () => [],
        authTokenGetter: () => AUTH_TOKEN,
        publicBaseUrl: `http://127.0.0.1:${port}`,
        authTestMode: true, // would otherwise accept (101); the drain gate runs first
      });
      dispose = result.dispose;

      setDraining(true);
      try {
        const res = await sendUpgrade(port, MEDIA_STREAM_PATH, undefined, `127.0.0.1:${port}`);
        expect(res.statusCode === 503 || res.closed).toBe(true);
        expect(res.statusCode).not.toBe(101);
      } finally {
        setDraining(false);
      }
    });

    it('VQ2-007 — authTestMode: true → properly-signed upgrade still works (permissive override)', async () => {
      const result = attachMediaStreamServer(server, {
        store: new VoiceSessionStore({ startInterval: false }),
        streamingProvider: makeStreamingProvider(),
        speechTurn: async () => [],
        authTokenGetter: () => AUTH_TOKEN,
        publicBaseUrl: `http://127.0.0.1:${port}`,
        authTestMode: true,
      });
      dispose = result.dispose;

      const url = `http://127.0.0.1:${port}${MEDIA_STREAM_PATH}`;
      const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, {});
      const res = await sendUpgrade(port, MEDIA_STREAM_PATH, sig, `127.0.0.1:${port}`);
      expect(res.statusCode).toBe(101);
    });

    it('VQ2-007 — production wiring in app.ts must NOT set authTestMode: true', async () => {
      // Lint-via-test: the production server construction in app.ts must
      // never opt into authTestMode. This test fails the suite if a
      // future commit accidentally introduces the literal pattern.
      const fs = await import('fs');
      const path = await import('path');
      const appPath = path.resolve(__dirname, '../../../src/app.ts');
      const src = fs.readFileSync(appPath, 'utf8');
      // Match `authTestMode: true` with optional whitespace, in any quote/comma context.
      expect(/authTestMode\s*:\s*true/.test(src)).toBe(false);
    });
  });
});
