# Two-Way Customer Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable dispatchers to send and receive SMS messages with customers directly inside ServiceOS, with a full conversation thread UI showing message history, delivery status, and unread badge counts. Inbound Twilio SMS messages are routed to the correct customer conversation, with CTIA-compliant opt-out handling. Unmatched inbound numbers are queued for dispatcher review.

**Architecture:** Existing `conversations` and `messages` tables are extended with new columns (`scope`, `channel`, `customer_id`, `direction`, `status`, `external_id`, `sender_type`) via additive migrations. A new `inbound SMS resolution` service layer matches incoming webhooks to customer conversations, delegating to `TwilioSmsProvider` (from the Twilio SMS Platform plan) for outbound sends and status callbacks. The frontend polls `GET /api/conversations/:id/messages` every 10 seconds and renders a direction-aware chat thread.

**Tech Stack:** TypeScript, Express, `pg` driver (API); React, Tailwind, `lucide-react` (Web); Twilio SMS via `TwilioSmsProvider` abstraction (Requires: 2026-04-23-twilio-sms-platform.md).

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `packages/api/src/conversations/inbound-sms-resolver.ts` | `resolveInboundMessage()` — matches phone to customer, finds/creates conversation, appends message or routes to unmatched table |
| `packages/api/src/conversations/pg-unmatched-sms.ts` | Pg repository for `unmatched_inbound_sms` table |
| `packages/api/src/conversations/unmatched-sms.ts` | `UnmatchedSmsRepository` interface + `InMemoryUnmatchedSmsRepository` |
| `packages/api/src/conversations/pg-read-state.ts` | Pg repository for `conversation_read_state` table |
| `packages/api/src/conversations/read-state.ts` | `ReadStateRepository` interface + `InMemoryReadStateRepository` |
| `packages/api/src/routes/unmatched-sms.ts` | `GET /api/unmatched-sms` + `POST /api/unmatched-sms/:id/resolve` |
| `packages/web/src/components/conversations/CustomerChat.tsx` | Chat thread UI component: direction-aware bubbles, compose box, 10s polling |
| `packages/web/src/components/conversations/UnmatchedSmsPanel.tsx` | Dispatcher panel listing unmatched inbound SMS; link-to-customer action |
| `packages/web/src/hooks/useChatMessages.ts` | Hook wrapping 10s polling of `GET /api/conversations/:id/messages` |
| `packages/api/test/conversations/inbound-sms-resolver.test.ts` | Unit tests for resolver (happy path, opt-out, HELP, UNSTOP, unmatched) |
| `packages/api/test/conversations/unmatched-sms.test.ts` | Unit tests for unmatched SMS repo + resolve endpoint |
| `packages/api/test/conversations/read-state.test.ts` | Unit tests for read-state repo |

> **Migration mechanism:** This codebase does **not** use a `packages/api/migrations/*.sql` directory. The migration runner in `packages/api/src/db/migrate.ts` calls `getMigrationSQL()` which concatenates the `MIGRATIONS` object exported from `packages/api/src/db/schema.ts:25` (each value is a SQL string keyed by `'NNN_name'`). New migrations are added by appending entries to that object. All migration tasks below modify `schema.ts` rather than creating new SQL files.

### Modified files

**Phase 1 (DB):** `packages/api/src/db/schema.ts` — append migrations `041` through `045`.

**Phase 2 (Repo):** `packages/api/src/conversations/conversation-service.ts` — extend `Conversation`, `Message`, `ConversationRepository`, `InMemoryConversationRepository`. `packages/api/src/conversations/pg-conversation.ts` — implement new repo methods and updated column mappings.

**Phase 3 (API):** `packages/api/src/routes/conversations.ts` — `POST /:id/messages` gains outbound SMS send logic and opt-out guard. `packages/api/src/webhooks/routes.ts` — add `/webhooks/twilio/status` handler for delivery callbacks. `packages/api/src/app.ts` — wire new repositories and routers.

**Phase 4 (Web thread):** `packages/web/src/types/conversation.ts` — add `direction`, `status`, `externalId`, `senderType` to `Message`; add `scope`, `channel`, `customerId` to `Conversation`. `packages/web/src/components/conversations/MessageBubble.tsx` — add direction-aware rendering and status icons.

**Phase 5 (Unmatched + badges):** `packages/web/src/components/customers/CustomerDetailPage.tsx` — add Chat tab. `packages/api/src/routes/conversations.ts` — add `GET /api/conversations?customerId=` and `POST /api/conversations/:id/read`.

