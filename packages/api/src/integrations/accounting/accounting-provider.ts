/**
 * F17 / P15-001 — Provider abstraction for accounting integrations.
 * QuickBooks is the v1 implementation; Xero is stubbed for future work.
 */
import { ValidationError } from '../../shared/errors';
import { QuickBooksClient } from './quickbooks-client';
import { QuickBooksFetch, QuickBooksOAuthConfig, resolveQuickBooksEnvironment } from './quickbooks-oauth';
import { AccountingIntegration, AccountingProvider as AccountingProviderName } from './types';
import { XeroAccountingProviderStub } from './xero-provider-stub';

export interface AccountingCustomerInput {
  displayName: string;
  email?: string;
  phone?: string;
}

export interface AccountingSalesReceiptInput {
  customerRefId: string;
  docNumber: string;
  totalCents: number;
  lineDescriptions: string[];
  txnDate: string;
}

export interface AccountingProviderClient {
  createCustomer(
    input: AccountingCustomerInput,
    idempotencyKey?: string,
  ): Promise<{ id: string }>;
  createSalesReceipt(
    input: AccountingSalesReceiptInput,
    idempotencyKey?: string,
  ): Promise<{ id: string }>;
}

export interface CreateAccountingProviderOptions {
  fetchFn?: QuickBooksFetch;
  qboConfig?: Pick<QuickBooksOAuthConfig, 'environment'>;
}

class QuickBooksAccountingProvider implements AccountingProviderClient {
  private readonly client: QuickBooksClient;

  constructor(
    integration: AccountingIntegration,
    accessToken: string,
    options?: CreateAccountingProviderOptions,
  ) {
    this.client = new QuickBooksClient(
      integration.realmId,
      accessToken,
      options?.fetchFn ?? fetch,
      options?.qboConfig?.environment ?? resolveQuickBooksEnvironment(),
    );
  }

  createCustomer(
    input: AccountingCustomerInput,
    idempotencyKey?: string,
  ): Promise<{ id: string }> {
    return this.client.createCustomer(input, idempotencyKey ?? `customer-${input.displayName}`);
  }

  createSalesReceipt(
    input: AccountingSalesReceiptInput,
    idempotencyKey?: string,
  ): Promise<{ id: string }> {
    return this.client.createSalesReceipt(input, idempotencyKey ?? `receipt-${input.docNumber}`);
  }
}

export function createAccountingProvider(
  integration: AccountingIntegration,
  accessToken: string,
  options?: CreateAccountingProviderOptions,
): AccountingProviderClient {
  switch (integration.provider) {
    case 'quickbooks':
      return new QuickBooksAccountingProvider(integration, accessToken, options);
    case 'xero':
      return new XeroAccountingProviderStub();
    default: {
      const provider = integration.provider as AccountingProviderName;
      throw new ValidationError(`Unsupported accounting provider: ${provider}`);
    }
  }
}
