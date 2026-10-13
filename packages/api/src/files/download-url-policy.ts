/**
 * H2 — which URLs the server may GET as "a stored file".
 *
 * Transcription jobs carry an audio URL that a worker fetches from inside the
 * API process. The only URLs it has any business fetching are the ones this
 * deployment's own storage provider mints (`generateDownloadUrl`), so the
 * policy is an allowlist of those download origins, built by
 * `createStorageProvider` from the same config it builds the provider from —
 * never from a request.
 */
import { isIP } from 'node:net';

export type DownloadUrlRejection =
  | 'unparseable'
  | 'userinfo'
  | 'scheme'
  | 'port'
  | 'ip_literal'
  | 'origin';

export interface DownloadUrlPolicy {
  /** Why `url` is not a download URL of the configured storage, or null when it is. */
  rejectionFor(url: string): DownloadUrlRejection | null;
}

/** The WHATWG-normalized origin of `url`, or null when it does not parse. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** True for IPv4 (any WHATWG-normalized spelling) and bracketed IPv6 hosts. */
function isIpLiteral(hostname: string): boolean {
  return isIP(hostname.replace(/^\[(.*)\]$/, '$1')) !== 0;
}

export function createDownloadUrlPolicy(input: {
  allowedOrigins: readonly string[];
  /**
   * prod/production/staging: on top of the origin allowlist, only https on
   * the default port to a DNS name — even if storage is misconfigured to an
   * http, IP-literal or odd-port endpoint. Outside production those are
   * allowed (localhost dev storage, a local MinIO) but the origin must still
   * be the configured one.
   */
  productionLike: boolean;
}): DownloadUrlPolicy {
  const allowed = new Set(
    input.allowedOrigins.map(originOf).filter((o): o is string => o !== null && o !== 'null'),
  );
  return {
    rejectionFor(url: string): DownloadUrlRejection | null {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return 'unparseable';
      }
      // `origin` drops userinfo, so check it explicitly: a URL carrying
      // credentials is never one the storage provider minted.
      if (parsed.username || parsed.password) return 'userinfo';
      if (parsed.protocol !== 'https:' && (input.productionLike || parsed.protocol !== 'http:')) {
        return 'scheme';
      }
      if (input.productionLike && parsed.port !== '') return 'port';
      if (input.productionLike && isIpLiteral(parsed.hostname)) return 'ip_literal';
      if (!allowed.has(parsed.origin)) return 'origin';
      return null;
    },
  };
}
