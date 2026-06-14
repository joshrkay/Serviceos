/** Re-export worker entry — sweep logic lives in sync-service. */
export {
  runAccountingSyncSweep,
  type AccountingSyncServiceDeps,
} from '../integrations/accounting/sync-service';

export const ACCOUNTING_SYNC_INTERVAL_MS = 5 * 60 * 1000;
