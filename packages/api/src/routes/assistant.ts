import { Router, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { LLMGateway } from '../ai/gateway/gateway';
import { ProposalRepository } from '../proposals/proposal';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import {
  recordAssistantTurn,
  type ConversationRepository,
} from '../conversations/conversation-service';
import {
  classifyIntent,
  isVoiceApprovalIntent,
  isVoiceEditIntent,
} from '../ai/orchestration/intent-classifier';
import { CreateCustomerTaskHandler } from '../ai/tasks/task-handlers';
import type { TaskHandler } from '../ai/tasks/task-handlers';
import { EstimateTaskHandler } from '../ai/tasks/estimate-task';
import { EstimateEditTaskHandler } from '../ai/tasks/estimate-edit-task';
import { InvoiceTaskHandler } from '../ai/tasks/invoice-task';
import type { InvoiceRepository } from '../invoices/invoice';
import type { CatalogItemRepository } from '../catalog/catalog-item';
import type { EstimateRepository } from '../estimates/estimate';
import type { StandingInstruction } from '../instructions/standing-instructions';
import { selectInjectedStandingInstructions } from '../ai/standing-instructions-context';
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
  // QA-2026-06-05: LLMs emit free-form statuses ('Sent', 'Draft', …) —
  // coerce anything unknown to 'Pending' instead of discarding the reply.
  status: z.preprocess(
    (v) => (v === 'Approved' || v === 'Rejected' ? v : 'Pending'),
    z.enum(['Pending', 'Approved', 'Rejected'])
  ),
  // QA-2026-06-05: LLMs emit JSON null for "no value" — .optional() alone
  // rejects null, so every estimate-draft completion whose relatedId/impact
  // was null failed validation and degraded to the fallback envelope
  // (live: "LLM completion failed ... expected string, received null").
  relatedId: z.string().nullish().transform((v) => v ?? undefined),
  impact: z.string().nullish().transform((v) => v ?? undefined),
  // E10 (U7) — pass-through of the trust signals AIProposalCard already
  // renders: the 4-tier confidence + severity badge + "what I wasn't sure
  // about" markers (`_meta`), the per-line catalog-grounding source
  // (`lineItems[].pricingSource`), and the unfilled-required-field prompt
  // (`missingFields`) that blocks Approve. Every field is `.nullish()` so a
  // normal complete proposal — and the QA-2026-06-05 null-coercion / status
  // -preprocess envelope — still validates unchanged.
  meta: z
    .object({
      overallConfidence: z.enum(['high', 'medium', 'low', 'very_low']).nullish().transform((v) => v ?? undefined),
      severity: z
        .enum(['TIER_1_EVACUATE', 'TIER_2_EMERGENCY_DISPATCH', 'TIER_3_SAME_DAY_URGENT', 'TIER_4_SCHEDULE'])
        .nullish()
        .transform((v) => v ?? undefined),
      markers: z
        .array(z.object({ path: z.string(), reason: z.string() }))
        .nullish()
        .transform((v) => v ?? undefined),
      // UB-A3 — "Standing instruction applied" chips on the assistant card.
      appliedStandingInstructions: z
        .array(z.object({ id: z.string(), text: z.string() }))
        .nullish()
        .transform((v) => v ?? undefined),
    })
    .nullish()
    .transform((v) => v ?? undefined),
  lineItems: z
    .array(
      z.object({
        description: z.string().nullish().transform((v) => v ?? undefined),
        pricingSource: z
          .enum(['catalog', 'ambiguous', 'uncatalogued', 'manual'])
          .nullish()
          .transform((v) => v ?? undefined),
      }),
    )
    .nullish()
    .transform((v) => v ?? undefined),
  missingFields: z.array(z.string()).nullish().transform((v) => v ?? undefined),
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
  // Story 3.11 — the client pins the running conversation so each turn persists
  // to the same thread; omitted on the first turn (server opens a new one).
  conversationId: z.string().optional(),
  // UB-B3 — how the operator produced this message. 'voice' turns (conversation
  // mode / PTT transcripts) are refused approval/reject/edit intents: in-app
  // voice approval stays deferred (RV-071/RV-225 posture — approvals are a
  // screen tap here).
  inputMode: z.enum(['voice', 'text']).optional(),
});

