/**
 * ADVERSARIAL verification of the per-channel outbound kill switch under
 * PRODUCTION's exact configuration.
 *
 * Reproduces prod: TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER present (dummy),
 * NO SENDGRID_*, NO TWILIO_EMAIL_FROM_ADDRESS, TELEPHONY_ENABLED='false',
 * EMAIL_ENABLED='false', and builds the REAL provider chain app.ts builds
 * (TwilioDeliveryProvider -> PerTenantTwilioDeliveryProvider -> Gated).
 *
 * The assertion that matters is at the OUTERMOST NETWORK BOUNDARY: global
 * fetch is replaced with a tripwire that fails the test if ANY layer reaches
 * api.twilio.com / comms.twilio.com / api.sendgrid.com.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  GatedMessageDelivery,
  SmsSuppressedError,
  EmailSuppressedError,
} from '../../src/notifications/gated-message-delivery';
import { TwilioDeliveryProvider } from '../../src/notifications/twilio-delivery-provider';
import { PerTenantTwilioDeliveryProvider } from '../../src/notifications/per-tenant-twilio-delivery-provider';
import { selectEmailProvider } from '../../src/notifications/twilio-email-delivery-provider';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { TransactionalCommsService } from '../../src/notifications/transactional-comms-service';
import { SendService } from '../../src/notifications/send-service';
import { MessageDeliveryFeedbackDispatcher } from '../../src/feedback/dispatcher';
import { TwilioDelayNotificationService } from '../../src/notifications/twilio-delay-notification-service';
import { sendLifecycleEmail } from '../../src/notifications/lifecycle-email';
import { sendCustomerMessage } from '../../src/notifications/customer-message-delivery';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CUST_PHONE = '+15551230000';
const OWNER_PHONE = '+15557654321';
const CUST_EMAIL = 'customer@example.com';

/** Hosts that mean "a real human was contacted". */
const FORBIDDEN = ['api.twilio.com', 'comms.twilio.com', 'api.sendgrid.com', 'twilio.com', 'sendgrid.com'];

/** Every URL global fetch was asked for during a test. */
let fetchCalls: string[] = [];
let realFetch: typeof globalThis.fetch;

/** PRODUCTION's env, exactly. */
const PROD_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  TWILIO_ACCOUNT_SID: 'ACdummydummydummydummydummydummy00',
  TWILIO_AUTH_TOKEN: 'dummy_auth_token_not_real',
  TWILIO_FROM_NUMBER: '+15550001111',
  TWILIO_DEFAULT_TENANT_ID: TENANT,
  TELEPHONY_ENABLED: 'false',
  EMAIL_ENABLED: 'false',
  DATABASE_URL: 'postgres://qa:qa@127.0.0.1:5432/serviceos_dev',
};
const CLEARED = [
  'SENDGRID_API_KEY',
  'SENDGRID_FROM_EMAIL',
  'SENDGRID_FROM_NAME',
  'SENDGRID_REPLY_TO_EMAIL',
  'TWILIO_EMAIL_FROM_ADDRESS',
  'TWILIO_EMAIL_FROM_NAME',
];

let saved: Record<string, string | undefined> = {};

function applyProdEnv(): void {
  saved = {};
  for (const k of [...Object.keys(PROD_ENV), ...CLEARED]) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(PROD_ENV)) process.env[k] = v;
  for (const k of CLEARED) delete process.env[k];
}
function restoreEnv(): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/**
 * Replaces global fetch with a tripwire. Any call to a provider host throws a
 * loud, unmistakable error AND is recorded, so a swallowed exception in a
 * best-effort notifier can never hide a real send attempt.
 */
function installFetchTripwire(): void {
  fetchCalls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, _init?: any) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    fetchCalls.push(url);
    if (FORBIDDEN.some((h) => url.includes(h))) {
      throw new Error(`OUTBOUND TRIPWIRE: real send attempted to ${url}`);
    }
    throw new Error(`OUTBOUND TRIPWIRE: unexpected network call to ${url}`);
  }) as any;
}
function expectNoOutbound(): void {
  const bad = fetchCalls.filter((u) => FORBIDDEN.some((h) => u.includes(h)));
  expect(bad, `outbound provider calls: ${JSON.stringify(bad)}`).toEqual([]);
  expect(fetchCalls, `ANY network call: ${JSON.stringify(fetchCalls)}`).toEqual([]);
}

