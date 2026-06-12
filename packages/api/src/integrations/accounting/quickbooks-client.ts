import { ValidationError } from '../../shared/errors';
import { quickBooksApiBase, resolveQuickBooksEnvironment, QuickBooksFetch } from './quickbooks-oauth';

export interface QboCustomerInput {
  displayName: string;
  email?: string;
  phone?: string;
}

export interface QboSalesReceiptInput {
  customerRefId: string;
  docNumber: string;
  totalCents: number;
  lineDescriptions: string[];
  txnDate: string;
}

export interface QboCreateResult {
  id: string;
}

interface QboEntityResponse {
  Customer?: { Id?: string };
  SalesReceipt?: { Id?: string };
  Fault?: { Error?: Array<{ Message?: string; Detail?: string }> };
}

const MAX_RETRIES = 3;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class QuickBooksClient {
  constructor(
    private readonly realmId: string,
    private readonly accessToken: string,
    private readonly fetchFn: QuickBooksFetch = fetch,
    private readonly environment: 'sandbox' | 'production' = resolveQuickBooksEnvironment(),
  ) {}

  private url(path: string): string {
    return `${quickBooksApiBase(this.environment)}/${this.realmId}${path}`;
  }

  private async request(
    method: 'POST' | 'GET',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<QboEntityResponse> {
    let attempt = 0;
    while (attempt < MAX_RETRIES) {
      attempt += 1;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
      if (idempotencyKey) {
        headers['Request-Id'] = idempotencyKey;
      }
      const res = await this.fetchFn(this.url(path), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '2');
        await sleep(Math.max(1, retryAfter) * 1000 * attempt);
        continue;
      }
      const json = (await res.json()) as QboEntityResponse;
      if (!res.ok) {
        const msg =
          json.Fault?.Error?.[0]?.Detail ??
          json.Fault?.Error?.[0]?.Message ??
          `QuickBooks API ${res.status}`;
        throw new ValidationError(msg);
      }
      return json;
    }
    throw new ValidationError('QuickBooks API rate limit exceeded');
  }

  async createCustomer(input: QboCustomerInput, idempotencyKey: string): Promise<QboCreateResult> {
    const payload: Record<string, unknown> = {
      DisplayName: input.displayName,
    };
    if (input.email) {
      payload.PrimaryEmailAddr = { Address: input.email };
    }
    if (input.phone) {
      payload.PrimaryPhone = { FreeFormNumber: input.phone };
    }
    const json = await this.request('POST', '/customer', payload, idempotencyKey);
    const id = json.Customer?.Id;
    if (!id) throw new ValidationError('QuickBooks customer create returned no Id');
    return { id };
  }

  async createSalesReceipt(
    input: QboSalesReceiptInput,
    idempotencyKey: string,
  ): Promise<QboCreateResult> {
    const totalDollars = input.totalCents / 100;
    const lineCount = Math.max(1, input.lineDescriptions.length);
    const perLine = totalDollars / lineCount;
    const lines = (input.lineDescriptions.length ? input.lineDescriptions : ['Services']).map(
      (desc) => ({
        Amount: perLine,
        DetailType: 'SalesItemLineDetail',
        Description: desc,
        SalesItemLineDetail: {
          Qty: 1,
          UnitPrice: perLine,
        },
      }),
    );
    const payload = {
      DocNumber: input.docNumber,
      TxnDate: input.txnDate,
      CustomerRef: { value: input.customerRefId },
      Line: lines,
      TotalAmt: totalDollars,
    };
    const json = await this.request('POST', '/salesreceipt', payload, idempotencyKey);
    const id = json.SalesReceipt?.Id;
    if (!id) throw new ValidationError('QuickBooks sales receipt create returned no Id');
    return { id };
  }
}
