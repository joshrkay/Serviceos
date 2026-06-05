import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { LLMGateway } from '../ai/gateway/gateway';
import { ProposalRepository } from '../proposals/proposal';
import { classifyIntent } from '../ai/orchestration/intent-classifier';
import { CreateCustomerTaskHandler } from '../ai/tasks/task-handlers';
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'routes.assistant',
  environment: process.env.NODE_ENV || 'development',
});

const assistantMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
});

/**
 * UI proposal shape consumed by AssistantPage + AIProposalCard. Narrower
 * than the server-side Proposal — the card only renders a title, summary,
 * optional edit fields, and a coarse confidence band. 'Customer' was
 * added alongside AST-01b so create_customer proposals have a home in
 * the UI type switch.
 */
const assistantProposalSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  explanation: z.string(),
  reasoning: z.array(z.string()).optional(),
  editFields: z.array(z.object({ label: z.string(), key: z.string(), value: z.string() })).optional(),
  confidence: z.enum(['High', 'Medium']),
  type: z.enum(['Invoice', 'Estimate', 'Schedule', 'Follow-up', 'Alert', 'Duplicate', 'Customer']),
  status: z.enum(['Pending', 'Approved', 'Rejected']),
  // QA-2026-06-05: LLMs emit JSON null for "no value" — .optional() alone
  // rejects null, so every estimate-draft completion whose relatedId/impact
  // was null failed validation and degraded to the fallback envelope
  // (live: "LLM completion failed ... expected string, received null").
  relatedId: z.string().nullish().transform((v) => v ?? undefined),
  impact: z.string().nullish().transform((v) => v ?? undefined),
});

