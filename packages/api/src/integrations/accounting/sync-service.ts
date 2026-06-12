import { Logger } from '../../logging/logger';
import { Customer, CustomerRepository } from '../../customers/customer';
import { Invoice, InvoiceRepository } from '../../invoices/invoice';
import { JobRepository } from '../../jobs/job';
import {
  AccountingIntegration,
  AccountingIntegrationRepository,
  AccountingSyncLogRepository,
} from './types';
import { createAccountingProvider, AccountingProviderClient } from './accounting-provider';
import {
  QuickBooksFetch,
  QuickBooksOAuthConfig,
  refreshQuickBooksTokens,
} from './quickbooks-oauth';
import {
  decryptedAccessToken,
  decryptedRefreshToken,
} from './repository';
import { encryptAccountingToken } from './token-crypto';
import { hashCustomerPayload, hashInvoicePayload } from './payload-hash';

export interface AccountingSyncServiceDeps {
  integrationRepo: AccountingIntegrationRepository;
  syncLogRepo: AccountingSyncLogRepository;
  invoiceRepo: InvoiceRepository;
  customerRepo: CustomerRepository;
  jobRepo: JobRepository;
  qboConfig: QuickBooksOAuthConfig;
  fetchFn?: QuickBooksFetch;
  logger: Logger;
}

export interface TenantSyncResult {
  tenantId: string;
  pushedInvoices: number;
  skippedInvoices: number;
  failedInvoices: number;
}

const MAX_INVOICE_LIMIT = 200;

type TokenPair = { accessToken: string; refreshToken: string };

export class AccountingSyncService {
  constructor(private readonly deps: AccountingSyncServiceDeps) {}

  async syncIntegration(integration: AccountingIntegration): Promise<TenantSyncResult> {
    const tenantId = integration.tenantId;
    const result: TenantSyncResult = {
      tenantId,
      pushedInvoices: 0,
      skippedInvoices: 0,
      failedInvoices: 0,
    };

    let tokens: TokenPair;
    try {
      tokens = {
        accessToken: decryptedAccessToken(integration),
        refreshToken: decryptedRefreshToken(integration),
      };
    } catch (err) {
      await this.deps.integrationRepo.setStatus(
        tenantId,
        integration.id,
        'error',
        err instanceof Error ? err.message : String(err),
      );
      return result;
    }

    const invoices = await this.deps.invoiceRepo.findByTenant(tenantId, {
      status: 'paid',
      limit: MAX_INVOICE_LIMIT,
    });

    for (const invoice of invoices) {
      const outcome = await this.pushPaidInvoice(integration, tokens, invoice);
      tokens = outcome.tokens;
      if (outcome.skipped) result.skippedInvoices += 1;
      else if (outcome.pushed) result.pushedInvoices += 1;
      else result.failedInvoices += 1;
    }

    await this.deps.integrationRepo.updateLastSyncedAt(tenantId, integration.id, new Date());
    return result;
  }

  private makeClient(integration: AccountingIntegration, accessToken: string): AccountingProviderClient {
    return createAccountingProvider(integration, accessToken, {
      fetchFn: this.deps.fetchFn ?? fetch,
      qboConfig: this.deps.qboConfig,
    });
  }

