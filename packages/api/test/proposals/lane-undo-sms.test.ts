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
import { sendLaneUndoSms, buildLaneUndoChannel } from '../../src/proposals/lane-undo-sms';
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
        canDeliver: () => true,
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

describe('buildLaneUndoChannel', () => {
  const sendSms = async () => {};
  const base = {
    nodeEnv: 'prod' as const,
    apiBaseUrl: 'https://api.rivet.example',
    smsConfigured: true,
    sendSms,
    secret: 'one-tap-secret',
  };

  // Value: protects=the owner UNDO channel is wired only when its SMS can really go out and its link reaches this API;
  //   fails_when=production wires the channel with no SMS provider, an http/localhost link base or no secret;
  //   why_new=a channel that cannot deliver let the lane auto-approve with no UNDO; seam=none;
  //   no_claim=the deploy's actual env values
  it('wires the channel in production only with a configured SMS sender, a secret and a public https link base', () => {
    const channel = buildLaneUndoChannel(base);
    expect(channel?.buildUndoUrl('t.k')).toBe('https://api.rivet.example/public/proposals/one-tap-undo?token=t.k');

    expect(buildLaneUndoChannel({ ...base, smsConfigured: false })).toBeUndefined();
    expect(buildLaneUndoChannel({ ...base, apiBaseUrl: 'http://api.rivet.example' })).toBeUndefined();
    expect(buildLaneUndoChannel({ ...base, apiBaseUrl: 'https://localhost:3000' })).toBeUndefined();
    expect(buildLaneUndoChannel({ ...base, secret: undefined })).toBeUndefined();
    expect(buildLaneUndoChannel({ ...base, sendSms: undefined })).toBeUndefined();
  });

  // Value: protects=the lane stops auto-approving while the outbound SMS kill switch silences every owner UNDO text;
  //   fails_when=the channel reports deliverable with TELEPHONY_ENABLED=false, or reads the switch only at boot;
  //   why_new=red-team pass 3: the kill switch suppressed UNDO sends while lanes kept auto-approving; seam=none;
  //   no_claim=the switch's own suppression (gated-message-delivery tests)
  it('canDeliver follows the outbound SMS kill switch at call time, not at boot', () => {
    let enabled = true;
    const channel = buildLaneUndoChannel({ ...base, outboundSmsEnabled: () => enabled });
    expect(channel?.canDeliver()).toBe(true);
    enabled = false;
    expect(channel?.canDeliver()).toBe(false);
  });

  it('defaults to the TELEPHONY_ENABLED kill switch', () => {
    const channel = buildLaneUndoChannel(base);
    const prior = process.env.TELEPHONY_ENABLED;
    try {
      process.env.TELEPHONY_ENABLED = 'false';
      expect(channel?.canDeliver()).toBe(false);
      delete process.env.TELEPHONY_ENABLED;
      expect(channel?.canDeliver()).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.TELEPHONY_ENABLED;
      else process.env.TELEPHONY_ENABLED = prior;
    }
  });

  it('dev keeps the in-memory sender and a localhost link', () => {
    expect(
      buildLaneUndoChannel({ ...base, nodeEnv: 'dev', smsConfigured: false, apiBaseUrl: 'http://localhost:3000' }),
    ).toBeDefined();
  });
});