/** UB-B3 — deterministic refusal copy for voice-mode approval intents. */
export const VOICE_APPROVAL_REFUSAL =
  "Tap the card to approve — I don't take approvals by voice here yet.";

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
   * QA-2026-06-05 (AST-05): read-only query intents ("which invoices are
   * unpaid?") answer from data instead of LLM narrative. Optional so tests
   * without an invoice repo keep working.
   */
  invoiceRepo?: InvoiceRepository;
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
  /**
   * UB-A3 — resolves the tenant's ACTIVE standing instructions once per
   * chat turn (production wires `standingInstructionRepo.listActive`).
   * `selectApplicableInstructions` (≤5) narrows per classified intent
   * before drafting. Mirrors `verticalPromptResolver`: optional,
   * failure-soft — a resolver error drafts without owner instructions.
   */
  standingInstructionsResolver?: (tenantId: string) => Promise<StandingInstruction[]>;
  /**
   * P22 — catalog grounding for assistant-drafted invoices/estimates:
   * line items get priced from the tenant's catalog instead of trusting
   * the LLM's invented numbers. Optional so tests can omit it.
   */
  catalogRepo?: CatalogItemRepository;
  /**
   * RV-042 — review-time visibility of acceptance voiding: lets the
   * update_estimate task handler read the targeted estimate and stamp the
   * `_meta.markers` acceptance-void warning when it is currently accepted.
   * Optional; absent -> marker skipped.
   */
  estimateRepo?: Pick<EstimateRepository, 'findById' | 'findByTenant'>;
  /**
   * Story 3.11 — persist each chat turn (operator message + agent reply) so the
   * running conversation survives reload and is searchable. Optional so tests
   * without a repo keep working (persistence simply skipped).
   */
  conversationRepo?: ConversationRepository;
  /** Audit sink for the conversation.created event on first persist. */
  auditRepo?: AuditRepository;
}

type AssistantProposal = z.infer<typeof assistantProposalSchema>;

/**
 * E10 (U7) — lift the trust signals AIProposalCard renders out of a persisted
 * proposal's `payload._meta` / `payload.lineItems` / `sourceContext.missingFields`
 * onto the UI card shape. Without this the assistant chat card dropped them and
 * an operator could approve an AI-estimated/ambiguous/missing-field proposal
 * into a server rejection.
 *
 * Price-field-agnostic: it reads only `description` + `pricingSource` from each
 * line, so it works for estimates (lines priced in `unitPrice`) and invoices
 * (priced in `unitPriceCents`) alike — it never touches a price field.
 * Every returned key is optional; a fully-grounded complete proposal yields an
 * empty object and the card renders exactly as before.
 */
export function proposalSignals(
  payload: Record<string, unknown> | undefined,
  sourceContext: Record<string, unknown> | undefined,
): Pick<AssistantProposal, 'meta' | 'lineItems' | 'missingFields'> {
  const out: Pick<AssistantProposal, 'meta' | 'lineItems' | 'missingFields'> = {};

  const rawMeta = payload?._meta;
  if (rawMeta !== null && typeof rawMeta === 'object') {
    const m = rawMeta as Record<string, unknown>;
    const meta: NonNullable<AssistantProposal['meta']> = {};
    if (
      m.overallConfidence === 'high' ||
      m.overallConfidence === 'medium' ||
      m.overallConfidence === 'low' ||
      m.overallConfidence === 'very_low'
    ) {
      meta.overallConfidence = m.overallConfidence;
    }
    if (
      m.severity === 'TIER_1_EVACUATE' ||
      m.severity === 'TIER_2_EMERGENCY_DISPATCH' ||
      m.severity === 'TIER_3_SAME_DAY_URGENT' ||
      m.severity === 'TIER_4_SCHEDULE'
    ) {
      meta.severity = m.severity;
    }
    if (Array.isArray(m.markers)) {
      const markers = m.markers
        .filter((mk): mk is Record<string, unknown> => mk !== null && typeof mk === 'object')
        .filter((mk) => typeof mk.path === 'string' && typeof mk.reason === 'string')
        .map((mk) => ({ path: mk.path as string, reason: mk.reason as string }));
      if (markers.length > 0) meta.markers = markers;
    }
    // UB-A3 — lift the applied-standing-instruction marker so the assistant
    // card can render its "Standing instruction applied" chips.
    if (Array.isArray(m.appliedStandingInstructions)) {
      const applied = m.appliedStandingInstructions
        .filter((si): si is Record<string, unknown> => si !== null && typeof si === 'object')
        .filter((si) => typeof si.id === 'string' && typeof si.text === 'string')
        .map((si) => ({ id: si.id as string, text: si.text as string }));
      if (applied.length > 0) meta.appliedStandingInstructions = applied;
    }
    if (meta.overallConfidence || meta.severity || meta.markers || meta.appliedStandingInstructions) {
      out.meta = meta;
    }
  }

  const rawLines = payload?.lineItems;
  if (Array.isArray(rawLines)) {
    const lineItems = rawLines
      .filter((li): li is Record<string, unknown> => li !== null && typeof li === 'object')
      .map((li) => {
        const item: {
          description?: string;
          pricingSource?: 'catalog' | 'ambiguous' | 'uncatalogued' | 'manual';
        } = {};
        if (typeof li.description === 'string') item.description = li.description;
        if (
          li.pricingSource === 'catalog' ||
          li.pricingSource === 'ambiguous' ||
          li.pricingSource === 'uncatalogued' ||
          li.pricingSource === 'manual'
        ) {
          item.pricingSource = li.pricingSource;
        }
        return item;
      });
    if (lineItems.length > 0) out.lineItems = lineItems;
  }

  // missingFields lives on sourceContext (createProposal stamps it there to
  // avoid a DB schema change; the catalog resolver appends to it too).
  const rawMissing = sourceContext?.missingFields;
  if (Array.isArray(rawMissing)) {
    const missingFields = rawMissing.filter((f): f is string => typeof f === 'string');
    if (missingFields.length > 0) out.missingFields = missingFields;
  }

  return out;
}

