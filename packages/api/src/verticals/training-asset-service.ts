import { randomUUID } from 'crypto';
import type { KnownEntities } from '../ai/training/scrub';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import { NotFoundError, ValidationError } from '../shared/errors';
import type { TrainingAssetRedactionService } from './training-asset-redaction';
import {
  createTrainingAssetDraft,
  trainingAssetInputSchema,
  type TrainingAssetLabels,
  type TrainingAssetRedactionSummary,
  type PrivacyAuditRepository,
  type TrainingAssetInput,
  type TrainingAssetRepository,
  type VerticalTrainingAsset,
} from './training-assets';

const QUARANTINED_TITLE = 'Quarantined training asset';

type RedactionResult = ReturnType<TrainingAssetRedactionService['redact']>;

function combineRedactionResults(results: RedactionResult[]): {
  summary: TrainingAssetRedactionSummary;
  auditRedactions: RedactionResult['auditRedactions'];
} {
  const auditRedactions = results.flatMap((result) => result.auditRedactions);
  const redactionKinds = [...new Set(auditRedactions.map((redaction) => redaction.kind))];
  const placeholders = [...new Set(auditRedactions.map((redaction) => redaction.placeholder))];
  const residualSignals = [...new Set(results.flatMap((result) => result.summary.residualSignals))];

  return {
    summary: {
      redactionCount: auditRedactions.length,
      redactionKinds,
      placeholders,
      residualSignals,
      hasResidualPii: results.some((result) => result.summary.hasResidualPii),
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
}

export interface CreateTrainingAssetRequest {
  tenantId: string;
  actorId: string;
  input: TrainingAssetInput;
  knownEntities?: KnownEntities;
}

export interface LifecycleRequest {
  tenantId: string;
  actorId: string;
  assetId: string;
}

export class TrainingAssetService {
  private readonly idGenerator: () => string;
  private readonly now: () => Date;

  constructor(private readonly deps: TrainingAssetServiceDeps) {
    this.idGenerator = deps.idGenerator ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
  }

  async create(request: CreateTrainingAssetRequest): Promise<VerticalTrainingAsset> {
    const parsed = trainingAssetInputSchema.parse(request.input);
    const now = this.now();
    const metadataRedactions: RedactionResult[] = [];
    let metadataHasResidualPii = false;

    const titleRedacted = this.deps.redaction.redact({
      text: parsed.title,
      knownEntities: request.knownEntities,
    });
    metadataRedactions.push(titleRedacted);
    const title = titleRedacted.status === 'quarantined'
      ? QUARANTINED_TITLE
      : titleRedacted.scrubbedText;
    metadataHasResidualPii ||= titleRedacted.status === 'quarantined';

    const provenance = { ...parsed.provenance };
    const sourceIdRedacted = parsed.provenance.sourceId === undefined
      ? undefined
      : this.deps.redaction.redact({
        text: parsed.provenance.sourceId,
        knownEntities: request.knownEntities,
      });
    if (sourceIdRedacted) {
      metadataRedactions.push(sourceIdRedacted);
    }
    const sourceVersionRedacted = this.deps.redaction.redact({
      text: parsed.provenance.sourceVersion,
      knownEntities: request.knownEntities,
    });
    metadataRedactions.push(sourceVersionRedacted);
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
      const notesRedacted = this.deps.redaction.redact({
        text: parsed.provenance.notes,
        knownEntities: request.knownEntities,
      });
      metadataRedactions.push(notesRedacted);
      if (notesRedacted.status === 'quarantined') {
        delete provenance.notes;
        metadataHasResidualPii = true;
      } else {
        provenance.notes = notesRedacted.scrubbedText;
      }
    }

    const labels: TrainingAssetLabels = { ...parsed.labels };
    const redactLabelText = (value: string): string | undefined => {
      const result = this.deps.redaction.redact({
        text: value,
        knownEntities: request.knownEntities,
      });
      metadataRedactions.push(result);
      if (result.status === 'quarantined') {
        metadataHasResidualPii = true;
        return undefined;
      }
      return result.scrubbedText;
    };

    if (parsed.labels.intent !== undefined) {
      const intent = redactLabelText(parsed.labels.intent);
      if (intent === undefined) {
        delete labels.intent;
      } else {
        labels.intent = intent;
      }
    }
    if (typeof parsed.labels.expectedNextQuestion === 'string') {
      const expectedNextQuestion = redactLabelText(parsed.labels.expectedNextQuestion);
      if (expectedNextQuestion === undefined) {
        delete labels.expectedNextQuestion;
      } else {
        labels.expectedNextQuestion = expectedNextQuestion;
      }
    }
    if (parsed.labels.expectedNextAction !== undefined) {
      const expectedNextAction = redactLabelText(parsed.labels.expectedNextAction);
      if (expectedNextAction === undefined) {
        delete labels.expectedNextAction;
      } else {
        labels.expectedNextAction = expectedNextAction;
      }
    }
    if (parsed.labels.expectedRetrievalTerms !== undefined) {
      labels.expectedRetrievalTerms = parsed.labels.expectedRetrievalTerms.flatMap((term) => {
        const sanitized = redactLabelText(term);
        return sanitized === undefined ? [] : [sanitized];
      });
    }
    if (parsed.labels.entities !== undefined) {
      const entitiesRedacted = this.deps.redaction.redact({
        text: JSON.stringify(parsed.labels.entities),
        knownEntities: request.knownEntities,
      });
      metadataRedactions.push(entitiesRedacted);
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
    const rawTextRedacted = this.deps.redaction.redact({
      text: parsed.rawText,
      knownEntities: request.knownEntities,
    });
    const allRedactions = combineRedactionResults([...metadataRedactions, rawTextRedacted]);
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
    };

    const saved = await this.deps.assetRepo.save(asset);
    await this.deps.privacyAuditRepo.create({
      id: this.idGenerator(),
      tenantId: request.tenantId,
      actorId: request.actorId,
      entityType: 'vertical_training_asset',
      entityId: saved.id,
      operation: 'redact_training_asset',
      redactionSummary: allRedactions.summary,
      redactions: allRedactions.auditRedactions,
      createdAt: now,
    });
    await this.deps.auditRepo.create(createAuditEvent({
      tenantId: request.tenantId,
      actorId: request.actorId,
      actorRole: 'user',
      eventType: 'vertical_training_asset.created',
      entityType: 'vertical_training_asset',
      entityId: saved.id,
      metadata: {
        status: saved.status,
        verticalType: saved.verticalType,
        assetKind: saved.assetKind,
      },
    }));
    return saved;
  }

  async approve(request: LifecycleRequest): Promise<VerticalTrainingAsset> {
    const existing = await this.deps.assetRepo.findById(request.tenantId, request.assetId);
    if (!existing) throw new NotFoundError('Training asset', request.assetId);
    if (existing.status === 'quarantined') {
      throw new ValidationError('Cannot approve quarantined training asset', {
        assetId: request.assetId,
        status: existing.status,
      });
    }
    if (existing.status !== 'redacted') {
      throw new ValidationError(`Cannot approve training asset from status ${existing.status}`, {
        assetId: request.assetId,
        status: existing.status,
      });
    }
    const approved = await this.deps.assetRepo.save({
      ...existing,
      status: 'approved',
      approvedBy: request.actorId,
      updatedAt: this.now(),
    });
    await this.deps.auditRepo.create(createAuditEvent({
      tenantId: request.tenantId,
      actorId: request.actorId,
      actorRole: 'user',
      eventType: 'vertical_training_asset.approved',
      entityType: 'vertical_training_asset',
      entityId: approved.id,
      metadata: {
        previousStatus: existing.status,
        status: approved.status,
      },
    }));
    return approved;
  }

  async activate(request: LifecycleRequest): Promise<VerticalTrainingAsset> {
    const existing = await this.deps.assetRepo.findById(request.tenantId, request.assetId);
    if (!existing) throw new NotFoundError('Training asset', request.assetId);
    if (existing.status !== 'approved') {
      throw new ValidationError(`Cannot activate training asset from status ${existing.status}`, {
        assetId: request.assetId,
        status: existing.status,
      });
    }
    const now = this.now();
    const active = await this.deps.assetRepo.save({
      ...existing,
      status: 'active',
      activatedAt: now,
      updatedAt: now,
    });
    await this.deps.auditRepo.create(createAuditEvent({
      tenantId: request.tenantId,
      actorId: request.actorId,
      actorRole: 'user',
      eventType: 'vertical_training_asset.activated',
      entityType: 'vertical_training_asset',
      entityId: active.id,
      metadata: {
        previousStatus: existing.status,
        status: active.status,
      },
    }));
    return active;
  }

  async list(tenantId: string): Promise<VerticalTrainingAsset[]> {
    return this.deps.assetRepo.listByTenant(tenantId);
  }
}
