import { describe, it, expect } from 'vitest';
import { evaluateTelephonyConfig } from '../../scripts/telephony-config-verdict';
import type { TelephonyHealthReport } from '../../src/routes/telephony';

const healthy: TelephonyHealthReport = {
  ok: true,
  capabilities: {
    mediaStreams: false,
    tts: true,
    stt: true,
    recording: true,
    messageDelivery: true,
    database: true,
    llmGateway: true,
  },
  config: { publicBaseUrl: 'https://api.example.com', businessName: 'Acme' },
  warnings: [],
};

function withReport(overrides: Partial<TelephonyHealthReport>): TelephonyHealthReport {
  return {
    ...healthy,
    ...overrides,
    capabilities: { ...healthy.capabilities, ...overrides.capabilities },
    config: { ...healthy.config, ...overrides.config },
  };
}

function check(report: TelephonyHealthReport, name: string) {
  const c = evaluateTelephonyConfig(report).checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check named ${name}`);
  return c;
}

describe('evaluateTelephonyConfig', () => {
  it('passes when all three gates are green', () => {
    const v = evaluateTelephonyConfig(healthy);
    expect(v.ok).toBe(true);
    expect(v.checks.map((c) => c.name)).toEqual([
      'outgoing-sms-email',
      'click-to-call-host',
      'database',
    ]);
    expect(v.checks.every((c) => c.ok)).toBe(true);
  });

  it('fails outgoing SMS when messageDelivery is off, naming the missing creds', () => {
    const report = withReport({ capabilities: { messageDelivery: false } as never });
    const v = evaluateTelephonyConfig(report);
    expect(v.ok).toBe(false);
    const c = check(report, 'outgoing-sms-email');
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/SENDGRID_API_KEY/);
    expect(c.detail).toMatch(/TWILIO_ACCOUNT_SID/);
  });

  it('does NOT let the endpoint ok:true mask SMS being off (the smoke-test gap)', () => {
    // The endpoint reports ok:true even with messageDelivery off — this
    // verifier must still fail, which is its whole reason to exist.
    const report = withReport({ ok: true, capabilities: { messageDelivery: false } as never });
    expect(evaluateTelephonyConfig(report).ok).toBe(false);
  });

  it('fails click-to-call when publicBaseUrl is null', () => {
    const report = withReport({ config: { publicBaseUrl: null } as never });
    expect(evaluateTelephonyConfig(report).ok).toBe(false);
    expect(check(report, 'click-to-call-host').ok).toBe(false);
  });

  it('fails click-to-call when publicBaseUrl is blank/whitespace', () => {
    const report = withReport({ config: { publicBaseUrl: '   ' } as never });
    expect(check(report, 'click-to-call-host').ok).toBe(false);
  });

  it('echoes publicBaseUrl in the detail when set', () => {
    expect(check(healthy, 'click-to-call-host').detail).toContain('https://api.example.com');
  });

  it('fails database when the pool is down', () => {
    const report = withReport({ capabilities: { database: false } as never });
    expect(evaluateTelephonyConfig(report).ok).toBe(false);
    expect(check(report, 'database').ok).toBe(false);
  });

  it('passes warnings through untouched', () => {
    const report = withReport({ warnings: ['PUBLIC_API_URL unset', 'Recording disabled'] });
    expect(evaluateTelephonyConfig(report).warnings).toEqual([
      'PUBLIC_API_URL unset',
      'Recording disabled',
    ]);
  });

  it('fails loudly on a malformed payload missing capabilities/config', () => {
    const v = evaluateTelephonyConfig({ ok: true } as unknown as TelephonyHealthReport);
    expect(v.ok).toBe(false);
    expect(v.checks).toHaveLength(1);
    expect(v.checks[0].name).toBe('health-shape');
  });
});