/**
 * Map the server-side create_customer Proposal to the UI card shape.
 * Reads `name` / `email` / `phone` out of the payload (the router
 * translates classifier `displayName` → contract `name` in AST-01).
 */
function customerProposalToUI(
  proposalId: string,
  payload: Record<string, unknown>,
  sourceMessage: string,
  confidenceScore: number,
  sourceContext?: Record<string, unknown>
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
    // E10 (U7) — surface any missing-field / confidence signals (a
    // create_customer with only a name carries missingFields).
    ...proposalSignals(payload, sourceContext),
  };
}


/**
 * QA-2026-06-05: the assistant accepts FREE TEXT — entity ids in LLM-built
 * payloads must literally appear in the operator's message (or classifier
 * entities); the model may not invent them (live: hallucinated textbook
 * UUIDs sent executions into doomed lookups).
 */
function dropUnverifiedIds(
  payload: Record<string, unknown>,
  operatorText: string,
  entities: Record<string, unknown>
): void {
  const haystack = (operatorText + ' ' + JSON.stringify(entities)).toLowerCase();
  for (const key of ['jobId', 'customerId', 'estimateId', 'invoiceId', 'appointmentId']) {
    const v = payload[key];
    if (typeof v === 'string' && v.length >= 32 && !haystack.includes(v.toLowerCase())) {
      delete payload[key];
    }
  }
}

/**
 * QA-2026-06-05 (AST-02/03/04): map any persisted proposal to the UI card
 * shape — estimates/invoices were previously unpersisted LLM JSON.
 */
function proposalToUI(
  proposal: {
    id: string;
    proposalType: string;
    summary: string;
    payload: Record<string, unknown>;
    sourceContext?: Record<string, unknown>;
    confidenceScore?: number;
  },
  sourceMessage: string
): AssistantProposal {
  const typeMap: Record<string, AssistantProposal['type']> = {
    draft_estimate: 'Estimate',
    update_estimate: 'Estimate',
    draft_invoice: 'Invoice',
    send_invoice: 'Invoice',
    create_customer: 'Customer',
    update_customer: 'Customer',
  };
  const cardType = typeMap[proposal.proposalType] ?? 'Follow-up';
  const total = typeof proposal.payload.totalCents === 'number'
    ? ` — $${(proposal.payload.totalCents / 100).toFixed(2)}`
    : '';
  return {
    id: proposal.id,
    title: `${cardType}: ${proposal.summary.slice(0, 80)}${total}`,
    summary: proposal.summary.slice(0, 160),
    explanation: `From your message: "${sourceMessage.slice(0, 120)}"`,
    confidence: (proposal.confidenceScore ?? 0) >= 0.85 ? 'High' : 'Medium',
    type: cardType,
    status: 'Pending',
    // E10 (U7) — surface AI-pricing / confidence / missing-field warnings so
    // the card can render them and block Approve on unresolved lines.
    ...proposalSignals(proposal.payload, proposal.sourceContext),
  };
}

