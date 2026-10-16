/**
 * UB-D / D-015 — the owner one-tap UNDO SMS for a lane-approved booking.
 *
 * Shared by the voice-memo router and the live-call processor so both
 * surfaces send the same text with the same signed, single-use link
 * (proposals/one-tap-undo.ts). The summary is the proposal's
 * "{work} — {time}" line. No reply anchor is recorded: the UNDO is the link,
 * not a Y/N reply.
 */
import { createOneTapUndoToken } from './one-tap-undo';

/** Everything needed to mint and send the UNDO link. */
export interface LaneUndoChannel {
  sendSms: (to: string, body: string) => Promise<void>;
  /** The one-tap HMAC secret the undo route verifies with. */
  secret: string;
  buildUndoUrl: (token: string) => string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isPublicHttpsOrigin(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !LOCAL_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * The owner UNDO is a safety channel, so it is wired only when it can
 * deliver: a sender and the one-tap secret, and in production / staging also
 * a configured SMS provider and an https, non-localhost link base. Undefined
 * means the D-015 lane reports `undo_channel_unavailable` instead of
 * auto-approving bookings nobody can undo.
 */
export function buildLaneUndoChannel(opts: {
  nodeEnv: string;
  /** The API origin the undo link points at (PUBLIC_API_URL). */
  apiBaseUrl: string;
  /** The delivery provider can really send SMS (not in-memory, has a from-number). */
  smsConfigured: boolean;
  sendSms: ((to: string, body: string) => Promise<void>) | undefined;
  secret: string | undefined;
}): LaneUndoChannel | undefined {
  const { sendSms, secret } = opts;
  if (!sendSms || !secret) return undefined;
  const productionLike = opts.nodeEnv === 'prod' || opts.nodeEnv === 'staging';
  if (productionLike && (!opts.smsConfigured || !isPublicHttpsOrigin(opts.apiBaseUrl))) {
    return undefined;
  }
  const base = opts.apiBaseUrl.replace(/\/+$/, '');
  return {
    sendSms,
    secret,
    buildUndoUrl: (token) =>
      `${base}/public/proposals/one-tap-undo?token=${encodeURIComponent(token)}`,
  };
}

export async function sendLaneUndoSms(
  channel: LaneUndoChannel,
  booking: { proposalId: string; tenantId: string; summary: string; ownerPhone: string },
): Promise<void> {
  const { token } = createOneTapUndoToken({
    proposalId: booking.proposalId,
    tenantId: booking.tenantId,
    secret: channel.secret,
  });
  await channel.sendSms(
    booking.ownerPhone,
    `Rivet booked: ${booking.summary}. Tap to UNDO: ${channel.buildUndoUrl(token)}`,
  );
}
