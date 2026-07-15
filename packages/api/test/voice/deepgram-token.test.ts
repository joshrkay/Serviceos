import { describe, it, expect, vi } from 'vitest';
import {
  mintDeepgramStreamToken,
  DeepgramTokenUnavailableError,
  DeepgramTokenMintError,
  DeepgramTokenPermissionError,
  STREAM_TOKEN_TTL_SECONDS,
  STREAM_TOKEN_MODEL,
} from '../../src/voice/deepgram-token';

function okFetch(body: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('Story 3.2 — mintDeepgramStreamToken', () => {
  it('throws (→503) when no API key is configured', async () => {
    await expect(mintDeepgramStreamToken({ apiKey: undefined })).rejects.toBeInstanceOf(
      DeepgramTokenUnavailableError,
    );
  });

  it('mints a short-lived token from a configured key', async () => {
    const fetchImpl = okFetch({ access_token: 'dg-temp-abc', expires_in: 30 });
    const result = await mintDeepgramStreamToken({ apiKey: 'long-lived-key', fetchImpl });
    expect(result.token).toBe('dg-temp-abc');
    expect(result.expiresInSeconds).toBe(30);
    expect(result.model).toBe(STREAM_TOKEN_MODEL);
  });

  it('never leaks the long-lived key to the response and sends it only as the Authorization header', async () => {
    const fetchImpl = okFetch({ access_token: 'dg-temp-abc', expires_in: 30 });
    const result = await mintDeepgramStreamToken({ apiKey: 'SECRET-KEY', fetchImpl });
    expect(JSON.stringify(result)).not.toContain('SECRET-KEY');
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Token SECRET-KEY' });
    expect((init as RequestInit).body).toContain('ttl_seconds');
  });

  it('clamps the requested TTL to the 30s ceiling', async () => {
    const fetchImpl = okFetch({ access_token: 't', expires_in: 3600 });
    const result = await mintDeepgramStreamToken({ apiKey: 'k', fetchImpl, ttlSeconds: 3600 });
    // Even if Deepgram echoes a larger expiry, we never report beyond the cap.
    expect(result.expiresInSeconds).toBeLessThanOrEqual(STREAM_TOKEN_TTL_SECONDS);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).body).toContain(`"ttl_seconds":${STREAM_TOKEN_TTL_SECONDS}`);
  });

  it('throws DeepgramTokenMintError on a non-200 grant response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(
      mintDeepgramStreamToken({ apiKey: 'k', fetchImpl }),
    ).rejects.toBeInstanceOf(DeepgramTokenMintError);
  });

  it('throws DeepgramTokenPermissionError on a 403 grant (usage-scoped key)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ err_code: 'FORBIDDEN', err_msg: 'Insufficient permissions.' }),
    })) as unknown as typeof fetch;
    await expect(
      mintDeepgramStreamToken({ apiKey: 'k', fetchImpl }),
    ).rejects.toBeInstanceOf(DeepgramTokenPermissionError);
  });

  it('throws when the grant response is missing access_token', async () => {
    const fetchImpl = okFetch({ expires_in: 30 });
    await expect(
      mintDeepgramStreamToken({ apiKey: 'k', fetchImpl }),
    ).rejects.toBeInstanceOf(DeepgramTokenMintError);
  });

  it('wraps a network failure as a mint error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(
      mintDeepgramStreamToken({ apiKey: 'k', fetchImpl }),
    ).rejects.toBeInstanceOf(DeepgramTokenMintError);
  });
});