const UNPAID_QUERY_RE = /(which|what|list|show|any)\b.{0,40}\binvoices?\b.{0,40}\b(unpaid|open|outstanding|overdue|due|owed)|\b(unpaid|outstanding)\s+invoices?/i;

async function answerUnpaidInvoicesQuery(
  invoiceRepo: InvoiceRepository,
  tenantId: string
): Promise<string> {
  const all = await invoiceRepo.findByTenant(tenantId);
  const cutoff = Date.now() - 31 * 86_400_000;
  const unpaid = all.filter(
    (i) => ['open', 'partially_paid'].includes(i.status) && new Date(i.createdAt).getTime() >= cutoff
  );
  if (unpaid.length === 0) {
    return 'No unpaid invoices from the last month — everything issued in the last 31 days is settled.';
  }
  const lines = unpaid
    .slice(0, 10)
    .map((i) => `${i.invoiceNumber} — $${(i.amountDueCents / 100).toFixed(2)} due (${i.status})`)
    .join('; ');
  const totalDue = unpaid.reduce((s2, i) => s2 + i.amountDueCents, 0);
  return `${unpaid.length} unpaid invoice${unpaid.length === 1 ? '' : 's'} from the last month, $${(totalDue / 100).toFixed(2)} total due: ${lines}${unpaid.length > 10 ? '; …' : ''}`;
}