/** Fake logger — captures instead of printing. */
const logs: any[] = [];
const logger: any = {
  info: (m: string, x?: any) => logs.push(['info', m, x]),
  warn: (m: string, x?: any) => logs.push(['warn', m, x]),
  error: (m: string, x?: any) => logs.push(['error', m, x]),
  debug: (m: string, x?: any) => logs.push(['debug', m, x]),
};

/** A pool that screams if touched — per-tenant cred lookup must never run. */
const tripwirePool: any = {
  query: async () => {
    throw new Error('POOL TRIPWIRE: per-tenant Twilio credential lookup was reached');
  },
  connect: async () => {
    throw new Error('POOL TRIPWIRE: connect() reached');
  },
};

/** Exactly the chain app.ts builds under production's env. */
function buildProdStack() {
  const base = new TwilioDeliveryProvider({
    sms: {
      accountSid: process.env.TWILIO_ACCOUNT_SID as string,
      authToken: process.env.TWILIO_AUTH_TOKEN as string,
      fromNumber: process.env.TWILIO_FROM_NUMBER as string,
    },
    // No email leg — selectEmailProvider(process.env) === 'none' in prod.
  });
  const raw = new PerTenantTwilioDeliveryProvider({ pool: tripwirePool, base });
  const gate = new GatedMessageDelivery({
    base: raw,
    dnc: new InMemoryDncRepository(),
    auditRepo: new InMemoryAuditRepository(),
    enforcement: 'block', // prod default when TCPA_CONSENT_ENFORCEMENT is unset
  });
  return { gate, raw, base };
}

const customer: any = {
  id: '22222222-2222-2222-2222-222222222222',
  displayName: 'Pat Customer',
  firstName: 'Pat',
  lastName: 'Customer',
  primaryPhone: CUST_PHONE,
  email: CUST_EMAIL,
  smsConsent: true, // consent GRANTED — only the kill switch can stop this
  preferredLanguage: undefined,
};
const job: any = { id: 'job-1', customerId: customer.id, summary: 'Furnace repair' };
const appointment: any = {
  id: 'appt-1',
  jobId: job.id,
  status: 'scheduled',
  appointmentType: 'service',
  scheduledStart: new Date('2026-08-01T17:00:00Z'),
  timezone: 'America/Los_Angeles',
};
const invoice: any = {
  id: '33333333-3333-3333-3333-333333333333',
  jobId: job.id,
  invoiceNumber: 'INV-1001',
  status: 'open',
  totals: { totalCents: 25000 },
  amountDueCents: 25000,
  dueDate: new Date('2026-08-10T00:00:00Z'),
  viewToken: null,
  viewTokenExpiresAt: null,
};
const estimate: any = {
  id: '44444444-4444-4444-4444-444444444444',
  jobId: job.id,
  estimateNumber: 'EST-2001',
  status: 'draft',
  totals: { totalCents: 25000 },
  viewToken: null,
  viewTokenExpiresAt: null,
  sentAt: null,
};

const settingsRepo: any = {
  findByTenant: async () => ({ businessName: 'Acme HVAC', defaultLanguage: 'en' }),
};
const appointmentRepo: any = { findById: async () => appointment };
const jobRepo: any = { findById: async () => job };
const customerRepo: any = { findById: async () => customer };
const invoiceRepo: any = { findById: async () => invoice, update: async () => invoice };
const estimateRepo: any = { findById: async () => estimate, update: async () => estimate };

