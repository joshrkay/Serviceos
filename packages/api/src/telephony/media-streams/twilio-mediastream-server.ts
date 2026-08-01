/**
 * Twilio Media Streams WebSocket server.
 *
 * Mounts a `ws.WebSocketServer` (in `noServer` mode) and attaches an
 * HTTP `upgrade` handler that:
 *   1. Filters by URL path — only /api/telephony/stream upgrades are accepted.
 *   2. Verifies the Twilio signature on the upgrade request — reuses the
 *      same HMAC-SHA1 algorithm as the existing webhook routes via
 *      `twilio.validateRequest` (with empty params, since Twilio signs
 *      the URL only on WS upgrades).
 *   3. Constructs a per-connection `TwilioMediaStreamAdapter` and starts it.
 *
 * The server is created from app.ts after `app.listen(...)` returns the
 * `http.Server`. Gated by `TWILIO_MEDIA_STREAMS_ENABLED` — when off, the
 * upgrade handler is never attached and Twilio receives the existing
 * Gather TwiML from the /voice route.
 */

import type { IncomingMessage } from 'http';
import { isDraining } from '../../ws/drain-state';
import type { Server as HttpServer } from 'http';
import type { Socket } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import twilio from 'twilio';
import { createLogger } from '../../logging/logger';
import { instrument } from '../../monitoring/instrumentation';
import {
  TwilioMediaStreamAdapter,
  type MediaStreamAdapterDeps,
  type WsLike,
} from './mediastream-adapter';

const logger = createLogger({
  service: 'telephony.media-streams.server',
  environment: process.env.NODE_ENV || 'development',
});

/** Path Twilio's `<Stream>` directive must dial into. */
export const MEDIA_STREAM_PATH = '/api/telephony/stream';

export interface MediaStreamServerDeps extends MediaStreamAdapterDeps {
  /**
   * Lazily-resolved Twilio auth token. Reads at upgrade time so the
   * server can be constructed before the env var is set (matches the
   * pattern used by `requireTwilioSignature`).
   *
   * Note: WS upgrades don't carry AccountSid in the request — that
   * arrives in the first `start` message after the upgrade succeeds.
   * Implementations that want per-tenant tokens for media streams
   * either use a global token here OR shift signature verification
   * to the first message handler (out of scope for now).
   */
  authTokenGetter: (opts: { accountSid?: string }) => Promise<string | undefined> | string | undefined;
  /**
   * Public base URL we expect Twilio to have signed against
   * (e.g. wss://api.example.com or https://api.example.com — both are
   * accepted; the signature algorithm doesn't care about the scheme
   * difference, it cares about the canonical URL string the operator
   * configured in TwiML).
   *
   * Optional. When unset, falls back to req.headers.host with the
   * scheme inferred from x-forwarded-proto (or http).
   */
  publicBaseUrl?: string;
  /**
   * @internal Test-only escape hatch (VQ2-007). When `true`, the server
   * accepts unsigned WebSocket upgrade requests — Twilio signature header
   * validation is skipped entirely. Must NEVER be set in production code
   * paths; it is read by Layer 2 voice-quality tests
   * (`voice-quality.layer2.test.ts`) only. Defaults to `false`.
   *
   * The flag is deliberately NOT pulled from any env var: callers must opt
   * in explicitly via this deps object so a misconfigured environment
   * (a stray `AUTH_TEST_MODE=true`) cannot accidentally disable auth in
   * production. Production wiring in `app.ts` does not pass this field; a
   * unit test (VQ2-007) lints the source to enforce that.
   */
  authTestMode?: boolean;
}

export interface AttachOptions {
  /**
   * When false, the upgrade handler is not attached. This is the
   * feature-flag off path — caller controls the boolean. Default true
   * so callers can omit it once they've already gated the construction.
   */
  enabled?: boolean;
}

/**
 * Attach the Media Streams WebSocketServer to an http.Server. Returns
 * a `dispose()` to cleanly close all open WS connections at shutdown.
 */
