/**
 * Event-driven onboarding email worker.
 *
 * Today it handles the `welcome` email enqueued by the Clerk `user.created`
 * webhook right after a brand-new tenant is bootstrapped. The time-based
 * onboarding emails (setup reminder, trial-ending) are handled by the
 * cross-tenant sweeps (setup-reminder-sweep / trial-reminder-sweep) rather
 * than the queue, since they fire relative to wall-clock time, not an event.
 *
 * All three share the same at-most-once send path (`sendLifecycleEmail`), so
 * a webhook/queue retry can never double-send the welcome.
 */
import type { Pool } from 'pg';
import type { Logger } from '../logging/logger';
import type { QueueMessage, WorkerHandler } from '../queues/queue';
import type { MessageDeliveryProvider } from '../notifications/delivery-provider';
import type { SettingsRepository } from '../settings/settings';
import { AuditRepository } from '../audit/audit';
import { renderWelcomeEmail } from '../notifications/templates';
import {
  sendLifecycleEmail,
  type LifecycleEmailKind,
} from '../notifications/lifecycle-email';

export const LIFECYCLE_EMAIL_JOB_TYPE = 'lifecycle_email';

export interface LifecycleEmailPayload {
  tenantId: string;
  ownerEmail: string;
  kind: LifecycleEmailKind;
}

export interface LifecycleEmailWorkerDeps {
  delivery: MessageDeliveryProvider | null;
  pool: Pool | null;
  settingsRepo: SettingsRepository;
  auditRepo?: AuditRepository;
  /** Absolute web origin for CTA links, e.g. https://app.rivet.ai (no slash). */
  appBaseUrl: string;
  supportEmail: string;
  logger: Logger;
}

export function createLifecycleEmailWorker(
  deps: LifecycleEmailWorkerDeps,
): WorkerHandler<LifecycleEmailPayload> {
  return {
    type: LIFECYCLE_EMAIL_JOB_TYPE,
    async handle(message: QueueMessage<LifecycleEmailPayload>, logger: Logger): Promise<void> {
      const { tenantId, ownerEmail, kind } = message.payload;

      if (kind !== 'welcome') {
        // The sweeps own the time-based kinds; the queue only carries welcome.
        logger.warn('Lifecycle email worker: unsupported kind for queue path', { kind });
        return;
      }
      if (!ownerEmail) {
        logger.warn('Lifecycle email worker: missing ownerEmail; skipping', { tenantId });
        return;
      }

      // Best-effort business name — the welcome fires before the identity step,
      // so this is usually absent and the copy reads fine without it.
      const businessName = await deps.settingsRepo
        .findByTenant(tenantId)
        .then((s) => s?.businessName ?? undefined)
        .catch(() => undefined);

      const rendered = renderWelcomeEmail({
        businessName,
        appBaseUrl: deps.appBaseUrl,
        supportEmail: deps.supportEmail,
      });

      const outcome = await sendLifecycleEmail(
        {
          pool: deps.pool,
          delivery: deps.delivery,
          auditRepo: deps.auditRepo,
          logger,
        },
        { tenantId, kind, to: ownerEmail, rendered },
      );

      logger.info('Welcome email processed', { tenantId, outcome });
    },
  };
}
