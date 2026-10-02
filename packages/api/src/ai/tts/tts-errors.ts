/**
 * #1536 — safe classification of TTS provider rejections.
 *
 * Provider error payloads can echo request details (and, in principle,
 * credentials), so nothing from them is logged or thrown verbatim. Only a
 * short snake_case code token (e.g. `missing_permissions`,
 * `invalid_api_key`) survives; anything else collapses to `unknown`.
 */

const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** Codes meaning the configured credential cannot synthesize speech. */
const AUTH_CODES = new Set([
  'missing_permissions',
  'invalid_api_key',
  'unauthorized',
  'needs_authorization',
]);

export function safeErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : undefined;
}

/**
 * Extracts the safe code from an ElevenLabs error, whichever shape it takes:
 * a WS frame `{ error: 'missing_permissions', message, code: 1008 }`, a WS
 * frame whose `error` is an object, or a REST body
 * `{ detail: { status: 'missing_permissions', message } }`.
 */
export function classifyElevenLabsError(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return safeErrorCode(payload) ?? 'unknown';
  const p = payload as Record<string, unknown>;
  const candidates: unknown[] = [];
  for (const key of ['error', 'detail']) {
    const v = p[key];
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      candidates.push(o.status, o.type, o.code);
    } else {
      candidates.push(v);
    }
  }
  candidates.push(p.status, p.type);
  for (const c of candidates) {
    const code = safeErrorCode(c);
    if (code) return code;
  }
  return 'unknown';
}

/** A provider refused a TTS request; `code` is the safe classification. */
export class TtsProviderRejectedError extends Error {
  constructor(
    readonly provider: 'elevenlabs' | 'openai',
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TtsProviderRejectedError';
  }
}

/** True when the code means the configured credential cannot synthesize. */
export function isTtsAuthCode(code: string | undefined): boolean {
  return !!code && AUTH_CODES.has(code);
}