describe("production config: TELEPHONY_ENABLED=false + EMAIL_ENABLED=false", () => {
  let gate: GatedMessageDelivery;
  let dispatchRepo: InMemoryDispatchRepository;

  beforeEach(() => {
    applyProdEnv();
    installFetchTripwire();
    logs.length = 0;
    dispatchRepo = new InMemoryDispatchRepository();
    ({ gate } = buildProdStack());
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    restoreEnv();
  });

  // ── 1. The risk is REAL: the decoupling makes the provider live ──────────
  it("RISK CONFIRMED: SMS creds alone now construct a live provider (no email creds needed)", () => {
    expect(selectEmailProvider(process.env)).toBe("none");
    const smsCredsPresent = !!(
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM_NUMBER
    );
    expect(smsCredsPresent).toBe(true);
    // app.ts: `if (smsCredsPresent || emailCredsPresent)` -> provider built.
    // Constructing it here proves it does NOT throw without email creds
    // (pre-36d30807 it threw, which is why prod sent nothing).
    const { gate: g } = buildProdStack();
    expect(g).toBeInstanceOf(GatedMessageDelivery);
    // => rawMessageDelivery non-null => messageDelivery non-null =>
    //    sendService / transactionalComms / every sweep are live objects.
  });

  // ── 2/3. Every path, customer AND owner class, zero outbound HTTP ────────
  const paths: Array<[string, (g: GatedMessageDelivery) => Promise<unknown>]> = [
    [
      "TransactionalCommsService.enqueue (booking confirmation)",
      (g) =>
        new TransactionalCommsService({
          delivery: g, dispatchRepo, pool: null, logger,
          appointmentRepo, jobRepo, customerRepo, settingsRepo, invoiceRepo,
        } as any).enqueue({ tenantId: TENANT, appointmentId: appointment.id } as any),
    ],
    [
      "TransactionalCommsService.notifyReminder (hourly reminder sweep)",
      (g) =>
        new TransactionalCommsService({
          delivery: g, dispatchRepo, pool: null, logger,
          appointmentRepo, jobRepo, customerRepo, settingsRepo, invoiceRepo,
        } as any).notifyReminder(TENANT, appointment.id, 24),
    ],
    [
      "TransactionalCommsService.notifyRescheduled",
      (g) =>
        new TransactionalCommsService({
          delivery: g, dispatchRepo, pool: null, logger,
          appointmentRepo, jobRepo, customerRepo, settingsRepo, invoiceRepo,
        } as any).notifyRescheduled(TENANT, appointment.id, "occ-1"),
    ],
    [
      "TransactionalCommsService.notifyCanceled",
      (g) =>
        new TransactionalCommsService({
          delivery: g, dispatchRepo, pool: null, logger,
          appointmentRepo, jobRepo, customerRepo, settingsRepo, invoiceRepo,
        } as any).notifyCanceled(TENANT, appointment.id),
    ],
    [
      "TransactionalCommsService.notifyPaymentReceived (payment receipt)",
      (g) =>
        new TransactionalCommsService({
          delivery: g, dispatchRepo, pool: null, logger,
          appointmentRepo, jobRepo, customerRepo, settingsRepo, invoiceRepo,
        } as any).notifyPaymentReceived(TENANT, invoice.id, 25000, "pay-1"),
    ],
    [
      "TransactionalCommsService.notifyInvoiceOverdue (dunning sweep)",
      (g) =>
        new TransactionalCommsService({
          delivery: g, dispatchRepo, pool: null, logger,
          appointmentRepo, jobRepo, customerRepo, settingsRepo, invoiceRepo,
        } as any).notifyInvoiceOverdue(TENANT, invoice.id, "occ-1"),
    ],
    [
      "SendService.sendEstimate",
      (g) =>
        new SendService({
          delivery: g, estimateRepo, invoiceRepo, jobRepo, customerRepo,
          settingsRepo, dispatchRepo, publicBaseUrl: "https://app.invalid",
        } as any)
          .sendEstimate({ tenantId: TENANT, estimateId: estimate.id, channel: "both" } as any)
          .catch((e) => e),
    ],
    [
      "SendService.sendInvoice",
      (g) =>
        new SendService({
          delivery: g, estimateRepo, invoiceRepo, jobRepo, customerRepo,
          settingsRepo, dispatchRepo, publicBaseUrl: "https://app.invalid",
        } as any)
          .sendInvoice({ tenantId: TENANT, invoiceId: invoice.id, channel: "both" } as any)
          .catch((e) => e),
    ],
    [
      "MessageDeliveryFeedbackDispatcher.send (review-request sweep)",
      (g) =>
        new MessageDeliveryFeedbackDispatcher(g)
          .send({
            tenantId: TENANT, to: CUST_PHONE, body: "How did we do?",
            customerId: customer.id, smsConsent: true,
          } as any)
          .catch((e) => e),
    ],
    [
      "TwilioDelayNotificationService.sendDelayNotice (SMS)",
      (g) =>
        new TwilioDelayNotificationService(g, dispatchRepo, customerRepo)
          .sendDelayNotice({
            tenantId: TENANT, customerId: customer.id, channel: "sms",
            destination: CUST_PHONE, message: "Running late", idempotencyKey: "d1",
          })
          .catch((e) => e),
    ],
    [
      "TwilioDelayNotificationService.sendDelayNotice (email)",
      (g) =>
        new TwilioDelayNotificationService(g, dispatchRepo, customerRepo)
          .sendDelayNotice({
            tenantId: TENANT, customerId: customer.id, channel: "email",
            destination: CUST_EMAIL, message: "Running late", idempotencyKey: "d2",
          })
          .catch((e) => e),
    ],
    [
      "sendCustomerMessage (shared customer send path)",
      (g) =>
        sendCustomerMessage(
          { delivery: g, dispatchRepo, pool: null, logger } as any,
          {
            tenantId: TENANT, customer, entityType: "appointment_confirmation",
            entityId: appointment.id, channels: ["sms", "email"],
            smsBody: "hi", emailSubject: "hi", emailText: "hi",
            idempotencyKeyPrefix: "k1",
          } as any,
        ),
    ],
    [
      "oneTapSmsSender (OWNER class — one-tap approval link)",
      (g) => g.sendSms({ to: OWNER_PHONE, body: "Tap to approve", recipientClass: "owner" }),
    ],
    [
      "emergencySmsSender (OWNER class — emergency page)",
      (g) =>
        g.sendSms({
          to: OWNER_PHONE, body: "EMERGENCY: no-heat call", tenantId: TENANT,
          recipientClass: "owner",
        }),
    ],
    [
      "daily digest / HFCR weekly summary (OWNER class)",
      (g) =>
        g.sendSms({
          to: OWNER_PHONE, body: "Your daily digest", tenantId: TENANT,
          recipientClass: "owner",
        }),
    ],
    [
      "dropped-call recovery SMS (customer class, 30s sweep)",
      (g) =>
        g.sendSms({
          to: CUST_PHONE, body: "Sorry we missed you", tenantId: TENANT,
          idempotencyKey: "rec-1", recipientClass: "customer",
          consent: { smsConsent: true, customerId: customer.id },
        }),
    ],
    [
      "lifecycle email worker (sendLifecycleEmail)",
      async (g) => {
        const pool: any = { query: async () => ({ rowCount: 1, rows: [{ tenant_id: TENANT }] }) };
        return sendLifecycleEmail(
          { pool, delivery: g, logger } as any,
          {
            tenantId: TENANT, kind: "welcome", to: "owner@acme.test",
            rendered: { subject: "Welcome", text: "hi", html: "<p>hi</p>" },
          } as any,
        ).catch((e) => e);
      },
    ],
  ];

  it.each(paths)("no outbound HTTP from: %s", async (_name, drive) => {
    const before = gate.killSwitchSuppressionCounts();
    // A thrown SmsSuppressedError / EmailSuppressedError IS the correct
    // outcome for the direct-gate drives. Only a TRIPWIRE error (= a real
    // network send was attempted) would be a bug.
    const outcome = await Promise.resolve(drive(gate)).catch((e) => e);
    if (outcome instanceof Error) {
      expect(outcome.message).not.toContain("TRIPWIRE");
    }
    const after = gate.killSwitchSuppressionCounts();
    // Proof the path actually REACHED the delivery boundary (not that it
    // crashed harmlessly earlier): the kill-switch counter moved.
    expect(
      after.sms + after.email,
      "path never reached the kill switch — test would be a false pass",
    ).toBeGreaterThan(before.sms + before.email);
    expectNoOutbound();
  });
});

