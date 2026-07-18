import { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import { createProposal, CreateProposalInput } from '../../proposals/proposal';
import { LLMGateway } from '../gateway/gateway';
import { assessConfidence, getConfidenceLevel } from '../guardrails/confidence';
import type { ProposalConfidenceMeta } from '../../proposals/contracts';
import type { Estimate, EstimateRepository } from '../../estimates/estimate';
import type { CatalogItem, CatalogItemRepository } from '../../catalog/catalog-item';
import { buildCatalogPromptSection } from './catalog-resolution';
import { UNCATALOGUED_CONFIDENCE_CAP } from '../resolution/catalog-resolver';
import { groundEditActionPricing } from '../resolution/edit-action-grounding';
import { mapEstimatesToCandidates } from '../resolution/reference-candidates';
import type { EntityCandidate } from '../resolution/entity-resolver';

// Mirrors InvoiceEditTaskHandler's check (invoice-edit-task.ts) / the
// execution-side isUuid checks (proposals/execution/voice-extended-handlers.ts,
// issue-invoice-handler.ts): a classifier/LLM-extracted reference is free
// text ("estimate EST-0001", "the Johnson estimate") in the overwhelming
// case, but may already BE the resolved id on a re-draft.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * EstimateEditTaskHandler — produces `update_estimate` proposals from
 * voice transcripts like:
 *   "Add a site visit for $150 to estimate EST-0001"
 *   "Remove the disposal fee from the Johnson estimate"
 *   "Add a trip fee and remove the old heater from EST-0001"
 *
 * LLM output includes an `estimateReference` (string hint — number,
 * customer name, whatever the operator said) plus edit actions. The
 * review step resolves the reference to a concrete estimate id before
 * execution, same pattern as InvoiceEditTaskHandler.
 *
 * Structural shape matches what applyEstimateEdits consumes in
 * estimates/estimate-editor.ts.
 */

const ESTIMATE_EDIT_SYSTEM_PROMPT = `You edit draft estimates for a field service operating system.
Given a voice transcript from an operator, extract (1) which estimate they want
to change and (2) what changes they want applied.

Return valid JSON only (no prose, no markdown fences):
{
  "estimateReference": "<string — estimate number, customer name, or whatever the operator said>",
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
      "description": "<short phrase matching the line-item description, e.g. 'disposal fee'>"
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
- unitPrice is ALWAYS integer cents. $150 → 15000. Never decimals.
- If the operator says "remove the disposal fee", use type "remove_line_item"
  with description: "disposal fee". The execution step matches it against the
  real line items on the estimate by description.
- If you can't identify either the estimate or a concrete edit, set confidence
  below 0.7. Empty editActions is acceptable when the transcript is truly
  ambiguous — don't fabricate.
- Never invent an estimate id or customer name. Use only what the transcript says.`;

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

  if (typeof parsed.estimateReference === 'string') {
    payload.estimateReference = parsed.estimateReference;
  }

  // Rare but allowed by the contract: a concrete estimateId (e.g. when the
  // classifier hints carried a verified id). Passed through so execution
  // can skip reference resolution.
  if (typeof parsed.estimateId === 'string') {
    payload.estimateId = parsed.estimateId;
  }

  if (Array.isArray(parsed.editActions)) {
    payload.editActions = parsed.editActions;
  } else {
    payload.editActions = [];
  }

  return payload;
}

/**
 * VOX-50 — catalog grounding for voice estimate-edit line items runs the
 * SAME money-correctness contract as draft_estimate via the shared
 * `groundEditActionPricing` (ai/resolution/edit-action-grounding.ts): a
 * catalog match OVERWRITES the LLM price; an uncatalogued / ambiguous /
 * price-conflict / no-catalog line is UNTRUSTED — `unitPriceCents` nulled,
 * `pricingSource` flagged, `needsPricing:true` — and drives
 * `anyUncatalogued` so the handler caps confidence AND stamps
 * `_meta.overallConfidence:'low'`, which hard-blocks auto-approval in
 * decideInitialStatus. The executable `unitPrice` is kept numeric to
 * satisfy the update_estimate Zod contract; it can never reach execution
 * without a human first reviewing the low-confidence proposal.
 */

/** RV-042 — review-time marker for edits that void a customer's acceptance. */
export const ACCEPTANCE_VOID_MARKER = {
  path: '_acceptance',
  reason: "approving voids the customer's prior acceptance",
} as const;

