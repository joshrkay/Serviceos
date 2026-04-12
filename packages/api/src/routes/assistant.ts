import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { createLLMGateway } from '../ai/gateway';
import { loadConfig } from '../shared/config';

const assistantMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
});

const assistantProposalSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  explanation: z.string(),
  reasoning: z.array(z.string()).optional(),
  editFields: z.array(z.object({ label: z.string(), key: z.string(), value: z.string() })).optional(),
  confidence: z.enum(['High', 'Medium']),
  type: z.enum(['Invoice', 'Estimate', 'Schedule', 'Follow-up', 'Alert', 'Duplicate']),
  status: z.enum(['Pending', 'Approved', 'Rejected']),
  relatedId: z.string().optional(),
  impact: z.string().optional(),
});

const assistantReplySchema = z.object({
  content: z.string().min(1),
  reasoning: z.string().optional(),
  autoApplied: z.boolean().optional(),
  proposal: assistantProposalSchema.optional(),
});

const assistantChatRequestSchema = z.object({
  messages: z.array(assistantMessageSchema).min(1),
  stream: z.boolean().optional(),
});

function inferTaskType(text: string): string {
  const t = text.toLowerCase();
  if (t.includes('invoice') || t.includes('payment') || t.includes('overdue')) return 'assistant.invoice';
  if (t.includes('schedule') || t.includes('tomorrow') || t.includes('dispatch')) return 'assistant.schedule';
  if (t.includes('follow-up') || t.includes('follow up') || t.includes('reminder')) return 'assistant.followup';
  if (t.includes('estimate') || t.includes('quote')) return 'assistant.estimate';
  return 'assistant.general';
}

function getSystemPrompt(taskType: string): string {
  if (taskType === 'assistant.invoice') {
    return 'You are a field-service assistant. Focus on invoice recommendations, payment status, and concise next actions.';
  }
  if (taskType === 'assistant.schedule') {
    return 'You are a field-service assistant. Focus on dispatch scheduling, availability, and conflict-free recommendations.';
  }
  if (taskType === 'assistant.followup') {
    return 'You are a field-service assistant. Focus on customer follow-up drafting with polite and actionable language.';
  }
  if (taskType === 'assistant.estimate') {
    return 'You are a field-service assistant. Focus on estimate clarity, scope, and customer-ready language.';
  }
  return 'You are a field-service assistant. Provide concise, high-signal operational help for jobs, customers, schedule, and billing.';
}

const outputContract = `
Return JSON only. No markdown. Match this schema exactly:
{
  "content": "assistant message text",
  "reasoning": "short optional rationale",
  "autoApplied": false,
  "proposal": {
    "id": "proposal-id",
    "title": "...",
    "summary": "...",
    "explanation": "...",
    "reasoning": ["..."],
    "editFields": [{"label":"...", "key":"...", "value":"..."}],
    "confidence": "High",
    "type": "Invoice",
    "status": "Pending",
    "relatedId": "optional-related-id",
    "impact": "optional impact statement"
  }
}
Set "proposal" to null when no proposal is needed.
`;

async function generateAssistantReply(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, tenantId: string) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const taskType = inferTaskType(lastUser?.content ?? '');
  const systemPrompt = getSystemPrompt(taskType);

  try {
    const config = loadConfig();
    const gateway = createLLMGateway(config);
    const response = await gateway.complete({
      taskType,
      responseFormat: 'json',
      messages: [
        { role: 'system', content: `${systemPrompt}\n\n${outputContract}` },
        ...messages.filter((m) => m.role !== 'system'),
      ],
      temperature: 0.2,
      maxTokens: 700,
      metadata: { source: 'assistant-chat-route', tenantId },
    });

    const parsed = assistantReplySchema.parse(JSON.parse(response.content));
    return {
      taskType,
      model: response.model,
      usage: response.tokenUsage,
      message: {
        role: 'assistant' as const,
        ...parsed,
        proposal: parsed.proposal ?? undefined,
      },
    };
  } catch {
    return {
      taskType,
      model: 'fallback',
      usage: { input: 0, output: 0, total: 0 },
      message: {
        role: 'assistant' as const,
        content: 'I can help with invoices, scheduling, follow-ups, and estimates. Tell me what you want to do next.',
        reasoning: 'AI provider unavailable, returned fallback response.',
      },
    };
  }
}

function writeSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createAssistantRouter(): Router {
  const router = Router();

  router.post(
    '/chat',
    requireAuth,
    requireTenant,
    requirePermission('ai:run'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = assistantChatRequestSchema.parse(req.body);
        const result = await generateAssistantReply(parsed.messages, req.auth!.tenantId);

        if (parsed.stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          res.flushHeaders();

          const content = result.message.content;
          const chunks = content.match(/.{1,18}(\s|$)/g) ?? [content];
          for (const chunk of chunks) {
            writeSse(res, 'token', { delta: chunk });
          }
          writeSse(res, 'done', result);
          res.end();
          return;
        }

        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
