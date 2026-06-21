import { WorkerHandler, QueueMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import {
  PUSH_NOTIFICATION_JOB_TYPE,
  PushNotificationJob,
  PushNotificationJobSchema,
} from '@ai-service-os/shared';
import { DeviceTokenRepository } from '../devices/device-token-repository';
import { PushDeliveryProvider } from '../notifications/push-delivery-provider';
import { AuditRepository, createAuditEvent } from '../audit/audit';

export interface PushNotificationWorkerDeps {
  deviceTokenRepo: DeviceTokenRepository;
  pushProvider: PushDeliveryProvider;
  auditRepo: AuditRepository;
}

/**
 * push-notification worker (mobile) — sends a queued push to a tenant's
 * registered devices, prunes dead tokens, and writes a system-actor audit.
 *
 * RLS: token selection goes through `deviceTokenRepo.listByTenant`, which
 * sets `app.current_tenant_id` on a pooled connection
 * (`PgBaseRepository.withTenant`). The worker never touches the table on an
 * unscoped connection, so a push can only ever target the originating
 * tenant's devices.
 *
 * Audit: the worker has no `req.auth`, so it synthesizes a system actor —
 * `createAuditEvent` throws on a falsy `actorId`.
 */
export function createPushNotificationWorker(
  deps: PushNotificationWorkerDeps,
): WorkerHandler<PushNotificationJob> {
  return {
    type: PUSH_NOTIFICATION_JOB_TYPE,
    async handle(message: QueueMessage<PushNotificationJob>, logger: Logger): Promise<void> {
      // Re-validate at the worker boundary — queue payloads are JSON blobs.
      const job = PushNotificationJobSchema.parse(message.payload);

      const tokens = await deps.deviceTokenRepo.listByTenant(job.tenantId, job.userId);
      if (tokens.length === 0) {
        logger.info('push.send: no registered devices', {
          tenantId: job.tenantId,
          userId: job.userId,
        });
        return;
      }

      let delivered = 0;
      let pruned = 0;
      const failures: string[] = [];

      for (const device of tokens) {
        let result;
        try {
          result = await deps.pushProvider.sendPush({
            token: device.token,
            platform: device.platform,
            title: job.title,
            body: job.body,
            data: job.data,
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          failures.push(error.message);
          logger.warn('push.send: provider error', { error: error.message });
          continue;
        }

        if (result.success) {
          delivered++;
        } else if (result.unregistered) {
          // Dead token — prune so we stop targeting it.
          await deps.deviceTokenRepo.deleteToken(job.tenantId, device.token);
          pruned++;
        } else {
          failures.push(result.error ?? 'unknown push failure');
        }
      }

      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: job.tenantId,
          actorId: job.actorId ?? 'system',
          actorRole: 'system',
          eventType: 'push.sent',
          entityType: 'device_push',
          entityId: job.userId ?? job.tenantId,
          correlationId: job.correlationId,
          metadata: {
            recipients: tokens.length,
            delivered,
            pruned,
            failures: failures.length,
          },
        }),
      );

      logger.info('push.send complete', {
        tenantId: job.tenantId,
        recipients: tokens.length,
        delivered,
        pruned,
        failures: failures.length,
      });
    },
  };
}
