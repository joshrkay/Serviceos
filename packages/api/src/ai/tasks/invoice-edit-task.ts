import { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import { createProposal, CreateProposalInput } from '../../proposals/proposal';
import { LLMGateway } from '../gateway/gateway';
import { assessConfidence, getConfidenceLevel } from '../guardrails/confidence';
import type { ProposalConfidenceMeta } from '../../proposals/contracts';
import type { CatalogItem, CatalogItemRepository } from '../../catalog/catalog-item';
import type { InvoiceRepository } from '../../invoices/invoice';
import { buildCatalogPromptSection } from './catalog-resolution';
import { UNCATALOGUED_CONFIDENCE_CAP } from '../resolution/catalog-resolver';
import { groundEditActionPricing } from '../resolution/edit-action-grounding';
import { candidatesForReference } from '../resolution/reference-candidates';
import type { EntityCandidate } from '../resolution/entity-resolver';

// Mirrors the execution-side check (isUuid in
// proposals/execution/voice-extended-handlers.ts / UUID_RE in
// proposals/execution/issue-invoice-handler.ts): a classifier/LLM-extracted
// reference is free text ("invoice INV-0042", "the Henderson invoice") in
// the overwhelming case, but may already BE the resolved id on a re-draft.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * InvoiceEditTaskHandler — produces `update_invoice` proposals from
 * voice transcripts like:
 *   "Add a water heater install for $850 to invoice INV-0042"
 *   "Remove the diagnostic from the Smith invoice"
 *   "Add a trip fee and remove the filter from INV-0042"
 *
 * The LLM returns an `invoiceReference` (a string the operator / review
 * UI resolves to a real invoice id) plus a list of edit actions. The
 * actual invoice-id resolution happens when the operator approves the
 * proposal: the reviewer confirms (or corrects) which invoice this
 * targets. Until then the payload carries the reference verbatim.
 *
 * Structural shape matches what applyInvoiceEdits consumes in
 * invoices/invoice-editor.ts. The execution handler validates the
 * resolved invoice id, then delegates to the pure editor.
 */

const INVOICE_EDIT_SYSTEM_PROMPT = `You edit draft invoices for a field service operating system.
Given a voice transcript from an operator, extract (1) which invoice they want
to change and (2) what changes they want applied.

Return valid JSON only (no prose, no markdown fences):
{
  "invoiceReference": "<string — invoice number, customer name, or whatever the operator said>",
  "editActions": [
    {
      "type": "add_line_item",
      "lineItem": {
        "description": "<string>",
        "quantity": <number>,
        "unitPrice": <integer cents>,
        "category": "labor" | "material" | "equipment" | "other" (optional)
      }
    },
    {
      "type": "remove_line_item",
      "description": "<short phrase matching the line-item description, e.g. 'diagnostic'>"
    },
    {
      "type": "update_line_item",
      "description": "<phrase matching existing line item>",
      "lineItem": { same shape as add_line_item }
    }
  ],
  "confidence_score": <number between 0 and 1>
}

Rules:
- unitPrice is ALWAYS integer cents. $850 → 85000. Never decimals.
- If the operator says "remove the plumbing repair", use type "remove_line_item"
  with description: "plumbing repair". The execution step will match it against
  the real line items in the invoice by description.
- If you can't identify either the invoice or a concrete edit, set confidence
  below 0.7. It's fine to return an editActions array that is empty if the
  transcript is truly ambiguous — don't fabricate.
- Never invent an invoice id or customer name. Use only what the transcript says.`;

function tryParseJson(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function buildPayload(parsed: Record<string, unknown> | null): Record<string, unknown> {
  if (!parsed) return { editActions: [] };
  const payload: Record<string, unknown> = {};

  if (typeof parsed.invoiceReference === 'string') {
    payload.invoiceReference = parsed.invoiceReference;
  }

  if (Array.isArray(parsed.editActions)) {
    payload.editActions = parsed.editActions;
  } else {
    payload.editActions = [];
  }

  return payload;
}

/**
 * VOX-51 — LLM edit actions are grounded through the shared
 * `groundEditActionPricing` (ai/resolution/edit-action-grounding.ts),
 * which runs the SAME money-correctness contract as draft_invoice: a
 * catalog match OVERWRITES the LLM price; an uncatalogued / ambiguous /
 * price-conflict / no-catalog line is UNTRUSTED — `unitPriceCents` nulled,
 * `pricingSource` flagged, `needsPricing:true` — and drives
 * `anyUncatalogued` so the handler caps confidence AND stamps
 * `_meta.overallConfidence:'low'`, hard-blocking auto-approval. The
 * executable `unitPrice` is left numeric so the update_invoice Zod
 * contract (which requires it) still validates; it can never reach
 * execution without a human first reviewing the low-confidence proposal.
 */

export interface InvoiceEditTaskDeps {
  /**
   * Optional — when present, active catalog items are injected into the
   * LLM prompt and line items are post-priced from the catalog
   * (P22-001). When absent, behavior is identical to pre-P22.
   */
  catalogRepo?: CatalogItemRepository;
  /**
   * PR review finding (2026-07): UpdateInvoiceExecutionHandler
   * (proposals/execution/update-invoice-handler.ts) requires
   * payload.invoiceId to ALREADY be a string id and never reads
   * invoiceReference — there is no resolution step between drafting and
   * execution. Mirrors the send_invoice fix (SendInvoiceTaskHandler in
   * voice-extended-tasks.ts): a reference that is already a UUID lands
   * directly on payload.invoiceId; when this repo is wired, a free-text
   * reference ("INV-0042", a customer name) is additionally looked up —
   * an unambiguous single match also resolves onto payload.invoiceId.
   * Anything that doesn't resolve cleanly (no repo, no match, >1 match)
   * stamps missingFields: ['invoiceId'] so approveProposal blocks until
   * the operator resolves it on the review card, instead of the card
   * being approvable and execution failing on the unresolved reference.
   */
  invoiceRepo?: Pick<InvoiceRepository, 'findById' | 'findByTenant'>;
}

export class InvoiceEditTaskHandler implements TaskHandler {
  readonly taskType = 'update_invoice' as const;
  private readonly gateway: LLMGateway;
  private readonly deps: InvoiceEditTaskDeps;

  constructor(gateway: LLMGateway, deps: InvoiceEditTaskDeps = {}) {
    this.gateway = gateway;
    this.deps = deps;
  }

  /**
   * Fetch the tenant's active catalog. Best-effort: a catalog hiccup
   * degrades to the free-text path rather than failing the voice turn.
   * Tenant isolation rides on the repo's tenantId-first contract.
   */
  private async fetchCatalog(tenantId: string): Promise<CatalogItem[]> {
    if (!this.deps.catalogRepo) return [];
    try {
      const items = await this.deps.catalogRepo.listByTenant(tenantId);
      return items.filter((i) => i.archivedAt === null);
    } catch {
      return [];
    }
  }

  /**
   * Best-effort invoiceReference → invoiceId resolution. Returns the
   * missingFields array to stamp on the proposal. Mutates `payload` in
   * place (adds invoiceId) whenever resolution succeeds; invoiceReference
   * is left untouched either way so the review card can always show what
   * the operator said.
   *
   * Gating rule: missingFields is cleared ONLY when the reference is
   * ALREADY a literal UUID (isUuid) — never merely because an
   * invoiceRepo search resolved a free-text reference unambiguously.
   *
   * This is deliberately more conservative than "resolved ⇒ ungated"
   * (which is what EstimateEditTaskHandler.resolveTargetEstimate's
   * search technique is mirrored from). The reason: assistant.ts's
   * `dropUnverifiedIds` guard deletes any id-shaped payload field
   * (jobId/customerId/estimateId/invoiceId/appointmentId) that doesn't
   * appear literally in the operator's raw text or classifier entities —
   * it exists to catch LLM-hallucinated ids and can't distinguish those
   * from a genuinely repo-verified invoiceId. A DB-resolved id from a
   * free-text search is NEVER literally in that text, so it gets
   * silently stripped on the assistant chat surface right before
   * persistence, while an "ungated" missingFields would leave the
   * proposal approvable with invoiceId gone — reintroducing the exact
   * doomed-approval bug this fix closes (confirmed empirically against
   * the live assistant router). voice-action-router.ts has no such
   * guard, but the two surfaces must gate identically or the same
   * transcript would behave differently depending on which one drafted
   * it. So: only a reference that is ALREADY a UUID (guaranteed present
   * in extractedEntities/text, so dropUnverifiedIds always keeps it) is
   * trusted to bypass review — exactly SendInvoiceTaskHandler's rule
   * (voice-extended-tasks.ts). The invoiceRepo search still runs and
   * still stamps payload.invoiceId when it resolves unambiguously —
   * useful review-card context and a correct id on the surface without
   * the guard — but it never lifts the gate.
   *
   * Never throws: a repo hiccup or an ambiguous match simply leaves the
   * proposal gated, same failure posture as
   * EstimateEditTaskHandler.resolveTargetEstimate.
   *
   * B2 — the search that identifies an unambiguous single match now also
   * doubles as the candidate list for the review card's one-tap
   * AmbiguityPicker (widened from the original limit:2 ambiguous-vs-
   * singular check to `candidatesForReference`'s top-5). Candidates are
   * returned alongside missingFields for the caller to stamp onto
   * `sourceContext` — they NEVER lift the gate on their own; see above.
   */
  private async resolveInvoiceId(
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<{ missingFields: string[]; candidates: EntityCandidate[] }> {
    const reference = payload.invoiceReference;

    if (isUuid(reference)) {
      // Already a resolved id (e.g. a re-draft carrying a prior pick) — no
      // repo round-trip needed, and safe to ungate: this literal string is
      // present in the classifier entities/text dropUnverifiedIds checks.
      payload.invoiceId = reference;
      return { missingFields: [], candidates: [] };
    }

    let candidates: EntityCandidate[] = [];
    if (typeof reference === 'string' && reference.trim().length > 0 && this.deps.invoiceRepo) {
      // ILIKE search on invoice_number / customer_message (failure-soft —
      // see candidatesForReference's own doc comment); only an UNAMBIGUOUS
      // single match identifies the target — mirrors
      // EstimateEditTaskHandler.resolveTargetEstimate's search.
      candidates = await candidatesForReference({
        tenantId,
        reference,
        kind: 'invoice',
        invoiceRepo: this.deps.invoiceRepo,
      });
      if (candidates.length === 1) {
        payload.invoiceId = candidates[0].id;
      }
    }

    // Free-text reference (resolved or not) — always gated. See the
    // method doc comment for why "resolved via search" doesn't bypass
    // this on its own.
    return { missingFields: ['invoiceId'], candidates };
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    const catalogItems = await this.fetchCatalog(context.tenantId);

    const llmResponse = await this.gateway.complete({
      taskType: 'update_invoice',
      // Top-level tenantId so the gateway keys this tenant's concurrency
      // quota / cache bucket correctly (never the shared SYSTEM_TENANT_ID).
      tenantId: context.tenantId,
      messages: [
        { role: 'system', content: INVOICE_EDIT_SYSTEM_PROMPT },
        { role: 'user', content: this.buildUserMessage(context, catalogItems) },
      ],
      responseFormat: 'json',
    });

    const parsed = tryParseJson(llmResponse.content);
    const grounding = groundEditActionPricing(buildPayload(parsed), catalogItems);
    const payload = grounding.payload;

    const confidence = assessConfidence(parsed ?? {});
    let confidenceScore = confidence.score;
    const confidenceFactors = [...confidence.factors];
    if (grounding.anyCatalogPriced) confidenceFactors.push('catalog_priced');
    if (grounding.anyUncatalogued) {
      confidenceFactors.push('uncatalogued_line_item');
      // Money-correctness gate: an AI-invented price must never ride a
      // ≥0.9 confidence score into autonomous auto-approval.
      confidenceScore = Math.min(confidenceScore, UNCATALOGUED_CONFIDENCE_CAP);
    }

    // VOX-51 — Confidence Marker `_meta`. Any ungrounded (LLM-priced) line
    // hard-blocks auto-approval via the RV-007 confidence-marker guard,
    // independent of the numeric score AND of any tenant
    // auto_approve_threshold override. An AI-invented edit price must always
    // reach a human.
    if (grounding.anyUncatalogued || grounding.anyCatalogPriced) {
      const meta: ProposalConfidenceMeta = {
        overallConfidence: grounding.anyUncatalogued
          ? 'low'
          : getConfidenceLevel(confidenceScore),
        ...(Object.keys(grounding.fieldConfidence).length > 0
          ? { fieldConfidence: grounding.fieldConfidence }
          : {}),
        ...(grounding.markers.length > 0 ? { markers: grounding.markers } : {}),
      };
      payload._meta = meta;
    }

    // PR review finding (2026-07): resolve the free-text invoiceReference
    // onto payload.invoiceId (direct UUID, or an unambiguous invoiceRepo
    // match) before this proposal can be approved — see resolveInvoiceId /
    // InvoiceEditTaskDeps.invoiceRepo above. Anything that doesn't resolve
    // gates the proposal via missingFields so approveProposal blocks it
    // instead of letting an unresolved edit reach
    // UpdateInvoiceExecutionHandler, which has no resolution step of its
    // own and would fail after approval.
    const { missingFields, candidates } = await this.resolveInvoiceId(context.tenantId, payload);

    // B2 — layer the resolved candidate list ON TOP of the gate (never a
    // substitute for it): only recorded while the gate is still present, so
    // the AmbiguityPicker only ever appears on a card the operator still
    // needs to act on.
    const sourceContext: Record<string, unknown> = {
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      ...(missingFields.length > 0 && candidates.length > 0
        ? {
            entityCandidates: candidates,
            entityKind: 'invoice',
            entityReference: payload.invoiceReference,
          }
        : {}),
    };

    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload,
      summary: context.message,
      confidenceScore,
      confidenceFactors,
      sourceContext: Object.keys(sourceContext).length > 0 ? sourceContext : undefined,
      createdBy: context.userId,
      // update_invoice touches an existing entity but the target is
      // still a draft (non-draft invoices are blocked at execute time).
      // Classified as `capture`, same as draft_invoice. The high
      // confidence threshold + operator review prevent surprise edits.
      sourceTrustTier: 'autonomous',
      ...(missingFields.length > 0 ? { missingFields } : {}),
      // PR B — propagate tenant override from context.
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
      // Phase 12 — forward supervisor presence so this autonomous edit only
      // auto-approves when a supervisor is present (same gate as create_appointment).
      ...(context.supervisorPresent !== undefined
        ? { supervisorPresent: context.supervisorPresent }
        : {}),
      ...(context.supervisorMode ? { supervisorMode: context.supervisorMode } : {}),
    };

    return { proposal: createProposal(input), taskType: this.taskType };
  }

  private buildUserMessage(context: TaskContext, catalogItems: CatalogItem[] = []): string {
    const parts: string[] = [];
    parts.push(`Transcript: ${context.message}`);
    if (context.existingEntities && Object.keys(context.existingEntities).length > 0) {
      parts.push(`Classifier hints: ${JSON.stringify(context.existingEntities)}`);
    }
    // P22-001: compact catalog table (capped at CATALOG_PROMPT_ITEM_CAP).
    const catalogSection = buildCatalogPromptSection(catalogItems);
    if (catalogSection) parts.push(catalogSection);
    return parts.join('\n');
  }
}

export { INVOICE_EDIT_SYSTEM_PROMPT, tryParseJson, buildPayload };
