/**
 * F17 / P15-001 — Per-tenant accounting integrations (QuickBooks Online v1;
 * Xero enum reserved for future).
 */

export type AccountingProvider = 'quickbooks' | 'xero';

export type AccountingIntegrationStatus =
  | 'active'
  | 'expired'
  | 'disconnected'
  | 'error';

export type AccountingSyncEntityType = 'invoice' | 'customer' | 'payment';

export type AccountingSyncAction = 'push' | 'pull' | 'conflict';

export type AccountingSyncStatus = 'success' | 'failed';

export interface AccountingIntegration {
  id: string;
  tenantId: string;
  provider: AccountingProvider;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  /** QBO company id (realm). Scoped per tenant — never shared across tenants. */
  realmId: string;
  connectedAt: Date;
  lastSyncedAt: Date | null;
  status: AccountingIntegrationStatus;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertAccountingIntegrationInput {
  tenantId: string;
  provider: AccountingProvider;
  accessToken: string;
  refreshToken: string;
  realmId: string;
}

export interface AccountingSyncLogEntry {
  id: string;
  tenantId: string;
  integrationId: string;
  entityType: AccountingSyncEntityType;
  entityId: string;
  externalId: string | null;
  action: AccountingSyncAction;
  status: AccountingSyncStatus;
  payloadHash: string;
  errorMessage: string | null;
  syncedAt: Date;
}

export interface CreateAccountingSyncLogInput {
  tenantId: string;
  integrationId: string;
  entityType: AccountingSyncEntityType;
  entityId: string;
  externalId?: string | null;
  action: AccountingSyncAction;
  status: AccountingSyncStatus;
  payloadHash: string;
  errorMessage?: string | null;
}

export interface AccountingIntegrationRepository {
  upsert(input: UpsertAccountingIntegrationInput): Promise<AccountingIntegration>;
  findByTenant(tenantId: string, provider?: AccountingProvider): Promise<AccountingIntegration | null>;
  /** Cross-tenant sweep driver — only active integrations. */
  findAllActive(): Promise<AccountingIntegration[]>;
  updateLastSyncedAt(tenantId: string, id: string, at: Date): Promise<void>;
  setStatus(
    tenantId: string,
    id: string,
    status: AccountingIntegrationStatus,
    errorMessage?: string | null,
  ): Promise<AccountingIntegration | null>;
  updateTokens(
    tenantId: string,
    id: string,
    accessTokenEncrypted: string,
    refreshTokenEncrypted: string,
  ): Promise<AccountingIntegration | null>;
  disconnect(tenantId: string, provider: AccountingProvider): Promise<boolean>;
}

export interface AccountingSyncLogRepository {
  create(input: CreateAccountingSyncLogInput): Promise<AccountingSyncLogEntry>;
  findSuccessfulPush(
    tenantId: string,
    integrationId: string,
    entityType: AccountingSyncEntityType,
    entityId: string,
    payloadHash: string,
  ): Promise<AccountingSyncLogEntry | null>;
  /** Latest external QBO id for an internal customer. */
  findExternalIdForEntity(
    tenantId: string,
    integrationId: string,
    entityType: AccountingSyncEntityType,
    entityId: string,
  ): Promise<string | null>;
  countRecentFailures(tenantId: string, integrationId: string, since: Date): Promise<number>;
  listRecent(
    tenantId: string,
    integrationId: string,
    limit?: number,
  ): Promise<AccountingSyncLogEntry[]>;
}

export interface AccountingOAuthStateRepository {
  create(input: {
    tenantId: string;
    userId: string;
    provider: AccountingProvider;
    redirectAfter?: string;
  }): Promise<{ id: string }>;
  consume(id: string): Promise<{
    tenantId: string;
    userId: string;
    provider: AccountingProvider;
    redirectAfter?: string;
  } | null>;
}
