import { randomUUID } from 'crypto';
import type { KnownEntities } from '../ai/training/scrub';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import { ConflictError, NotFoundError, ValidationError } from '../shared/errors';
import type { TrainingAssetRedactionService } from './training-asset-redaction';
import {
  createTrainingAssetDraft,
  trainingAssetInputSchema,
  type PrivacyAuditOperation,
  type PrivacyAuditRedactionEntry,
  type PrivacyAuditRepository,
  type TrainingAssetInput,
  type TrainingAssetLabels,
  type TrainingAssetListOptions,
  type TrainingAssetListPage,
  type TrainingAssetRedactionSummary,
  type TrainingAssetRepository,
  type VerticalTrainingAsset,
} from './training-assets';

const QUARANTINED_TITLE = 'Quarantined training asset';
const METADATA_TITLE_CASE_NAME_RE = /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})+\b/g;
const METADATA_NAME_PREFIX_WORDS = new Set(['Ask', 'Call', 'Dispatch', 'Schedule']);

type RedactionResult = ReturnType<TrainingAssetRedactionService['redact']>;

function applyMetadataNameFallback(text: string): {
  scrubbedText: string;
  auditRedactions: RedactionResult['auditRedactions'];
} {
  const auditRedactions: RedactionResult['auditRedactions'] = [];
  const scrubbedText = text.replace(METADATA_TITLE_CASE_NAME_RE, (match, offset: number) => {
    const words = match.split(/\s+/);
    if (words.length > 2 && METADATA_NAME_PREFIX_WORDS.has(words[0])) {
      const prefixMatch = /^(\S+)(\s+)/.exec(match);
      const nameStart = offset + (prefixMatch?.[0].length ?? words[0].length + 1);
      auditRedactions.push({
        kind: 'metadata_name',
        placeholder: '[NAME]',
        start: nameStart,
        end: offset + match.length,
      });
      return `${words[0]} [NAME]`;
    }
    auditRedactions.push({
      kind: 'metadata_name',
      placeholder: '[NAME]',
      start: offset,
      end: offset + match.length,
    });
    return '[NAME]';
  });
  return { scrubbedText, auditRedactions };
}

interface SourcedRedactionResult {
  sourceField: string;
  result: RedactionResult;
}

function combineSourcedRedactionResults(results: SourcedRedactionResult[]): {
  summary: TrainingAssetRedactionSummary;
  auditRedactions: PrivacyAuditRedactionEntry[];
} {
  const auditRedactions: PrivacyAuditRedactionEntry[] = results.flatMap((entry) =>
    entry.result.auditRedactions.map((redaction) => ({
      ...redaction,
      sourceField: entry.sourceField,
    })),
  );
  const redactionKinds = [...new Set(auditRedactions.map((redaction) => redaction.kind))];
  const placeholders = [...new Set(auditRedactions.map((redaction) => redaction.placeholder))];
  const residualSignals = [
    ...new Set(results.flatMap((entry) => entry.result.summary.residualSignals)),
  ];

  return {
    summary: {
      redactionCount: auditRedactions.length,
      redactionKinds,
      placeholders,
      residualSignals,
      hasResidualPii: results.some((entry) => entry.result.summary.hasResidualPii),
    },
    auditRedactions,
  };
}

export interface TrainingAssetServiceDeps {
  assetRepo: TrainingAssetRepository;
  privacyAuditRepo: PrivacyAuditRepository;
  auditRepo: AuditRepository;
  redaction: TrainingAssetRedactionService;
  idGenerator?: () => string;
  now?: () => Date;
  /**
   * Optional callback invoked after a successful approve / activate /
   * archive so the prompt resolver can invalidate any cached prompt
   * section for the affected tenant. No-op by default; tests don't
   * need to wire this.
   */
  invalidatePromptCache?: (tenantId: string) => void;
}

export interface CreateTrainingAssetRequest {
  tenantId: string;
  actorId: string;
  input: TrainingAssetInput;
  knownEntities?: KnownEntities;
  /**
   * Optional client-supplied key used to dedupe a successful create
   * retried after a timeout. Persisted with a tenant-scoped partial
   * unique index — a duplicate POST returns the original asset.
   */
  idempotencyKey?: string;
}

export interface LifecycleRequest {
  tenantId: string;
  actorId: string;
  assetId: string;
}

