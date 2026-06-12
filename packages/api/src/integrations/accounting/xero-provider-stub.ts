/**
 * F17 / P15-001 — Xero provider placeholder for v2.
 */
import { ValidationError } from '../../shared/errors';
import {
  AccountingCustomerInput,
  AccountingProviderClient,
  AccountingSalesReceiptInput,
} from './accounting-provider';

const NOT_IMPLEMENTED = 'Xero integration is not yet available';

export class XeroAccountingProviderStub implements AccountingProviderClient {
  async createCustomer(_input: AccountingCustomerInput): Promise<{ id: string }> {
    throw new ValidationError(NOT_IMPLEMENTED);
  }

  async createSalesReceipt(_input: AccountingSalesReceiptInput): Promise<{ id: string }> {
    throw new ValidationError(NOT_IMPLEMENTED);
  }
}
