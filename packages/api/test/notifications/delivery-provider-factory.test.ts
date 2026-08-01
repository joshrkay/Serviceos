/**
 * REGRESSION GUARD for the silent promotion of Development to real delivery.
 *
 * 36d30807 decoupled the SMS and email credential legs so production (Twilio
 * creds, no SendGrid key) could send SMS again. Correct fix, but the branch
 * that chose a real provider then keyed ONLY on "are credentials present?" —
 * and Development has Twilio credentials. So Development silently started
 * building a real PerTenantTwilioDeliveryProvider over a real
 * TwilioDeliveryProvider, and (via the global-creds fallback in
 * integrations/credentials.ts) became able to text real customers from the
 * real business number. Only TELEPHONY_ENABLED=false stood in the way.
 *
 * These tests assert the restored invariant: a non-production environment is
 * STRUCTURALLY INCAPABLE of sending — no real provider is even constructed —
 * while prod/staging keep 36d30807's independent SMS and email legs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Constructor tripwires. Subclass the REAL classes so `instanceof` still
// works and nothing about the provider's behaviour is faked — we only record
// that construction happened at all.
const ctor = vi.hoisted(() => ({ twilio: [] as unknown[], perTenant: [] as unknown[] }));

vi.mock('../../src/notifications/twilio-delivery-provider', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/notifications/twilio-delivery-provider')>();
  return {
    ...actual,
    TwilioDeliveryProvider: class extends actual.TwilioDeliveryProvider {
      constructor(cfg: ConstructorParameters<typeof actual.TwilioDeliveryProvider>[0]) {
        ctor.twilio.push(cfg);
        super(cfg);
      }
    },
  };
});

vi.mock('../../src/notifications/per-tenant-twilio-delivery-provider', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/notifications/per-tenant-twilio-delivery-provider')
  >();
  return {
    ...actual,
    PerTenantTwilioDeliveryProvider: class extends actual.PerTenantTwilioDeliveryProvider {
      constructor(cfg: ConstructorParameters<typeof actual.PerTenantTwilioDeliveryProvider>[0]) {
        ctor.perTenant.push(cfg);
        super(cfg);
      }
    },
  };
});

import {
  createMessageDeliveryProvider,
  realDeliveryProvidersAllowed,
  DELIVERY_ALLOW_REAL_PROVIDERS,
} from '../../src/notifications/delivery-provider-factory';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { TwilioDeliveryProvider } from '../../src/notifications/twilio-delivery-provider';
import { PerTenantTwilioDeliveryProvider } from '../../src/notifications/per-tenant-twilio-delivery-provider';

/** Development's real credential shape: full Twilio SMS, no email at all. */
const DEV_TWILIO_CREDS = {
  TWILIO_ACCOUNT_SID: 'ACdummydummydummydummydummydummy00',
  TWILIO_AUTH_TOKEN: 'dummy_auth_token_not_real',
  TWILIO_FROM_NUMBER: '+15550001111',
};

interface LogEntry {
  level: 'info' | 'warn';
  message: string;
  meta?: Record<string, unknown>;
}

function fakeLogger() {
  const entries: LogEntry[] = [];
  return {
    entries,
    info: (message: string, meta?: Record<string, unknown>) =>
      entries.push({ level: 'info', message, meta }),
    warn: (message: string, meta?: Record<string, unknown>) =>
      entries.push({ level: 'warn', message, meta }),
  };
}

/** Hosts that mean "a real human was contacted". */
const FORBIDDEN = ['api.twilio.com', 'comms.twilio.com', 'api.sendgrid.com'];
let fetchCalls: string[] = [];
let realFetch: typeof globalThis.fetch;
let realNodeEnv: string | undefined;

beforeEach(() => {
  ctor.twilio.length = 0;
  ctor.perTenant.length = 0;
  fetchCalls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url =
      typeof input === 'string' ? input : ((input as { url?: string })?.url ?? String(input));
    fetchCalls.push(url);
    throw new Error(`OUTBOUND TRIPWIRE: ${url}`);
  }) as typeof globalThis.fetch;
  realNodeEnv = process.env.NODE_ENV;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = realNodeEnv;
});

/**
 * The suite itself may be run with NODE_ENV=production exported in the shell.
 * InMemoryDeliveryProvider's own guard reads process.env.NODE_ENV directly, so
 * align it with the environment under test rather than leaving the ambient
 * value to leak in.
 */
function withProcessNodeEnv(value: string) {
  process.env.NODE_ENV = value;
}

