/**
 * #1144 — the customer-photo leg never left the Assistant chat.
 * AssistantPage.tsx's `send()` accepted `opts.attachments` and rendered them
 * in LOCAL chat-bubble state, but `sendToConversationAPI` (AssistantPage.tsx
 * ~69-90) POSTed only `{ messages, conversationId, inputMode }` — the
 * attachment's file reference never reached `POST /api/assistant/chat`, and
 * even if it had, `assistantChatRequestSchema` had no field for it (Zod
 * silently strips unknown keys), so it would have been dropped anyway.
 *
 * The web fix uploads the photo through the existing files route
 * (POST /api/files/upload-url → PUT → fileId) and sends `{ attachments:
 * [{ fileId }] }` on the turn. This file pins the SERVER half of that
 * contract: the schema now declares `attachments` (additive, optional) so a
 * well-formed reference survives `.parse()` instead of being silently
 * stripped, and a malformed one is now actually validated (400) rather than
 * silently ignored — proof the field is genuinely recognized, not just
 * tolerated as inert JSON.
 *
 * #1173 consumes the field: the fileId is resolved tenant-scoped and reaches
 * the draft estimate as an image part — proven at real Postgres in
 * test/integration/assistant-photo-estimate-draft.test.ts. (This file's
 * router has no `photoAttachments` wired, so its 200 leg is the honest
 * "couldn't open that photo" reply, not a draft.)
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect } from 'vitest';
import { createAssistantRouter, assistantChatRequestSchema } from '../../src/routes/assistant';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';

const TEST_TENANT = 'tenant-1144';
const TEST_USER = 'user-1144';

function buildApp(gateway: LLMGateway, proposalRepo: InMemoryProposalRepository) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER,
      sessionId: 'sess-1144',
      tenantId: TEST_TENANT,
      role: 'owner',
    };
    next();
  });
  app.use('/api/assistant', createAssistantRouter({ gateway, proposalRepo }));
  return app;
}

function plainReplyGateway(content = "Got it, I've noted that."): LLMGateway {
  return {
    complete: async (): Promise<LLMResponse> => ({
      content: JSON.stringify({ content }),
      model: 'test-model',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }),
  } as unknown as LLMGateway;
}

describe('#1144 — assistantChatRequestSchema.attachments (additive contract)', () => {
  it('retains a well-formed fileId reference instead of silently stripping it', () => {
    const parsed = assistantChatRequestSchema.parse({
      messages: [{ role: 'user', content: "Here's the photo — can you identify the issue?" }],
      attachments: [{ fileId: 'file-abc123' }],
    });
    expect(parsed.attachments).toEqual([{ fileId: 'file-abc123' }]);
  });

  it('POST /api/assistant/chat 400s on a malformed attachment entry (proves the field is validated, not silently ignored)', async () => {
    const app = buildApp(plainReplyGateway(), new InMemoryProposalRepository());
    const res = await request(app)
      .post('/api/assistant/chat')
      .send({
        messages: [{ role: 'user', content: 'hello' }],
        attachments: [{ notFileId: 'file-abc123' }],
      });
    expect(res.status).toBe(400);
  });

  it('POST /api/assistant/chat accepts a turn carrying a real fileId reference (200, not a 400)', async () => {
    const app = buildApp(plainReplyGateway(), new InMemoryProposalRepository());
    const res = await request(app)
      .post('/api/assistant/chat')
      .send({
        messages: [{ role: 'user', content: "Here's the photo — can you identify the issue?" }],
        attachments: [{ fileId: 'file-abc123' }],
      });
    expect(res.status).toBe(200);
  });
});