export class TrainingAssetService {
  private readonly idGenerator: () => string;
  private readonly now: () => Date;
  private readonly invalidatePromptCache: (tenantId: string) => void;

  constructor(private readonly deps: TrainingAssetServiceDeps) {
    this.idGenerator = deps.idGenerator ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
    this.invalidatePromptCache = deps.invalidatePromptCache ?? (() => {});
  }

  async create(request: CreateTrainingAssetRequest): Promise<VerticalTrainingAsset> {
    const parsed = trainingAssetInputSchema.parse(request.input);

    if (request.idempotencyKey) {
      const replay = await this.deps.assetRepo.findByIdempotencyKey(
        request.tenantId,
        request.idempotencyKey,
      );
      if (replay) return replay;
    }

    const now = this.now();
    const sourcedRedactions: SourcedRedactionResult[] = [];
    let metadataHasResidualPii = false;
    const redactMetadataText = (value: string, sourceField: string): RedactionResult => {
      const result = this.deps.redaction.redact({
        text: value,
        knownEntities: request.knownEntities,
      });
      const fallback = applyMetadataNameFallback(result.scrubbedText);
      const auditRedactions = [...result.auditRedactions, ...fallback.auditRedactions];
      const merged: RedactionResult = {
        ...result,
        scrubbedText: fallback.scrubbedText,
        summary: {
          ...result.summary,
          redactionCount: auditRedactions.length,
          redactionKinds: [...new Set(auditRedactions.map((redaction) => redaction.kind))],
          placeholders: [...new Set(auditRedactions.map((redaction) => redaction.placeholder))],
        },
        auditRedactions,
      };
      sourcedRedactions.push({ sourceField, result: merged });
      return merged;
    };

    const titleRedacted = redactMetadataText(parsed.title, 'title');
    const title = titleRedacted.status === 'quarantined'
      ? QUARANTINED_TITLE
      : titleRedacted.scrubbedText;
    metadataHasResidualPii ||= titleRedacted.status === 'quarantined';

    const provenance = { ...parsed.provenance };
    const sourceIdRedacted = parsed.provenance.sourceId === undefined
      ? undefined
      : redactMetadataText(parsed.provenance.sourceId, 'provenance.sourceId');
    const sourceVersionRedacted = redactMetadataText(
      parsed.provenance.sourceVersion,
      'provenance.sourceVersion',
    );
    const provenanceHasResidualPii =
      sourceIdRedacted?.status === 'quarantined' ||
      sourceVersionRedacted.status === 'quarantined';
    if (provenanceHasResidualPii) {
      delete provenance.sourceId;
      provenance.sourceVersion = 'redacted';
      metadataHasResidualPii = true;
    } else {
      if (sourceIdRedacted) {
        provenance.sourceId = sourceIdRedacted.scrubbedText;
      }
      provenance.sourceVersion = sourceVersionRedacted.scrubbedText;
    }

    if (parsed.provenance.notes !== undefined) {
      const notesRedacted = redactMetadataText(parsed.provenance.notes, 'provenance.notes');
      if (notesRedacted.status === 'quarantined') {
        delete provenance.notes;
        metadataHasResidualPii = true;
      } else {
        provenance.notes = notesRedacted.scrubbedText;
      }
    }

    const labels: TrainingAssetLabels = { ...parsed.labels };
    const redactLabelText = (value: string, sourceField: string): string | undefined => {
      const result = redactMetadataText(value, sourceField);
      if (result.status === 'quarantined') {
        metadataHasResidualPii = true;
        return undefined;
      }
      return result.scrubbedText;
    };

    if (parsed.labels.intent !== undefined) {
      const intent = redactLabelText(parsed.labels.intent, 'labels.intent');
      if (intent === undefined) {
        delete labels.intent;
      } else {
        labels.intent = intent;
      }
    }
    if (typeof parsed.labels.expectedNextQuestion === 'string') {
      const expectedNextQuestion = redactLabelText(
        parsed.labels.expectedNextQuestion,
        'labels.expectedNextQuestion',
      );
      if (expectedNextQuestion === undefined) {
        delete labels.expectedNextQuestion;
      } else {
        labels.expectedNextQuestion = expectedNextQuestion;
      }
    }
    if (parsed.labels.expectedNextAction !== undefined) {
      const expectedNextAction = redactLabelText(
        parsed.labels.expectedNextAction,
        'labels.expectedNextAction',
      );
      if (expectedNextAction === undefined) {
        delete labels.expectedNextAction;
      } else {
        labels.expectedNextAction = expectedNextAction;
      }
    }
    if (parsed.labels.expectedRetrievalTerms !== undefined) {
      labels.expectedRetrievalTerms = parsed.labels.expectedRetrievalTerms.flatMap(
        (term, index) => {
          const sanitized = redactLabelText(term, `labels.expectedRetrievalTerms[${index}]`);
          return sanitized === undefined ? [] : [sanitized];
        },
      );
    }
    if (parsed.labels.entities !== undefined) {
      const entitiesRedacted = redactMetadataText(
        JSON.stringify(parsed.labels.entities),
        'labels.entities',
      );
      if (entitiesRedacted.status === 'quarantined') {
        delete labels.entities;
        metadataHasResidualPii = true;
      } else {
        try {
          labels.entities = JSON.parse(entitiesRedacted.scrubbedText) as Record<string, unknown>;
        } catch {
          delete labels.entities;
          metadataHasResidualPii = true;
        }
      }
    }

    const sanitizedInput: TrainingAssetInput = {
      ...parsed,
      title,
      labels,
      provenance,
    };
    const draft = createTrainingAssetDraft({
      ...sanitizedInput,
      id: this.idGenerator(),
      tenantId: request.tenantId,
      createdBy: request.actorId,
      now,
    });
    const rawTextRedacted = redactMetadataText(parsed.rawText, 'rawText');
    const allRedactions = combineSourcedRedactionResults(sourcedRedactions);
    const status = metadataHasResidualPii || rawTextRedacted.status === 'quarantined'
      ? 'quarantined'
      : 'redacted';
    const { rawText: _rawText, ...safeDraft } = draft;
    const asset: VerticalTrainingAsset = {
      ...safeDraft,
      status,
      scrubbedText: status === 'redacted' ? rawTextRedacted.scrubbedText : undefined,
      redactionSummary: allRedactions.summary,
      updatedAt: now,
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
    };

    let saved: VerticalTrainingAsset;
    try {
      saved = await this.deps.assetRepo.save(asset);
    } catch (err) {
      if (request.idempotencyKey && isUniqueViolation(err)) {
        const replay = await this.deps.assetRepo.findByIdempotencyKey(
          request.tenantId,
          request.idempotencyKey,
        );
        if (replay) return replay;
      }
      throw err;
    }
    const privacyAuditId = this.idGenerator();
    let privacyAuditCreated = false;
    try {
      await this.deps.privacyAuditRepo.create({
        id: privacyAuditId,
        tenantId: request.tenantId,
        actorId: request.actorId,
        entityType: 'vertical_training_asset',
        entityId: asset.id,
        operation: 'redact_training_asset',
        redactionSummary: allRedactions.summary,
        redactions: allRedactions.auditRedactions,
        createdAt: now,
      });
      privacyAuditCreated = true;
      await this.deps.auditRepo.create(createAuditEvent({
        tenantId: request.tenantId,
        actorId: request.actorId,
        actorRole: 'user',
        eventType: 'vertical_training_asset.created',
        entityType: 'vertical_training_asset',
        entityId: asset.id,
        metadata: {
          status: asset.status,
          verticalType: asset.verticalType,
          assetKind: asset.assetKind,
        },
      }));
    } catch (err) {
      await this.deps.assetRepo.delete(request.tenantId, asset.id);
      if (privacyAuditCreated) {
        await this.deps.privacyAuditRepo.delete(request.tenantId, privacyAuditId);
      }
      throw err;
    }
    return saved;
  }

