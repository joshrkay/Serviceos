/**
 * D-015 — the owner one-tap UNDO SMS for a lane-approved booking, shared by
 * the voice-memo router and the live-call processor.
 *
 * Value: protects=the UNDO text goes to the given owner cell and carries a link whose token verifies for exactly that proposal and tenant;
 *   fails_when=the sender texts another number, mints the token for the wrong proposal or tenant, or drops the link;
 *   why_new=the helper is extracted from the router so the live path can reuse it; seam=none;
 *   no_claim=SMS delivery (mocked sender)
 */
import { describe, it, expect, vi } from 'vitest';
import { sendLaneUndoSms } from '../../src/proposals/lane-undo-sms';
import { verifyOneTapUndoToken } from '../../src/proposals/one-tap-undo';

const SECRET = 'lane-undo-test-secret';

describe('sendLaneUndoSms', () => {
  it('texts the owner cell "Rivet booked: … Tap to UNDO: <link>" with a token for this proposal and tenant', async () => {
    const sendSms = vi.fn(async (_to: string, _body: string) => {});

    await sendLaneUndoSms(
      {
        sendSms,
        secret: SECRET,
        buildUndoUrl: (token) => `https://api.example.com/undo?token=${token}`,
      },
      {
        proposalId: 'prop-1',
        tenantId: 'tenant-1',
        summary: 'Furnace repair — Tue 2:00 PM',
        ownerPhone: '+15125550888',
      },
    );

    expect(sendSms).toHaveBeenCalledTimes(1);
    const [to, body] = sendSms.mock.calls[0]!;
    expect(to).toBe('+15125550888');
    expect(body.startsWith('Rivet booked: Furnace repair — Tue 2:00 PM. Tap to UNDO: https://api.example.com/undo?token=')).toBe(true);

    const token = body.slice(body.indexOf('token=') + 'token='.length);
    const verified = await verifyOneTapUndoToken({
      token,
      secret: SECRET,
      expectedTenantId: 'tenant-1',
      consumeNonce: () => true,
    });
    expect(verified).toMatchObject({ ok: true, proposalId: 'prop-1', tenantId: 'tenant-1' });
  });
});
