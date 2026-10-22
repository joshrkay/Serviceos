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

export type DownloadUrlRejection = 'unparseable' | 'userinfo' | 'origin';

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
   * prod/production/staging. An operator-configured origin is NEVER refused
   * (refusing what storage itself mints would silently fail every
   * transcription — H2 review M1); instead a configured origin that is not
   * https, or whose host is an IP literal, is reported once, here, at boot.
   */
  productionLike: boolean;
  logger?: Pick<Console, 'warn'>;
}): DownloadUrlPolicy {
  const allowed = new Set(
    input.allowedOrigins.map(originOf).filter((o): o is string => o !== null && o !== 'null'),
  );
  if (input.productionLike) {
    const insecure = [...allowed].filter((origin) => {
      const { protocol, hostname } = new URL(origin);
      return protocol !== 'https:' || isIpLiteral(hostname);
    });
    if (insecure.length > 0) {
      (input.logger ?? console).warn(
        '[storage] configured storage origin is not https on a DNS name; stored-file ' +
          'fetches (transcription audio) will still use it',
        { origins: insecure },
      );
    }
  }
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
      if (!allowed.has(parsed.origin)) return 'origin';
      return null;
    },
  };
}
