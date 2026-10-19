/**
 * LCR-04 — numbers bought before the fallback existed carry no
 * `VoiceFallbackUrl`, so a failed /voice still drops their calls. The backfill
 * sets it on every live number, idempotently, and is a DRY RUN unless
 * `--apply` is passed. The planner is tested here with the Twilio calls and
 * the token decryption injected; the row query is pinned at real Postgres in
 * test/integration/backfill-twilio-voice-fallback-url.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseBackfillArgs,
  runVoiceFallbackBackfill,
  type BackfillRow,
  type BackfillTwilio,
} from '../../scripts/backfill-twilio-voice-fallback-url';

const VOICE_BASE = 'https://voice.example.com';
const TARGET = `${VOICE_BASE}/api/telephony/voice/fallback`;

function row(overrides: Partial<BackfillRow> = {}): BackfillRow {
  return {
    tenantId: 'tenant-a',
    subaccountSid: 'ACaaa',
    authTokenEnc: 'enc:tok-a',
    phoneNumberSid: 'PNaaa',
    phoneE164: '+15125550001',
    stub: false,
    ...overrides,
  };
}

/** A fake Twilio that remembers what each number's fallback is. */
function fakeTwilio(initial: Record<string, string | null>) {
  const fallback: Record<string, string | null> = { ...initial };
  const twilio: BackfillTwilio = {
    getVoiceConfig: vi.fn(async (_sid, _tok, pn) => ({
      voiceUrl: `${VOICE_BASE}/api/telephony/voice`,
      voiceFallbackUrl: fallback[pn] ?? null,
      voiceFallbackMethod: fallback[pn] ? 'POST' : null,
    })),
    setVoiceFallback: vi.fn(async (_sid, _tok, pn, url) => {
      fallback[pn] = url;
    }),
  };
  return { twilio, fallback };
}

const decryptToken = (enc: string) => enc.replace(/^enc:/, '');
const quiet = () => undefined;

describe('backfill-twilio-voice-fallback-url (LCR-04)', () => {
  it('is a dry run by default: reports what it would set and changes nothing', async () => {
    const { twilio } = fakeTwilio({ PNaaa: null });
    const result = await runVoiceFallbackBackfill({
      rows: [row()],
      voiceBaseUrl: VOICE_BASE,
      decryptToken,
      twilio,
      apply: false,
      log: quiet,
    });
    expect(result.reports).toEqual([
      expect.objectContaining({ tenantId: 'tenant-a', phoneE164: '+15125550001', outcome: 'would_set' }),
    ]);
    expect(result.counts).toMatchObject({ would_set: 1, set: 0 });
    expect(twilio.setVoiceFallback).not.toHaveBeenCalled();
  });

  it('--apply sets the fallback with the subaccount\'s own decrypted token, and a re-run is a no-op', async () => {
    const { twilio, fallback } = fakeTwilio({ PNaaa: null });
    const first = await runVoiceFallbackBackfill({
      rows: [row()],
      voiceBaseUrl: VOICE_BASE,
      decryptToken,
      twilio,
      apply: true,
      log: quiet,
    });
    expect(first.reports[0].outcome).toBe('set');
    expect(twilio.setVoiceFallback).toHaveBeenCalledWith('ACaaa', 'tok-a', 'PNaaa', TARGET);
    expect(fallback.PNaaa).toBe(TARGET);

    const second = await runVoiceFallbackBackfill({
      rows: [row()],
      voiceBaseUrl: VOICE_BASE,
      decryptToken,
      twilio,
      apply: true,
      log: quiet,
    });
    expect(second.reports[0].outcome).toBe('already_set');
    expect(twilio.setVoiceFallback).toHaveBeenCalledTimes(1);
  });

  it('a number whose fallback points elsewhere is repointed', async () => {
    const { twilio } = fakeTwilio({ PNaaa: 'https://old.example.com/fallback' });
    const result = await runVoiceFallbackBackfill({
      rows: [row()],
      voiceBaseUrl: VOICE_BASE,
      decryptToken,
      twilio,
      apply: true,
      log: quiet,
    });
    expect(result.reports[0].outcome).toBe('set');
  });

  it('skips stub rows and rows missing a subaccount, a token or a number SID, and never calls Twilio for them', async () => {
    const { twilio } = fakeTwilio({});
    const result = await runVoiceFallbackBackfill({
      rows: [
        row({ tenantId: 't-stub', stub: true }),
        row({ tenantId: 't-nosub', subaccountSid: null }),
        row({ tenantId: 't-notok', authTokenEnc: null }),
        row({ tenantId: 't-nopn', phoneNumberSid: null }),
      ],
      voiceBaseUrl: VOICE_BASE,
      decryptToken,
      twilio,
      apply: true,
      log: quiet,
    });
    expect(result.reports.map((r) => r.outcome)).toEqual(['skipped', 'skipped', 'skipped', 'skipped']);
    expect(twilio.getVoiceConfig).not.toHaveBeenCalled();
    expect(twilio.setVoiceFallback).not.toHaveBeenCalled();
  });

  it('one number failing does not stop the rest, and the summary counts it', async () => {
    const { twilio } = fakeTwilio({ PNaaa: null, PNbbb: null });
    (twilio.setVoiceFallback as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('Twilio POST → 503: busy');
    });
    const result = await runVoiceFallbackBackfill({
      rows: [row(), row({ tenantId: 'tenant-b', subaccountSid: 'ACbbb', authTokenEnc: 'enc:tok-b', phoneNumberSid: 'PNbbb', phoneE164: '+15125550002' })],
      voiceBaseUrl: VOICE_BASE,
      decryptToken,
      twilio,
      apply: true,
      log: quiet,
    });
    expect(result.reports.map((r) => r.outcome)).toEqual(['failed', 'set']);
    expect(result.counts).toMatchObject({ failed: 1, set: 1 });
  });

  it('parseBackfillArgs: dry run unless --apply; optional --tenant-id filter', () => {
    expect(parseBackfillArgs([])).toEqual({ apply: false });
    expect(parseBackfillArgs(['--apply'])).toEqual({ apply: true });
    expect(parseBackfillArgs(['--tenant-id', 'abc'])).toEqual({ apply: false, tenantId: 'abc' });
  });
});
