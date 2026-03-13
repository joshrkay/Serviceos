import { v4 as uuidv4 } from 'uuid';
import { WorkerHandler, QueueMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import { DocumentRevision, DocumentRevisionRepository } from './document-revision';

export type DiffStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface DiffAnalysis {
  id: string;
  tenantId: string;
  documentType: string;
  documentId: string;
  fromRevisionId: string;
  toRevisionId: string;
  diff: DiffEntry[];
  summary?: string;
  status: DiffStatus;
  errorMessage?: string;
  createdAt: Date;
}

export interface DiffEntry {
  path: string;
  type: 'added' | 'removed' | 'changed';
  oldValue?: unknown;
  newValue?: unknown;
}

export interface DiffAnalysisRepository {
  create(analysis: DiffAnalysis): Promise<DiffAnalysis>;
  findById(tenantId: string, id: string): Promise<DiffAnalysis | null>;
  findByDocument(tenantId: string, documentType: string, documentId: string): Promise<DiffAnalysis[]>;
  updateStatus(
    tenantId: string,
    id: string,
    status: DiffStatus,
    result?: { diff?: DiffEntry[]; summary?: string; error?: string }
  ): Promise<DiffAnalysis | null>;
}

export function computeDiff(
  oldSnapshot: Record<string, unknown>,
  newSnapshot: Record<string, unknown>,
  prefix: string = ''
): DiffEntry[] {
  const diffs: DiffEntry[] = [];
  const allKeys = new Set([...Object.keys(oldSnapshot), ...Object.keys(newSnapshot)]);

  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const oldVal = oldSnapshot[key];
    const newVal = newSnapshot[key];

    if (!(key in oldSnapshot)) {
      diffs.push({ path, type: 'added', newValue: newVal });
    } else if (!(key in newSnapshot)) {
      diffs.push({ path, type: 'removed', oldValue: oldVal });
    } else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      if (
        oldVal && typeof oldVal === 'object' && !Array.isArray(oldVal) &&
        newVal && typeof newVal === 'object' && !Array.isArray(newVal)
      ) {
        diffs.push(
          ...computeDiff(
            oldVal as Record<string, unknown>,
            newVal as Record<string, unknown>,
            path
          )
        );
      } else if (Array.isArray(oldVal) && Array.isArray(newVal)) {
        const maxLen = Math.max(oldVal.length, newVal.length);
        for (let i = 0; i < maxLen; i++) {
          const elemPath = `${path}[${i}]`;
          if (i >= oldVal.length) {
            diffs.push({ path: elemPath, type: 'added', newValue: newVal[i] });
          } else if (i >= newVal.length) {
            diffs.push({ path: elemPath, type: 'removed', oldValue: oldVal[i] });
          } else if (JSON.stringify(oldVal[i]) !== JSON.stringify(newVal[i])) {
            if (
              oldVal[i] && typeof oldVal[i] === 'object' && !Array.isArray(oldVal[i]) &&
              newVal[i] && typeof newVal[i] === 'object' && !Array.isArray(newVal[i])
            ) {
              diffs.push(
                ...computeDiff(
                  oldVal[i] as Record<string, unknown>,
                  newVal[i] as Record<string, unknown>,
                  elemPath
                )
              );
            } else {
              diffs.push({ path: elemPath, type: 'changed', oldValue: oldVal[i], newValue: newVal[i] });
            }
          }
        }
      } else {
        diffs.push({ path, type: 'changed', oldValue: oldVal, newValue: newVal });
      }
    }
  }

  return diffs;
}

export interface DiffAnalysisJobPayload {
  tenantId: string;
  analysisId: string;
  documentType: string;
  documentId: string;
  fromRevisionId: string;
  toRevisionId: string;
}

export function createDiffAnalysisWorker(
  revisionRepository: DocumentRevisionRepository,
  diffRepository: DiffAnalysisRepository
): WorkerHandler<DiffAnalysisJobPayload> {
  return {
    type: 'diff_analysis',
    async handle(message: QueueMessage<DiffAnalysisJobPayload>, logger: Logger): Promise<void> {
      const { tenantId, analysisId, fromRevisionId, toRevisionId } = message.payload;

      logger.info('Starting diff analysis', { analysisId });

      await diffRepository.updateStatus(tenantId, analysisId, 'processing');

      try {
        const fromRev = await revisionRepository.findById(tenantId, fromRevisionId);
        const toRev = await revisionRepository.findById(tenantId, toRevisionId);

        if (!fromRev || !toRev) {
          throw new Error('One or both revisions not found');
        }

        const diff = computeDiff(fromRev.snapshot, toRev.snapshot);
        const summary = `${diff.length} change(s): ${diff.filter((d) => d.type === 'added').length} added, ${diff.filter((d) => d.type === 'removed').length} removed, ${diff.filter((d) => d.type === 'changed').length} changed`;

        await diffRepository.updateStatus(tenantId, analysisId, 'completed', { diff, summary });
        logger.info('Diff analysis completed', { analysisId, changeCount: diff.length });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error('Diff analysis failed', { analysisId, error: error.message });
        await diffRepository.updateStatus(tenantId, analysisId, 'failed', {
          error: error.message,
        });
        throw err;
      }
    },
  };
}

export class InMemoryDiffAnalysisRepository implements DiffAnalysisRepository {
  private analyses: Map<string, DiffAnalysis> = new Map();

  async create(analysis: DiffAnalysis): Promise<DiffAnalysis> {
    this.analyses.set(analysis.id, { ...analysis });
    return analysis;
  }

  async findById(tenantId: string, id: string): Promise<DiffAnalysis | null> {
    const a = this.analyses.get(id);
    if (!a || a.tenantId !== tenantId) return null;
    return { ...a };
  }

  async findByDocument(
    tenantId: string,
    documentType: string,
    documentId: string
  ): Promise<DiffAnalysis[]> {
    return Array.from(this.analyses.values()).filter(
      (a) =>
        a.tenantId === tenantId &&
        a.documentType === documentType &&
        a.documentId === documentId
    );
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: DiffStatus,
    result?: { diff?: DiffEntry[]; summary?: string; error?: string }
  ): Promise<DiffAnalysis | null> {
    const a = this.analyses.get(id);
    if (!a || a.tenantId !== tenantId) return null;

    a.status = status;
    if (result?.diff) a.diff = result.diff;
    if (result?.summary) a.summary = result.summary;
    if (result?.error) a.errorMessage = result.error;

    this.analyses.set(id, a);
    return { ...a };
  }
}
