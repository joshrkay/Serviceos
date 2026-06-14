/**
 * Secure download of inbound MMS media from Twilio.
 *
 * The media URL arrives in a webhook request body. Even though the
 * webhook signature is verified upstream (only Twilio can trigger this),
 * we treat the URL as untrusted and defend in depth against SSRF: we
 * fetch ONLY from Twilio's media hosts, never an arbitrary URL. We also
 * cap the size and require an image content-type, so a hostile or
 * malformed payload can't exhaust memory or smuggle a non-image file
 * through the photo path.
 */
import { createLogger } from '../../logging/logger';

const logger = createLogger({
  service: 'twilio-media',
  environment: process.env.NODE_ENV || 'dev',
});

/** Twilio media is served from these hosts (api + regional MCS + CDN). */
const ALLOWED_MEDIA_HOST_SUFFIXES = [
  '.twilio.com',
  '.twiliocdn.com',
] as const;

/** Image content-types we accept for a job photo. */
export const ALLOWED_MMS_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

/** Hard cap on a single inbound media download (Twilio MMS ≤ ~5MB; allow headroom). */
export const MAX_MMS_MEDIA_BYTES = 16 * 1024 * 1024;

export function isAllowedTwilioMediaUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_MEDIA_HOST_SUFFIXES.some(
    (suffix) => host === suffix.slice(1) || host.endsWith(suffix),
  );
}

export function isAllowedImageType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const base = contentType.split(';')[0].trim().toLowerCase();
  return (ALLOWED_MMS_IMAGE_TYPES as readonly string[]).includes(base);
}

export interface DownloadedMedia {
  buffer: Buffer;
  contentType: string;
}

export type DownloadMediaResult =
  | { ok: true; media: DownloadedMedia }
  | { ok: false; reason: 'untrusted_url' | 'not_image' | 'too_large' | 'fetch_failed' };

export interface DownloadTwilioMediaDeps {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  maxBytes?: number;
}

/**
 * Download one Twilio media URL with the tenant's account credentials.
 * Returns a structured result rather than throwing so the caller can
 * skip a bad attachment without failing the whole inbound message.
 */
export async function downloadTwilioMedia(
  mediaUrl: string,
  accountSid: string,
  authToken: string,
  declaredContentType: string | undefined,
  deps: DownloadTwilioMediaDeps = {},
): Promise<DownloadMediaResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const maxBytes = deps.maxBytes ?? MAX_MMS_MEDIA_BYTES;

  if (!isAllowedTwilioMediaUrl(mediaUrl)) {
    logger.warn('twilio-media: refusing non-Twilio media URL', { mediaUrl });
    return { ok: false, reason: 'untrusted_url' };
  }
  // Reject by the declared type before spending a download when we can.
  if (declaredContentType && !isAllowedImageType(declaredContentType)) {
    return { ok: false, reason: 'not_image' };
  }

  try {
    const res = await doFetch(mediaUrl, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      },
    });
    if (!res.ok) {
      logger.warn('twilio-media: media fetch failed', { status: res.status });
      return { ok: false, reason: 'fetch_failed' };
    }

    const contentType = res.headers.get('content-type') ?? declaredContentType ?? '';
    if (!isAllowedImageType(contentType)) {
      return { ok: false, reason: 'not_image' };
    }
    // Cap before buffering when the server is honest about length…
    const lenHeader = res.headers.get('content-length');
    if (lenHeader && Number(lenHeader) > maxBytes) {
      return { ok: false, reason: 'too_large' };
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    // …and re-check after, in case Content-Length was absent or lied.
    if (buffer.length > maxBytes) {
      return { ok: false, reason: 'too_large' };
    }

    return { ok: true, media: { buffer, contentType: contentType.split(';')[0].trim().toLowerCase() } };
  } catch (err) {
    logger.warn('twilio-media: media download threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: 'fetch_failed' };
  }
}

/** First-N media descriptors parsed from a Twilio inbound-MMS body. */
export interface InboundMediaItem {
  url: string;
  contentType?: string;
}

/**
 * Pull the MediaUrl{N} / MediaContentType{N} pairs out of a Twilio
 * inbound webhook body. Returns [] for a plain SMS (NumMedia 0/absent).
 */
export function parseInboundMedia(body: Record<string, unknown>): InboundMediaItem[] {
  const num = Number(body.NumMedia ?? 0);
  if (!Number.isFinite(num) || num <= 0) return [];
  const items: InboundMediaItem[] = [];
  for (let i = 0; i < num; i++) {
    const url = body[`MediaUrl${i}`];
    if (typeof url !== 'string' || url.length === 0) continue;
    const ct = body[`MediaContentType${i}`];
    items.push({ url, ...(typeof ct === 'string' ? { contentType: ct } : {}) });
  }
  return items;
}
