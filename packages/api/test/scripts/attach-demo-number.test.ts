/**
 * Attach one real Twilio number to an existing, seeded demo tenant — the
 * number that is published as the public demo line.
 *
 * The flow is tested here with Twilio and the database injected: a dry run
 * must search and report and change nothing; a real run buys exactly one
 * number and records it the way normal provisioning does. The SQL the real
 * store runs is pinned at Postgres in test/integration/attach-demo-number.test.ts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  parseAttachArgs,
  runAttachDemoNumber,
  type AttachArgs,
  type AttachDeps,
  type AttachTenantRow,
  type ExistingTwilioIntegration,
} from '../../scripts/attach-demo-number';
import { areaCodeForRegion } from '../../src/integrations/twilio/provisioning';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const VOICE_BASE = 'https://voice.example.com';
const CANDIDATE = { phoneNumber: '+16025550142', locality: 'Phoenix', region: 'AZ' };

const demoTenant: AttachTenantRow = { id: TENANT_ID, name: 'Demo Plumbing 1', demo: true, platform: false };

interface Overrides {
  tenant?: AttachTenantRow | null;
  integration?: ExistingTwilioIntegration | null;
  inventory?: Array<{ phoneNumber: string; locality?: string; region?: string }>;
  owned?: Array<{ sid: string; phoneNumber: string }>;
  purchased?: { sid: string; phoneNumber: string };
}

/** Every dependency is a spy, so a test can assert what was — and was not — touched. */
function makeDeps(o: Overrides = {}) {
  const calls: string[] = [];
  const track = <A extends unknown[], R>(name: string, fn: (...a: A) => R) =>
    vi.fn((...a: A) => {
      calls.push(name);
      return fn(...a);
    });
  const deps = {
    store: {
      getTenant: track('getTenant', async () => (o.tenant === undefined ? demoTenant : o.tenant)),
      getTwilioIntegration: track('getTwilioIntegration', async () => (o.integration === undefined ? null : o.integration)),
      saveSubaccount: track('saveSubaccount', async () => undefined),
      recordNumber: track('recordNumber', async () => undefined),
    },
    twilio: {
      searchAvailableNumbers: track('search', async () => o.inventory ?? [CANDIDATE]),
      createSubaccount: track('createSubaccount', async () => ({ sid: 'ACnew', authToken: 'tok-new' })),
      listNumbers: track('listNumbers', async () => o.owned ?? []),
      purchase: track('purchase', async () => o.purchased ?? { sid: 'PNnew', phoneNumber: CANDIDATE.phoneNumber }),
    },
    encrypt: vi.fn((s: string) => `enc:${s}`),
    decrypt: vi.fn((s: string) => s.replace(/^enc:/, '')),
    voiceBaseUrl: VOICE_BASE,
    log: vi.fn(),
  };
  return { deps: deps as unknown as AttachDeps & typeof deps, calls };
}

const args = (over: Partial<AttachArgs> = {}): AttachArgs => ({
  tenantId: TENANT_ID,
  region: 'AZ',
  dryRun: false,
  ...over,
});

const WRITES_AND_SPEND = ['createSubaccount', 'purchase', 'saveSubaccount', 'recordNumber', 'listNumbers'];

describe('parseAttachArgs', () => {
  it('defaults the region to AZ and a real run', () => {
    expect(parseAttachArgs(['--tenant-id', TENANT_ID])).toEqual({ tenantId: TENANT_ID, region: 'AZ', dryRun: false });
  });

  it('reads --area-code, --region and --dry-run', () => {
    expect(parseAttachArgs(['--tenant-id', TENANT_ID, '--area-code', '480', '--region', 'tx', '--dry-run'])).toEqual({
      tenantId: TENANT_ID,
      areaCode: '480',
      region: 'TX',
      dryRun: true,
    });
  });

  it.each([
    [[], /--tenant-id/],
    [['--tenant-id'], /--tenant-id/],
    [['--tenant-id', 'not-a-uuid'], /--tenant-id/],
    [['--tenant-id', TENANT_ID, '--area-code', '48'], /--area-code/],
    [['--tenant-id', TENANT_ID, '--area-code', 'abc'], /--area-code/],
    [['--tenant-id', TENANT_ID, '--region', 'ZZ'], /--region/],
    [['--tenant-id', TENANT_ID, '--bogus'], /--bogus/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseAttachArgs(argv as string[])).toThrow(message);
  });
});

