/**
 * S6-3 (U7 Approach, "Only a `Calls` request that provably created no call
 * releases anything at once") — the parts of the start service that run
 * before any write or are pure: the refusals that touch nothing, the
 * visitor's number, its hash, the metro, and the exact `Calls` request.
 * The transaction, the request and the settle are proven on real Postgres
 * against a local fake Twilio (test/integration/demo-calls.test.ts).
 */
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import {
  startDemoCall,
  normalizeDemoPhone,
  hashDemoPhone,
  resolveDemoMetro,
  buildCallsRequest,
  LocalRequestError,
  type DemoCallServiceDeps,
} from '../../src/demo/service';
import { loadDemoConfig } from '../../src/demo/config';
import { mintLeaseToken, verifyLeaseToken } from '../../src/demo/lease-token';

/** A pool that fails the test if anything reaches the database. */
function untouchablePool(): Pool & { touched: number } {
  const p = {
    touched: 0,
    connect() {
      p.touched += 1;
      throw new Error('the database was touched');
    },
    query() {
      p.touched += 1;
      throw new Error('the database was touched');
    },
  };
  return p as unknown as Pool & { touched: number };
}

function deps(overrides: Partial<DemoCallServiceDeps> = {}): DemoCallServiceDeps & { pool: Pool & { touched: number } } {
  return {
    pool: untouchablePool(),
    config: loadDemoConfig({}),
    isEnabled: () => true,
    getCreds: () => ({ accountSid: 'ACplatform', authToken: 'tok', fromE164: '+15125550100' }),
    leaseTokenSecret: 'secret',
    publicApiUrl: 'https://api.example.test',
    alert: async () => undefined,
    fetchImpl: async () => {
      throw new Error('no request may be made');
    },
    ...overrides,
  } as DemoCallServiceDeps & { pool: Pool & { touched: number } };
}

const input = { phone: '(512) 555-0142', trade: 'plumbing' as const, businessName: 'Austin Pipe Pros' };

describe('startDemoCall — refusals that write nothing', () => {
  it.each([
    ['missing platform credentials', { getCreds: () => null }],
    ['the kill switch off', { isEnabled: () => false }],
    ['a closed module', { config: loadDemoConfig({ DEMO_CALLS_DAILY_CAP: 'zero' }) }],
    ['no lease token secret', { leaseTokenSecret: undefined }],
    ['no public API URL', { publicApiUrl: undefined }],
    ['no database', { pool: null }],
  ] as Array<[string, Partial<DemoCallServiceDeps>]>)('%s → disabled, the database untouched', async (_l, o) => {
    const d = deps(o);
    const out = await startDemoCall(input, d);
    expect(out.kind).toBe('disabled');
    if (d.pool) expect(d.pool.touched).toBe(0);
  });

  it.each([
    ['+19005550142', 'premium_npa'],
    ['+19765550142', 'premium_npa'],
    ['+447700900123', 'non_nanp'],
    ['+11235550142', 'malformed'],
    ['(512) 155-0142', 'malformed'],
    ['call me maybe', 'malformed'],
  ])('%s → number_not_allowed (%s), the database untouched', async (phone, reason) => {
    const d = deps();
    expect(await startDemoCall({ ...input, phone }, d)).toEqual({ kind: 'number_not_allowed', reason });
    expect(d.pool.touched).toBe(0);
  });
});

describe('the visitor number', () => {
  it.each([
    ['(512) 555-0142', '+15125550142'],
    ['512-555-0142', '+15125550142'],
    ['+1 512 555 0142', '+15125550142'],
    ['15125550142', '+15125550142'],
    ['+447700900123', '+447700900123'],
  ])('%s normalizes to %s', (raw, e164) => {
    expect(normalizeDemoPhone(raw)).toBe(e164);
  });

  it('is hashed with the secret, never stored in the clear', () => {
    const h = hashDemoPhone('+15125550142', 'secret');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('5125550142');
    expect(hashDemoPhone('+15125550142', 'secret')).toBe(h);
    expect(hashDemoPhone('+15125550142', 'other')).not.toBe(h);
    expect(hashDemoPhone('+15125550143', 'secret')).not.toBe(h);
  });

  it('the metro comes from the visitor pick when known, else the area code, else none', () => {
    expect(resolveDemoMetro('+15125550142', undefined)).toEqual({ metroCode: 'AUS', metroName: 'Austin' });
    expect(resolveDemoMetro('+15125550142', 'not-a-metro')).toEqual({ metroCode: 'AUS', metroName: 'Austin' });
    expect(resolveDemoMetro('+15125550142', 'DEN')).toEqual({ metroCode: 'DEN', metroName: 'Denver' });
    expect(resolveDemoMetro('+18085550142', undefined)).toEqual({ metroCode: null, metroName: null });
  });
});

describe('buildCallsRequest', () => {
  const token = mintLeaseToken({ leaseId: 'L1', tenantId: 'T1', gen: 7, sexp: Date.UTC(2030, 0, 1) }, 'secret');

  it('dials the visitor from the platform number with both callback URLs carrying the lease token', () => {
    const req = buildCallsRequest({
      apiBaseUrl: 'https://api.twilio.test/2010-04-01',
      creds: { accountSid: 'ACplatform', authToken: 'tok', fromE164: '+15125550100' },
      publicApiUrl: 'https://api.example.test/',
      toE164: '+15125550142',
      leaseToken: token,
    });
    expect(req.url).toBe('https://api.twilio.test/2010-04-01/Accounts/ACplatform/Calls.json');
    expect(req.init.method).toBe('POST');
    expect(req.init.headers).toEqual({
      Authorization: `Basic ${Buffer.from('ACplatform:tok').toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    const body = new URLSearchParams(req.init.body);
    expect(body.get('To')).toBe('+15125550142');
    expect(body.get('From')).toBe('+15125550100');
    expect(body.get('Method')).toBe('POST');
    expect(body.get('StatusCallbackMethod')).toBe('POST');
    expect(body.getAll('StatusCallbackEvent')).toEqual(['ringing', 'answered', 'completed']);
    expect(body.get('Timeout')).toBe('30');
    expect(body.get('TimeLimit')).toBe('90');
    const voice = new URL(body.get('Url')!);
    const status = new URL(body.get('StatusCallback')!);
    expect(`${voice.origin}${voice.pathname}`).toBe('https://api.example.test/public/demo/voice');
    expect(`${status.origin}${status.pathname}`).toBe('https://api.example.test/public/demo/status');
    for (const u of [voice, status]) {
      expect(u.searchParams.get('lease')).toBe(token);
      expect(verifyLeaseToken(u.searchParams.get('lease')!, 'secret', new Date(Date.UTC(2029, 0, 1))).ok).toBe(true);
    }
  });

  it.each([
    ['a From that is not E.164', { fromE164: '512-555-0100' }, 'https://api.example.test'],
    ['a public URL that is not absolute', {}, '/relative'],
    ['a public URL that is not http(s)', {}, 'ftp://api.example.test'],
  ])('%s fails locally, before any request', (_l, creds, publicApiUrl) => {
    expect(() =>
      buildCallsRequest({
        apiBaseUrl: 'https://api.twilio.test/2010-04-01',
        creds: { accountSid: 'ACplatform', authToken: 'tok', fromE164: '+15125550100', ...creds },
        publicApiUrl,
        toE164: '+15125550142',
        leaseToken: token,
      }),
    ).toThrow(LocalRequestError);
  });
});
