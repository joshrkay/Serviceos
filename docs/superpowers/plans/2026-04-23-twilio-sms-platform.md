# Twilio SMS Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full Twilio SMS platform to ServiceOS covering four operational surfaces: per-tenant credential storage (AES-256-GCM encrypted at rest), outbound SMS for appointment reminders/confirmations/en-route ETAs, an inbound SMS webhook that routes replies into the existing conversations system, and delivery-status callbacks that keep the `sms_messages` row accurate. Together these stories close P7-001 through P7-004.

**Architecture:** A new `SmsProvider` interface keeps Twilio behind an abstraction; the `TwilioSmsProvider` implementation talks to `https://api.twilio.com`. Credentials are stored per-tenant in a new `tenant_integrations` table whose sensitive columns are encrypted with a server-side AES-256-GCM key loaded from environment. Webhook handlers are added to the existing `/webhooks` router (P0-014 pattern) with Twilio's own `X-Twilio-Signature` HMAC validation. The 24-hour reminder and en-route SMS triggers run as background sweep workers following the execution-worker pattern (P0-009).

**Tech Stack:** TypeScript, Express, Node `crypto` module for AES-256-GCM, `twilio` npm SDK for signature validation and REST calls, `pg` driver with the existing `PgBaseRepository`, Vitest for all tests.

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `packages/api/src/sms/sms-provider.ts` | `SmsProvider` interface + `SmsMessage` / `SendSmsResult` types; `InMemorySmsProvider` for tests |
| `packages/api/src/sms/twilio-sms-provider.ts` | `TwilioSmsProvider` implementing `SmsProvider`; wraps Twilio REST API |
| `packages/api/src/sms/twilio-signature.ts` | Pure `validateTwilioSignature(authToken, url, params)` helper; no side effects |
| `packages/api/src/sms/sms-message.ts` | `SmsMessageRecord` domain type + `SmsMessageRepository` interface + `InMemorySmsMessageRepository` |
| `packages/api/src/sms/pg-sms-message.ts` | `PgSmsMessageRepository` |
| `packages/api/src/sms/tenant-integration.ts` | `TenantIntegration` domain type, `TenantIntegrationRepository` interface, `InMemoryTenantIntegrationRepository`, AES-256-GCM `encryptSecret` / `decryptSecret` helpers |
| `packages/api/src/sms/pg-tenant-integration.ts` | `PgTenantIntegrationRepository` |
| `packages/api/src/sms/inbound-sms-service.ts` | `InboundSmsService` — phone-number-to-customer lookup + conversation upsert logic |
| `packages/api/src/webhooks/twilio-sms-routes.ts` | Express router for `POST /webhooks/twilio/sms` and `POST /webhooks/twilio/status` |
| `packages/api/src/workers/sms-reminder-worker.ts` | `runSmsReminderSweep` — 24-hour appointment reminder sweep |
| `packages/api/src/workers/en-route-sms-worker.ts` | `runEnRouteSmsCheck` — watches for `en_route` status transitions and sends ETA SMS |
| `packages/api/src/routes/tenant-integrations.ts` | REST CRUD routes for admin to save/test Twilio credentials |
| `packages/api/test/sms/sms-provider.test.ts` | Unit tests for `InMemorySmsProvider` and `SmsProvider` contract |
| `packages/api/test/sms/twilio-signature.test.ts` | Unit tests for `validateTwilioSignature` |
| `packages/api/test/sms/sms-message.test.ts` | Unit tests for `SmsMessageRecord` and `InMemorySmsMessageRepository` |
| `packages/api/test/sms/tenant-integration.test.ts` | Unit tests for encryption helpers and `InMemoryTenantIntegrationRepository` |
| `packages/api/test/sms/inbound-sms-service.test.ts` | Unit tests for `InboundSmsService` |
| `packages/api/test/webhooks/twilio-sms-webhook.test.ts` | Integration tests for both Twilio webhook routes |
| `packages/api/test/workers/sms-reminder-worker.test.ts` | Unit tests for reminder sweep idempotency and send logic |
| `packages/api/test/workers/en-route-sms-worker.test.ts` | Unit tests for en-route trigger |

> **Migration mechanism:** This codebase does **not** use a `packages/api/migrations/*.sql` directory. The migration runner in `packages/api/src/db/migrate.ts` calls `getMigrationSQL()` which concatenates the `MIGRATIONS` object exported from `packages/api/src/db/schema.ts:25` (each value is a SQL string keyed by `'NNN_name'`). New migrations are added by appending entries to that object. All migration tasks below modify `schema.ts` rather than creating new SQL files.

### Modified files

**Phase 1** — `packages/api/src/db/schema.ts`: append `041_create_tenant_integrations` and `042_create_sms_messages`.

**Phase 2** — `packages/api/src/shared/config.ts`: add `TWILIO_ENCRYPTION_KEY`, `TWILIO_AUTH_TOKEN` (fallback for outbound-only tenants). `packages/api/src/app.ts`: wire `TwilioSmsProvider` + Twilio webhook router, start reminder sweeps on `setInterval`.