describe('areaCodeForRegion', () => {
  it('maps a US state to the area code normal provisioning searches first', () => {
    expect(areaCodeForRegion('AZ')).toBe('602');
    expect(areaCodeForRegion('az')).toBe('602');
    expect(areaCodeForRegion('ZZ')).toBeUndefined();
  });
});

describe('attach-demo-number — which tenants it will touch', () => {
  it('refuses a tenant that is not a demo tenant, before any Twilio call or write', async () => {
    const { deps, calls } = makeDeps({ tenant: { id: TENANT_ID, name: 'Real Co', demo: false, platform: false } });
    await expect(runAttachDemoNumber(args(), deps)).rejects.toThrow(/not a demo tenant/);
    expect(calls).toEqual(['getTenant']);
  });

  it('refuses the platform tenant', async () => {
    const { deps, calls } = makeDeps({ tenant: { id: TENANT_ID, name: 'platform', demo: true, platform: true } });
    await expect(runAttachDemoNumber(args(), deps)).rejects.toThrow(/platform/);
    expect(calls).toEqual(['getTenant']);
  });

  it('refuses a tenant id that does not exist', async () => {
    const { deps, calls } = makeDeps({ tenant: null });
    await expect(runAttachDemoNumber(args(), deps)).rejects.toThrow(/not found/);
    expect(calls).toEqual(['getTenant']);
  });
});

