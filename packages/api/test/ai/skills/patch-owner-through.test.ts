import { describe, it, expect, vi } from 'vitest';
import {
  patchOwnerThrough,
  composePatchMissSms,
  PATCH_ANNOUNCE_LINE_OWNER,
  PATCH_ANNOUNCE_LINE_ONCALL,
  PATCH_DIAL_TIMEOUT_SECONDS,
} from '../../../src/ai/skills/patch-owner-through';
import { DefaultTwilioCallControl } from '../../../src/telephony/twilio-call-control';
import { InMemoryOnCallRepository } from '../../../src/oncall/rotation';
import { InMemoryCallMeBackRepository } from '../../../src/voice/call-me-back/call-me-back';
import { InMemoryAuditRepository } from '../../../src/audit/audit';

const INPUT = {
  tenantId: 't1',
  sessionId: 's1',
  callSid: 'CA-patch-1',
  dialActionUrl: 'https://api.example.com/api/telephony/dial-result?sid=s1',
  reason: 'vulnerability (score 2) with critical urgency',
  callerPhone: '+15125550111',
  shopName: 'Acme Plumbing',
  voicemailRecordingCallbackUrl: 'https://api.example.com/api/telephony/recording',
};

describe('RV-121 — patchOwnerThrough', () => {
  it('rung 1: bridges straight to the owner cell with the announce line first', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const result = await patchOwnerThrough(INPUT, {
      callControl: new DefaultTwilioCallControl(),
      ownerPhoneResolver: vi.fn(async () => '+15125550999'),
      auditRepo,
    });
    expect(result.kind).toBe('bridged');
    if (result.kind !== 'bridged') throw new Error('unreachable');
    expect(result.target).toBe('owner');
    expect(result.phone).toBe('+15125550999');
    // Announce <Say> precedes the <Dial> verb.
    // Apostrophes are XML-escaped in the <Say>; match an escape-free fragment.
    expect(PATCH_ANNOUNCE_LINE_OWNER).toContain('patch you straight through');
    const sayIdx = result.twiml.indexOf('patch you straight through');
    const dialIdx = result.twiml.indexOf('<Dial');
    expect(sayIdx).toBeGreaterThan(-1);
    expect(sayIdx).toBeLessThan(dialIdx);
    // Per-rung copy accuracy: the owner rung promises the owner, not "our team".
    expect(result.twiml).toContain('straight through to the owner');
    expect(result.twiml).not.toContain('our team');
    expect(result.twiml).toContain(`timeout="${PATCH_DIAL_TIMEOUT_SECONDS}"`);
    expect(result.twiml).toContain('+15125550999');
    expect(
      auditRepo.getAll().some(
        (e) =>
          e.eventType === 'vulnerability_patch.attempted' &&
          (e.metadata as { outcome?: string }).outcome === 'bridged_owner',
      ),
    ).toBe(true);
  });

  it('rung 2: no owner cell → first on-call dispatcher with a resolvable phone', async () => {
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([
        ['t1', [
          { id: 'e1', userId: 'user-no-phone', orderIndex: 0 },
          { id: 'e2', userId: 'user-with-phone', orderIndex: 1 },
        ]],
      ]),
    );
    const result = await patchOwnerThrough(INPUT, {
      callControl: new DefaultTwilioCallControl(),
      ownerPhoneResolver: vi.fn(async () => null),
      onCallRepo,
      dispatcherPhoneResolver: vi.fn(async (_t, userId) =>
        userId === 'user-with-phone' ? '+15125550555' : null,
      ),
    });
    expect(result.kind).toBe('bridged');
    if (result.kind !== 'bridged') throw new Error('unreachable');
    expect(result.target).toBe('oncall');
    expect(result.phone).toBe('+15125550555');
    // Per-rung copy accuracy: bridging on-call must say "our team" — it
    // must NOT promise "the owner" (announce-line accuracy, audit item 6).
    expect(PATCH_ANNOUNCE_LINE_ONCALL).toContain('our team');
    expect(result.twiml).toContain('straight through to our team');
    expect(result.twiml).not.toContain('to the owner');
  });

  it('rung 3: nothing reachable → voicemail TwiML + urgent SMS + call_me_back task', async () => {
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([['t1', [{ id: 'e1', userId: 'pager-only', orderIndex: 0 }]]]),
    );
    const callMeBackRepo = new InMemoryCallMeBackRepository();
    const sendSms = vi.fn(async () => ({}));
    const result = await patchOwnerThrough(INPUT, {
      callControl: new DefaultTwilioCallControl(),
      ownerPhoneResolver: vi.fn(async () => null),
      onCallRepo,
      // Phone resolves for the SMS page but rung 2 must not have used it…
      dispatcherPhoneResolver: vi.fn(async () => null),
      sendSms,
      callMeBackRepo,
    });
    expect(result.kind).toBe('fallback');
    if (result.kind !== 'fallback') throw new Error('unreachable');
    expect(result.voicemailTwiml).toContain('<Record');
    expect(result.voicemailTwiml).toContain('Acme Plumbing');
    // No resolvable page phone → smsSent false, but the durable task lands.
    expect(result.smsSent).toBe(false);
    const pending = await callMeBackRepo.listPending('t1');
    expect(pending).toHaveLength(1);
    expect(pending[0].reason).toBe('vulnerability_patch');
    expect(pending[0].callerPhone).toBe('+15125550111');
    expect(result.callMeBackTaskId).toBe(pending[0].id);
  });

  it('rung 3 pages the first resolvable rotation phone when one exists', async () => {
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([['t1', [{ id: 'e1', userId: 'csr-1', orderIndex: 0 }]]]),
    );
    const sendSms = vi.fn(async (_args: { to: string; body: string }) => ({}));
    // Owner unresolvable; dispatcher resolver throws on the BRIDGE attempt
    // but succeeds for the page (simulate via call counting).
    let calls = 0;
    const result = await patchOwnerThrough(INPUT, {
      callControl: new DefaultTwilioCallControl(),
      ownerPhoneResolver: vi.fn(async () => null),
      onCallRepo,
      dispatcherPhoneResolver: vi.fn(async () => {
        calls += 1;
        // First walk (bridge rung) fails; second walk (page) resolves.
        return calls === 1 ? null : '+15125550555';
      }),
      sendSms,
      callMeBackRepo: new InMemoryCallMeBackRepository(),
    });
    expect(result.kind).toBe('fallback');
    if (result.kind !== 'fallback') throw new Error('unreachable');
    expect(result.smsSent).toBe(true);
    const sms = sendSms.mock.calls[0][0];
    expect(sms.to).toBe('+15125550555');
    expect(sms.body).toContain('URGENT');
    expect(sms.body).toContain('+15125550111');
  });

  it('owner resolver throwing falls down the ladder instead of failing the call', async () => {
    const result = await patchOwnerThrough(INPUT, {
      callControl: new DefaultTwilioCallControl(),
      ownerPhoneResolver: vi.fn(async () => {
        throw new Error('settings down');
      }),
    });
    expect(result.kind).toBe('fallback');
  });
});

describe('composePatchMissSms', () => {
  it('caps at 320 chars and carries the reason', () => {
    const body = composePatchMissSms({ ...INPUT, reason: 'r'.repeat(400) });
    expect(body.length).toBeLessThanOrEqual(320);
    expect(body).toContain('URGENT');
  });
});