const assistantReplySchema = z.object({
  content: z.string().min(1),
  reasoning: z.string().optional(),
  autoApplied: z.boolean().optional(),
  proposal: assistantProposalSchema.nullable().optional(),
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

export interface AssistantRouterDeps {
  gateway: LLMGateway;
  proposalRepo: ProposalRepository;
  /**
   * §3B/3D/3E — vertical-aware prompt resolver. When wired, the
   * assistant chat classifier sees the tenant's HVAC/plumbing pack
   * terminology + intake-disambiguation questions + objection scripts
   * as a separate system message, matching the voice pipeline. Without
   * it, an operator chatting "draft an estimate for the Johnson water
   * heater" can miss vertical-specific entity terms. Optional so tests
   * can omit it.
   */
  verticalPromptResolver?: (tenantId: string) => Promise<string | undefined>;
}

type AssistantProposal = z.infer<typeof assistantProposalSchema>;

/**
 * Map the server-side create_customer Proposal to the UI card shape.
 * Reads `name` / `email` / `phone` out of the payload (the router
 * translates classifier `displayName` → contract `name` in AST-01).
 */
function customerProposalToUI(
  proposalId: string,
  payload: Record<string, unknown>,
  sourceMessage: string,
  confidenceScore: number
): AssistantProposal {
  const name = typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : undefined;
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const phone = typeof payload.phone === 'string' ? payload.phone : undefined;

  const title = name ? `New customer: ${name}` : 'New customer (needs details)';
  const summary = [
    name ? `Name: ${name}` : 'Name not provided',
    email ? `Email: ${email}` : undefined,
    phone ? `Phone: ${phone}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    id: proposalId,
    title,
    summary: summary || 'Review and approve to add this customer.',
    explanation: `From your message: "${sourceMessage}"`,
    editFields: [
      { label: 'Name', key: 'name', value: name ?? '' },
      { label: 'Email', key: 'email', value: email ?? '' },
      { label: 'Phone', key: 'phone', value: phone ?? '' },
    ],
    confidence: confidenceScore >= 0.85 ? 'High' : 'Medium',
    type: 'Customer',
    status: 'Pending',
  };
}

async function generateAssistantReply(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  tenantId: string,
  userId: string,
  deps: AssistantRouterDeps
) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const lastUserText = lastUser?.content ?? '';

  // ── Intent path: AST-01b ──────────────────────────────────────────
  // Run the same classifier the voice pipeline uses. If the message is
  // a recognized action (today: create_customer), build a real proposal
  // and return it instead of a free-text LLM reply. Other intents fall
  // through to the LLM — separate stories wire them into the chat.
  if (lastUserText.trim().length > 0) {
    try {
      // §3B/3D/3E — resolve the tenant's vertical context (terminology +
      // intake questions + objection scripts) once per request. The
      // resolver memoizes internally; a failure falls back to the bare
      // classifier rather than breaking the chat.
      let verticalPromptSection: string | undefined;
      if (deps.verticalPromptResolver) {
        try {
          verticalPromptSection = await deps.verticalPromptResolver(tenantId);
        } catch {
          verticalPromptSection = undefined;
        }
      }

      const classification = await classifyIntent(
        lastUserText,
        { tenantId, ...(verticalPromptSection ? { verticalPromptSection } : {}) },
        deps.gateway,
      );

      if (classification.intentType === 'create_customer') {
        const handler = new CreateCustomerTaskHandler();
        const entities = classification.extractedEntities;
        // Same translation the voice-action-router does: classifier
        // surfaces `displayName`, the create_customer contract wants
        // `name`. Keeping the mapping here means the task handler stays
        // a dumb passthrough.
        const customerPayload: Record<string, unknown> = {};
        if (entities?.displayName) customerPayload.name = entities.displayName;
        if (entities?.email) customerPayload.email = entities.email;
        if (entities?.phone) customerPayload.phone = entities.phone;

        const { proposal } = await handler.handle({
          tenantId,
          userId,
          message: lastUserText,
          existingEntities: customerPayload,
        });
        await deps.proposalRepo.create(proposal);
        // QA-2026-06-05: parity with the guardrail promote step (see
        // inapp-adapter.handleCreateProposal). create-customer-task builds
        // proposals without a trust tier, so they land 'draft' — invisible
        // to the inbox and unapprovable under the lifecycle guard. Promote
        // complete drafts so the operator can act on them.
        if (proposal.status === 'draft') {
          await deps.proposalRepo.updateStatus(tenantId, proposal.id, 'ready_for_review');
        }

        const uiProposal = customerProposalToUI(
          proposal.id,
          proposal.payload,
          lastUserText,
          classification.confidence
        );

        return {
          taskType: 'assistant.create_customer',
          model: 'intent-classifier',
          usage: { input: 0, output: 0, total: 0 },
          message: {
            role: 'assistant' as const,
            content: uiProposal.title + '. Review and approve to add them to your CRM.',
            reasoning: classification.reasoning,
            proposal: uiProposal,
          },
        };
      }
    } catch {
      // Classifier failure should never break the chat — drop into the
      // generic LLM path so the operator still gets a response.
    }
  }

  // ── Fallback path: generic LLM text reply ────────────────────────
  const taskType = inferTaskType(lastUserText);
  const systemPrompt = getSystemPrompt(taskType);

  try {
    const response = await deps.gateway.complete({
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
      degraded: response.degraded ?? false,
      fallbackStage: response.fallbackStage,
      message: {
        role: 'assistant' as const,
        ...parsed,
        proposal: parsed.proposal ?? undefined,
      },
    };
  } catch (err) {
    // Log the real failure server-side (BUG-5) — the client only ever sees
    // the degraded envelope, so without this the root cause (missing/invalid
    // provider key, JSON parse failure, provider outage) is invisible.
    logger.error('assistant/chat: LLM completion failed', {
      taskType,
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      taskType,
      model: 'fallback',
      usage: { input: 0, output: 0, total: 0 },
      degraded: true,
      fallbackStage: 'error-envelope',
      message: {
        role: 'assistant' as const,
        content: 'I can help with invoices, scheduling, follow-ups, estimates, and creating customers. Tell me what you want to do next.',
        reasoning: 'AI provider unavailable, returned fallback response.',
      },
    };
  }
}

function writeSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createAssistantRouter(deps: AssistantRouterDeps): Router {
  const router = Router();

  router.post(
    '/chat',
    requireAuth,
    requireTenant,
    requirePermission('ai:run'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = assistantChatRequestSchema.parse(req.body);
        const result = await generateAssistantReply(
          parsed.messages,
          req.auth!.tenantId,
          req.auth!.userId,
          deps
        );

        if (parsed.stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          res.flushHeaders();

          const content = result.message.content;
          const chunks = content.match(/.{1,18}(\s|$)/g) ?? [content];
          // Mirror the SSE token stream onto the client WS gateway,
          // scoped to the user-specific target so concurrent operators
          // in the same tenant don't see each other's tokens.
          const { publish } = await import('../ws/client-gateway');
          const userTarget = req.auth!.userId;
          const correlationId = `assistant-${userTarget}-${Date.now()}`;
          for (const chunk of chunks) {
            writeSse(res, 'token', { delta: chunk });
            publish(
              'assistant',
              userTarget,
              {
                kind: 'assistant.token',
                channel: 'assistant',
                delta: chunk,
                correlationId,
                degraded: result.degraded ?? false,
              },
              req.auth!.tenantId,
            );
          }
          writeSse(res, 'done', result);
          publish(
            'assistant',
            userTarget,
            {
              kind: 'assistant.done',
              channel: 'assistant',
              finalText: content,
              correlationId,
              degraded: result.degraded ?? false,
              fallbackStage: result.fallbackStage,
            },
            req.auth!.tenantId,
          );
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