describe('attach-demo-number --dry-run', () => {
  it('searches, reports what it would buy, and buys and writes nothing', async () => {
    const { deps, calls } = makeDeps();

    const result = await runAttachDemoNumber(args({ dryRun: true }), deps);

    expect(result).toMatchObject({ outcome: 'dry_run', candidate: CANDIDATE, areaCode: '602' });
    expect(calls).toContain('search');
    for (const forbidden of WRITES_AND_SPEND) expect(calls).not.toContain(forbidden);
    expect(deps.twilio.purchase).not.toHaveBeenCalled();
    expect(deps.twilio.createSubaccount).not.toHaveBeenCalled();
    expect(deps.store.saveSubaccount).not.toHaveBeenCalled();
    expect(deps.store.recordNumber).not.toHaveBeenCalled();

    const out = (deps.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain(CANDIDATE.phoneNumber);
    expect(out).toContain(TENANT_ID);
    expect(out).toContain(`${VOICE_BASE}/api/telephony/voice`);
    expect(out).toMatch(/dry run/i);
  });

  it('on a tenant that already has its number, reports it and stays quiet about buying', async () => {
    const { deps, calls } = makeDeps({
      integration: {
        status: 'full_readiness',
        subaccountSid: 'ACold',
        authTokenEnc: 'enc:tok-old',
        phoneNumberSid: 'PNold',
        phoneE164: '+16025550100',
      },
    });
    const result = await runAttachDemoNumber(args({ dryRun: true }), deps);
    expect(result).toEqual({ outcome: 'already_attached', phoneE164: '+16025550100' });
    for (const forbidden of [...WRITES_AND_SPEND, 'search']) expect(calls).not.toContain(forbidden);
  });
});

describe('attach-demo-number — real run', () => {
  it('searches the region area code, buys one number pointed at the normal inbound voice path, and records it', async () => {
    const { deps, calls } = makeDeps();

    const result = await runAttachDemoNumber(args(), deps);

    expect(result).toEqual({
      outcome: 'attached',
      phoneE164: CANDIDATE.phoneNumber,
      phoneNumberSid: 'PNnew',
      subaccountSid: 'ACnew',
    });
    expect(deps.twilio.searchAvailableNumbers).toHaveBeenCalledWith('602', expect.any(Number));
    expect(deps.twilio.purchase).toHaveBeenCalledTimes(1);
    expect(deps.twilio.purchase).toHaveBeenCalledWith('ACnew', 'tok-new', CANDIDATE.phoneNumber, {
      voiceUrl: `${VOICE_BASE}/api/telephony/voice`,
      voiceFallbackUrl: `${VOICE_BASE}/api/telephony/voice/fallback`,
      statusCallbackUrl: `${VOICE_BASE}/webhooks/twilio/status/${TENANT_ID}`,
    });
    expect(deps.store.recordNumber).toHaveBeenCalledWith(TENANT_ID, {
      phoneNumberSid: 'PNnew',
      phoneE164: CANDIDATE.phoneNumber,
    });
    // The subaccount credential is stored encrypted, and before any money is spent,
    // so a crash after the purchase leaves a number the next run can find.
    expect(deps.store.saveSubaccount).toHaveBeenCalledWith(TENANT_ID, { subaccountSid: 'ACnew', authTokenEnc: 'enc:tok-new' });
    expect(calls.indexOf('saveSubaccount')).toBeLessThan(calls.indexOf('purchase'));
    expect(calls.indexOf('purchase')).toBeLessThan(calls.indexOf('recordNumber'));
  });

  it('prefers --area-code over the region', async () => {
    const { deps } = makeDeps();
    await runAttachDemoNumber(args({ areaCode: '480' }), deps);
    expect(deps.twilio.searchAvailableNumbers).toHaveBeenCalledWith('480', expect.any(Number));
  });

  it('finds no inventory: fails before creating a subaccount or buying anything', async () => {
    const { deps, calls } = makeDeps({ inventory: [] });
    await expect(runAttachDemoNumber(args(), deps)).rejects.toThrow(/no numbers.*602/i);
    for (const forbidden of WRITES_AND_SPEND) expect(calls).not.toContain(forbidden);
  });

  it('is idempotent: a tenant whose number is already attached is left alone', async () => {
    const { deps, calls } = makeDeps({
      integration: {
        status: 'full_readiness',
        subaccountSid: 'ACold',
        authTokenEnc: 'enc:tok-old',
        phoneNumberSid: 'PNold',
        phoneE164: '+16025550100',
      },
    });
    const result = await runAttachDemoNumber(args(), deps);
    expect(result).toEqual({ outcome: 'already_attached', phoneE164: '+16025550100' });
    for (const forbidden of [...WRITES_AND_SPEND, 'search']) expect(calls).not.toContain(forbidden);
  });

  it('resumes a tenant that has a subaccount but no number: no second subaccount', async () => {
    const { deps } = makeDeps({
      integration: {
        status: 't0_requested',
        subaccountSid: 'ACold',
        authTokenEnc: 'enc:tok-old',
        phoneNumberSid: null,
        phoneE164: null,
      },
    });
    await runAttachDemoNumber(args(), deps);
    expect(deps.twilio.createSubaccount).not.toHaveBeenCalled();
    expect(deps.twilio.purchase).toHaveBeenCalledWith('ACold', 'tok-old', CANDIDATE.phoneNumber, expect.any(Object));
  });

  it('recovers a number a crashed earlier run bought, instead of buying a second', async () => {
    const { deps } = makeDeps({
      integration: {
        status: 't0_requested',
        subaccountSid: 'ACold',
        authTokenEnc: 'enc:tok-old',
        phoneNumberSid: null,
        phoneE164: null,
      },
      owned: [{ sid: 'PNorphan', phoneNumber: '+16025550177' }],
    });
    const result = await runAttachDemoNumber(args(), deps);
    expect(deps.twilio.purchase).not.toHaveBeenCalled();
    expect(deps.store.recordNumber).toHaveBeenCalledWith(TENANT_ID, { phoneNumberSid: 'PNorphan', phoneE164: '+16025550177' });
    expect(result).toMatchObject({ outcome: 'attached', phoneE164: '+16025550177' });
  });

  it('refuses to record a Twilio magic test number (test credentials) as the public line', async () => {
    const { deps } = makeDeps({ purchased: { sid: 'PNtest', phoneNumber: '+15005550006' } });
    await expect(runAttachDemoNumber(args(), deps)).rejects.toThrow(/test/i);
    expect(deps.store.recordNumber).not.toHaveBeenCalled();
  });

  it('refuses a voice base URL that is not https (a localhost webhook on a bought number is a footgun)', async () => {
    const { deps, calls } = makeDeps();
    deps.voiceBaseUrl = 'http://localhost:3000';
    await expect(runAttachDemoNumber(args(), deps)).rejects.toThrow(/https/);
    for (const forbidden of [...WRITES_AND_SPEND, 'search']) expect(calls).not.toContain(forbidden);
  });
});

describe('attach-demo-number — what it must never do', () => {
  it('does not import tenant, Clerk or Stripe machinery', () => {
    const src = readFileSync(path.resolve(__dirname, '../../scripts/attach-demo-number.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => /^\s*(import|} from)\b/.test(l) || /^\s*import\(/.test(l));
    const joined = imports.join('\n');
    expect(joined).not.toMatch(/auth\/clerk/);
    expect(joined).not.toMatch(/billing/);
    expect(joined).not.toMatch(/stripe/i);
    expect(joined).not.toMatch(/bootstrapTenant|pg-tenant/);
    expect(joined).not.toMatch(/workers\/provision-twilio/);
  });
});
