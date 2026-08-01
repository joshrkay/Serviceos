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

// fetch has no default timeout — a stalled QBO API would hang the
// accounting-sync worker indefinitely.
const QBO_REQUEST_TIMEOUT_MS = 20_000;

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
        signal: AbortSignal.timeout(QBO_REQUEST_TIMEOUT_MS),
      });
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '2');
        await sleep(Math.max(1, retryAfter) * 1000 * attempt);
        continue;
      }
      // Guarded parse: an edge proxy can answer 502/503 with HTML, where a
      // bare res.json() throws a SyntaxError and masks the real HTTP failure.
      const json = (await res.json().catch(() => ({}))) as QboEntityResponse;
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
    // Split in INTEGER CENTS with remainder distribution, converting to
    // dollars only at the end. Splitting in floating dollars produced
    // unrounded per-line amounts (e.g. $100 / 3 = 33.333…): QBO rounds each
    // line to 2dp, the lines then don't sum to TotalAmt, and the receipt is
    // rejected ("Transaction total does not equal sum of lines") — or worse,
    // silently mis-booked.
    const lineCount = Math.max(1, input.lineDescriptions.length);
    const baseCents = Math.floor(input.totalCents / lineCount);
    const remainderCents = input.totalCents - baseCents * lineCount;
    const lines = (input.lineDescriptions.length ? input.lineDescriptions : ['Services']).map(
      (desc, i) => {
        // First `remainderCents` lines absorb one extra cent so the lines
        // sum exactly to totalCents.
        const lineCents = baseCents + (i < remainderCents ? 1 : 0);
        const lineDollars = lineCents / 100;
        return {
          Amount: lineDollars,
          DetailType: 'SalesItemLineDetail',
          Description: desc,
          SalesItemLineDetail: {
            Qty: 1,
            UnitPrice: lineDollars,
          },
        };
      },
    );
    const payload = {
      DocNumber: input.docNumber,
      TxnDate: input.txnDate,
      CustomerRef: { value: input.customerRefId },
      Line: lines,
      TotalAmt: input.totalCents / 100,
    };
    const json = await this.request('POST', '/salesreceipt', payload, idempotencyKey);
    const id = json.SalesReceipt?.Id;
    if (!id) throw new ValidationError('QuickBooks sales receipt create returned no Id');
    return { id };
  }
}
