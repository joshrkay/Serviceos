/**
 * N-009 / P2-038 — Correction-loop orchestration (record + undo).
 *
 * `recordCorrectionLessons` is the audited mutation that turns extractor
 * drafts into persisted, forward-applied lessons:
 *   1. persist each lesson (correction_lessons, tenant_id + RLS),
 *   2. cascade its config change forward (labor rate / SKU / banned phrase /
 *      template weight) via the applicator ports,
 *   3. emit `correction_lesson.applied` audit per lesson.
 *
 * `undoCorrectionLesson` is the single-action reversal:
 *   1. reverse the cascaded config (payload `before`),
 *   2. mark the lesson reverted,
 *   3. emit `correction_lesson.reverted` audit.
 *
 * Both honor the repo invariants: integer cents flow through unchanged, every
 * mutation emits audit, and persistence is tenant-scoped (RLS).
 */
import { randomUUID } from 'crypto';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { applyLessonConfig, revertLessonConfig, type ConfigPorts } from './lesson-applicator';
import {
  buildCorrectionLesson,
  type CorrectionLesson,
  type CorrectionLessonRepository,
} from './correction-lesson';
import type { CorrectionLessonDraft } from './correction-extractor';

const AUDIT_ENTITY_TYPE = 'correction_lesson';

export interface RecordCorrectionLessonsInput {
  tenantId: string;
  sourceProposalId: string;
  ownerId: string;
  /** Tenant-local day (YYYY-MM-DD) the lessons apply forward within. */
  localDate: string;
  drafts: CorrectionLessonDraft[];
}

export interface CorrectionLoopDeps {
  repository: CorrectionLessonRepository;
  ports: ConfigPorts;
  auditRepo: AuditRepository;
  actorRole?: string;
}

/**
 * Persist + forward-apply + audit each extracted lesson. Returns the persisted
 * lessons (empty array when extraction produced nothing — the conservative,
 * no-op-edit case).
 */
export async function recordCorrectionLessons(
  input: RecordCorrectionLessonsInput,
  deps: CorrectionLoopDeps,
): Promise<CorrectionLesson[]> {
  const { repository, ports, auditRepo } = deps;
  const actorRole = deps.actorRole ?? 'owner';
  const recorded: CorrectionLesson[] = [];

  for (const draft of input.drafts) {
    const lesson = buildCorrectionLesson({
      id: randomUUID(),
      tenantId: input.tenantId,
      lessonType: draft.lessonType,
      sourceProposalId: input.sourceProposalId,
      ownerId: input.ownerId,
      summary: draft.summary,
      payload: draft.payload,
      localDate: input.localDate,
    });

    const created = await repository.create(lesson);
    // Cascade the config change forward within the day.
    await applyLessonConfig(input.tenantId, created.payload, ports);

    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.ownerId,
        actorRole,
        eventType: 'correction_lesson.applied',
        entityType: AUDIT_ENTITY_TYPE,
        entityId: created.id,
        metadata: {
          lessonType: created.lessonType,
          sourceProposalId: created.sourceProposalId,
          summary: created.summary,
          payload: created.payload,
        },
      }),
    );

    recorded.push(created);
  }

  return recorded;
}

export interface UndoCorrectionLessonInput {
  tenantId: string;
  lessonId: string;
  /** Owner performing the undo (audit provenance). */
  ownerId: string;
}

/**
 * Single-action undo: reverse the cascaded config and mark the lesson
 * reverted. Idempotent — a lesson already reverted returns it unchanged
 * without re-reversing config or re-auditing.
 */
export async function undoCorrectionLesson(
  input: UndoCorrectionLessonInput,
  deps: CorrectionLoopDeps,
): Promise<CorrectionLesson | null> {
  const { repository, ports, auditRepo } = deps;
  const actorRole = deps.actorRole ?? 'owner';

  const lesson = await repository.findById(input.tenantId, input.lessonId);
  if (!lesson) return null;
  if (lesson.status === 'reverted') return lesson; // idempotent

  await revertLessonConfig(input.tenantId, lesson.payload, ports);
  const reverted = await repository.markReverted(input.tenantId, input.lessonId, new Date());

  await auditRepo.create(
    createAuditEvent({
      tenantId: input.tenantId,
      actorId: input.ownerId,
      actorRole,
      eventType: 'correction_lesson.reverted',
      entityType: AUDIT_ENTITY_TYPE,
      entityId: input.lessonId,
      metadata: {
        lessonType: lesson.lessonType,
        sourceProposalId: lesson.sourceProposalId,
        payload: lesson.payload,
      },
    }),
  );

  return reverted;
}
