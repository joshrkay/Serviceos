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