describe('createMessageDeliveryProvider — non-production is structurally incapable of sending', () => {
  it('NODE_ENV=development WITH full Twilio credentials → InMemoryDeliveryProvider, no real provider constructed', async () => {
    withProcessNodeEnv('development');
    const logger = fakeLogger();

    const wiring = createMessageDeliveryProvider({
      // config.ts normalizes 'development' → 'dev'; that normalized value is
      // what app.ts passes.
      nodeEnv: 'dev',
      env: { NODE_ENV: 'development', ...DEV_TWILIO_CREDS },
      // A pool IS available in Development — this is exactly the shape that
      // produced a real PerTenantTwilioDeliveryProvider after 36d30807.
      pool: {} as never,
      logger,
    });

    expect(wiring.mode).toBe('in-memory');
    expect(wiring.provider).toBeInstanceOf(InMemoryDeliveryProvider);
    expect(wiring.provider).not.toBeInstanceOf(TwilioDeliveryProvider);
    expect(wiring.provider).not.toBeInstanceOf(PerTenantTwilioDeliveryProvider);
    expect(wiring.smsConfigured).toBe(false);
    expect(wiring.escapeHatchEngaged).toBe(false);

    // THE regression assertion: the real provider classes were never even
    // constructed, so there is nothing holding live credentials.
    expect(ctor.twilio).toEqual([]);
    expect(ctor.perTenant).toEqual([]);

    // And a send goes nowhere near the network.
    await wiring.provider!.sendSms({ to: '+15551230000', body: 'hi' });
    expect(fetchCalls.filter((u) => FORBIDDEN.some((h) => u.includes(h)))).toEqual([]);
    expect((wiring.provider as InMemoryDeliveryProvider).sentSms).toHaveLength(1);

    // The choice is logged, and the log says the credentials were deliberately ignored.
    const chosen = logger.entries.find((e) => e.message.includes('Message delivery mode'));
    expect(chosen?.message).toMatch(/in-memory/);
    expect(chosen?.meta?.credentialsPresentButIgnored).toBe(true);
  });

  it('NODE_ENV=test WITH full Twilio credentials → InMemoryDeliveryProvider, no real provider constructed', () => {
    withProcessNodeEnv('test');
    const logger = fakeLogger();

    const wiring = createMessageDeliveryProvider({
      nodeEnv: 'test',
      env: { NODE_ENV: 'test', ...DEV_TWILIO_CREDS },
      pool: {} as never,
      logger,
    });

    expect(wiring.mode).toBe('in-memory');
    expect(wiring.provider).toBeInstanceOf(InMemoryDeliveryProvider);
    expect(ctor.twilio).toEqual([]);
    expect(ctor.perTenant).toEqual([]);
  });

  it('non-production ignores email credentials too (SendGrid present, still in-memory)', () => {
    withProcessNodeEnv('development');
    const wiring = createMessageDeliveryProvider({
      nodeEnv: 'dev',
      env: {
        NODE_ENV: 'development',
        ...DEV_TWILIO_CREDS,
        SENDGRID_API_KEY: 'SG.dummy',
        SENDGRID_FROM_EMAIL: 'noreply@example.test',
      },
      pool: {} as never,
      logger: fakeLogger(),
    });

    expect(wiring.mode).toBe('in-memory');
    expect(wiring.emailProvider).toBe('none');
    expect(ctor.twilio).toEqual([]);
  });
});

describe('createMessageDeliveryProvider — prod/staging keep 36d30807 decoupling', () => {
  it("NODE_ENV=prod with Twilio SMS creds ONLY → real SMS provider, email leg unconfigured", () => {
    withProcessNodeEnv('production');
    const logger = fakeLogger();

    const wiring = createMessageDeliveryProvider({
      nodeEnv: 'prod',
      env: { NODE_ENV: 'production', ...DEV_TWILIO_CREDS },
      pool: {} as never,
      logger,
    });

    expect(wiring.mode).toBe('real');
    expect(wiring.smsConfigured).toBe(true);
    expect(wiring.emailProvider).toBe('none');
    expect(wiring.provider).toBeInstanceOf(PerTenantTwilioDeliveryProvider);

    // A real Twilio provider WAS constructed, carrying an SMS leg and no email
    // leg — the whole point of 36d30807.
    expect(ctor.twilio).toHaveLength(1);
    const cfg = ctor.twilio[0] as Record<string, unknown>;
    expect(cfg.sms).toMatchObject({ fromNumber: DEV_TWILIO_CREDS.TWILIO_FROM_NUMBER });
    expect(cfg.email).toBeUndefined();
    expect(cfg.twilioEmail).toBeUndefined();
    expect(ctor.perTenant).toHaveLength(1);

    const chosen = logger.entries.find((e) => e.message.includes('Message delivery mode'));
    expect(chosen?.message).toMatch(/REAL/);
    expect(chosen?.meta?.smsConfigured).toBe(true);
  });

  it('NODE_ENV=staging with SendGrid creds ONLY → real provider with an email leg and no SMS leg', () => {
    withProcessNodeEnv('staging');
    const wiring = createMessageDeliveryProvider({
      nodeEnv: 'staging',
      env: {
        NODE_ENV: 'staging',
        SENDGRID_API_KEY: 'SG.dummy',
        SENDGRID_FROM_EMAIL: 'noreply@example.test',
      },
      pool: null,
      logger: fakeLogger(),
    });

    expect(wiring.mode).toBe('real');
    expect(wiring.smsConfigured).toBe(false);
    expect(wiring.emailProvider).toBe('sendgrid');
    // No pool ⇒ the global provider, not the per-tenant wrapper.
    expect(wiring.provider).toBeInstanceOf(TwilioDeliveryProvider);
    expect(ctor.perTenant).toEqual([]);
    const cfg = ctor.twilio[0] as Record<string, unknown>;
    expect(cfg.sms).toBeUndefined();
    expect(cfg.email).toMatchObject({ apiKey: 'SG.dummy' });
  });

  it('NODE_ENV=prod with NOTHING configured → null (never InMemory in production)', () => {
    withProcessNodeEnv('production');
    const logger = fakeLogger();

    const wiring = createMessageDeliveryProvider({
      nodeEnv: 'prod',
      env: { NODE_ENV: 'production' },
      pool: {} as never,
      logger,
    });

    expect(wiring.mode).toBe('none');
    expect(wiring.provider).toBeNull();
    expect(ctor.twilio).toEqual([]);
    expect(ctor.perTenant).toEqual([]);
    expect(logger.entries.some((e) => e.level === 'warn' && e.message.includes('none'))).toBe(true);
  });
});

