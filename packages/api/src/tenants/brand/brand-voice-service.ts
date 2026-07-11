/**
 * N-011 / P4-015 — Brand-Voice Configurator service.
 *
 * Orchestrates the explicit-web-edit and rollback flows on top of the pure
 * logic + repository in `brand-voice.ts`: cool-down gate (423), re-validation,
 * transactional version bump, and an audit event. The router is a thin HTTP
 * shell over these two functions so the semantics are unit-testable without
 * Express.
 */
import { AppError } from '../../shared/errors';
import { createAuditEvent, type AuditEvent } from '../../audit/audit';
import type { BrandVoiceSettings } from '../../settings/settings';
import {
  cooldownUntil,
  BrandVoiceCooldownError,
  type BrandVoiceInput,
  type BrandVoiceRepository,
  type BrandVoiceState,
} from './brand-voice';

export interface BrandVoiceActor {
  tenantId: string;
  userId: string;
  role: string;
}

export interface BrandVoiceUpdateResult {
  state: BrandVoiceState;
  cooldownUntil: string | null;
  audit: AuditEvent;
}

/**
 * Apply an explicit brand-voice edit. `onboarding` skips the cool-down and is
 * the first (unlocked) write; every subsequent web edit is cool-down gated.
 *
 * @throws AppError 423 BRAND_VOICE_COOLDOWN when a web edit lands inside the
 *   15-minute window.
 */
export async function updateBrandVoice(
  args: {
    actor: BrandVoiceActor;
    patch: BrandVoiceInput;
    onboarding?: boolean;
    now?: number;
  },
  repo: BrandVoiceRepository,
): Promise<BrandVoiceUpdateResult> {
  const { actor, patch, onboarding = false } = args;
  const now = args.now ?? Date.now();

  // The whole read → cool-down check → merge → write happens atomically under
  // the repo's row lock (bumpVersion), so two concurrent saves can't merge on
  // stale config or both bypass the cool-down. The cool-down decision throws
  // BrandVoiceCooldownError from under the lock; map it to the HTTP 423 here.
  let bump;
  try {
    bump = await repo.bumpVersion(actor.tenantId, {
      mutation: { kind: 'merge', patch, onboarding },
      changedBy: actor.userId,
      now,
    });
  } catch (err) {
    if (err instanceof BrandVoiceCooldownError) {
      throw new AppError(
        'BRAND_VOICE_COOLDOWN',
        'Brand voice was changed recently. Try again after the cool-down.',
        423,
        { cooldownUntil: err.cooldownUntil },
      );
    }
    throw err;
  }

  const audit = createAuditEvent({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    actorRole: actor.role,
    eventType: 'brand_voice.updated',
    entityType: 'brand_voice',
    entityId: actor.tenantId,
    metadata: {
      fromVersion: bump.fromVersion,
      toVersion: bump.state.version,
      changeReason: bump.changeReason,
      changedFields: bump.changedFields,
    },
  });

  return { state: bump.state, cooldownUntil: cooldownUntil(bump.state.updatedAt), audit };
}

/**
 * Roll back to a prior version by re-persisting its snapshot as a NEW bump
 * (history is never mutated). Same cool-down + audit as a web edit.
 *
 * @throws AppError 404 when the target version has no snapshot.
 * @throws AppError 423 when inside the cool-down.
 */
export async function rollbackBrandVoice(
  args: { actor: BrandVoiceActor; version: number; now?: number },
  repo: BrandVoiceRepository,
): Promise<BrandVoiceUpdateResult> {
  const { actor, version } = args;
  const now = args.now ?? Date.now();

  // History is immutable, so resolving the target snapshot outside the lock is
  // race-free; the cool-down check moves under the lock (bumpVersion) with the
  // write so a concurrent rollback/edit can't slip past a stale check.
  const snapshot = await repo.getVersionSnapshot(actor.tenantId, version);
  if (!snapshot) {
    throw new AppError(
      'BRAND_VOICE_VERSION_NOT_FOUND',
      `Brand voice version ${version} not found`,
      404,
      { version },
    );
  }

  const config: BrandVoiceSettings = { ...snapshot };

  let bump;
  try {
    bump = await repo.bumpVersion(actor.tenantId, {
      mutation: { kind: 'replace', config, changeReason: 'rollback' },
      changedBy: actor.userId,
      now,
    });
  } catch (err) {
    if (err instanceof BrandVoiceCooldownError) {
      throw new AppError(
        'BRAND_VOICE_COOLDOWN',
        'Brand voice was changed recently. Try again after the cool-down.',
        423,
        { cooldownUntil: err.cooldownUntil },
      );
    }
    throw err;
  }

  const audit = createAuditEvent({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    actorRole: actor.role,
    eventType: 'brand_voice.updated',
    entityType: 'brand_voice',
    entityId: actor.tenantId,
    metadata: {
      fromVersion: bump.fromVersion,
      toVersion: bump.state.version,
      changeReason: 'rollback',
      rolledBackTo: version,
      changedFields: bump.changedFields,
    },
  });

  return { state: bump.state, cooldownUntil: cooldownUntil(bump.state.updatedAt), audit };
}