/**
 * NEGATIVE CONTROL. Without this the suite above is vacuous: it must be shown
 * that the SAME stack, driven the SAME way, DOES reach api.twilio.com when the
 * kill switch is off. This is also the proof that production is one flag away
 * from live traffic.
 */
describe("negative control — flags unset means the tripwire DOES fire", () => {
  beforeEach(() => {
    applyProdEnv();
    delete process.env.TELEPHONY_ENABLED;
    delete process.env.EMAIL_ENABLED;
    installFetchTripwire();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    restoreEnv();
  });

  it("owner SMS reaches api.twilio.com when TELEPHONY_ENABLED is unset", async () => {
    // Global provider only (no per-tenant pool), so the send goes straight out.
    const base = new TwilioDeliveryProvider({
      sms: {
        accountSid: process.env.TWILIO_ACCOUNT_SID as string,
        authToken: process.env.TWILIO_AUTH_TOKEN as string,
        fromNumber: process.env.TWILIO_FROM_NUMBER as string,
      },
    });
    const g = new GatedMessageDelivery({
      base,
      dnc: new InMemoryDncRepository(),
      auditRepo: new InMemoryAuditRepository(),
      enforcement: "block",
    });
    const err = await g
      .sendSms({ to: OWNER_PHONE, body: "digest", recipientClass: "owner" })
      .catch((e) => e);
    expect(String(err)).toContain("TRIPWIRE");
    expect(fetchCalls.some((u) => u.includes("api.twilio.com"))).toBe(true);
    expect(g.killSwitchSuppressionCounts()).toEqual({ sms: 0, email: 0 });
  });

  it("customer email reaches comms.twilio.com when EMAIL_ENABLED is unset", async () => {
    process.env.TWILIO_EMAIL_FROM_ADDRESS = "no-reply@acme.test";
    const base = new TwilioDeliveryProvider({
      twilioEmail: {
        accountSid: process.env.TWILIO_ACCOUNT_SID as string,
        authToken: process.env.TWILIO_AUTH_TOKEN as string,
        fromAddress: "no-reply@acme.test",
      },
    } as any);
    const g = new GatedMessageDelivery({
      base,
      dnc: new InMemoryDncRepository(),
      auditRepo: new InMemoryAuditRepository(),
      enforcement: "block",
    });
    const err = await g
      .sendEmail({ to: CUST_EMAIL, subject: "s", text: "t", tenantId: TENANT })
      .catch((e) => e);
    expect(String(err)).toContain("TRIPWIRE");
    expect(fetchCalls.some((u) => u.includes("comms.twilio.com"))).toBe(true);
  });
});