describe('the escape hatch', () => {
  it(`${DELIVERY_ALLOW_REAL_PROVIDERS}=true in dev → real provider constructed AND a prominent warning is logged`, () => {
    withProcessNodeEnv('development');
    const logger = fakeLogger();

    const wiring = createMessageDeliveryProvider({
      nodeEnv: 'dev',
      env: {
        NODE_ENV: 'development',
        ...DEV_TWILIO_CREDS,
        [DELIVERY_ALLOW_REAL_PROVIDERS]: 'true',
      },
      pool: {} as never,
      logger,
    });

    expect(wiring.mode).toBe('real');
    expect(wiring.escapeHatchEngaged).toBe(true);
    expect(wiring.provider).toBeInstanceOf(PerTenantTwilioDeliveryProvider);
    expect(ctor.twilio).toHaveLength(1);

    const warning = logger.entries.find(
      (e) => e.level === 'warn' && e.message.includes(DELIVERY_ALLOW_REAL_PROVIDERS)
    );
    expect(warning, JSON.stringify(logger.entries)).toBeDefined();
    expect(warning!.message).toMatch(/NON-PRODUCTION/);
    expect(warning!.message).toMatch(/real phone numbers/);
  });

  it('defaults to OFF — any value other than the literal "true" does not unlock real providers', () => {
    withProcessNodeEnv('development');
    for (const value of ['1', 'yes', 'TRUE', 'false', '']) {
      ctor.twilio.length = 0;
      const wiring = createMessageDeliveryProvider({
        nodeEnv: 'dev',
        env: { NODE_ENV: 'development', ...DEV_TWILIO_CREDS, [DELIVERY_ALLOW_REAL_PROVIDERS]: value },
        pool: {} as never,
        logger: fakeLogger(),
      });
      expect(wiring.mode, `value=${JSON.stringify(value)}`).toBe('in-memory');
      expect(ctor.twilio).toEqual([]);
    }
  });

  it('opting in with no credentials at all still boots (falls back to in-memory)', () => {
    withProcessNodeEnv('development');
    const logger = fakeLogger();
    const wiring = createMessageDeliveryProvider({
      nodeEnv: 'dev',
      env: { NODE_ENV: 'development', [DELIVERY_ALLOW_REAL_PROVIDERS]: 'true' },
      pool: {} as never,
      logger,
    });

    expect(wiring.mode).toBe('in-memory');
    expect(wiring.provider).toBeInstanceOf(InMemoryDeliveryProvider);
    expect(ctor.twilio).toEqual([]);
  });
});

describe('realDeliveryProvidersAllowed', () => {
  it('is true only for real deployments, or with the explicit opt-in', () => {
    expect(realDeliveryProvidersAllowed('prod', {})).toBe(true);
    expect(realDeliveryProvidersAllowed('production', {})).toBe(true);
    expect(realDeliveryProvidersAllowed('staging', {})).toBe(true);

    expect(realDeliveryProvidersAllowed('dev', {})).toBe(false);
    expect(realDeliveryProvidersAllowed('development', {})).toBe(false);
    expect(realDeliveryProvidersAllowed('test', {})).toBe(false);
    expect(realDeliveryProvidersAllowed(undefined, {})).toBe(false);

    expect(
      realDeliveryProvidersAllowed('dev', { [DELIVERY_ALLOW_REAL_PROVIDERS]: 'true' })
    ).toBe(true);
  });
});
