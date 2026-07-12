import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import type { KnownEntities } from '../ai/training/scrub';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import { runInTenantTransaction } from '../commands/command-runner';
import { PRESIDIO_UNAVAILABLE_SIGNAL } from '../ai/privacy/presidio-adapter';
import { ConflictError, NotFoundError, ValidationError } from '../shared/errors';
import type {
  TrainingAssetRedactionResult,
  TrainingAssetRedactionService,
} from './training-asset-redaction';
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

/**
 * Domain vocabulary the metadata-name fallback must not redact. The
 * fallback regex matches any sequence of title-case words ≥3 chars,
 * which would otherwise rewrite plain HVAC / plumbing / electrical
 * terms ("Water Heater", "Circuit Breaker", "Heat Pump", etc.) to
 * `[NAME]`, degrading prompt quality and downstream retrieval. The
 * lookup is case-insensitive on the matched phrase.
 */
const METADATA_NAME_VOCAB_DENYLIST: ReadonlySet<string> = new Set([
  // HVAC
  'air conditioner', 'air conditioning', 'air filter', 'air flow', 'air handler',
  'air quality', 'carbon monoxide', 'condenser coil', 'condenser unit',
  'cooling system', 'ductless mini split', 'evaporator coil', 'forced air',
  'heat exchanger', 'heat pump', 'heating system', 'mini split',
  'natural gas', 'split system', 'thermostat upgrade',
  // Plumbing
  'backflow preventer', 'cold water', 'drain cleaning', 'drain pipe',
  'expansion tank', 'garbage disposal', 'hot water', 'hose bib',
  'main line', 'pipe insulation', 'pressure regulator', 'pressure tank',
  'pressure relief', 'sewer line', 'shut off', 'sump pump',
  'tank water', 'tankless water heater', 'tankless heater', 'water heater',
  'water line', 'water main', 'water meter', 'water pressure',
  'water softener', 'water damage',
  // Electrical
  'arc fault', 'breaker box', 'breaker panel', 'ceiling fan',
  'circuit breaker', 'electrical panel', 'fuse box', 'ground fault',
  'junction box', 'knob and tube', 'light fixture', 'main panel',
  'outlet box', 'power outage', 'power surge', 'service entrance',
  'service panel', 'smoke detector', 'sub panel', 'subpanel install',
  // Service / business
  'annual inspection', 'customer service', 'emergency service',
  'free estimate', 'free quote', 'job site', 'maintenance agreement',
  'maintenance contract', 'maintenance plan', 'maintenance visit',
  'same day', 'service area', 'service call', 'service plan',
  'service tier', 'service visit', 'site visit', 'work order',
]);

type RedactionResult = TrainingAssetRedactionResult;

/**
 * A synthesized fail-closed redaction result used to short-circuit the
 * remaining fields once Presidio has been observed unavailable for a request —
 * so we don't incur a fresh 5s timeout per field. Mirrors the redaction
 * service's own fail-closed shape: quarantine, no derived text, the
 * `presidio_unavailable` residual signal.
 */
function presidioFailClosedRedaction(): RedactionResult {
  return {
    status: 'quarantined',
    scrubbedText: '',
    summary: {
      redactionCount: 0,
      redactionKinds: [],
      placeholders: [],
      residualSignals: [PRESIDIO_UNAVAILABLE_SIGNAL],
      hasResidualPii: true,
    },
    auditRedactions: [],
    failClosed: true,
  };
}