export class EstimateEditTaskHandler implements TaskHandler {
  readonly taskType = 'update_estimate' as const;
  private readonly gateway: LLMGateway;
  /**
   * RV-042 — review-time visibility of acceptance voiding. When wired, the
   * handler resolves the targeted estimate (by id when the payload carries
   * one, else by an unambiguous estimateReference match) and, if it is
   * CURRENTLY ACCEPTED, stamps `_meta.markers` with ACCEPTANCE_VOID_MARKER
   * so the SMS/UI review surfaces warn the approver that approving voids
   * the customer's prior acceptance. Absent repo → marker skipped (the
   * execute-time invalidation audit still records the voiding).
   *
   * PR review finding (2026-07): the SAME search this powers is now also
   * reused (not duplicated) to resolve payload.estimateId — see
   * resolveEstimateIdGate below. UpdateEstimateExecutionHandler
   * (proposals/execution/update-estimate-handler.ts) requires
   * payload.estimateId to ALREADY be a string id and has no reference
   * resolution of its own.
   */
  private readonly estimateRepo?: Pick<EstimateRepository, 'findById' | 'findByTenant'>;
  /**
   * VOX-50 catalog grounding. When present, edit line items are resolved
   * against the tenant's active catalog and matched prices OVERRIDE the
   * LLM's numbers; uncatalogued/ambiguous lines cap confidence and stamp
   * `_meta.overallConfidence:'low'` so an AI-invented edit price can never
   * auto-approve. Optional so existing callers/tests are unaffected.
   */
  private readonly catalogRepo?: CatalogItemRepository;

  constructor(
    gateway: LLMGateway,
    estimateRepo?: Pick<EstimateRepository, 'findById' | 'findByTenant'>,
    catalogRepo?: CatalogItemRepository,
  ) {
    this.gateway = gateway;
    this.estimateRepo = estimateRepo;
    this.catalogRepo = catalogRepo;
  }