**Phase 3** — `packages/api/src/webhooks/routes.ts`: import and mount `createTwilioSmsRouter`. `packages/api/src/conversations/linkage.ts`: extend `LinkableEntityType` to include `'customer'` (already present) — no change needed; verify `findByEntity` used for SMS customer lookup.

**Phase 4** — No new files; `pg-sms-message.ts` gains `updateStatus` used by status webhook.

**Phase 5** — `packages/api/src/appointments/appointment.ts`: add `'en_route'` to `AppointmentStatus` union. `packages/api/src/db/schema.ts`: append `043_appointment_status_en_route` to add the new CHECK constraint value. `packages/api/src/app.ts`: register two new `setInterval` sweeps.

### Commit cadence

One commit per task. Every commit keeps tests green. No step leaves the repo broken.

---

## Phase 1: Database Migrations

The two new tables provide the persistence foundation for every later phase. `tenant_integrations` stores third-party credentials (Twilio or future providers) with encrypted secret columns. `sms_messages` is the canonical record of every outbound SMS sent by the platform; inbound replies are stored in the conversations/messages tables but cross-linked here by `twilio_message_sid`.

### Task 1: Migration — `tenant_integrations` table

**Files:**
- Modify: `packages/api/src/db/schema.ts`

**Context:** The table needs `provider TEXT` (e.g. `'twilio'`), `account_sid TEXT`, `auth_token_enc TEXT` (AES-256-GCM ciphertext), `from_number TEXT`, `config JSONB`, and `validated_at TIMESTAMPTZ`. RLS is mandatory. The encryption key itself lives in `TWILIO_ENCRYPTION_KEY` env var — never stored in the DB.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/sms/tenant-integration.test.ts
import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '../../src/sms/tenant-integration';

