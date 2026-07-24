import type { Pool } from 'pg';
import type { WorkerHandler, QueueMessage } from '../queues/queue';
import type { Logger } from '../logging/logger';
import type { StorageProvider } from '../files/file-service';
import {
  deprovisionTenant,
  type DeprovisionReason,
} from '../tenants/deprovision';

export const DEPROVISION_TENANT_JOB_TYPE = 'deprovision_tenant';

export interface DeprovisionTenantPayload {
  tenantId: string;
  reason: DeprovisionReason;
  actorId: string;
  force?: boolean;
}

export function createDeprovisionTenantWorker(deps: {
  pool: Pool;
  /** Comms C6 — deletes the tenant's stored objects during the purge. */
  storage?: StorageProvider;
}): WorkerHandler<DeprovisionTenantPayload> {
  return {
    type: DEPROVISION_TENANT_JOB_TYPE,

    async handle(message: QueueMessage<DeprovisionTenantPayload>, logger: Logger): Promise<void> {
      const result = await deprovisionTenant(
        { pool: deps.pool, logger, storage: deps.storage },
        message.payload,
      );
      if (result.alreadyPurged) {
        logger.info('Deprovision job: tenant already purged', {
          tenantId: message.payload.tenantId,
        });
      }
    },
  };
}
