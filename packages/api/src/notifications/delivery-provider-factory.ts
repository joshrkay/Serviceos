import type { Pool } from 'pg';
import {
  InMemoryDeliveryProvider,
  type MessageDeliveryProvider,
} from './delivery-provider';
import { TwilioDeliveryProvider } from './twilio-delivery-provider';
import { selectEmailProvider } from './twilio-email-delivery-provider';
import { PerTenantTwilioDeliveryProvider } from './per-tenant-twilio-delivery-provider';
import { isTwilioDeploymentEnv } from '../integrations/credentials';

/**
 * Which delivery provider a given environment gets. Pure-ish (constructs the
 * provider objects, touches nothing else) so app.ts's wiring decision is
 * unit-testable without booting createApp() — same rationale as
 * `selectEmailProvider`.
 *
 * THE INVARIANT THIS FILE EXISTS TO ENFORCE
 * -----------------------------------------
 * A non-production environment is STRUCTURALLY INCAPABLE of sending real
 * SMS/email. Not "capable but flagged off" — incapable.
 *
 * History: 36d30807 correctly decoupled the SMS and email credential legs so
 * production, which has Twilio creds but no SendGrid key, could send SMS. But
 * the branch that chose a real provider keyed only on "are credentials
 * present?", and Development HAS Twilio credentials. So Development silently
 * got promoted from InMemoryDeliveryProvider to a real
 * PerTenantTwilioDeliveryProvider over a real TwilioDeliveryProvider. Combined
 * with `isTwilioDeploymentEnv` in integrations/credentials.ts — under which a
 * Dev tenant with no tenant_integrations row falls back to the GLOBAL Twilio
 * account and from-number — Development became able to text real customers
 * from the real business number. Only TELEPHONY_ENABLED=false stopped it.
 *
 * The environment gate now comes FIRST, before any credential check. The
 * credential legs stay independent inside prod/staging, so 36d30807's fix is
 * preserved: SMS still works with no email credentials at all.
 */

/**
 * The one deliberate escape hatch. Named after the established
 * `E2E_DB_ALLOW_UNSAFE` convention (e2e/fixtures/safety.ts) — an explicit
 * "I know this is dangerous and I mean it" opt-in, default off.
 *
 * Setting this in a non-production environment lets that environment
 * construct REAL Twilio/SendGrid providers and send to REAL phone numbers and
 * inboxes, billed to the real account. Boot logs a prominent warning whenever
 * it is engaged.
 */
export const DELIVERY_ALLOW_REAL_PROVIDERS = 'DELIVERY_ALLOW_REAL_PROVIDERS';

/**
 * - `real`      — a live Twilio/SendGrid-backed provider. Bytes leave the box.
 * - `in-memory` — dispatch rows are recorded, nothing is sent.
 * - `none`      — no provider at all; send routes answer 503.
 */
export type DeliveryMode = 'real' | 'in-memory' | 'none';

export interface DeliveryWiringLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface MessageDeliveryWiring {
  provider: MessageDeliveryProvider | null;
  mode: DeliveryMode;
  /** True when the real provider carries an SMS leg. */
  smsConfigured: boolean;
  /** Which email backend the real provider carries, if any. */
  emailProvider: 'twilio-email' | 'sendgrid' | 'none';
  /** True when a non-production env opted in to real providers. */
  escapeHatchEngaged: boolean;
}

/**
 * True when this environment is allowed to construct real delivery providers:
 * a real deployment, or a non-deployment that explicitly opted in.
 *
 * Reuses `isTwilioDeploymentEnv` — the codebase's existing exported prod-like
 * predicate — rather than a fourth private copy of `isProductionLike`. That is
 * deliberate: it is the SAME predicate that decides whether a tenant may fall
 * back to the global Twilio account, so the two decisions can never disagree
 * and leave a non-prod env holding real credentials.
 */
export function realDeliveryProvidersAllowed(
  nodeEnv: string | undefined,
  env: Record<string, string | undefined>
): boolean {
  return isTwilioDeploymentEnv(nodeEnv) || env[DELIVERY_ALLOW_REAL_PROVIDERS] === 'true';
}

export interface CreateMessageDeliveryOptions {
  /** `config.NODE_ENV` — the NORMALIZED value ('dev' | 'test' | 'staging' | 'prod'). */
  nodeEnv: string;
  /** Usually `process.env`. */
  env: Record<string, string | undefined>;
  /** Pg pool, when available — enables per-tenant Twilio subaccount routing. */
  pool: Pool | null | undefined;
  logger: DeliveryWiringLogger;
}

