import { expect, matrixTest, test } from './helpers/matrix-test';

/**
 * CONV-01 — conversation thread: create → append a text message → read the
 *           thread back, message present.
 */

test.describe.configure({ mode: 'serial' });

matrixTest('CONV-01', 'Conversation + message thread', async (h) => {
  const { token } = h.tenantA;

  const conv = await h.api.call({
    method: 'POST',
    path: '/api/conversations',
    body: { title: `QA thread ${Date.now()}`, entityType: 'job', entityId: h.tenantA.jobId },
    token,
    label: '01-create-conversation',
    expectStatus: 201,
  });
  const conversationId = (conv.response.body as { id: string }).id;
  expect(conversationId, 'conversation create must return an id').toBeTruthy();

  await h.api.call({
    method: 'POST',
    path: `/api/conversations/${conversationId}/messages`,
    body: { conversationId, messageType: 'text', content: 'QA hello' },
    token,
    label: '01-post-message',
    expectStatus: 201,
  });

  const thread = await h.api.call({
    method: 'GET',
    path: `/api/conversations/${conversationId}/messages`,
    token,
    label: '01-read-thread',
    expectStatus: 200,
  });
  const body = thread.response.body as Array<{ content?: string }> | { data?: Array<{ content?: string }> };
  const msgs = Array.isArray(body) ? body : body.data ?? [];
  expect(msgs.length, 'thread must contain at least one message').toBeGreaterThanOrEqual(1);
  expect(msgs.some((m) => m.content === 'QA hello'), 'posted message must be in the thread').toBe(true);

  h.evidence.pass();
});