  private async refreshIfNeeded(
    integration: AccountingIntegration,
    tokens: TokenPair,
    err: unknown,
  ): Promise<TokenPair> {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.toLowerCase().includes('401') && !message.toLowerCase().includes('token')) {
      throw err;
    }
    const refreshed = await refreshQuickBooksTokens(
      this.deps.qboConfig,
      tokens.refreshToken,
      this.deps.fetchFn ?? fetch,
    );
    await this.deps.integrationRepo.updateTokens(
      integration.tenantId,
      integration.id,
      encryptAccountingToken(refreshed.accessToken),
      encryptAccountingToken(refreshed.refreshToken),
    );
    return refreshed;
  }

  private async pushPaidInvoice(
    integration: AccountingIntegration,
    tokens: TokenPair,
    invoice: Invoice,
  ): Promise<{ pushed: boolean; skipped: boolean; tokens: TokenPair }> {
    const tenantId = integration.tenantId;
    const payloadHash = hashInvoicePayload(invoice);
    const existing = await this.deps.syncLogRepo.findSuccessfulPush(
      tenantId,
      integration.id,
      'invoice',
      invoice.id,
      payloadHash,
    );
    if (existing) {
      return { pushed: false, skipped: true, tokens };
    }

    const job = await this.deps.jobRepo.findById(tenantId, invoice.jobId);
    if (!job) {
      await this.logFailure(integration, 'invoice', invoice.id, payloadHash, 'Job not found');
      return { pushed: false, skipped: false, tokens };
    }

    const customer = await this.deps.customerRepo.findById(tenantId, job.customerId);
    if (!customer) {
      await this.logFailure(integration, 'invoice', invoice.id, payloadHash, 'Customer not found');
      return { pushed: false, skipped: false, tokens };
    }

    try {
      const customerOut = await this.ensureCustomerExternalId(integration, tokens, customer);
      tokens = customerOut.tokens;

      let client = this.makeClient(integration, tokens.accessToken);
      try {
        const created = await client.createSalesReceipt(
          {
            customerRefId: customerOut.externalId,
            docNumber: invoice.invoiceNumber,
            totalCents: invoice.totals.totalCents,
            lineDescriptions: invoice.lineItems.map((li) => li.description),
            txnDate: (invoice.issuedAt ?? invoice.updatedAt).toISOString().slice(0, 10),
          },
          `invoice-${invoice.id}-${payloadHash.slice(0, 16)}`,
        );
        await this.deps.syncLogRepo.create({
          tenantId,
          integrationId: integration.id,
          entityType: 'invoice',
          entityId: invoice.id,
          externalId: created.id,
          action: 'push',
          status: 'success',
          payloadHash,
        });
        return { pushed: true, skipped: false, tokens };
      } catch (err) {
        tokens = await this.refreshIfNeeded(integration, tokens, err);
        client = this.makeClient(integration, tokens.accessToken);
        const created = await client.createSalesReceipt(
          {
            customerRefId: customerOut.externalId,
            docNumber: invoice.invoiceNumber,
            totalCents: invoice.totals.totalCents,
            lineDescriptions: invoice.lineItems.map((li) => li.description),
            txnDate: (invoice.issuedAt ?? invoice.updatedAt).toISOString().slice(0, 10),
          },
          `invoice-${invoice.id}-${payloadHash.slice(0, 16)}`,
        );
        await this.deps.syncLogRepo.create({
          tenantId,
          integrationId: integration.id,
          entityType: 'invoice',
          entityId: invoice.id,
          externalId: created.id,
          action: 'push',
          status: 'success',
          payloadHash,
        });
        return { pushed: true, skipped: false, tokens };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.logFailure(integration, 'invoice', invoice.id, payloadHash, message);
      if (message.toLowerCase().includes('token')) {
        await this.deps.integrationRepo.setStatus(tenantId, integration.id, 'expired', message);
      }
      return { pushed: false, skipped: false, tokens };
    }
  }

  private async ensureCustomerExternalId(
    integration: AccountingIntegration,
    tokens: TokenPair,
    customer: Customer,
  ): Promise<{ externalId: string; tokens: TokenPair }> {
    const tenantId = integration.tenantId;
    const payloadHash = hashCustomerPayload(customer);
    const cached = await this.deps.syncLogRepo.findExternalIdForEntity(
      tenantId,
      integration.id,
      'customer',
      customer.id,
    );
    if (cached) {
      return { externalId: cached, tokens };
    }

    const dup = await this.deps.syncLogRepo.findSuccessfulPush(
      tenantId,
      integration.id,
      'customer',
      customer.id,
      payloadHash,
    );
    if (dup?.externalId) {
      return { externalId: dup.externalId, tokens };
    }

    let client = this.makeClient(integration, tokens.accessToken);
    try {
      const created = await client.createCustomer(
        {
          displayName: customer.displayName,
          email: customer.email,
          phone: customer.primaryPhone,
        },
        `customer-${customer.id}`,
      );
      await this.deps.syncLogRepo.create({
        tenantId,
        integrationId: integration.id,
        entityType: 'customer',
        entityId: customer.id,
        externalId: created.id,
        action: 'push',
        status: 'success',
        payloadHash,
      });
      return { externalId: created.id, tokens };
    } catch (err) {
      tokens = await this.refreshIfNeeded(integration, tokens, err);
      client = this.makeClient(integration, tokens.accessToken);
      const created = await client.createCustomer(
        {
          displayName: customer.displayName,
          email: customer.email,
          phone: customer.primaryPhone,
        },
        `customer-${customer.id}`,
      );
      await this.deps.syncLogRepo.create({
        tenantId,
        integrationId: integration.id,
        entityType: 'customer',
        entityId: customer.id,
        externalId: created.id,
        action: 'push',
        status: 'success',
        payloadHash,
      });
      return { externalId: created.id, tokens };
    }
  }

  private async logFailure(
    integration: AccountingIntegration,
    entityType: 'invoice' | 'customer',
    entityId: string,
    payloadHash: string,
    errorMessage: string,
  ): Promise<void> {
    await this.deps.syncLogRepo.create({
      tenantId: integration.tenantId,
      integrationId: integration.id,
      entityType,
      entityId,
      action: 'push',
      status: 'failed',
      payloadHash,
      errorMessage,
    });
    this.deps.logger.warn('Accounting sync push failed', {
      tenantId: integration.tenantId,
      entityType,
      entityId,
      errorMessage,
    });
  }
}

export async function runAccountingSyncSweep(
  deps: AccountingSyncServiceDeps,
): Promise<{ integrations: number; pushed: number; skipped: number; failed: number }> {
  let integrations: AccountingIntegration[];
  try {
    integrations = await deps.integrationRepo.findAllActive();
  } catch (err) {
    deps.logger.error('Accounting sync: failed to list integrations', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { integrations: 0, pushed: 0, skipped: 0, failed: 0 };
  }

  const service = new AccountingSyncService(deps);
  let pushed = 0;
  let skipped = 0;
  let failed = 0;

  for (const integration of integrations) {
    if (integration.provider !== 'quickbooks') continue;
    try {
      const result = await service.syncIntegration(integration);
      pushed += result.pushedInvoices;
      skipped += result.skippedInvoices;
      failed += result.failedInvoices;
    } catch (err) {
      deps.logger.warn('Accounting sync: tenant sweep failed', {
        tenantId: integration.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { integrations: integrations.length, pushed, skipped, failed };
}
