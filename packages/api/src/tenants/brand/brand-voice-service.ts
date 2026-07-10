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
  isInCooldown,
  mergeBrandVoice,
  computeChangedFields,
  revalidateRoundTrip,
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

  const current = await repo.getState(actor.tenantId);

  // Cool-down gate — onboarding's first write is exempt.
  if (!onboarding && isInCooldown(current.updatedAt, now)) {
    const until = cooldownUntil(current.updatedAt);
    throw new AppError(
      'BRAND_VOICE_COOLDOWN',
      'Brand voice was changed recently. Try again after the cool-down.',
      423,
      { cooldownUntil: until },
    );
  }

  const nextConfig = mergeBrandVoice(current.config, patch);
  revalidateRoundTrip(nextConfig);

  const changedFields = computeChangedFields(current.config, nextConfig);
  const changeReason = onboarding ? 'onboarding' : 'web_edit';

  const state = await repo.bumpVersion(actor.tenantId, {
    config: nextConfig,
    changedBy: actor.userId,
    changeReason,
    updatedAt: new Date(now).toISOString(),
  });

  const audit = createAuditEvent({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    actorRole: actor.role,
    eventType: 'brand_voice.updated',
    entityType: 'brand_voice',
    entityId: actor.tenantId,
    metadata: {
      fromVersion: current.version,
      toVersion: state.version,
      changeReason,
      changedFields,
    },
  });

  return { state, cooldownUntil: cooldownUntil(state.updatedAt), audit };
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

  const current = await repo.getState(actor.tenantId);
  if (isInCooldown(current.updatedAt, now)) {
    throw new AppError(
      'BRAND_VOICE_COOLDOWN',
      'Brand voice was changed recently. Try again after the cool-down.',
      423,
      { cooldownUntil: cooldownUntil(current.updatedAt) },
    );
  }

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
  const changedFields = computeChangedFields(current.config, config);

  const state = await repo.bumpVersion(actor.tenantId, {
    config,
    changedBy: actor.userId,
    changeReason: 'rollback',
    updatedAt: new Date(now).toISOString(),
  });

  const audit = createAuditEvent({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    actorRole: actor.role,
    eventType: 'brand_voice.updated',
    entityType: 'brand_voice',
    entityId: actor.tenantId,
    metadata: {
      fromVersion: current.version,
      toVersion: state.version,
      changeReason: 'rollback',
      rolledBackTo: version,
      changedFields,
    },
  });

  return { state, cooldownUntil: cooldownUntil(state.updatedAt), audit };
}
