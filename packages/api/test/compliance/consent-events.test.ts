import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryConsentEventRepository,
  deriveConsentStatus,
  normalizeConsentPhone,
} from '../../src/compliance/consent-events';
import {
  detectRecordingObjection,
  RECORDING_OBJECTION_PHRASES,
} from '../../src/compliance/recording-objection';
import { discloseRecording } from '../../src/ai/skills/disclose-recording';

describe('RV-130 — consent ledger (append-only)', () => {
  it('appends and lists by normalized phone, newest first', async () => {
    const repo = new InMemoryConsentEventRepository();
    await repo.append({
      tenantId: 't1',
      phone: '+1 (512) 555-0188',
      kind: 'recording',
      state: 'implicit',
      source: 'voice',
      voiceSessionId: 's1',
    });
    await repo.append({
      tenantId: 't1',
      phone: '15125550188',
      kind: 'recording',
      state: 'revoked',
      source: 'voice',
      voiceSessionId: 's1',
    });
    // Different formatting, same normalized digits — lookup uses digits too.
    expect(normalizeConsentPhone('+1 (512) 555-0188')).toBe('15125550188');
    const events = await repo.listByPhone('t1', '1-512-555-0188');
    expect(events.map((e) => e.state)).toEqual(['revoked', 'implicit']);
    expect(events.every((e) => e.phoneNormalized === '15125550188')).toBe(true);
  });

  it('deriveConsentStatus: only revocations roll up — grants never manufacture voice consent (WS12/D-017), implicit never upgrades', () => {
    expect(deriveConsentStatus({ state: 'granted' })).toBeNull();
    expect(deriveConsentStatus({ state: 'revoked' })).toBe('revoked');
    expect(deriveConsentStatus({ state: 'implicit' })).toBeNull();
  });
});

describe('RV-130 — recording objection detector', () => {
  it.each([
    'please stop recording this',
    "don't record me",
    'do not record this',
    'I do not consent to being recorded',
  ])('matches %j', (utterance) => {
    expect(detectRecordingObjection(utterance).matched).toBe(true);
  });

  it('does not match ordinary mentions of recordings', () => {
    expect(detectRecordingObjection('can I get a recording of my estimate call').matched).toBe(false);
    expect(detectRecordingObjection('I want to record a payment').matched).toBe(false);
    expect(RECORDING_OBJECTION_PHRASES.length).toBeGreaterThan(3);
  });
});

describe('RV-130 — disclosure skill ledgers implicit consent', () => {
  it('telephony disclosure appends {recording, implicit, voice} tied to the session', async () => {
    const ledger = new InMemoryConsentEventRepository();
    const result = await discloseRecording({
      tenantId: 't1',
      channel: 'telephony',
      businessName: 'Acme',
      consentLedger: ledger,
      callerPhone: '+15125550188',
      voiceSessionId: 'sess-1',
    });
    expect(result.disclosed).toBe(true);
    // C5 — the write is DEFERRED to the caller's point of evidence.
    await result.commitConsentLedger();
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      kind: 'recording',
      state: 'implicit',
      source: 'voice',
      voiceSessionId: 'sess-1',
      phoneNormalized: '15125550188',
    });
  });

  /**
   * C5 (Codex P1) — the regression that motivated deferring the write.
   *
   * The ledger defines `recording/implicit` as "the disclosure PLAYED and the
   * caller stayed on the line" (consent-events.ts). Generating the copy is not
   * evidence of either. Before this fix the row was appended inside
   * discloseRecording, so every fail-closed hang-up — truncated, non-PCM,
   * zero-length, or filler-only playback — left compliance data asserting a
   * caller consented to a call we terminated precisely because they were
   * never told. Note there is no ttsProvider here at all: not one byte of
   * audio can have reached the caller.
   */
  it('generating the disclosure does NOT ledger consent until the caller has heard it', async () => {
    const ledger = new InMemoryConsentEventRepository();
    const result = await discloseRecording({
      tenantId: 't1',
      channel: 'telephony',
      businessName: 'Acme',
      consentLedger: ledger,
      callerPhone: '+15125550188',
      voiceSessionId: 'sess-1',
    });
    expect(result.disclosureText.length).toBeGreaterThan(0);
    expect(ledger.rows).toHaveLength(0);
  });

  it('committing twice writes exactly one row (idempotent)', async () => {
    const ledger = new InMemoryConsentEventRepository();
    const result = await discloseRecording({
      tenantId: 't1',
      channel: 'telephony',
      businessName: 'Acme',
      consentLedger: ledger,
      callerPhone: '+15125550188',
    });
    await result.commitConsentLedger();
    await result.commitConsentLedger();
    expect(ledger.rows).toHaveLength(1);
  });

  it('in-app channel never writes a recording event (ToS consent)', async () => {
    const ledger = new InMemoryConsentEventRepository();
    const result = await discloseRecording({
      tenantId: 't1',
      channel: 'inapp',
      businessName: 'Acme',
      consentLedger: ledger,
      callerPhone: '+15125550188',
    });
    // Even an explicit commit is a no-op on the in-app path.
    await result.commitConsentLedger();
    expect(ledger.rows).toHaveLength(0);
  });

  it('a ledger failure never blocks the disclosure', async () => {
    const ledger = new InMemoryConsentEventRepository();
    ledger.append = vi.fn(async () => {
      throw new Error('pg down');
    });
    const result = await discloseRecording({
      tenantId: 't1',
      channel: 'telephony',
      businessName: 'Acme',
      consentLedger: ledger,
      callerPhone: '+15125550188',
    });
    expect(result.disclosed).toBe(true);
    expect(result.disclosureText.length).toBeGreaterThan(0);
    // The deferred commit swallows the failure too — a ledger outage must
    // never sink an otherwise-disclosed call.
    await expect(result.commitConsentLedger()).resolves.toBeUndefined();
  });

  it('no caller phone → no ledger write (nothing to key the row on)', async () => {
    const ledger = new InMemoryConsentEventRepository();
    const result = await discloseRecording({
      tenantId: 't1',
      channel: 'telephony',
      businessName: 'Acme',
      consentLedger: ledger,
    });
    await result.commitConsentLedger();
    expect(ledger.rows).toHaveLength(0);
  });
});