### Commit cadence

One commit per task. Every commit keeps tests green. No step leaves the repo broken.

---

## Phase 1: Database Migrations

Extend the `conversations` and `messages` tables with SMS-specific columns, add `sms_opt_out` to customers, and create three new tables: `unmatched_inbound_sms`, `conversation_read_state`. All migrations are appended to the `MIGRATIONS` object in `schema.ts` beginning at key `041_`.

### Task 1: Extend `conversations` table (scope, channel, customer_id)

**Files:**
- Modify: `packages/api/src/db/schema.ts`

**Context:** Migration `041` adds three columns to the existing `conversations` table. `scope` distinguishes internal job-note threads from customer-facing SMS threads. `channel` records the delivery medium. `customer_id` is a nullable FK to `customers` — nullable because existing internal conversations have no customer association.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/conversations/conversation.test.ts — add inside describe block
it('conversation has scope, channel, customer_id fields', async () => {
  const repo = new InMemoryConversationRepository();
  const conv = await repo.createConversation({
    tenantId: 'tenant-1',
    createdBy: 'user-1',
    scope: 'customer',
    channel: 'sms',
    customerId: 'cust-abc',
  });
  expect(conv.scope).toBe('customer');
  expect(conv.channel).toBe('sms');
  expect(conv.customerId).toBe('cust-abc');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/conversations/conversation.test.ts -t "scope"`
Expected: FAIL — `scope` does not exist on `CreateConversationInput` or `Conversation`

- [ ] **Step 3: Implement migration**

Append to `MIGRATIONS` in `packages/api/src/db/schema.ts`:

```sql
-- key: '041_conversations_add_customer_channel'
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'internal'
    CHECK (scope IN ('internal', 'customer')),
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'in_app'
    CHECK (channel IN ('sms', 'in_app')),
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id);
CREATE INDEX IF NOT EXISTS idx_conversations_customer ON conversations(tenant_id, customer_id);
```

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/db/schema.ts
git commit -m "feat(db): migration 041 — add scope, channel, customer_id to conversations"
```

---

### Task 2: Extend `messages` table (direction, status, external_id, sender_type)

**Files:**
- Modify: `packages/api/src/db/schema.ts`

**Context:** Migration `042` adds four columns to `messages`. `direction` is `inbound` or `outbound`. `status` tracks Twilio delivery lifecycle. `external_id` stores the Twilio Message SID for status callback correlation (indexed for O(1) lookup). `sender_type` identifies whether the sender is a staff member, customer, or system automated message.

- [ ] **Step 1: Write the failing test**

```typescript
it('message has direction, status, external_id, sender_type fields', async () => {
  const repo = new InMemoryConversationRepository();
  const conv = await repo.createConversation({ tenantId: 't1', createdBy: 'u1' });
  const msg = await repo.addMessage({
    tenantId: 't1',
    conversationId: conv.id,
    messageType: 'text',
    content: 'Hello',
    senderId: 'u1',
    senderRole: 'dispatcher',
    direction: 'outbound',
    status: 'queued',
    senderType: 'staff',
  });
  expect(msg.direction).toBe('outbound');
  expect(msg.status).toBe('queued');
  expect(msg.senderType).toBe('staff');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/conversations/conversation.test.ts -t "direction"`
Expected: FAIL — `direction` not on `CreateMessageInput` or `Message`

- [ ] **Step 3: Implement migration**

```sql
-- key: '042_messages_add_sms_fields'
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS direction TEXT CHECK (direction IN ('inbound', 'outbound')),
  ADD COLUMN IF NOT EXISTS status TEXT CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'received')),
  ADD COLUMN IF NOT EXISTS external_id TEXT,
  ADD COLUMN IF NOT EXISTS sender_type TEXT CHECK (sender_type IN ('staff', 'customer', 'system'));
CREATE INDEX IF NOT EXISTS idx_messages_external_id ON messages(external_id) WHERE external_id IS NOT NULL;
```

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/db/schema.ts
git commit -m "feat(db): migration 042 — add direction, status, external_id, sender_type to messages"
```

---

### Task 3: Add sms_opt_out to customers; create unmatched_inbound_sms table

**Files:**
- Modify: `packages/api/src/db/schema.ts`

**Context:** Migration `043` adds `sms_opt_out` to customers (CTIA STOP compliance). Migration `044` creates `unmatched_inbound_sms` — inbound messages whose `from_number` does not match any customer's `primary_phone`. `resolved_at` and `resolved_to_customer_id` are set when a dispatcher links the number to a customer.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/conversations/unmatched-sms.test.ts
import { InMemoryUnmatchedSmsRepository } from '../../src/conversations/unmatched-sms';

describe('UnmatchedSmsRepository', () => {
  it('saves and retrieves unmatched inbound SMS', async () => {
    const repo = new InMemoryUnmatchedSmsRepository();
    const record = await repo.save({
      tenantId: 't1',
      fromNumber: '+15550001111',
      body: 'Hello?',
      twilioSid: 'SM123',
    });
    expect(record.id).toBeTruthy();
    expect(record.resolvedAt).toBeNull();
    const list = await repo.findUnresolved('t1');
    expect(list).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/conversations/unmatched-sms.test.ts`
Expected: FAIL — module `../../src/conversations/unmatched-sms` does not exist

- [ ] **Step 3: Implement migrations + InMemory repo**

Append to `MIGRATIONS`:

```sql
-- key: '043_customers_add_sms_opt_out'
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS sms_opt_out BOOLEAN NOT NULL DEFAULT FALSE;

-- key: '044_create_unmatched_inbound_sms'
CREATE TABLE IF NOT EXISTS unmatched_inbound_sms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  from_number TEXT NOT NULL,
  body TEXT NOT NULL,
  twilio_sid TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_to_customer_id UUID REFERENCES customers(id)
);
CREATE INDEX IF NOT EXISTS idx_unmatched_tenant ON unmatched_inbound_sms(tenant_id, resolved_at);
ALTER TABLE unmatched_inbound_sms ENABLE ROW LEVEL SECURITY;
ALTER TABLE unmatched_inbound_sms FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_unmatched_sms ON unmatched_inbound_sms;
CREATE POLICY tenant_isolation_unmatched_sms ON unmatched_inbound_sms
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
```

Create `packages/api/src/conversations/unmatched-sms.ts` with `UnmatchedSmsRepository` interface and `InMemoryUnmatchedSmsRepository`.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/db/schema.ts packages/api/src/conversations/unmatched-sms.ts
git commit -m "feat(db): migrations 043-044 — sms_opt_out on customers, unmatched_inbound_sms table"
```

---

### Task 4: Create conversation_read_state table

**Files:**
- Modify: `packages/api/src/db/schema.ts`
- Create: `packages/api/src/conversations/read-state.ts`

**Context:** Migration `045` creates `conversation_read_state` which records when each user last read a given conversation. The unique constraint on `(tenant_id, conversation_id, user_id)` lets us upsert on each read event. Unread badge counts are computed as conversations where `messages.created_at > last_read_at` for the current user.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/conversations/read-state.test.ts
import { InMemoryReadStateRepository } from '../../src/conversations/read-state';

it('upserts last_read_at and computes unread flag', async () => {
  const repo = new InMemoryReadStateRepository();
  await repo.markRead('t1', 'conv-1', 'user-1');
  const state = await repo.getReadState('t1', 'conv-1', 'user-1');
  expect(state).not.toBeNull();
  expect(state!.lastReadAt).toBeInstanceOf(Date);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/conversations/read-state.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Append to `MIGRATIONS`:

```sql
-- key: '045_create_conversation_read_state'
CREATE TABLE IF NOT EXISTS conversation_read_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_read_state_tenant_user ON conversation_read_state(tenant_id, user_id);
ALTER TABLE conversation_read_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_read_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_read_state ON conversation_read_state;
CREATE POLICY tenant_isolation_read_state ON conversation_read_state
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
```

Create `packages/api/src/conversations/read-state.ts` with `ReadStateRepository` interface and `InMemoryReadStateRepository` (Map-backed, keyed by `${conversationId}:${userId}`).

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/db/schema.ts packages/api/src/conversations/read-state.ts
git commit -m "feat(db): migration 045 — conversation_read_state table for unread badges"
```

---

## Phase 2: Repository Extensions & Inbound SMS Resolution

Update `ConversationRepository` with customer-centric methods, wire Pg implementations, and implement `resolveInboundMessage()` — the core inbound routing logic.

### Task 5: Extend ConversationRepository interface and InMemory implementation

**Files:**
- Modify: `packages/api/src/conversations/conversation-service.ts`

**Context:** Add `scope`, `channel`, `customerId` to `Conversation` and `CreateConversationInput`. Add `direction`, `status`, `externalId`, `senderType` to `Message` and `CreateMessageInput`. Add three new repository methods: `findByCustomer`, `createCustomerConversation`, and `updateMessageStatus`.

- [ ] **Step 1: Write the failing test**

```typescript
it('findByCustomer returns customer-scoped conversations', async () => {
  const repo = new InMemoryConversationRepository();
  await repo.createCustomerConversation('t1', 'cust-1', undefined);
  const convs = await repo.findByCustomer('t1', 'cust-1');
  expect(convs).toHaveLength(1);
  expect(convs[0].scope).toBe('customer');
  expect(convs[0].customerId).toBe('cust-1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/conversations/conversation.test.ts -t "findByCustomer"`
Expected: FAIL — `findByCustomer` not on `InMemoryConversationRepository`

- [ ] **Step 3: Implement**

Extend the `Conversation` interface with `scope?: 'internal' | 'customer'`, `channel?: 'sms' | 'in_app'`, `customerId?: string`. Extend `Message` with `direction?: 'inbound' | 'outbound'`, `status?: string`, `externalId?: string`, `senderType?: 'staff' | 'customer' | 'system'`. Add the three new methods to `ConversationRepository` and implement in `InMemoryConversationRepository`. `createCustomerConversation` creates a conversation with `scope: 'customer'`, `channel: 'sms'`, `createdBy: 'system'`.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/conversations/conversation-service.ts
git commit -m "feat(conversations): extend ConversationRepository with customer chat methods"
```

---

### Task 6: Implement PgConversationRepository extensions

**Files:**
- Modify: `packages/api/src/conversations/pg-conversation.ts`

**Context:** Update `mapConversationRow` and `mapMessageRow` to include the new columns. Implement `findByCustomer`, `createCustomerConversation`, and `updateMessageStatus` with SQL. `updateMessageStatus` is used by both the outbound send flow (status: `queued` -> `sent`) and the Twilio delivery callback.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/conversations/pg-conversation.integration.test.ts (skip if no DATABASE_URL)
it.skipIf(!process.env.DATABASE_URL)('Pg: updateMessageStatus updates status and external_id', async () => {
  // ... integration test body
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/conversations/pg-conversation.integration.test.ts`
Expected: SKIP (no DATABASE_URL in CI unit test run) or FAIL if DB present

- [ ] **Step 3: Implement**

Update `mapConversationRow` to read `scope`, `channel`, `customer_id`. Update `mapMessageRow` to read `direction`, `status`, `external_id`, `sender_type`. Update `createConversation` INSERT to include the new columns. Add `findByCustomer`, `createCustomerConversation`, `updateMessageStatus` methods.

```typescript
async updateMessageStatus(
  tenantId: string,
  messageId: string,
  status: string,
  externalId?: string
): Promise<Message | null> { /* UPDATE messages SET status=$1, external_id=COALESCE($2, external_id) WHERE id=$3 */ }
```

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/conversations/pg-conversation.ts
git commit -m "feat(conversations): Pg implementation of findByCustomer, createCustomerConversation, updateMessageStatus"
```

---

### Task 7: Implement inbound SMS resolver

**Files:**
- Create: `packages/api/src/conversations/inbound-sms-resolver.ts`
- Create: `packages/api/test/conversations/inbound-sms-resolver.test.ts`

**Context:** `resolveInboundMessage(tenantId, fromNumber, body, twilioSid, deps)` is the core routing function. It: (1) handles STOP/UNSTOP/HELP keywords before doing anything else; (2) looks up customer by `primary_phone`; (3) if no customer, saves to `unmatched_inbound_sms` and returns; (4) finds the most recent open `customer`-scoped conversation for that customer or creates one; (5) appends the message with `direction: 'inbound'`, `status: 'received'`, `senderType: 'customer'`.

- [ ] **Step 1: Write the failing test**

```typescript
import { resolveInboundMessage } from '../../src/conversations/inbound-sms-resolver';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryUnmatchedSmsRepository } from '../../src/conversations/unmatched-sms';