export function attachMediaStreamServer(
  httpServer: HttpServer,
  deps: MediaStreamServerDeps,
  opts: AttachOptions = {},
): { dispose: () => void } {
  const enabled = opts.enabled ?? true;
  if (!enabled) {
    logger.info('mediastream server NOT attached (flag disabled)');
    return { dispose: () => {} };
  }

  const wss = new WebSocketServer({ noServer: true });

  // §11 H3: Wrap the upgrade handler with instrument() so any unexpected
  // throw during signature verification or adapter construction is tagged
  // `path=voice` (plus correlation_id when Twilio supplied the call SID
  // header) and captured to Sentry before the error rethrows. Expected
  // rejections (bad signature, missing token) already exit via
  // rejectUpgrade() without throwing, so they don't reach Sentry — only
  // structural failures do.
  const upgradeHandlerInner = async (req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> => {
    // 1. Path filter — leave other upgrade paths (if any) untouched.
    const url = req.url ?? '';
    const pathOnly = url.split('?')[0];
    if (pathOnly !== MEDIA_STREAM_PATH) {
      // We don't own this path; do not destroy the socket — another
      // listener may handle it. Express has no upgrade handler by
      // default, but a future feature might.
      return;
    }

    // On 'upgrade' Node hands over a raw net.Socket and stops managing its
    // errors. Twilio resetting the connection during the async token /
    // signature window below would emit 'error' with no listener →
    // uncaughtException → process exit (killing every live call). Swallow
    // it; rejectUpgrade/handleUpgrade handle the dead socket from here.
    socket.on('error', () => {});

    // P4/U-P4a: reject new media streams while draining so Twilio establishes the
    // call's stream on a live replica (this one is finishing its active calls).
    if (isDraining()) {
      rejectUpgrade(socket, 503);
      return;
    }

    // 2. Signature verification. Twilio signs the WS upgrade URL the
    //    same way it signs HTTP webhooks — auth_token + URL + (no
    //    params for upgrades) → HMAC-SHA1 → base64. Reject 403 on miss.
    if (deps.authTestMode === true) {
      // VQ2-007: Test-only escape hatch. Skip signature validation
      // entirely so Layer 2 voice-quality tests can drive unsigned
      // upgrades against an in-process server. Documented on the deps
      // interface; production wiring never sets this flag.
      logger.warn('mediastream upgrade: authTestMode=true → signature validation BYPASSED');
    } else {
      const authToken = await Promise.resolve(deps.authTokenGetter({}));
      if (!authToken) {
        logger.error('mediastream upgrade rejected: no auth token configured');
        rejectUpgrade(socket, 500);
        return;
      }
      const signature = (req.headers['x-twilio-signature'] as string | undefined) ?? '';
      const fullUrl = reconstructUpgradeUrl(req, deps.publicBaseUrl);
      let signatureOk = false;
      try {
        signatureOk = twilio.validateRequest(authToken, signature, fullUrl, {});
      } catch {
        signatureOk = false;
      }
      if (!signatureOk) {
        logger.warn('mediastream upgrade rejected: invalid Twilio signature', { fullUrl });
        rejectUpgrade(socket, 403);
        return;
      }
    }

    // 3. Hand off to ws — at this point we trust the upgrade.
    wss.handleUpgrade(req, socket, head, (ws) => {
      try {
        const adapter = new TwilioMediaStreamAdapter(deps, ws as unknown as WsLike);
        adapter.start();
      } catch (err) {
        logger.error('mediastream adapter init failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          ws.close(1011, 'init_failed');
        } catch {
          /* swallow */
        }
      }
    });
  };

  const upgradeHandler = instrument(upgradeHandlerInner, {
    path: 'voice',
    extractTags: (req) => ({
      correlation_id: (req.headers['x-twilio-call-sid'] as string | undefined) ?? undefined,
    }),
  });

  httpServer.on('upgrade', upgradeHandler);
  logger.info('mediastream server attached', { path: MEDIA_STREAM_PATH });

  return {
    dispose: () => {
      httpServer.off('upgrade', upgradeHandler);
      for (const client of wss.clients) {
        try {
          (client as WebSocket).close(1001, 'server_shutdown');
        } catch {
          /* swallow */
        }
      }
      wss.close();
    },
  };
}

/**
 * Reconstruct the URL Twilio signed against. Mirrors the approach in
 * `twilio-signature.ts` but for raw http.IncomingMessage instead of
 * Express req. WS doesn't carry req.protocol, so we derive scheme
 * from `x-forwarded-proto` if present (Twilio uses wss in TwiML; the
 * reverse proxy decrypts to http upstream — Twilio's signature is
 * computed against the public-facing scheme, so we honor it via the
 * publicBaseUrl override or x-forwarded-proto).
 */
function reconstructUpgradeUrl(req: IncomingMessage, publicBaseUrl?: string): string {
  const url = req.url ?? '';
  if (publicBaseUrl) {
    const trimmed = publicBaseUrl.replace(/\/+$/, '');
    return `${trimmed}${url}`;
  }
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'wss';
  const host = (req.headers.host as string | undefined) ?? '';
  // Twilio's TwiML uses wss://; signatures are computed against that.
  // If a future deployment configures https:// the publicBaseUrl
  // override is the documented escape hatch.
  const scheme = proto.startsWith('ws') ? proto : `ws${proto.endsWith('s') ? 's' : ''}`;
  return `${scheme}://${host}${url}`;
}

function rejectUpgrade(socket: Socket, code: 401 | 403 | 500 | 503): void {
  const reason =
    code === 401
      ? 'Unauthorized'
      : code === 403
        ? 'Forbidden'
        : code === 503
          ? 'Service Unavailable'
          : 'Internal Server Error';
  socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
  try {
    socket.destroy();
  } catch {
    /* swallow */
  }
}