/** Channel independence + observability under production's env. */
describe("kill switch: independence and observability", () => {
  beforeEach(() => {
    applyProdEnv();
    installFetchTripwire();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    restoreEnv();
  });

  it("SMS off / email on suppresses only SMS", async () => {
    delete process.env.EMAIL_ENABLED;
    process.env.TWILIO_EMAIL_FROM_ADDRESS = "no-reply@acme.test";
    const base = new TwilioDeliveryProvider({
      sms: {
        accountSid: process.env.TWILIO_ACCOUNT_SID as string,
        authToken: process.env.TWILIO_AUTH_TOKEN as string,
        fromNumber: process.env.TWILIO_FROM_NUMBER as string,
      },
      twilioEmail: {
        accountSid: process.env.TWILIO_ACCOUNT_SID as string,
        authToken: process.env.TWILIO_AUTH_TOKEN as string,
        fromAddress: "no-reply@acme.test",
      },
    } as any);
    const g = new GatedMessageDelivery({
      base,
      dnc: new InMemoryDncRepository(),
      auditRepo: new InMemoryAuditRepository(),
      enforcement: "block",
    });
    const smsErr = await g
      .sendSms({ to: OWNER_PHONE, body: "b", recipientClass: "owner" })
      .catch((e) => e);
    expect(smsErr).toBeInstanceOf(SmsSuppressedError);
    const emailErr = await g
      .sendEmail({ to: CUST_EMAIL, subject: "s", text: "t" })
      .catch((e) => e);
    expect(emailErr).not.toBeInstanceOf(EmailSuppressedError);
    expect(String(emailErr)).toContain("TRIPWIRE");
    expect(g.killSwitchSuppressionCounts()).toEqual({ sms: 1, email: 0 });
  });

  it("suppression is observable and never logs the full phone or address", async () => {
    const captured: any[] = [];
    const g = new GatedMessageDelivery({
      base: new TwilioDeliveryProvider({
        sms: {
          accountSid: process.env.TWILIO_ACCOUNT_SID as string,
          authToken: process.env.TWILIO_AUTH_TOKEN as string,
          fromNumber: process.env.TWILIO_FROM_NUMBER as string,
        },
      }),
      dnc: new InMemoryDncRepository(),
      auditRepo: new InMemoryAuditRepository(),
      enforcement: "block",
      logger: { info: (m: string, meta?: any) => captured.push({ m, meta }) } as any,
    });
    await g
      .sendSms({ to: CUST_PHONE, body: "b", tenantId: TENANT, recipientClass: "customer" })
      .catch(() => undefined);
    await g.sendEmail({ to: CUST_EMAIL, subject: "s", text: "t", tenantId: TENANT }).catch(() => undefined);
    expect(captured).toHaveLength(2);
    expect(captured[0].meta.reason).toBe("channel_disabled");
    expect(captured[0].meta.channel).toBe("sms");
    expect(captured[1].meta.channel).toBe("email");
    const blob = JSON.stringify(captured);
    expect(blob).not.toContain(CUST_PHONE);
    expect(blob).not.toContain("15551230000");
    expect(blob).not.toContain(CUST_EMAIL);
    expect(blob).toContain("example.com"); // domain only
    expect(g.killSwitchSuppressionCounts()).toEqual({ sms: 1, email: 1 });
  });
});