function applyMetadataNameFallback(text: string): {
  scrubbedText: string;
  auditRedactions: RedactionResult['auditRedactions'];
} {
  const auditRedactions: RedactionResult['auditRedactions'] = [];
  const scrubbedText = text.replace(METADATA_TITLE_CASE_NAME_RE, (match, offset: number) => {
    const lowered = match.toLowerCase();
    if (METADATA_NAME_VOCAB_DENYLIST.has(lowered)) {
      return match;
    }
    const words = match.split(/\s+/);
    if (words.length > 2 && METADATA_NAME_PREFIX_WORDS.has(words[0])) {
      const trailingLowered = words.slice(1).join(' ').toLowerCase();
      if (METADATA_NAME_VOCAB_DENYLIST.has(trailingLowered)) {
        return match;
      }
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

/**
 * Recursively walk an entities object and apply a string-redacting
 * function to every string value, preserving structure. Done per-value
 * rather than via `JSON.stringify(...)` + scrub + `JSON.parse(...)` so
 * placeholders containing JSON-significant chars can't break the parse,
 * and so PII-looking object keys aren't mangled into syntactically
 * invalid JSON. The `path` argument is threaded into `redactString`
 * so each audit entry records exactly which nested entity field the
 * offsets refer to (e.g. `labels.entities.address.street`,
 * `labels.entities.equipmentTags[1]`) — without it, every nested
 * string would share the same `sourceField` and overlapping offsets
 * would be ambiguous in the privacy audit trail.
 */
async function redactEntities(
  value: unknown,
  redactString: (s: string, path: string) => Promise<{ scrubbed: string; quarantined: boolean }>,
  path: string,
): Promise<{ value: unknown; quarantined: boolean }> {
  if (typeof value === 'string') {
    const result = await redactString(value, path);
    return { value: result.scrubbed, quarantined: result.quarantined };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    let quarantined = false;
    for (let idx = 0; idx < value.length; idx += 1) {
      const child = await redactEntities(value[idx], redactString, `${path}[${idx}]`);
      out.push(child.value);
      quarantined ||= child.quarantined;
    }
    return { value: out, quarantined };
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let quarantined = false;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const child = await redactEntities(v, redactString, `${path}.${k}`);
      out[k] = child.value;
      quarantined ||= child.quarantined;
    }
    return { value: out, quarantined };
  }
  return { value, quarantined: false };
}

interface SourcedRedactionResult {
  sourceField: string;
  /** How many of the auditRedactions at the tail are scrubbed-basis (metadata-name fallback). */
  fallbackCount: number;
  result: RedactionResult;
}

function combineSourcedRedactionResults(results: SourcedRedactionResult[]): {
  summary: TrainingAssetRedactionSummary;
  auditRedactions: PrivacyAuditRedactionEntry[];
} {
  const auditRedactions: PrivacyAuditRedactionEntry[] = results.flatMap((entry) => {
    const all = entry.result.auditRedactions;
    const fallbackStart = all.length - entry.fallbackCount;
    return all.map((redaction, idx) => ({
      ...redaction,
      sourceField: entry.sourceField,
      offsetBasis: idx >= fallbackStart ? 'scrubbed' as const : 'original' as const,
    }));
  });
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
  /**
   * WS5 — when provided, `create`/`transition` persist the asset write, the
   * privacy_audit entry, and the normal audit entry inside ONE Postgres
   * transaction (via `runInTenantTransaction`), so a failure in any write
   * rolls back all of them — no compensating deletes, no orphaned rows. When
   * absent (in-memory repos: dev/test), the service falls back to
   * compensating deletes to preserve the same all-or-nothing guarantee
   * without a real transaction.
   */
  pool?: Pool;
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
  /** True when a real Postgres transaction covers persistence (pool wired). */
  private readonly transactional: boolean;

  constructor(private readonly deps: TrainingAssetServiceDeps) {
    this.idGenerator = deps.idGenerator ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
    this.invalidatePromptCache = deps.invalidatePromptCache ?? (() => {});
    this.transactional = Boolean(deps.pool);
  }

  /**
   * Run `fn` inside a single tenant-scoped Postgres transaction when a pool is
   * wired; otherwise run it directly (in-memory repos). In the transactional
   * path every PgBaseRepository write inside `fn` reuses the same client (via
   * `tenantContextStore`) and joins the one transaction, so a throw rolls the
   * whole unit back.
   */
  private async withPersistence<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.deps.pool) {
      return runInTenantTransaction(null, tenantId, fn);
    }
    const client = await this.deps.pool.connect();
    try {
      return await runInTenantTransaction(client, tenantId, fn);
    } finally {
      client.release();
    }
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
    // Once Presidio is observed unavailable for this request we stop calling it
    // and synthesize fail-closed results for the remaining fields — otherwise
    // every field would eat a fresh ~5s timeout. The whole asset quarantines.
    let presidioUnavailable = false;
    const redactMetadataText = async (
      value: string,
      sourceField: string,
    ): Promise<RedactionResult> => {
      const result = presidioUnavailable
        ? presidioFailClosedRedaction()
        : await this.deps.redaction.redactAsync({
            text: value,
            knownEntities: request.knownEntities,
          });
      if (result.failClosed) {
        presidioUnavailable = true;
      }
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
      sourcedRedactions.push({
        sourceField,
        fallbackCount: fallback.auditRedactions.length,
        result: merged,
      });
      return merged;
    };

    const titleRedacted = await redactMetadataText(parsed.title, 'title');
    const title = titleRedacted.status === 'quarantined'
      ? QUARANTINED_TITLE
      : titleRedacted.scrubbedText;
    metadataHasResidualPii ||= titleRedacted.status === 'quarantined';

    const provenance = { ...parsed.provenance };
    const sourceIdRedacted = parsed.provenance.sourceId === undefined
      ? undefined
      : await redactMetadataText(parsed.provenance.sourceId, 'provenance.sourceId');
    const sourceVersionRedacted = await redactMetadataText(
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
      const notesRedacted = await redactMetadataText(parsed.provenance.notes, 'provenance.notes');
      if (notesRedacted.status === 'quarantined') {
        delete provenance.notes;
        metadataHasResidualPii = true;
      } else {
        provenance.notes = notesRedacted.scrubbedText;
      }
    }

    const labels: TrainingAssetLabels = { ...parsed.labels };
    const redactLabelText = async (
      value: string,
      sourceField: string,
    ): Promise<string | undefined> => {
      const result = await redactMetadataText(value, sourceField);
      if (result.status === 'quarantined') {
        metadataHasResidualPii = true;
        return undefined;
      }
      return result.scrubbedText;
    };

    if (parsed.labels.intent !== undefined) {
      const intent = await redactLabelText(parsed.labels.intent, 'labels.intent');
      if (intent === undefined) {
        delete labels.intent;
      } else {
        labels.intent = intent;
      }
    }
    if (typeof parsed.labels.expectedNextQuestion === 'string') {
      const expectedNextQuestion = await redactLabelText(
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
      const expectedNextAction = await redactLabelText(
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
      const retrievalTerms: string[] = [];
      for (let index = 0; index < parsed.labels.expectedRetrievalTerms.length; index += 1) {
        const sanitized = await redactLabelText(
          parsed.labels.expectedRetrievalTerms[index],
          `labels.expectedRetrievalTerms[${index}]`,
        );
        if (sanitized !== undefined) retrievalTerms.push(sanitized);
      }
      labels.expectedRetrievalTerms = retrievalTerms;
    }
    if (parsed.labels.entities !== undefined) {
      let entitiesQuarantined = false;
      const redacted = await redactEntities(
        parsed.labels.entities,
        async (s, path) => {
          const result = await redactMetadataText(s, path);
          const quarantined = result.status === 'quarantined';
          entitiesQuarantined ||= quarantined;
          return { scrubbed: result.scrubbedText, quarantined };
        },
        'labels.entities',
      );
      if (entitiesQuarantined) {
        delete labels.entities;
        metadataHasResidualPii = true;
      } else {
        labels.entities = redacted.value as Record<string, unknown>;
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
    const rawTextRedacted = await redactMetadataText(parsed.rawText, 'rawText');
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

    // Persist the asset, the privacy_audit entry, and the normal audit event
    // atomically. Transactional path (pool wired): a throw rolls the whole
    // unit back. Non-transactional path (in-memory): compensating deletes give
    // the same all-or-nothing guarantee.
    const privacyAuditId = this.idGenerator();
    try {
      return await this.withPersistence(request.tenantId, async () => {
        const saved = await this.deps.assetRepo.save(asset);
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
          // Transactional path: the surrounding transaction ROLLBACK undoes the
          // asset + any partial audit writes, so DON'T issue compensating
          // deletes (the tx is already poisoned). Non-transactional path: undo
          // by hand.
          if (!this.transactional) {
            await this.deps.assetRepo.delete(request.tenantId, asset.id);
            if (privacyAuditCreated) {
              await this.deps.privacyAuditRepo.delete(request.tenantId, privacyAuditId);
            }
          }
          throw err;
        }
        return saved;
      });
    } catch (err) {
      // A unique-violation on the asset insert means a concurrent create with
      // the same idempotency key won the race; return the winner. The read
      // happens AFTER the transaction has rolled back (fresh connection).
      if (request.idempotencyKey && isUniqueViolation(err)) {
        const replay = await this.deps.assetRepo.findByIdempotencyKey(
          request.tenantId,
          request.idempotencyKey,
        );
        if (replay) return replay;
      }
      throw err;
    }
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

    // The optimistic status update, the privacy_audit row, and the standard
    // audit event all persist atomically. Transactional path (pool wired): any
    // throw rolls the whole unit back — the status change cannot commit without
    // its audit rows, and no manual revert is needed. Non-transactional path
    // (in-memory): revert the status write + delete the privacy_audit row by
    // hand for the same guarantee.
    //
    // Order still matters in the non-transactional path: write the
    // privacy_audit row first, then the standard audit event, so a failure of
    // the standard audit write leaves no orphaned "this succeeded" row.
    const privacyAuditId = this.idGenerator();
    const updated = await this.withPersistence(request.tenantId, async () => {
      const updateResult = await this.deps.assetRepo.tryUpdate(next, existing.updatedAt);
      if (updateResult.kind === 'missing') {
        throw new NotFoundError('Training asset', request.assetId);
      }
      if (updateResult.kind === 'stale') {
        throw new ConflictError(
          `Training asset was modified by another request (assetId=${request.assetId})`,
        );
      }
      const updatedAsset = updateResult.asset;
      let privacyAuditCreated = false;
      try {
        await this.deps.privacyAuditRepo.create({
          id: privacyAuditId,
          tenantId: request.tenantId,
          actorId: request.actorId,
          entityType: 'vertical_training_asset',
          entityId: updatedAsset.id,
          operation: spec.privacyAuditOperation,
          redactionSummary: emptyRedactionSummary(),
          redactions: [],
          createdAt: now,
        });
        privacyAuditCreated = true;
        await this.deps.auditRepo.create(createAuditEvent({
          tenantId: request.tenantId,
          actorId: request.actorId,
          actorRole: 'user',
          eventType: spec.eventType,
          entityType: 'vertical_training_asset',
          entityId: updatedAsset.id,
          metadata: {
            previousStatus: existing.status,
            status: updatedAsset.status,
          },
        }));
      } catch (err) {
        if (!this.transactional) {
          if (privacyAuditCreated) {
            await this.deps.privacyAuditRepo.delete(request.tenantId, privacyAuditId);
          }
          const revertResult = await this.deps.assetRepo.tryUpdate(
            existing,
            updatedAsset.updatedAt,
          );
          if (revertResult.kind !== 'updated') {
            // Best-effort revert: if another writer raced in we let the
            // newer state stand and surface the original audit failure.
          }
        }
        throw err;
      }
      return updatedAsset;
    });
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