  /**
   * Fetch the tenant's active catalog. Best-effort: a catalog hiccup
   * degrades to the uncatalogued path (capped, human-reviewed) rather
   * than failing the voice turn. Tenant isolation rides the repo's
   * tenantId-first contract.
   */
  private async fetchCatalog(tenantId: string): Promise<CatalogItem[]> {
    if (!this.catalogRepo) return [];
    try {
      const items = await this.catalogRepo.listByTenant(tenantId);
      return items.filter((i) => i.archivedAt === null);
    } catch {
      return [];
    }
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    const catalogItems = await this.fetchCatalog(context.tenantId);

    const llmResponse = await this.gateway.complete({
      taskType: 'update_estimate',
      // Top-level tenantId so the gateway keys this tenant's concurrency
      // quota / cache bucket correctly (never the shared SYSTEM_TENANT_ID).
      tenantId: context.tenantId,
      messages: [
        { role: 'system', content: ESTIMATE_EDIT_SYSTEM_PROMPT },
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

    // RV-042 acceptance-void marker + VOX-50 catalog markers MERGE into a
    // single `_meta` — overwriting the whole object would clobber whichever
    // path ran, so both contribute. Acceptance marker stays first.
    const { target, candidates } = await this.resolveTargetEstimate(context.tenantId, payload);
    const accepted = target?.status === 'accepted';
    // B3 — `anyAmbiguousWithCandidates` also surfaces markers here (so the
    // review UI shows why a line needs a pick), but deliberately does NOT
    // drive `overallConfidence` to 'low' — see edit-action-grounding.ts
    // "SPLIT REVIEW SIGNAL": that stamp is never lifted by
    // resolveProposalLine, so stamping a resolvable ambiguity 'low' would
    // keep blocking approval after the operator resolves it. Only
    // `anyUncatalogued` (nothing to resolve to) drives the sticky 'low' stamp.
    if (
      accepted ||
      grounding.anyUncatalogued ||
      grounding.anyCatalogPriced ||
      grounding.anyAmbiguousWithCandidates
    ) {
      const markers = [
        ...(accepted ? [ACCEPTANCE_VOID_MARKER] : []),
        ...grounding.markers,
      ];
      const meta: ProposalConfidenceMeta = {
        // Any ungrounded (LLM-priced) line hard-blocks auto-approval via the
        // RV-007 confidence-marker guard — independent of the numeric score
        // AND of any tenant auto_approve_threshold override. An AI-invented
        // edit price must always reach a human.
        overallConfidence: grounding.anyUncatalogued
          ? 'low'
          : getConfidenceLevel(confidenceScore),
        ...(Object.keys(grounding.fieldConfidence).length > 0
          ? { fieldConfidence: grounding.fieldConfidence }
          : {}),
        ...(markers.length > 0 ? { markers } : {}),
      };
      payload._meta = meta;
    }

    // PR review finding (2026-07): resolve the free-text estimateReference
    // onto payload.estimateId (direct UUID, or an unambiguous
    // resolveTargetEstimate match) before this proposal can be approved —
    // see resolveEstimateIdGate below. Anything that doesn't resolve to a
    // trusted UUID gates the proposal via missingFields so approveProposal
    // blocks it instead of letting an unresolved edit reach
    // UpdateEstimateExecutionHandler, which has no resolution step of its
    // own and would fail after approval.
    const { missingFields: estimateIdMissingFields, verifiedIds } = this.resolveEstimateIdGate(
      payload,
      target,
    );

    // B3 — the estimateId gate (B2) and the editAction catalog gates
    // (edit-action-grounding.ts) are disjoint string sets (`estimateId` vs
    // `editActions[i].lineItem.catalogItemId`); they compose by simple
    // concatenation, resolved independently by resolve-entity.ts and
    // resolve-line.ts respectively.
    const missingFields = [...estimateIdMissingFields, ...grounding.missingFields];

    // B2 — layer the resolved candidate list ON TOP of the gate (never a
    // substitute for it): only recorded while the gate is still present, so
    // the AmbiguityPicker only ever appears on a card the operator still
    // needs to act on.
    const sourceContext: Record<string, unknown> = {
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      // Verify-or-gate: a repo-confirmed estimateId rides the B4 allowlist so
      // it survives assistant.ts's dropUnverifiedIds (repo-verified by
      // construction — never copied from LLM/classifier text).
      ...(verifiedIds ? { verifiedIds } : {}),
      ...(estimateIdMissingFields.length > 0 && candidates.length > 0
        ? {
            entityCandidates: candidates,
            entityKind: 'estimate',
            entityReference: payload.estimateReference,
          }
        : {}),
      // B3 — edit-action catalog candidates, keyed by edit-action index;
      // resolve-line.ts reads this the same way it reads the draft path's
      // sourceContext.catalogResolution.
      ...(grounding.catalogResolution ? { catalogResolution: grounding.catalogResolution } : {}),
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
      // Estimate edits target existing entities but only in editable
      // statuses (draft / ready_for_review). Sent estimates are locked
      // at execute time. Classified as `capture`, same as draft_estimate.
      sourceTrustTier: 'autonomous',
      ...(missingFields.length > 0 ? { missingFields } : {}),
      // PR B — propagate tenant override from context.
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
      // Phase 12 — forward supervisor presence so this autonomous, capture-class
      // edit only auto-approves when a supervisor is on the wall (same gate as
      // the create_appointment path).
      ...(context.supervisorPresent !== undefined
        ? { supervisorPresent: context.supervisorPresent }
        : {}),
      ...(context.supervisorMode ? { supervisorMode: context.supervisorMode } : {}),
    };

    return { proposal: createProposal(input), taskType: this.taskType };
  }

  /**
   * Best-effort target resolution for the acceptance-void marker. Never
   * throws — a repo hiccup or an ambiguous reference simply skips the
   * marker (the hard guarantees live at execute time).
   *
   * B2 — widened from limit:2 (ambiguous-vs-singular check only) to top-5,
   * and the same fetched rows are mapped (mapEstimatesToCandidates, no
   * second repo round trip) into the candidate list the review card's
   * one-tap AmbiguityPicker reads off `sourceContext.entityCandidates`.
   * `target` (used only for the acceptance-void marker) still requires an
   * UNAMBIGUOUS single match — candidates are returned regardless, for the
   * caller to layer on top of the gate; see resolveEstimateIdGate below for
   * why a search match never lifts the gate itself.
   */
  private async resolveTargetEstimate(
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<{ target: Estimate | null; candidates: EntityCandidate[] }> {
    if (!this.estimateRepo) return { target: null, candidates: [] };
    try {
      if (typeof payload.estimateId === 'string' && payload.estimateId.length > 0) {
        const target = await this.estimateRepo.findById(tenantId, payload.estimateId);
        return { target, candidates: [] };
      }
      const reference = payload.estimateReference;
      if (isUuid(reference)) {
        // Verify-or-gate: an id-shaped estimateReference from the LLM is an
        // ASSUMPTION, not a fact — VERIFY it via findById (an ILIKE search on
        // a UUID string could never match an estimate number anyway). A hit
        // both powers the acceptance-void marker and lets resolveEstimateIdGate
        // trust + allowlist the id; a miss leaves target null → gated.
        const target = await this.estimateRepo.findById(tenantId, reference);
        return { target, candidates: [] };
      }
      if (typeof reference === 'string' && reference.trim().length > 0) {
        // ILIKE search on estimate_number / customer_message; only an
        // UNAMBIGUOUS single match identifies the acceptance-marker target.
        const matches = await this.estimateRepo.findByTenant(tenantId, {
          search: reference.trim(),
          limit: 5,
        });
        const candidates = mapEstimatesToCandidates(matches);
        return { target: matches.length === 1 ? matches[0] : null, candidates };
      }
    } catch {
      // Marker resolution must never block proposal creation.
    }
    return { target: null, candidates: [] };
  }

  /**
   * PR review finding (2026-07): UpdateEstimateExecutionHandler
   * (proposals/execution/update-estimate-handler.ts) requires
   * payload.estimateId to ALREADY be a string id and never reads
   * estimateReference — there is no resolution step between drafting and
   * execution. `resolveTargetEstimate` above already resolves the target
   * (by id or by an unambiguous estimateReference search) purely to power
   * the RV-042 acceptance-void marker; this method reuses that same
   * `target` — no second repo round-trip — to ALSO decide whether the
   * proposal is safe to approve, mirroring the update_invoice fix
   * (InvoiceEditTaskHandler.resolveInvoiceId in invoice-edit-task.ts).
   *
   * Verify-or-gate rule: the gate is lifted ONLY when the wired repo
   * confirms the id — i.e. `resolveTargetEstimate`'s findById actually
   * returned the estimate whose id equals the UUID candidate. A UUID that
   * merely "looks right" is NOT trusted on its own.
   *
   * Why a bare UUID is NOT trusted: `buildPayload` copies the
   * estimateId/estimateReference straight from the LLM's JSON, so an
   * id-shaped value is an ASSUMPTION about model output, not a fact. The
   * old rule ("a literal UUID is guaranteed present in text/entities so
   * dropUnverifiedIds keeps it") does not hold for a HALLUCINATED UUID the
   * model invented from nowhere in the operator's words. On the assistant
   * surface `dropUnverifiedIds` would strip that fabricated id (not in the
   * haystack, not in verifiedIds), leaving an APPROVABLE proposal with NO
   * estimateId and NO gate — nothing re-gates post-scrub, and
   * approveProposal only checks missingFields. So a UUID is VERIFIED
   * against the repo (findById in resolveTargetEstimate, reused here — no
   * second round-trip); a repo-confirmed id is stamped onto
   * payload.estimateId AND recorded in `verifiedIds` ({ estimateId }) — the
   * B4 allowlist dropUnverifiedIds honors, safe because it came from a repo
   * lookup, not LLM text. A miss (or an absent repo → null target) fails
   * closed: nothing trusted is stamped and the proposal is gated.
   *
   * A free-text reference resolved unambiguously by resolveTargetEstimate's
   * search still stamps payload.estimateId for review-card context, but per
   * the rule above never lifts the gate (dropUnverifiedIds strips a
   * search-resolved id since it isn't literally in the operator's text).
   * voice-action-router.ts has no such guard, but the two surfaces must
   * gate identically or the same transcript would behave differently
   * depending on which one drafted it.
   *
   * Never throws: mutates `payload` in place and returns the missingFields
   * array (plus, on a verified id, a `verifiedIds` allowlist entry) to
   * stamp on the proposal. `estimateReference` is left untouched either way
   * so the review card can always show what the operator said.
   */
  private resolveEstimateIdGate(
    payload: Record<string, unknown>,
    target: Estimate | null,
  ): { missingFields: string[]; verifiedIds?: Record<string, string> } {
    const uuidCandidate = isUuid(payload.estimateId)
      ? (payload.estimateId as string)
      : isUuid(payload.estimateReference)
        ? (payload.estimateReference as string)
        : undefined;

    if (uuidCandidate) {
      // Trust the UUID ONLY when resolveTargetEstimate's findById returned
      // it. A hallucinated UUID (repo miss) or an absent repo → null target.
      if (target && target.id === uuidCandidate) {
        payload.estimateId = uuidCandidate;
        return { missingFields: [], verifiedIds: { estimateId: uuidCandidate } };
      }
      // Unverifiable — drop a bare unverified estimateId so nothing untrusted
      // rides the payload, and gate (fail closed).
      if (payload.estimateId === uuidCandidate) delete payload.estimateId;
      return { missingFields: ['estimateId'] };
    }

    // A free-text reference resolved unambiguously by
    // resolveTargetEstimate's search is still useful review-card context
    // — stamp it, unless payload.estimateId already carries something
    // (e.g. the rare classifier passthrough handled by buildPayload) —
    // but per the rule above it never lifts the gate.
    if (target && typeof payload.estimateId !== 'string') {
      payload.estimateId = target.id;
    }

    // Free-text reference (resolved or not) — always gated.
    return { missingFields: ['estimateId'] };
  }

  private buildUserMessage(context: TaskContext, catalogItems: CatalogItem[] = []): string {
    const parts: string[] = [];
    parts.push(`Transcript: ${context.message}`);
    if (context.existingEntities && Object.keys(context.existingEntities).length > 0) {
      parts.push(`Classifier hints: ${JSON.stringify(context.existingEntities)}`);
    }
    // VOX-50: compact catalog table so the model prefers catalog names.
    const catalogSection = buildCatalogPromptSection(catalogItems);
    if (catalogSection) parts.push(catalogSection);
    return parts.join('\n');
  }
}

export { ESTIMATE_EDIT_SYSTEM_PROMPT, tryParseJson, buildPayload };