describe('resolveInboundMessage', () => {
  it('routes matched inbound SMS to existing conversation', async () => {
    const convRepo = new InMemoryConversationRepository();
    const custRepo = new InMemoryCustomerRepository();
    const unmatchedRepo = new InMemoryUnmatchedSmsRepository();
    // seed customer
    const cust = await custRepo.create({ id: 'c1', tenantId: 't1', primaryPhone: '+15550001111', ... });
    const conv = await convRepo.createCustomerConversation('t1', 'c1', undefined);

    await resolveInboundMessage('t1', '+15550001111', 'Hi there', 'SMabc', { convRepo, custRepo, unmatchedRepo });

    const messages = await convRepo.getMessages('t1', conv.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].direction).toBe('inbound');
    expect(messages[0].senderType).toBe('customer');
  });

  it('saves to unmatched when phone has no customer', async () => {
    const convRepo = new InMemoryConversationRepository();
    const custRepo = new InMemoryCustomerRepository();
    const unmatchedRepo = new InMemoryUnmatchedSmsRepository();

    await resolveInboundMessage('t1', '+19990009999', 'Hello', 'SMxyz', { convRepo, custRepo, unmatchedRepo });

    const unmatched = await unmatchedRepo.findUnresolved('t1');
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].fromNumber).toBe('+19990009999');
  });

  it('sets sms_opt_out on STOP keyword', async () => {
    // seed customer, call resolver with body='STOP', assert customer.smsOptOut=true
  });

  it('replies with help text on HELP keyword', async () => {
    // assert TwilioSmsProvider.send was called with help text
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/conversations/inbound-sms-resolver.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Create `inbound-sms-resolver.ts`. Implement `resolveInboundMessage`. STOP sets `customer.smsOptOut = true` via `CustomerRepository.update`. UNSTOP sets it to `false`. HELP calls `TwilioSmsProvider.send(helpText)` and returns early. Customer lookup is `CustomerRepository.findByPhone(tenantId, fromNumber)` — add this method to the interface if not present (searching both `primary_phone` and `secondary_phone`).

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/conversations/inbound-sms-resolver.ts packages/api/test/conversations/inbound-sms-resolver.test.ts
git commit -m "feat(conversations): inbound SMS resolver — route, opt-out, HELP, unmatched handling"
```

---

### Task 8: Implement PgUnmatchedSmsRepository + PgReadStateRepository

**Files:**
- Create: `packages/api/src/conversations/pg-unmatched-sms.ts`
- Create: `packages/api/src/conversations/pg-read-state.ts`

**Context:** Two thin Pg implementations following the codebase's standard `PgBaseRepository` pattern. `pg-unmatched-sms` adds a `resolve(tenantId, id, customerId)` method that sets `resolved_at = NOW()` and `resolved_to_customer_id`. `pg-read-state` uses `INSERT ... ON CONFLICT DO UPDATE` for the upsert.

- [ ] **Step 1: Write the failing test**

No new unit tests needed (InMemory tests cover behavior). Add integration test stubs gated on `DATABASE_URL`.

- [ ] **Step 2: Implement**

Create `pg-unmatched-sms.ts` extending `PgBaseRepository`, implementing `UnmatchedSmsRepository`. Create `pg-read-state.ts` with `upsert` using `ON CONFLICT (tenant_id, conversation_id, user_id) DO UPDATE SET last_read_at = NOW()`.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/conversations/pg-unmatched-sms.ts packages/api/src/conversations/pg-read-state.ts
git commit -m "feat(conversations): Pg repos for unmatched_inbound_sms and conversation_read_state"
```

---

## Phase 3: Outbound Send, Delivery Status, & Opt-Out API

Wire the outbound SMS send path, the Twilio status callback webhook, and the opt-out guard into the Express routes.

### Task 9: Outbound SMS send endpoint

**Files:**
- Modify: `packages/api/src/routes/conversations.ts`

**Context:** `POST /api/conversations/:id/messages` already exists for internal messages. It needs a new code path: when the conversation has `scope: 'customer'` and `channel: 'sms'`, check `customer.smsOptOut` first (return 422 if opted out), save the message with `direction: 'outbound'`, `status: 'queued'`, then call `TwilioSmsProvider.send()` asynchronously and call `updateMessageStatus` with the resulting SID.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/conversations/outbound-sms.test.ts
it('POST /conversations/:id/messages sends SMS for customer-scoped conversation', async () => {
  // set up supertest with customer conversation, mock TwilioSmsProvider
  // assert response 201, message direction=outbound, status=queued
});

it('returns 422 when customer has sms_opt_out=true', async () => {
  // assert 422 with error code SMS_OPT_OUT
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/conversations/outbound-sms.test.ts`
Expected: FAIL — no opt-out check, no TwilioSmsProvider call

- [ ] **Step 3: Implement**

Inject `TwilioSmsProvider` and `CustomerRepository` into `createConversationRouter`. In the `POST /:id/messages` handler, after saving the message: if `conv.scope === 'customer' && conv.channel === 'sms'`, look up the customer, check `smsOptOut`, send via Twilio, update status. Return immediately with the `queued` message; Twilio status callbacks will update delivery status asynchronously.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/conversations.ts
git commit -m "feat(conversations): outbound SMS send with opt-out guard and Twilio integration"
```

---

### Task 10: Twilio delivery status callback webhook

**Files:**
- Modify: `packages/api/src/webhooks/routes.ts`

**Context:** Twilio POSTs to `/webhooks/twilio/status` with `MessageSid`, `MessageStatus` fields. The handler validates the Twilio signature (using the `TwilioRequestValidator` from the Twilio SMS Platform plan), looks up the message by `external_id = MessageSid`, and calls `updateMessageStatus`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/webhooks/twilio-status.test.ts
it('updates message status on delivered callback', async () => {
  // POST /webhooks/twilio/status with MessageSid + MessageStatus=delivered
  // assert message.status updated to 'delivered'
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/webhooks/twilio-status.test.ts`
Expected: FAIL — route does not exist

- [ ] **Step 3: Implement**

Add `router.post('/twilio/status', ...)` inside `createWebhookRouter`. Parse `MessageSid` and `MessageStatus` from `req.body`. Call `conversationRepo.updateMessageStatus(tenantId, ..., status)` after looking up message by `external_id`. Return `200 <?xml ...><Response/></Response>` (Twilio expects TwiML or empty 200).

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/webhooks/routes.ts
git commit -m "feat(webhooks): Twilio delivery status callback updates message status"
```

---

### Task 11: Inbound SMS webhook route

**Files:**
- Modify: `packages/api/src/webhooks/routes.ts`

**Context:** Twilio POSTs inbound messages to `/webhooks/twilio/inbound`. The handler calls `resolveInboundMessage` passing the Twilio `From`, `Body`, and `MessageSid` fields. Tenant routing uses the `To` number to look up the tenant's configured Twilio number.

- [ ] **Step 1: Write the failing test**

```typescript
it('inbound webhook routes matched SMS to conversation', async () => {
  // POST /webhooks/twilio/inbound with From=matched phone, Body='Test'
  // assert conversation message created
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/webhooks/twilio-inbound.test.ts`
Expected: FAIL — route does not exist

- [ ] **Step 3: Implement**

Add `router.post('/twilio/inbound', ...)`. Parse `From`, `Body`, `MessageSid`, `To` from `req.body`. Look up tenant by `To` number (query `tenant_settings` for `twilio_from_number`). Call `resolveInboundMessage`. Respond with empty TwiML `<Response/>`.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/webhooks/routes.ts packages/api/src/app.ts
git commit -m "feat(webhooks): inbound Twilio SMS webhook routes to resolveInboundMessage"
```

---

## Phase 4: Chat Thread UI & Polling

Build the `CustomerChat.tsx` component and the `useChatMessages` polling hook. Update `MessageBubble` to render direction-aware layout with delivery status icons.

### Task 12: useChatMessages polling hook

**Files:**
- Create: `packages/web/src/hooks/useChatMessages.ts`

**Context:** Polls `GET /api/conversations/:id/messages` every 10 seconds using `setInterval`. Returns `{ messages, isLoading, error, sendMessage }`. `sendMessage` POSTs to `POST /api/conversations/:id/messages` with `direction: 'outbound'` and optimistically appends the message before the server confirms.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/hooks/useChatMessages.test.ts
import { renderHook, act } from '@testing-library/react';
import { useChatMessages } from './useChatMessages';

it('polls messages every 10 seconds', async () => {
  vi.useFakeTimers();
  const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
  global.fetch = fetchSpy;
  renderHook(() => useChatMessages('conv-1'));
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(10000));
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/hooks/useChatMessages.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Create `useChatMessages.ts` using `useState`, `useEffect`, `useCallback`. `useEffect` sets up a 10-second `setInterval` and cleans it up on unmount. `sendMessage` calls `apiFetch` with `POST`, then triggers a manual refetch. The hook accepts an optional `enabled` flag defaulting to `true`.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/hooks/useChatMessages.ts
git commit -m "feat(web): useChatMessages hook with 10-second polling"
```

---

### Task 13: Direction-aware MessageBubble & CustomerChat component

**Files:**
- Modify: `packages/web/src/components/conversations/MessageBubble.tsx`
- Create: `packages/web/src/components/conversations/CustomerChat.tsx`
- Modify: `packages/web/src/types/conversation.ts`

**Context:** `MessageBubble` gains a `direction` prop. Outbound messages are right-aligned with a blue background; inbound are left-aligned with a grey background. Status icons: clock (queued), checkmark (sent), double-checkmark (delivered), X (failed). `CustomerChat.tsx` composes the full thread: scrollable message list, `MessageInput` at the bottom, opt-out warning banner when `customer.smsOptOut` is `true`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/components/conversations/CustomerChat.test.tsx
it('renders outbound message on right', () => {
  const msg = { id: '1', direction: 'outbound', content: 'Hi', status: 'sent', ... };
  const { getByTestId } = render(<MessageBubble message={msg} />);
  expect(getByTestId('message-bubble')).toHaveClass('message-outbound');
});

it('shows opt-out banner when smsOptOut is true', () => {
  const { getByTestId } = render(
    <CustomerChat conversationId="c1" customer={{ smsOptOut: true }} />
  );
  expect(getByTestId('opt-out-banner')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/conversations/CustomerChat.test.tsx`
Expected: FAIL — `CustomerChat` and `direction` prop do not exist

- [ ] **Step 3: Implement**

Update `Message` type in `packages/web/src/types/conversation.ts` to add `direction?: 'inbound' | 'outbound'`, `status?: string`, `externalId?: string`, `senderType?: string`. Extend `Conversation` with `scope?`, `channel?`, `customerId?`.

Update `MessageBubble` to apply `message-outbound` / `message-inbound` CSS classes based on `message.direction`, and render a status icon `<span data-testid="message-status-icon">` for `delivered`, `sent`, `queued`, `failed`.

Create `CustomerChat.tsx`: uses `useChatMessages`, renders a scrollable `<div data-testid="chat-thread">`, maps messages to `<MessageBubble>`, renders `<MessageInput onSend={sendMessage} disabled={customer.smsOptOut}>`, and conditionally renders `<div data-testid="opt-out-banner">`.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/conversations/CustomerChat.tsx packages/web/src/components/conversations/MessageBubble.tsx packages/web/src/types/conversation.ts
git commit -m "feat(web): CustomerChat component with direction-aware bubbles, status icons, opt-out banner"
```

---

## Phase 5: Unmatched SMS Panel & Unread Badges

Surface unmatched inbound SMS for dispatcher resolution and show unread badge counts on conversation list items.

### Task 14: Unmatched SMS API routes

**Files:**
- Create: `packages/api/src/routes/unmatched-sms.ts`
- Modify: `packages/api/src/app.ts`

**Context:** `GET /api/unmatched-sms` returns all unresolved records for the tenant. `POST /api/unmatched-sms/:id/resolve` accepts `{ customerId }`, calls `unmatchedRepo.resolve()`, then creates (or finds existing) a customer conversation and re-appends the SMS body as an inbound message.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/conversations/unmatched-sms-routes.test.ts
it('GET /unmatched-sms returns unresolved records', async () => {
  // seed unmatched record, GET, assert array length 1
});

it('POST /unmatched-sms/:id/resolve creates conversation and marks resolved', async () => {
  // seed record, POST with customerId, assert resolved_at set, conversation created
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/conversations/unmatched-sms-routes.test.ts`
Expected: FAIL — routes do not exist

- [ ] **Step 3: Implement**

Create `routes/unmatched-sms.ts` with `createUnmatchedSmsRouter(deps)`. Wire into `app.ts` at `app.use('/api/unmatched-sms', ...)`.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/unmatched-sms.ts packages/api/src/app.ts
git commit -m "feat(api): unmatched SMS list and resolve endpoints"
```

---

### Task 15: Unmatched SMS Panel UI

**Files:**
- Create: `packages/web/src/components/conversations/UnmatchedSmsPanel.tsx`

**Context:** A table/card list of unresolved inbound SMS records. Each row shows `from_number`, `body` (truncated to 80 chars), `received_at`. A "Link to Customer" button opens a customer search modal; on confirmation, calls `POST /api/unmatched-sms/:id/resolve` with the selected `customerId` and navigates to the resulting conversation.

- [ ] **Step 1: Write the failing test**

```typescript
it('renders list of unmatched SMS records', () => {
  const records = [{ id: '1', fromNumber: '+15550001111', body: 'Hello', receivedAt: '...' }];
  const { getByText } = render(<UnmatchedSmsPanel records={records} onResolve={vi.fn()} />);
  expect(getByText('+15550001111')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/conversations/UnmatchedSmsPanel.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Create `UnmatchedSmsPanel.tsx`. Accept `records` and `onResolve(id, customerId)` as props. Render records in a list with `data-testid="unmatched-sms-row"`. "Link to Customer" button shows an inline customer search `<select>` or modal (reuse existing customer search patterns). On confirm, call `onResolve`. Parent page fetches from `GET /api/unmatched-sms` and handles the `onResolve` callback with `POST`.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/conversations/UnmatchedSmsPanel.tsx
git commit -m "feat(web): UnmatchedSmsPanel for dispatcher review and resolution"
```

---

### Task 16: Unread badge counts & read state endpoint

**Files:**
- Modify: `packages/api/src/routes/conversations.ts`
- Modify: `packages/web/src/components/conversations/CustomerChat.tsx`

**Context:** `GET /api/conversations?customerId=` returns customer conversations (calls `findByCustomer`). `POST /api/conversations/:id/read` upserts `conversation_read_state`. Each conversation list item in the UI shows an unread badge when `messages` contains entries after `last_read_at` for the current user. `CustomerChat` calls the read endpoint on mount and after each send.

- [ ] **Step 1: Write the failing test**

```typescript
it('POST /conversations/:id/read upserts read state', async () => {
  // call endpoint, assert 204, call again to verify upsert does not error
});

it('GET /conversations?customerId= returns customer conversations', async () => {
  // seed customer conversation, GET with customerId query param, assert result
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/conversations/ -t "read state"`
Expected: FAIL — endpoints not implemented

- [ ] **Step 3: Implement**

Add `GET /` handler in conversations router that reads optional `customerId` query param and calls `findByCustomer` when present. Add `POST /:id/read` handler calling `readStateRepo.markRead(tenantId, conversationId, userId)`. Return `204 No Content`.

In `CustomerChat.tsx`, call `apiFetch('POST', /api/conversations/${conversationId}/read)` inside a `useEffect` on mount. Surface an unread badge count by comparing `messages.filter(m => new Date(m.createdAt) > lastReadAt).length`.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/conversations.ts packages/web/src/components/conversations/CustomerChat.tsx
git commit -m "feat(conversations): unread badge counts with read-state endpoint and CustomerChat integration"
```

---

### Task 17: Wire CustomerChat into CustomerDetailPage

**Files:**
- Modify: `packages/web/src/components/customers/CustomerDetailPage.tsx`

**Context:** The customer detail page gains a "Messages" tab alongside existing Jobs/Estimates/Invoices tabs. Selecting the tab fetches conversations via `GET /api/conversations?customerId=:id`, picks the most recent open `customer`-scoped conversation (or prompts to start one), and renders `<CustomerChat>`. An "Unmatched SMS" link in the sidebar navigation opens `<UnmatchedSmsPanel>` for dispatchers only.

- [ ] **Step 1: Write the failing test**

```typescript
it('CustomerDetailPage renders Messages tab', () => {
  const { getByText } = render(<CustomerDetailPage />);
  expect(getByText('Messages')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/customers/CustomerDetailPage.test.tsx -t "Messages"`
Expected: FAIL — no Messages tab

- [ ] **Step 3: Implement**

Add `'messages'` to the tab list. In the `messages` tab panel, render `<CustomerChat conversationId={activeConvId} customer={customer} />`. Handle `activeConvId` by fetching `GET /api/conversations?customerId=${customer.id}` and taking the first result, or showing a "Start SMS conversation" button that calls `POST /api/conversations` with `scope: 'customer'`, `channel: 'sms'`, `customerId`.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/customers/CustomerDetailPage.tsx
git commit -m "feat(web): Messages tab on CustomerDetailPage with CustomerChat integration"
```

---

## Out of scope

- WebSockets / real-time push (beta uses 10-second polling only)
- MMS / media message attachments
- Email channel
- WhatsApp or other messaging platforms
- Group SMS (one conversation, multiple customer recipients)
- AI-assisted reply suggestions
- Message scheduling / send-later
- Customer-initiated conversation creation (customers cannot open new threads; only inbound SMS routing does)
- Read receipts sent back to the customer over SMS
- Multi-number support per tenant (single Twilio number per tenant for beta)

---

### Critical Files for Implementation
- `/home/user/Serviceos/packages/api/src/db/schema.ts`
- `/home/user/Serviceos/packages/api/src/conversations/conversation-service.ts`
- `/home/user/Serviceos/packages/api/src/conversations/pg-conversation.ts`
- `/home/user/Serviceos/packages/api/src/routes/conversations.ts`
- `/home/user/Serviceos/packages/web/src/components/conversations/CustomerChat.tsx`