export function createMessageDeliveryProvider(
  opts: CreateMessageDeliveryOptions
): MessageDeliveryWiring {
  const { nodeEnv, env, pool, logger } = opts;

  const deploymentEnv = isTwilioDeploymentEnv(nodeEnv);
  const optedIn = env[DELIVERY_ALLOW_REAL_PROVIDERS] === 'true';
  const escapeHatchEngaged = !deploymentEnv && optedIn;

  // The two credential legs are INDEPENDENT. Previously a single `if` required
  // all five vars, so production — which has Twilio creds but no SendGrid creds
  // — got no provider and NO SMS, purely for want of an email key. Each leg is
  // wired only if its own credentials are present, and TwilioDeliveryProvider
  // fails loudly at send time on the unconfigured channel (see its config doc).
  const smsCredsPresent = !!(
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    env.TWILIO_FROM_NUMBER
  );
  // Email has TWO possible backends. Twilio-native email (comms.twilio.com,
  // reusing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN — no new secret) when
  // TWILIO_EMAIL_FROM_ADDRESS is set; SendGrid when SENDGRID_API_KEY +
  // SENDGRID_FROM_EMAIL are set; neither ⇒ email unconfigured, which
  // TwilioDeliveryProvider surfaces as a loud DeliveryError at send time.
  // `selectEmailProvider` is the single, unit-tested rule (Twilio-native wins
  // deterministically if both are somehow complete).
  const emailProvider = selectEmailProvider(env);
  const emailCredsPresent = emailProvider !== 'none';

  if (escapeHatchEngaged) {
    logger.warn(
      `${DELIVERY_ALLOW_REAL_PROVIDERS}=true in a NON-PRODUCTION environment — ` +
        'real SMS/email will be sent to real phone numbers and inboxes and billed ' +
        'to the real Twilio/SendGrid account. Unset it unless you are deliberately ' +
        'testing live delivery.',
      { nodeEnv, smsCredsPresent, emailProvider }
    );
  }

  // ENVIRONMENT GATE FIRST. Credentials alone never promote a non-production
  // environment to real delivery.
  if (!deploymentEnv && !optedIn) {
    logger.info('Message delivery mode: in-memory (non-production environment)', {
      nodeEnv,
      mode: 'in-memory',
      // Named so it is obvious in the boot log that creds were present and
      // deliberately ignored, rather than absent.
      credentialsPresentButIgnored: smsCredsPresent || emailCredsPresent,
      escapeHatch: DELIVERY_ALLOW_REAL_PROVIDERS,
    });
    // `allowInProduction` intentionally left false: this branch is unreachable
    // when config.NODE_ENV normalizes to 'prod', so if InMemoryDeliveryProvider's
    // own production guard ever fires here it means process.env.NODE_ENV and the
    // parsed config disagree — which must fail loud, not be papered over.
    return {
      provider: new InMemoryDeliveryProvider(),
      mode: 'in-memory',
      smsConfigured: false,
      emailProvider: 'none',
      escapeHatchEngaged,
    };
  }

  if (!smsCredsPresent && !emailCredsPresent) {
    if (deploymentEnv) {
      // prod/staging with nothing configured: no provider. Never InMemory here —
      // send routes must 503 rather than silently swallow customer messages.
      logger.warn('Message delivery mode: none — no Twilio/SendGrid credentials configured', {
        nodeEnv,
        mode: 'none',
      });
      return {
        provider: null,
        mode: 'none',
        smsConfigured: false,
        emailProvider: 'none',
        escapeHatchEngaged,
      };
    }
    // Opted in but nothing to opt in WITH. Fall back to in-memory so the app
    // still boots in dev; the flag permits real providers, it doesn't demand one.
    logger.warn(
      `${DELIVERY_ALLOW_REAL_PROVIDERS}=true but no Twilio/SendGrid credentials are ` +
        'configured — falling back to in-memory delivery',
      { nodeEnv, mode: 'in-memory' }
    );
    return {
      provider: new InMemoryDeliveryProvider(),
      mode: 'in-memory',
      smsConfigured: false,
      emailProvider: 'none',
      escapeHatchEngaged,
    };
  }

  // Never let the email choice be invisible: if both credential sets are
  // present, say which one actually carries mail.
  if (emailCredsPresent) {
    const sendgridAlsoConfigured = !!(env.SENDGRID_API_KEY && env.SENDGRID_FROM_EMAIL);
    if (emailProvider === 'twilio-email' && sendgridAlsoConfigured) {
      logger.warn(
        'Both Twilio-native email and SendGrid are configured; using Twilio-native email',
        { emailProvider }
      );
    } else {
      logger.info('Email delivery provider selected', { emailProvider });
    }
  }

  // The global Twilio/SendGrid provider handles email and any send that
  // carries no tenantId; the global Twilio SMS creds also serve as the
  // dev/test fallback inside getTenantTwilioCreds.
  const baseDelivery = new TwilioDeliveryProvider({
    ...(smsCredsPresent
      ? {
          sms: {
            accountSid: env.TWILIO_ACCOUNT_SID as string,
            authToken: env.TWILIO_AUTH_TOKEN as string,
            fromNumber: env.TWILIO_FROM_NUMBER as string,
          },
        }
      : {}),
    ...(emailProvider === 'twilio-email'
      ? {
          twilioEmail: {
            accountSid: env.TWILIO_ACCOUNT_SID as string,
            authToken: env.TWILIO_AUTH_TOKEN as string,
            fromAddress: env.TWILIO_EMAIL_FROM_ADDRESS as string,
            fromName: env.TWILIO_EMAIL_FROM_NAME,
          },
        }
      : {}),
    ...(emailProvider === 'sendgrid'
      ? {
          email: {
            apiKey: env.SENDGRID_API_KEY as string,
            fromEmail: env.SENDGRID_FROM_EMAIL as string,
            fromName: env.SENDGRID_FROM_NAME,
            replyToEmail: env.SENDGRID_REPLY_TO_EMAIL,
          },
        }
      : {}),
  });

  // Feature 7 — when a Postgres pool is available, route per-tenant SMS
  // through each tenant's own Twilio subaccount (failing closed when a
  // tenant has no credentials). Without a pool we cannot resolve per-tenant
  // creds, so keep the global provider.
  const provider = pool
    ? new PerTenantTwilioDeliveryProvider({ pool, base: baseDelivery })
    : baseDelivery;

  logger.info('Message delivery mode: REAL — outbound SMS/email will be sent', {
    nodeEnv,
    mode: 'real',
    smsConfigured: smsCredsPresent,
    emailProvider,
    perTenantRouting: !!pool,
    escapeHatchEngaged,
  });

  return {
    provider,
    mode: 'real',
    smsConfigured: smsCredsPresent,
    emailProvider,
    escapeHatchEngaged,
  };
}
