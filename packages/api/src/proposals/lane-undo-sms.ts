/**
 * UB-D / D-015 — the owner one-tap UNDO SMS for a lane-approved booking.
 *
 * Shared by the voice-memo router and the live-call processor so both
 * surfaces send the same text with the same signed, single-use link
 * (proposals/one-tap-undo.ts). `summary` is the caller's owner-facing line:
 * the router passes the proposal's "{work} — {time}" summary, the live call
 * "{customer on record} — {held time}". No reply anchor is recorded: the
 * UNDO is the link, not a Y/N reply.
 */
import { createOneTapUndoToken } from './one-tap-undo';
import { isOutboundChannelEnabled } from '../notifications/gated-message-delivery';
import type { AppConfig } from '../shared/config';

/** Everything needed to mint and send the UNDO link. */
export interface LaneUndoChannel {
  sendSms: (to: string, body: string) => Promise<void>;
  /** The one-tap HMAC secret the undo route verifies with. */
  secret: string;
  buildUndoUrl: (token: string) => string;
  /**
   * Whether an UNDO text can go out right now. Checked per booking: the
   * outbound SMS kill switch (TELEPHONY_ENABLED=false) suppresses owner
   * sends at runtime while inbound voice stays live.
   */
  canDeliver: () => boolean;
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
 * auto-approving bookings nobody can undo; so does `canDeliver()` returning
 * false while the outbound SMS kill switch is off.
 */
export function buildLaneUndoChannel(opts: {
  nodeEnv: AppConfig['NODE_ENV'];
  /** The API origin the undo link points at (PUBLIC_API_URL). */
  apiBaseUrl: string;
  /** The delivery provider can really send SMS (not in-memory, has a from-number). */
  smsConfigured: boolean;
  sendSms: ((to: string, body: string) => Promise<void>) | undefined;
  secret: string | undefined;
  /** Runtime outbound-SMS switch; defaults to the TELEPHONY_ENABLED kill switch. */
  outboundSmsEnabled?: () => boolean;
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
    canDeliver: opts.outboundSmsEnabled ?? (() => isOutboundChannelEnabled('sms')),
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
