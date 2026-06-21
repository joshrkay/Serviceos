/**
 * Story 3.2 — short-lived Deepgram streaming token minting.
 *
 * The browser dictation client streams mic audio straight to Deepgram over a
 * WebSocket, so it needs Deepgram credentials — but it must NEVER hold the
 * long-lived DEEPGRAM_API_KEY. Instead the server exchanges the long-lived key
 * for a 30-second grant token (Deepgram's /v1/auth/grant) that the browser uses
 * once and that expires almost immediately. The long-lived key never leaves the
 * server.
 *
 * Pure + dependency-injected (apiKey + fetchImpl) so it is fully unit-testable
 * without network or env.
 */

const DEEPGRAM_GRANT_URL = 'https://api.deepgram.com/v1/auth/grant';

/** The AC's cap: a browser token lives at most 30 seconds. */
export const STREAM_TOKEN_TTL_SECONDS = 30;

/** The streaming model the browser must connect with. */
export const STREAM_TOKEN_MODEL = 'nova-3';

/** Thrown when no DEEPGRAM_API_KEY is configured — callers map this to 503. */
export class DeepgramTokenUnavailableError extends Error {
  constructor(message = 'DEEPGRAM_API_KEY is not configured') {
    super(message);
    this.name = 'DeepgramTokenUnavailableError';
  }
}

/** Thrown when Deepgram refuses or malforms the grant — callers map to 502. */
export class DeepgramTokenMintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeepgramTokenMintError';
  }
}

export interface MintDeepgramTokenDeps {
  apiKey?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Requested TTL; clamped to [1, STREAM_TOKEN_TTL_SECONDS]. */
  ttlSeconds?: number;
}

export interface DeepgramStreamToken {
  token: string;
  expiresInSeconds: number;
  model: string;
}

export async function mintDeepgramStreamToken(
  deps: MintDeepgramTokenDeps,
): Promise<DeepgramStreamToken> {
  const apiKey = deps.apiKey;
  if (!apiKey) {
    throw new DeepgramTokenUnavailableError();
  }

  // Clamp: never mint a browser token that outlives the 30s ceiling.
  const requested = deps.ttlSeconds ?? STREAM_TOKEN_TTL_SECONDS;
  const ttl = Math.min(Math.max(Math.floor(requested), 1), STREAM_TOKEN_TTL_SECONDS);

  const doFetch = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(DEEPGRAM_GRANT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl_seconds: ttl }),
    });
  } catch (err) {
    throw new DeepgramTokenMintError(
      `Deepgram grant request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    throw new DeepgramTokenMintError(`Deepgram grant returned ${res.status}`);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new DeepgramTokenMintError('Deepgram grant response missing access_token');
  }

  return {
    token: data.access_token,
    // Trust the server's clamp over whatever Deepgram echoes back.
    expiresInSeconds: Math.min(data.expires_in ?? ttl, STREAM_TOKEN_TTL_SECONDS),
    model: STREAM_TOKEN_MODEL,
  };
}
