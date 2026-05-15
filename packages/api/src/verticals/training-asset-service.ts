import { randomUUID } from 'crypto';
import type { KnownEntities } from '../ai/training/scrub';
import type { TrainingAssetRedactionService } from './training-asset-redaction';
import {
  createTrainingAssetDraft,
  trainingAssetInputSchema,
  type PrivacyAuditRepository,
  type TrainingAssetInput,
  type TrainingAssetRepository,
  type VerticalTrainingAsset,
} from './training-assets';

export interface TrainingAssetServiceDeps {
  assetRepo: TrainingAssetRepository;
  privacyAuditRepo: PrivacyAuditRepository;
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
    const draft = createTrainingAssetDraft({
      ...parsed,
      id: this.idGenerator(),
      tenantId: request.tenantId,
      createdBy: request.actorId,
      now,
    });
    const redacted = this.deps.redaction.redact({
      text: parsed.rawText,
      knownEntities: request.knownEntities,
    });
    const asset: VerticalTrainingAsset = {
      ...draft,
      status: redacted.status,
      scrubbedText: redacted.scrubbedText,
      redactionSummary: redacted.summary,
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
      redactionSummary: redacted.summary,
      redactions: redacted.auditRedactions,
      createdAt: now,
    });
    return saved;
  }

  async approve(request: LifecycleRequest): Promise<VerticalTrainingAsset> {
    const existing = await this.deps.assetRepo.findById(request.tenantId, request.assetId);
    if (!existing) throw new Error('Training asset not found');
    if (existing.status === 'quarantined') {
      throw new Error('Cannot approve quarantined training asset');
    }
    if (existing.status !== 'redacted') {
      throw new Error(`Cannot approve training asset from status ${existing.status}`);
    }
    return this.deps.assetRepo.save({
      ...existing,
      status: 'approved',
      approvedBy: request.actorId,
      updatedAt: this.now(),
    });
  }

  async activate(request: LifecycleRequest): Promise<VerticalTrainingAsset> {
    const existing = await this.deps.assetRepo.findById(request.tenantId, request.assetId);
    if (!existing) throw new Error('Training asset not found');
    if (existing.status !== 'approved') {
      throw new Error(`Cannot activate training asset from status ${existing.status}`);
    }
    const now = this.now();
    return this.deps.assetRepo.save({
      ...existing,
      status: 'active',
      activatedAt: now,
      updatedAt: now,
    });
  }

  async list(tenantId: string): Promise<VerticalTrainingAsset[]> {
    return this.deps.assetRepo.listByTenant(tenantId);
  }
}