  async approve(request: LifecycleRequest): Promise<VerticalTrainingAsset> {
    return this.transition(request, {
      from: ['redacted', 'approved'],
      idempotentStatus: 'approved',
      reject: (existing) => {
        if (existing.status === 'quarantined') {
          return new ValidationError('Cannot approve quarantined training asset', {
            assetId: request.assetId,
            status: existing.status,
          });
        }
        return null;
      },
      operation: 'approve',
      privacyAuditOperation: 'approve_training_asset',
      eventType: 'vertical_training_asset.approved',
      applyMutation: (existing, now) => ({
        ...existing,
        status: 'approved' as const,
        approvedBy: request.actorId,
        updatedAt: now,
      }),
    });
  }

  async activate(request: LifecycleRequest): Promise<VerticalTrainingAsset> {
    return this.transition(request, {
      from: ['approved', 'active'],
      idempotentStatus: 'active',
      reject: () => null,
      operation: 'activate',
      privacyAuditOperation: 'activate_training_asset',
      eventType: 'vertical_training_asset.activated',
      applyMutation: (existing, now) => ({
        ...existing,
        status: 'active' as const,
        activatedAt: now,
        updatedAt: now,
      }),
    });
  }

  async archive(request: LifecycleRequest): Promise<VerticalTrainingAsset> {
    return this.transition(request, {
      from: ['approved', 'active', 'archived'],
      idempotentStatus: 'archived',
      reject: () => null,
      operation: 'archive',
      privacyAuditOperation: 'archive_training_asset',
      eventType: 'vertical_training_asset.archived',
      applyMutation: (existing, now) => ({
        ...existing,
        status: 'archived' as const,
        updatedAt: now,
      }),
    });
  }