async function generateAssistantReply(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  tenantId: string,
  userId: string,
  deps: AssistantRouterDeps,
  correlationId: string,
  inputMode?: 'voice' | 'text',
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

      // UB-A3 — resolve the tenant's active standing instructions once per
      // turn (mirrors verticalPromptResolver). Failure-soft: drafting
      // proceeds without owner instructions rather than breaking the chat.
      let activeStandingInstructions: StandingInstruction[] | undefined;
      if (deps.standingInstructionsResolver) {
        try {
          activeStandingInstructions = await deps.standingInstructionsResolver(tenantId);
        } catch {
          activeStandingInstructions = undefined;
        }
      }

      // QA-2026-06-05 (AST-05): deterministic read-only query — answer from
      // data, never propose. Runs before classification so phrasing variance
      // in the classifier can't turn a question into a mutation proposal.
      if (deps.invoiceRepo && UNPAID_QUERY_RE.test(lastUserText)) {
        const content = await answerUnpaidInvoicesQuery(deps.invoiceRepo, tenantId);
        return {
          taskType: 'assistant.query.unpaid_invoices',
          model: 'data-lookup',
          usage: { input: 0, output: 0, total: 0 },
          message: { role: 'assistant' as const, content, reasoning: 'Answered from invoice records (read-only query intent).' },
        };
      }

      const classification = await classifyIntent(
        lastUserText,
        { tenantId, ...(verticalPromptSection ? { verticalPromptSection } : {}) },
        deps.gateway,
      );

      // UB-B3 — voice-mode approval guard. approve/reject/edit_proposal are
      // NOT routed in this chat handler; before this guard they fell through
      // to the generic LLM path, so a spoken "approve it" got a free-form LLM
      // reply. Intercept HERE — before the chain/handler/LLM paths — so a
      // voice turn gets a deterministic refusal, never an approval action and
      // never an LLM improvisation. In-app voice approval stays deferred
      // (RV-071/RV-225: approve/reject/edit by voice is owner-telephony only).
      if (
        inputMode === 'voice' &&
        (isVoiceApprovalIntent(classification.intentType) ||
          isVoiceEditIntent(classification.intentType))
      ) {
        if (deps.auditRepo) {
          try {
            await deps.auditRepo.create(createAuditEvent({
              tenantId,
              actorId: userId,
              actorRole: 'user',
              eventType: 'assistant.voice_approval_refused',
              entityType: 'assistant_chat',
              entityId: correlationId,
              metadata: { intentType: classification.intentType },
            }));
          } catch {
            // Audit failures must not block the refusal reply.
          }
        }
        return {
          taskType: 'assistant.voice_approval_refused',
          model: 'policy-guard',
          usage: { input: 0, output: 0, total: 0 },
          message: {
            role: 'assistant' as const,
            content: VOICE_APPROVAL_REFUSAL,
            reasoning:
              'Voice approvals are not enabled on this surface; approvals require a screen tap.',
          },
        };
      }

      // QA-2026-06-05 (AST-07, scoped): multi-step asks ("…, then …") are
      // decomposed into SEQUENTIAL linked proposals sharing a chainId in
      // sourceContext. Each step executes per its action class: capture
      // steps auto-approve at confidence and the worker executes them;
      // money/comms steps land ready_for_review — the HITL contract is
      // never bypassed (the original matrix expectation of a fully-executed
      // invoice without approval contradicts 'money never auto-approves').
      const chainSegments = lastUserText.split(/(?:,\s*)?\bthen\b\s+/i).map((seg) => seg.trim()).filter(Boolean);
      if (chainSegments.length >= 2 && chainSegments.length <= 4) {
        const chainId = `chain_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const chainCards: AssistantProposal[] = [];
        const carried: Record<string, unknown> = {};
        for (const segment of chainSegments) {
          let segClass;
          try {
            segClass = await classifyIntent(
              segment,
              { tenantId, ...(verticalPromptSection ? { verticalPromptSection } : {}) },
              deps.gateway,
            );
          } catch {
            continue;
          }
          const chainHandlers: Record<string, (() => TaskHandler) | undefined> = {
            create_customer: () => new CreateCustomerTaskHandler(),
            draft_estimate: () => new EstimateTaskHandler(deps.gateway, deps.catalogRepo),
            update_estimate: () => new EstimateEditTaskHandler(deps.gateway, deps.estimateRepo),
            create_invoice: () => new InvoiceTaskHandler(deps.gateway, deps.catalogRepo),
            send_invoice: () => new InvoiceTaskHandler(deps.gateway, deps.catalogRepo),
            issue_invoice: () => new InvoiceTaskHandler(deps.gateway, deps.catalogRepo),
            update_invoice: () => new InvoiceTaskHandler(deps.gateway, deps.catalogRepo),
          };
          const factory = chainHandlers[segClass.intentType];
          if (!factory) continue;
          const segEntities: Record<string, unknown> = { ...carried, ...(segClass.extractedEntities ?? {}) };
          if (segClass.intentType === 'create_customer' && segEntities.displayName && !segEntities.name) {
            segEntities.name = segEntities.displayName;
          }
          // UB-A3 — thread the applicable standing instructions (≤5, keyed
          // on this segment's classified intent) into the drafting handler.
          const segStandingInstructions = selectInjectedStandingInstructions(
            activeStandingInstructions,
            segClass.intentType,
          );
          const { proposal } = await factory().handle({
            tenantId,
            userId,
            message: segment,
            existingEntities: segEntities,
            ...(segStandingInstructions
              ? { standingInstructions: segStandingInstructions }
              : {}),
          });
          if (!proposal) continue;
          dropUnverifiedIds(proposal.payload, segment, segEntities);
          proposal.sourceContext = { ...(proposal.sourceContext ?? {}), chainId, chainStep: chainCards.length + 1 };
          // Dependency gate: steps after the first reference results that
          // don't exist yet (the customer, their job). Auto-approval would
          // send them into doomed executions — hold every dependent step
          // (and any draft) in ready_for_review for sequential operator
          // approval as predecessors materialize.
          if (chainCards.length >= 1 && proposal.status === 'approved') {
            proposal.status = 'ready_for_review';
            proposal.approvedAt = undefined;
          }
          await deps.proposalRepo.create(proposal);
          if (proposal.status === 'draft') {
            await deps.proposalRepo.updateStatus(tenantId, proposal.id, 'ready_for_review');
          }
          // Carry the customer reference into later steps so "for her" /
          // "their estimate" resolves at execution time.
          if (typeof segEntities.name === 'string') carried.customerName = segEntities.name;
          if (typeof segEntities.displayName === 'string') carried.customerName = segEntities.displayName;
          chainCards.push(proposalToUI(proposal, segment));
        }
        if (chainCards.length === 1) {
          // Only one segment produced a proposal — return it directly so the
          // single-intent path doesn't mint a duplicate.
          return {
            taskType: 'assistant.chain',
            model: 'intent-classifier',
            usage: { input: 0, output: 0, total: 0 },
            message: {
              role: 'assistant' as const,
              content: `${chainCards[0].title}. Review and approve to proceed.`,
              proposal: chainCards[0],
            },
          };
        }
        if (chainCards.length >= 2) {
          return {
            taskType: 'assistant.chain',
            model: 'intent-classifier',
            usage: { input: 0, output: 0, total: 0 },
            message: {
              role: 'assistant' as const,
              content:
                `Created ${chainCards.length} linked steps: ` +
                chainCards.map((c, i) => `${i + 1}) ${c.title}`).join('; ') +
                '. Capture steps run after approval windows; money steps wait for your approval.',
              proposal: chainCards[0],
            },
          };
        }
      }

      // QA-2026-06-05 (AST-02/03/04): estimate/invoice intents go through
      // the REAL task handlers and persist — the generic LLM path returned
      // unpersisted JSON cards whose ids 404'd on approve.
      const proposalHandlers: Record<string, () => TaskHandler> = {
        draft_estimate: () => new EstimateTaskHandler(deps.gateway, deps.catalogRepo),
        update_estimate: () => new EstimateEditTaskHandler(deps.gateway, deps.estimateRepo),
        create_invoice: () => new InvoiceTaskHandler(deps.gateway, deps.catalogRepo),
        send_invoice: () => new InvoiceTaskHandler(deps.gateway, deps.catalogRepo),
        issue_invoice: () => new InvoiceTaskHandler(deps.gateway, deps.catalogRepo),
        update_invoice: () => new InvoiceTaskHandler(deps.gateway, deps.catalogRepo),
      };
      const handlerFactory = proposalHandlers[classification.intentType];
      if (handlerFactory) {
        const handler = handlerFactory();
        // UB-A3 — thread the applicable standing instructions (≤5, keyed on
        // the classified intent) into the drafting handler.
        const standingInstructions = selectInjectedStandingInstructions(
          activeStandingInstructions,
          classification.intentType,
        );
        const { proposal } = await handler.handle({
          tenantId,
          userId,
          message: lastUserText,
          existingEntities: { ...(classification.extractedEntities ?? {}) },
          ...(standingInstructions ? { standingInstructions } : {}),
        });
        dropUnverifiedIds(proposal.payload, lastUserText, { ...(classification.extractedEntities ?? {}) });
        await deps.proposalRepo.create(proposal);
        if (proposal.status === 'draft') {
          await deps.proposalRepo.updateStatus(tenantId, proposal.id, 'ready_for_review');
        }
        const uiProposal = proposalToUI(proposal, lastUserText);
        return {
          taskType: `assistant.${handler.taskType}`,
          model: 'intent-classifier',
          usage: { input: 0, output: 0, total: 0 },
          message: {
            role: 'assistant' as const,
            content: `${uiProposal.title}. Review and approve to proceed.`,
            reasoning: classification.reasoning,
            proposal: uiProposal,
          },
        };
      }

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
          classification.confidence,
          proposal.sourceContext
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
      metadata: { source: 'assistant-chat-route', tenantId, correlationId },
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
      correlationId,
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
      // Story 3.12 — one correlation id per chat turn, threaded into the gateway
      // call + every error log so a failure is traceable end-to-end. Honors an
      // inbound x-correlation-id when the caller supplies one.
      const correlationId =
        req.header('x-correlation-id') || `assistant-${req.auth!.userId}-${uuidv4()}`;
      try {
        const parsed = assistantChatRequestSchema.parse(req.body);
        const result = await generateAssistantReply(
          parsed.messages,
          req.auth!.tenantId,
          req.auth!.userId,
          deps,
          correlationId,
          parsed.inputMode,
        );

        // Story 3.11 — persist the turn so the conversation survives reload and
        // is searchable. Failure-soft: a persistence error must not drop the
        // reply the operator is waiting on.
        let conversationId = parsed.conversationId;
        if (deps.conversationRepo) {
          try {
            const lastUserText =
              [...parsed.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
            conversationId = await recordAssistantTurn(
              deps.conversationRepo,
              {
                tenantId: req.auth!.tenantId,
                userId: req.auth!.userId,
                conversationId: parsed.conversationId,
                userText: lastUserText,
                assistantText: result.message.content,
              },
              deps.auditRepo,
            );
          } catch (persistErr) {
            logger.error('assistant/chat: conversation persist failed', {
              correlationId,
              tenantId: req.auth!.tenantId,
              error: persistErr instanceof Error ? persistErr.message : String(persistErr),
            });
          }
        }

        // The reply envelope carries the conversation id (so the client pins the
        // thread) and the correlation id (traceability).
        const envelope = { ...result, conversationId, correlationId };

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
          writeSse(res, 'done', envelope);
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

        res.json(envelope);
      } catch (err) {
        logger.error('assistant/chat: request failed', {
          correlationId,
          tenantId: req.auth?.tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