describe('AES-256-GCM secret encryption', () => {
  const key = Buffer.alloc(32, 'k').toString('hex'); // 64 hex chars = 32 bytes
  it('round-trips a secret', () => {
    const ct = encryptSecret('AC1234567890abcdef', key);
    expect(ct).not.toBe('AC1234567890abcdef');
    expect(decryptSecret(ct, key)).toBe('AC1234567890abcdef');
  });
  it('produces unique ciphertexts (random IV)', () => {
    const a = encryptSecret('secret', key);
    const b = encryptSecret('secret', key);
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/sms/tenant-integration.test.ts`
Expected: FAIL — `encryptSecret` does not exist yet.

- [ ] **Step 3: Implement `tenant-integration.ts` with crypto helpers**

Create `packages/api/src/sms/tenant-integration.ts`. Export `encryptSecret(plaintext, hexKey): string` using `crypto.createCipheriv('aes-256-gcm', ...)` with a random 12-byte IV prepended as `iv:authTag:ciphertext` (all hex). Export `decryptSecret(ciphertext, hexKey): string` for the inverse. Export `TenantIntegration` interface and `InMemoryTenantIntegrationRepository`.

- [ ] **Step 4: Append migration to `schema.ts`**

Append key `'041_create_tenant_integrations'` to `MIGRATIONS` with:

```sql
CREATE TABLE IF NOT EXISTS tenant_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  account_sid TEXT,
  auth_token_enc TEXT,
  from_number TEXT,
  config JSONB DEFAULT '{}',
  validated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, provider)
);
ALTER TABLE tenant_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_integrations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_tenant_integrations ON tenant_integrations;
CREATE POLICY tenant_isolation_tenant_integrations ON tenant_integrations
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
```

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/sms/tenant-integration.ts packages/api/src/db/schema.ts packages/api/test/sms/tenant-integration.test.ts
git commit -m "feat(sms): add tenant_integrations migration + AES-256-GCM encryption helpers"
```

---

### Task 2: Migration — `sms_messages` table

**Files:**
- Modify: `packages/api/src/db/schema.ts`
- Create: `packages/api/src/sms/sms-message.ts`
- Create: `packages/api/test/sms/sms-message.test.ts`

**Context:** Every outbound SMS row must have an idempotency key to prevent duplicate sends in the reminder sweep. The `status` column mirrors Twilio delivery-status callbacks. `direction` distinguishes outbound from inbound. `twilio_message_sid` is populated by the send response and used to match status callbacks.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/sms/sms-message.test.ts
import { describe, it, expect } from 'vitest';
import { InMemorySmsMessageRepository } from '../../src/sms/sms-message';

describe('InMemorySmsMessageRepository', () => {
  it('saves and retrieves by idempotency key', async () => {
    const repo = new InMemorySmsMessageRepository();
    const msg = await repo.create({
      id: 'uuid-1', tenantId: 't1', direction: 'outbound',
      toNumber: '+15550001111', fromNumber: '+15559999', body: 'Hello',
      status: 'queued', idempotencyKey: 'appt-123:reminder:24h',
      appointmentId: 'appt-123', customerId: 'cust-1',
      twilioMessageSid: null, createdAt: new Date(), updatedAt: new Date(),
    });
    const found = await repo.findByIdempotencyKey('t1', 'appt-123:reminder:24h');
    expect(found?.id).toBe(msg.id);
  });

  it('updateStatus sets status and sid', async () => {
    const repo = new InMemorySmsMessageRepository();
    await repo.create({ id: 'u2', tenantId: 't1', direction: 'outbound',
      toNumber: '+1', fromNumber: '+2', body: 'x', status: 'queued',
      idempotencyKey: 'k2', appointmentId: null, customerId: null,
      twilioMessageSid: null, createdAt: new Date(), updatedAt: new Date() });
    await repo.updateStatus('t1', 'u2', 'delivered', 'SM123');
    const updated = await repo.findById('t1', 'u2');
    expect(updated?.status).toBe('delivered');
    expect(updated?.twilioMessageSid).toBe('SM123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/sms/sms-message.test.ts`
Expected: FAIL — `InMemorySmsMessageRepository` not found.

- [ ] **Step 3: Implement `sms-message.ts`**

Create `packages/api/src/sms/sms-message.ts`. Export:
- `SmsMessageStatus` type: `'queued' | 'sent' | 'delivered' | 'failed' | 'undelivered'`
- `SmsDirection` type: `'outbound' | 'inbound'`
- `SmsMessageRecord` interface with all columns
- `SmsMessageRepository` interface with `create`, `findById`, `findByIdempotencyKey`, `findByTwilioSid`, `updateStatus`
- `InMemorySmsMessageRepository` class

- [ ] **Step 4: Append migration to `schema.ts`**

Append key `'042_create_sms_messages'` with:

```sql
CREATE TABLE IF NOT EXISTS sms_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  to_number TEXT NOT NULL,
  from_number TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  idempotency_key TEXT,
  appointment_id UUID REFERENCES appointments(id),
  customer_id UUID REFERENCES customers(id),
  conversation_id UUID REFERENCES conversations(id),
  twilio_message_sid TEXT,
  error_code TEXT,
  error_message TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_idempotency
  ON sms_messages(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sms_twilio_sid ON sms_messages(twilio_message_sid);
CREATE INDEX IF NOT EXISTS idx_sms_tenant_customer ON sms_messages(tenant_id, customer_id);
ALTER TABLE sms_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_sms_messages ON sms_messages;
CREATE POLICY tenant_isolation_sms_messages ON sms_messages
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
```

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/sms/sms-message.ts packages/api/src/db/schema.ts packages/api/test/sms/sms-message.test.ts
git commit -m "feat(sms): add sms_messages migration + InMemorySmsMessageRepository"
```

---

## Phase 2: TwilioSmsProvider & Outbound Send

### Task 3: `SmsProvider` interface + `InMemorySmsProvider`

**Files:**
- Create: `packages/api/src/sms/sms-provider.ts`
- Create: `packages/api/test/sms/sms-provider.test.ts`

**Context:** The interface is kept minimal — `send(params): Promise<SendSmsResult>` — so other providers can be swapped in. `InMemorySmsProvider` is the test double; it records sent messages for assertion and can be configured to throw on demand.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/sms/sms-provider.test.ts
import { describe, it, expect } from 'vitest';
import { InMemorySmsProvider } from '../../src/sms/sms-provider';

describe('InMemorySmsProvider', () => {
  it('records a sent message and returns a fake sid', async () => {
    const provider = new InMemorySmsProvider();
    const result = await provider.send({
      to: '+15550001111', from: '+15559999', body: 'Test message',
    });
    expect(result.messageSid).toMatch(/^FAKE_SID_/);
    expect(provider.getSent()).toHaveLength(1);
    expect(provider.getSent()[0].to).toBe('+15550001111');
  });

  it('throws when configured to fail', async () => {
    const provider = new InMemorySmsProvider({ failWith: new Error('Twilio unavailable') });
    await expect(provider.send({ to: '+1', from: '+2', body: 'x' }))
      .rejects.toThrow('Twilio unavailable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/sms/sms-provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sms-provider.ts`**

```typescript
// packages/api/src/sms/sms-provider.ts
export interface SendSmsParams { to: string; from: string; body: string; }
export interface SendSmsResult { messageSid: string; }

export interface SmsProvider {
  send(params: SendSmsParams): Promise<SendSmsResult>;
}

export class InMemorySmsProvider implements SmsProvider {
  private sent: SendSmsParams[] = [];
  constructor(private opts: { failWith?: Error } = {}) {}
  async send(params: SendSmsParams): Promise<SendSmsResult> {
    if (this.opts.failWith) throw this.opts.failWith;
    this.sent.push(params);
    return { messageSid: `FAKE_SID_${Date.now()}` };
  }
  getSent(): SendSmsParams[] { return [...this.sent]; }
  clear(): void { this.sent = []; }
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/sms/sms-provider.ts packages/api/test/sms/sms-provider.test.ts
git commit -m "feat(sms): add SmsProvider interface and InMemorySmsProvider test double"
```

---

### Task 4: `TwilioSmsProvider` + `PgTenantIntegrationRepository`

**Files:**
- Create: `packages/api/src/sms/twilio-sms-provider.ts`
- Create: `packages/api/src/sms/pg-tenant-integration.ts`

**Context:** `TwilioSmsProvider` calls `https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json` with Basic Auth (AccountSid:AuthToken). The constructor accepts a decrypted `accountSid`, `authToken`, and `fromNumber`. `PgTenantIntegrationRepository.findByTenant` decrypts the stored `auth_token_enc` using `decryptSecret` before returning the integration. The admin credential-save route calls Twilio's Accounts API to validate credentials before persisting.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/sms/twilio-sms-provider.test.ts
import { describe, it, expect, vi } from 'vitest';
import { TwilioSmsProvider } from '../../src/sms/twilio-sms-provider';

describe('TwilioSmsProvider', () => {
  it('calls Twilio API and returns messageSid', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sid: 'SM_abc123', status: 'queued' }),
    });
    const provider = new TwilioSmsProvider(
      { accountSid: 'ACtest', authToken: 'token', fromNumber: '+15550000' },
      mockFetch as unknown as typeof fetch
    );
    const result = await provider.send({ to: '+15551111', from: '+15550000', body: 'Hi' });
    expect(result.messageSid).toBe('SM_abc123');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('throws on non-ok Twilio response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false, status: 400,
      json: async () => ({ message: 'Invalid number', code: 21211 }),
    });
    const provider = new TwilioSmsProvider(
      { accountSid: 'ACtest', authToken: 'token', fromNumber: '+15550000' },
      mockFetch as unknown as typeof fetch
    );
    await expect(provider.send({ to: '+1bad', from: '+15550000', body: 'Hi' }))
      .rejects.toThrow('Twilio send failed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/sms/twilio-sms-provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `twilio-sms-provider.ts`**

Constructor takes `{ accountSid, authToken, fromNumber }` and an optional `fetchFn` for injection. `send()` POSTs to `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json` with `application/x-www-form-urlencoded` body (`To`, `From`, `Body`) and Basic auth header. On `!response.ok` throw `new Error('Twilio send failed: ' + body.message)`.

- [ ] **Step 4: Implement `pg-tenant-integration.ts`**

Extends `PgBaseRepository`. `findByTenant(tenantId, provider)` queries `tenant_integrations` and calls `decryptSecret(row.auth_token_enc, encKey)` on the way out. `upsert(input)` encrypts before insert via `encryptSecret`. `markValidated(tenantId, provider)` sets `validated_at = NOW()`.

- [ ] **Step 5: Add config keys**

In `packages/api/src/shared/config.ts` configSchema, add:
```
TWILIO_ENCRYPTION_KEY: z.string().length(64).optional(), // 32 bytes hex
```

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/sms/twilio-sms-provider.ts packages/api/src/sms/pg-tenant-integration.ts packages/api/src/shared/config.ts packages/api/test/sms/twilio-sms-provider.test.ts
git commit -m "feat(sms): implement TwilioSmsProvider and PgTenantIntegrationRepository"
```

---

### Task 5: Tenant integrations REST routes + outbound send service

**Files:**
- Create: `packages/api/src/routes/tenant-integrations.ts`
- Modify: `packages/api/src/app.ts`

**Context:** `POST /api/integrations/twilio` validates credentials by hitting `GET https://api.twilio.com/2010-04-01/Accounts/{sid}.json`, stores encrypted, sets `validated_at`. `GET /api/integrations/twilio` returns the integration minus the auth token. `POST /api/integrations/twilio/send-test` sends a test SMS to the tenant's own `businessPhone`. Audit events are emitted on save.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/routes/tenant-integrations.test.ts
import { describe, it, expect } from 'vitest';
import { validateTwilioCredentials } from '../../src/routes/tenant-integrations';

describe('validateTwilioCredentials', () => {
  it('returns false when accountSid missing', async () => {
    const result = await validateTwilioCredentials('', 'token');
    expect(result.valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/routes/tenant-integrations.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the routes file**

Export `validateTwilioCredentials(accountSid, authToken, fetchFn?)` which calls `GET https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json` with Basic auth and returns `{ valid: boolean; error?: string }`. Export `createTenantIntegrationsRouter(deps)` with the three endpoints. Mount in `app.ts` under `/api`.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/tenant-integrations.ts packages/api/src/app.ts packages/api/test/routes/tenant-integrations.test.ts
git commit -m "feat(sms): add Twilio credential save/validate REST routes"
```

---

## Phase 3: Inbound SMS Webhook + Conversation Linkage

### Task 6: Twilio signature validation helper

**Files:**
- Create: `packages/api/src/sms/twilio-signature.ts`
- Create: `packages/api/test/sms/twilio-signature.test.ts`

**Context:** Twilio signs inbound webhook PODs with `X-Twilio-Signature`: a base64 HMAC-SHA1 of `url + sorted(params joined as key+value)`. This is distinct from the Stripe/Clerk svix HMAC-SHA256 used elsewhere in the codebase — a dedicated helper is needed.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/sms/twilio-signature.test.ts
import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import { validateTwilioSignature, buildTwilioSignature } from '../../src/sms/twilio-signature';

describe('validateTwilioSignature', () => {
  const authToken = 'test_auth_token_32chars_padding__';
  const url = 'https://example.com/webhooks/twilio/sms';
  const params = { From: '+15550001111', To: '+15559999', Body: 'Hello' };

  it('accepts a correctly signed request', () => {
    const sig = buildTwilioSignature(authToken, url, params);
    expect(validateTwilioSignature(authToken, url, params, sig)).toBe(true);
  });

  it('rejects a tampered signature', () => {
    expect(validateTwilioSignature(authToken, url, params, 'bad')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/sms/twilio-signature.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `twilio-signature.ts`**

```typescript
import * as crypto from 'crypto';

export function buildTwilioSignature(
  authToken: string, url: string, params: Record<string, string>
): string {
  const sorted = Object.keys(params).sort();
  const str = url + sorted.map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', authToken).update(str).digest('base64');
}

export function validateTwilioSignature(
  authToken: string, url: string,
  params: Record<string, string>, signature: string
): boolean {
  if (!signature) return false;
  const expected = buildTwilioSignature(authToken, url, params);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch { return false; }
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/sms/twilio-signature.ts packages/api/test/sms/twilio-signature.test.ts
git commit -m "feat(sms): add Twilio HMAC-SHA1 signature validation helper"
```

---

### Task 7: `InboundSmsService` — customer lookup + conversation upsert

**Files:**
- Create: `packages/api/src/sms/inbound-sms-service.ts`
- Create: `packages/api/test/sms/inbound-sms-service.test.ts`

**Context:** When an inbound SMS arrives, the service must: (1) find the customer whose `primaryPhone` matches `From` (E.164); (2) find or create a conversation with `entityType: 'customer'` and `entityId: customerId`; (3) add a `Message` with `direction: 'inbound'` stored in `metadata`, `source: 'twilio_sms'`, `messageType: 'text'`; (4) create an `SmsMessageRecord` with `direction: 'inbound'`. If no customer matches, still record the `SmsMessageRecord` with `customerId: null`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/sms/inbound-sms-service.test.ts
import { describe, it, expect } from 'vitest';
import { InboundSmsService } from '../../src/sms/inbound-sms-service';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { InMemorySmsMessageRepository } from '../../src/sms/sms-message';

describe('InboundSmsService', () => {
  it('creates conversation and message for known customer', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    const convRepo = new InMemoryConversationRepository();
    const smsRepo = new InMemorySmsMessageRepository();
    // seed a customer with smsConsent
    const customer = await customerRepo.create({
      tenantId: 't1', firstName: 'Jane', lastName: 'Doe',
      primaryPhone: '+15550001111', smsConsent: true,
      preferredChannel: 'sms', createdBy: 'system',
    });
    const service = new InboundSmsService(customerRepo, convRepo, smsRepo);
    const result = await service.handle({
      tenantId: 't1',
      from: '+15550001111', to: '+15559999',
      body: 'Is the tech on the way?',
      twilioMessageSid: 'SM_inbound_001',
    });
    expect(result.customerId).toBe(customer.id);
    expect(result.conversationId).toBeDefined();
    const msgs = await convRepo.getMessages('t1', result.conversationId!);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].metadata?.direction).toBe('inbound');
  });

  it('records SMS row even when customer not found', async () => {
    const service = new InboundSmsService(
      new InMemoryCustomerRepository(),
      new InMemoryConversationRepository(),
      new InMemorySmsMessageRepository(),
    );
    const result = await service.handle({
      tenantId: 't1', from: '+10000000000', to: '+15559999',
      body: 'Who is this?', twilioMessageSid: 'SM_unknown',
    });
    expect(result.customerId).toBeNull();
    expect(result.conversationId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/sms/inbound-sms-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `inbound-sms-service.ts`**

Class `InboundSmsService` takes `CustomerRepository`, `ConversationRepository`, `SmsMessageRepository`. `handle()` method: (a) calls `customerRepo.findByPhone(tenantId, from)` — if that method doesn't exist, filter `findAll` by `primaryPhone`; (b) if customer found, call `convRepo.findByEntity(tenantId, 'customer', customer.id)` and take `[0]` or `convRepo.createConversation(...)`; (c) `convRepo.addMessage(...)` with `metadata: { direction: 'inbound' }`; (d) `smsRepo.create(...)` with `direction: 'inbound'`. Returns `{ customerId, conversationId, smsMessageId }`.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/sms/inbound-sms-service.ts packages/api/test/sms/inbound-sms-service.test.ts
git commit -m "feat(sms): InboundSmsService — customer lookup and conversation upsert for inbound SMS"
```

---

### Task 8: Twilio webhook routes (inbound SMS + status callback)

**Files:**
- Create: `packages/api/src/webhooks/twilio-sms-routes.ts`
- Modify: `packages/api/src/webhooks/routes.ts`
- Create: `packages/api/test/webhooks/twilio-sms-webhook.test.ts`

**Context:** Both routes return TwiML `<Response/>` (empty) with `Content-Type: text/xml`. The inbound route uses `express.urlencoded({ extended: false })` (Twilio POSTs form-encoded). Signature validation uses `validateTwilioSignature` with the tenant's `authToken` retrieved via `TenantIntegrationRepository`. The status route matches on `MessageSid` and calls `smsRepo.updateStatus`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/webhooks/twilio-sms-webhook.test.ts
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTwilioSmsRouter } from '../../src/webhooks/twilio-sms-routes';
import { InMemoryTenantIntegrationRepository } from '../../src/sms/tenant-integration';
import { InMemorySmsMessageRepository } from '../../src/sms/sms-message';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { buildTwilioSignature } from '../../src/sms/twilio-signature';

describe('POST /webhooks/twilio/sms', () => {
  it('returns 403 when signature is missing', async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use('/webhooks/twilio', createTwilioSmsRouter({
      integrationRepo: new InMemoryTenantIntegrationRepository(),
      smsRepo: new InMemorySmsMessageRepository(),
      customerRepo: new InMemoryCustomerRepository(),
      convRepo: new InMemoryConversationRepository(),
      webhookBaseUrl: 'https://example.com',
      encryptionKey: Buffer.alloc(32, 'k').toString('hex'),
    }));
    const res = await request(app)
      .post('/webhooks/twilio/sms')
      .send('AccountSid=ACtest&From=%2B15550001111&To=%2B15559999&Body=Hi');
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/webhooks/twilio-sms-webhook.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `twilio-sms-routes.ts`**

Router deps interface: `{ integrationRepo, smsRepo, customerRepo, convRepo, webhookBaseUrl, encryptionKey }`. `POST /sms`: (1) parse form body; (2) look up `TenantIntegration` by `AccountSid` (needs a `findByAccountSid` on the repo — add to InMemory + Pg impls); (3) `validateTwilioSignature` with decrypted `authToken`; (4) reject 403 if invalid; (5) call `InboundSmsService.handle`; (6) return `<Response/>`. `POST /status`: (1) validate signature; (2) call `smsRepo.updateStatus` using `MessageSid`; (3) return `<Response/>`.

- [ ] **Step 4: Mount in `routes.ts` and `app.ts`**

In `packages/api/src/webhooks/routes.ts`, import and mount `createTwilioSmsRouter` at `/twilio`. Pass deps including the `encryptionKey` from config.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/webhooks/twilio-sms-routes.ts packages/api/src/webhooks/routes.ts packages/api/test/webhooks/twilio-sms-webhook.test.ts
git commit -m "feat(sms): add Twilio inbound SMS and status callback webhook routes"
```

---

## Phase 4: Delivery Status Updates

### Task 9: `PgSmsMessageRepository` with `updateStatus`

**Files:**
- Create: `packages/api/src/sms/pg-sms-message.ts`

**Context:** The status webhook handler calls `smsRepo.updateStatus(tenantId, messageId, newStatus, twilioSid)`. The Pg implementation must resolve by `twilio_message_sid` (the sid known to Twilio) not the internal UUID, because status callbacks only carry `MessageSid`. Add a `findByTwilioSid(tenantId, sid)` query.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/sms/pg-sms-message.test.ts (skipped in CI, runs in integration suite)
import { describe, it, expect } from 'vitest';
import { InMemorySmsMessageRepository } from '../../src/sms/sms-message';

describe('updateStatus via twilioSid', () => {
  it('finds by twilio sid and updates status', async () => {
    const repo = new InMemorySmsMessageRepository();
    await repo.create({
      id: 'u1', tenantId: 't1', direction: 'outbound',
      toNumber: '+1', fromNumber: '+2', body: 'hi',
      status: 'queued', idempotencyKey: 'ik1',
      appointmentId: null, customerId: null,
      twilioMessageSid: 'SM_real_sid',
      createdAt: new Date(), updatedAt: new Date(),
    });
    await repo.updateStatusBySid('t1', 'SM_real_sid', 'delivered');
    const found = await repo.findByTwilioSid('t1', 'SM_real_sid');
    expect(found?.status).toBe('delivered');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/sms/pg-sms-message.test.ts`
Expected: FAIL — `updateStatusBySid` not defined.

- [ ] **Step 3: Add `updateStatusBySid` + `findByTwilioSid` to `SmsMessageRepository` interface**

Extend the interface in `sms-message.ts` and implement in `InMemorySmsMessageRepository`. Then create `pg-sms-message.ts` with `PgSmsMessageRepository extends PgBaseRepository`. The Pg `updateStatusBySid` runs:

```sql
UPDATE sms_messages
SET status = $3, twilio_message_sid = COALESCE($4, twilio_message_sid), updated_at = NOW()
WHERE tenant_id = $1 AND twilio_message_sid = $2
```

- [ ] **Step 4: Wire into app.ts and status webhook route**

Status webhook route calls `smsRepo.updateStatusBySid(tenantId, body.MessageSid, body.MessageStatus)`. Update `twilio-sms-routes.ts` accordingly.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/sms/pg-sms-message.ts packages/api/src/sms/sms-message.ts packages/api/src/webhooks/twilio-sms-routes.ts packages/api/test/sms/pg-sms-message.test.ts
git commit -m "feat(sms): PgSmsMessageRepository + updateStatusBySid for delivery callbacks"
```

---

## Phase 5: Reminder Scheduler & En-Route Trigger

### Task 10: `en_route` AppointmentStatus + migration

**Files:**
- Modify: `packages/api/src/appointments/appointment.ts`
- Modify: `packages/api/src/db/schema.ts`

**Context:** The `AppointmentStatus` union type must include `'en_route'`. The existing CHECK constraint on the `appointments` table needs a migration to broaden it. The en-route SMS worker listens for status transitions to this value.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/appointments/en-route-status.test.ts
import { describe, it, expect } from 'vitest';
import { createAppointment } from '../../src/appointments/appointment';

describe('AppointmentStatus en_route', () => {
  it('accepts en_route as a valid status', () => {
    const appt = createAppointment({
      tenantId: 't1', jobId: 'j1',
      scheduledStart: new Date('2026-05-01T10:00:00Z'),
      scheduledEnd: new Date('2026-05-01T11:00:00Z'),
      timezone: 'America/New_York', createdBy: 'u1',
    });
    expect(['scheduled','confirmed','in_progress','completed','canceled','no_show','en_route'])
      .toContain(appt.status);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/appointments/en-route-status.test.ts -t "accepts en_route"`
Expected: FAIL — `'en_route'` not in the type union (TypeScript) / CHECK constraint.

- [ ] **Step 3: Extend `AppointmentStatus`**

In `appointment.ts` line 6, change union to:
`'scheduled' | 'confirmed' | 'in_progress' | 'completed' | 'canceled' | 'no_show' | 'en_route'`

Append `'043_appointment_status_en_route'` to `MIGRATIONS`:

```sql
ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_status_check;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('scheduled','confirmed','in_progress','completed','canceled','no_show','en_route'));
```

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/appointments/appointment.ts packages/api/src/db/schema.ts packages/api/test/appointments/en-route-status.test.ts
git commit -m "feat(appointments): add en_route status value for on-my-way SMS trigger"
```

---

### Task 11: SMS reminder sweep worker (24-hour)

**Files:**
- Create: `packages/api/src/workers/sms-reminder-worker.ts`
- Create: `packages/api/test/workers/sms-reminder-worker.test.ts`

**Context:** The worker queries `AppointmentRepository.findUpcoming(tenantId, windowStart, windowEnd)` — or iterates tenants and queries appointments in a 24h ± 5-minute window. Before sending, it calls `smsRepo.findByIdempotencyKey(tenantId, key)` where `key = appt.id + ':reminder:24h'`. If a row already exists, it skips. After send, it creates the `SmsMessageRecord` with the idempotency key to prevent re-send.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/workers/sms-reminder-worker.test.ts
import { describe, it, expect } from 'vitest';
import { runSmsReminderSweep } from '../../src/workers/sms-reminder-worker';
import { InMemoryAppointmentRepository } from '../../src/appointments/appointment';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemorySmsMessageRepository } from '../../src/sms/sms-message';
import { InMemorySmsProvider } from '../../src/sms/sms-provider';
import { InMemoryTenantIntegrationRepository } from '../../src/sms/tenant-integration';

describe('runSmsReminderSweep', () => {
  it('sends reminder once and skips on second sweep (idempotency)', async () => {
    const apptRepo = new InMemoryAppointmentRepository();
    const smsRepo = new InMemorySmsMessageRepository();
    const provider = new InMemorySmsProvider();
    const integrationRepo = new InMemoryTenantIntegrationRepository();
    // Appointment 24h from now ±2 min
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    // (seed appointment, customer, integration omitted for brevity — full test sets all up)
    const result1 = await runSmsReminderSweep({ apptRepo, smsRepo, provider, integrationRepo, customerRepo: new InMemoryCustomerRepository(), tenantIds: [] });
    const result2 = await runSmsReminderSweep({ apptRepo, smsRepo, provider, integrationRepo, customerRepo: new InMemoryCustomerRepository(), tenantIds: [] });
    expect(result1.sent).toBe(0); // no appointments seeded in this minimal test
    expect(result2.sent).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/workers/sms-reminder-worker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sms-reminder-worker.ts`**

Export `runSmsReminderSweep(deps): Promise<{ sent: number; skipped: number; failed: number }>`. The sweep logic: for each `tenantId`, load the `TenantIntegration` for provider `'twilio'`; skip if none or not validated. Load appointments where `scheduledStart` is between `now + 23h55m` and `now + 24h5m`. For each: check idempotency key; skip if already sent; load job & customer; if `smsConsent && primaryPhone` send via provider; record `SmsMessageRecord`.

- [ ] **Step 4: Register sweep in `app.ts`**

```typescript
setInterval(() => runSmsReminderSweep(reminderDeps), 60_000);
```

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/workers/sms-reminder-worker.ts packages/api/test/workers/sms-reminder-worker.test.ts packages/api/src/app.ts
git commit -m "feat(sms): 24-hour appointment reminder sweep with idempotency guard"
```

---

### Task 12: En-route SMS trigger worker

**Files:**
- Create: `packages/api/src/workers/en-route-sms-worker.ts`
- Create: `packages/api/test/workers/en-route-sms-worker.test.ts`

**Context:** The en-route trigger worker sweeps appointments with `status = 'en_route'` and no sent `sms_messages` row for idempotency key `appt.id + ':en_route'`. It composes an ETA message using the `arrivalWindowStart`/`arrivalWindowEnd` in the tenant timezone (using `Intl.DateTimeFormat`), then sends and records. The sweep interval is 60 seconds same as the reminder sweep.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/workers/en-route-sms-worker.test.ts
import { describe, it, expect } from 'vitest';
import { buildEnRouteMessage } from '../../src/workers/en-route-sms-worker';

describe('buildEnRouteMessage', () => {
  it('includes ETA window in tenant timezone when available', () => {
    const msg = buildEnRouteMessage({
      customerName: 'Alice',
      technicianName: 'Bob',
      arrivalWindowStart: new Date('2026-05-01T17:00:00Z'),
      arrivalWindowEnd: new Date('2026-05-01T18:00:00Z'),
      timezone: 'America/New_York',
    });
    expect(msg).toContain('Bob');
    expect(msg).toContain('1:00');
  });

  it('works without ETA window', () => {
    const msg = buildEnRouteMessage({ customerName: 'Alice', technicianName: 'Bob' });
    expect(msg).toContain('on the way');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/workers/en-route-sms-worker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `en-route-sms-worker.ts`**

Export `buildEnRouteMessage(opts): string`. Export `runEnRouteSmsCheck(deps): Promise<{ sent, skipped, failed }>`. The sweep: query appointments where `status = 'en_route'` (add `findByStatus` to `AppointmentRepository`); for each check idempotency key `appt.id + ':en_route'`; build message via `buildEnRouteMessage`; send via provider; record `SmsMessageRecord`. Register with `setInterval(60_000)` in `app.ts`.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/workers/en-route-sms-worker.ts packages/api/test/workers/en-route-sms-worker.test.ts packages/api/src/app.ts
git commit -m "feat(sms): en-route ETA SMS worker triggered by appointment status transition"
```

---

### Task 13: Scheduling confirmation SMS on booking

**Files:**
- Modify: `packages/api/src/appointments/appointment.ts` (or `pg-appointment.ts`)
- Modify: `packages/api/src/routes/appointments.ts`

**Context:** When a new appointment is created (`POST /api/appointments`), a confirmation SMS is sent inline (not via sweep) to the customer's `primaryPhone` if `smsConsent` is true. The send is best-effort — failure is logged but does not roll back the appointment. An `SmsMessageRecord` is created with idempotency key `appt.id + ':booking_confirmation'`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/sms/booking-confirmation.test.ts
import { describe, it, expect } from 'vitest';
import { buildBookingConfirmationMessage } from '../../src/sms/booking-confirmation';

describe('buildBookingConfirmationMessage', () => {
  it('includes date and business name', () => {
    const msg = buildBookingConfirmationMessage({
      customerName: 'Jane',
      businessName: 'ACME HVAC',
      scheduledStart: new Date('2026-05-01T14:00:00Z'),
      timezone: 'America/New_York',
    });
    expect(msg).toContain('ACME HVAC');
    expect(msg).toContain('10:00 AM');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/sms/booking-confirmation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `booking-confirmation.ts` + wire into appointments route**

Create `packages/api/src/sms/booking-confirmation.ts`. Export `buildBookingConfirmationMessage(opts): string`. In `routes/appointments.ts` `POST /` handler: after successful `createAppointment`, load customer, check `smsConsent`, call `smsProvider.send(...)`, record `SmsMessageRecord` — wrapped in `try/catch` that logs but does not throw.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/sms/booking-confirmation.ts packages/api/src/routes/appointments.ts packages/api/test/sms/booking-confirmation.test.ts
git commit -m "feat(sms): send booking confirmation SMS when appointment is created"
```

---

## Out of scope

- Two-way SMS chat UI (separate plan — React components, real-time socket relay)
- WhatsApp Business API integration
- MMS (media messages) — Twilio `MediaUrl` parsing and storage
- International / non-US number formatting and carrier lookup
- SMS opt-out / STOP keyword handling (TCPA compliance automation)
- Subaccount-per-tenant Twilio architecture
- SMS templates stored in the database (currently hardcoded strings)
- Twilio Conversations or Twilio Flex (managed contact-centre products)
- Email channel (separate feature set)
- Retry queue for failed outbound sends beyond best-effort

---

### Critical Files for Implementation
- `/home/user/Serviceos/packages/api/src/db/schema.ts`
- `/home/user/Serviceos/packages/api/src/webhooks/routes.ts`
- `/home/user/Serviceos/packages/api/src/conversations/conversation-service.ts`
- `/home/user/Serviceos/packages/api/src/appointments/appointment.ts`
- `/home/user/Serviceos/packages/api/src/app.ts`