  async list(
    tenantId: string,
    options?: TrainingAssetListOptions,
  ): Promise<TrainingAssetListPage> {
    return this.deps.assetRepo.listByTenant(tenantId, options);
  }

  private async transition(
    request: LifecycleRequest,
    spec: {
      from: VerticalTrainingAsset['status'][];
      idempotentStatus: VerticalTrainingAsset['status'];
      reject: (existing: VerticalTrainingAsset) => Error | null;
      operation: 'approve' | 'activate' | 'archive';
      privacyAuditOperation: PrivacyAuditOperation;
      eventType: string;
      applyMutation: (existing: VerticalTrainingAsset, now: Date) => VerticalTrainingAsset;
    },
  ): Promise<VerticalTrainingAsset> {
    const existing = await this.deps.assetRepo.findById(request.tenantId, request.assetId);
    if (!existing) throw new NotFoundError('Training asset', request.assetId);
    const rejection = spec.reject(existing);
    if (rejection) throw rejection;
    if (existing.status === spec.idempotentStatus) {
      return existing;
    }
    if (!spec.from.includes(existing.status)) {
      throw new ValidationError(
        `Cannot ${spec.operation} training asset from status ${existing.status}`,
        { assetId: request.assetId, status: existing.status },
      );
    }
    const now = this.now();
    const next = spec.applyMutation(existing, now);
    const updateResult = await this.deps.assetRepo.tryUpdate(next, existing.updatedAt);
    if (updateResult.kind === 'missing') {
      throw new NotFoundError('Training asset', request.assetId);
    }
    if (updateResult.kind === 'stale') {
      throw new ConflictError(
        `Training asset was modified by another request (assetId=${request.assetId})`,
      );
    }
    const updated = updateResult.asset;
    try {
      await this.deps.auditRepo.create(createAuditEvent({
        tenantId: request.tenantId,
        actorId: request.actorId,
        actorRole: 'user',
        eventType: spec.eventType,
        entityType: 'vertical_training_asset',
        entityId: updated.id,
        metadata: {
          previousStatus: existing.status,
          status: updated.status,
        },
      }));
      await this.deps.privacyAuditRepo.create({
        id: this.idGenerator(),
        tenantId: request.tenantId,
        actorId: request.actorId,
        entityType: 'vertical_training_asset',
        entityId: updated.id,
        operation: spec.privacyAuditOperation,
        redactionSummary: emptyRedactionSummary(),
        redactions: [],
        createdAt: now,
      });
    } catch (err) {
      const revertResult = await this.deps.assetRepo.tryUpdate(existing, updated.updatedAt);
      if (revertResult.kind !== 'updated') {
        // Best-effort revert: if another writer raced in we let the
        // newer state stand and surface the original audit failure.
      }
      throw err;
    }
    this.invalidatePromptCache(request.tenantId);
    return updated;
  }
}

function emptyRedactionSummary(): TrainingAssetRedactionSummary {
  return {
    redactionCount: 0,
    redactionKinds: [],
    placeholders: [],
    residualSignals: [],
    hasResidualPii: false,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}
