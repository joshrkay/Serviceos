/**
 * B1.19 — single implementation for "activate a vertical pack and seed
 * its defaults," shared by POST /api/onboarding/pack (the form wizard)
 * and the conversational onboarding_tenant_settings /
 * onboarding_service_category execution handlers
 * (proposals/execution/onboarding-handlers.ts). CRITICAL: parity means
 * both write through this one function, never a re-implementation —
 * see routes/onboarding.ts POST /pack for the original.
 */
import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import {
  PackActivationRepository,
  activatePack,
} from '../settings/pack-activation';
import { SettingsRepository, resolveBootstrapAiModel } from '../settings/settings';
import {
  SeedPackDefaultsDeps,
  SeedPackDefaultsResult,
  seedPackDefaults,
} from '../packs/seed-pack-defaults';

export interface ActivatePackWithSeedDeps {
  settingsRepo: SettingsRepository;
  packActivationRepo: PackActivationRepository;
  auditRepo: AuditRepository;
  /**
   * When absent, catalog/template seeding is skipped and the pack is
   * activated (pack_activations row + audit) but the price book / job
   * types stay empty — mirrors the route's own behavior when
   * packSeedDeps isn't wired.
   */
  packSeedDeps?: SeedPackDefaultsDeps;
}

export interface ActivatePackWithSeedInput {
  tenantId: string;
  packId: string;
  actorId: string;
  /**
   * Ambient request-scoped tenant transaction client, when one exists —
   * used to hold the per-(tenant,pack) advisory xact lock that
   * serializes concurrent activations of the SAME pack (see the
   * route's original comment). Omit when calling outside an HTTP
   * request (the execution handlers below): a duplicate-activation
   * race there is already guarded by activatePack's own "already
   * active" idempotency check plus seedPackDefaults' per-item
   * existence probes — narrower coverage than the request-scoped lock,
   * but the executor also never runs two proposals for the very same
   * (tenant, proposal id) concurrently, so the remaining window is a
   * genuine two-different-proposals-same-instant race, not a retry
   * storm. Flagged in the B1.19 report rather than silently assumed.
   */
  lockClient?: Pick<PoolClient, 'query'>;
}

export type ActivatePackWithSeedResult =
  | { status: 'locked' }
  | { status: 'activated'; seedResult: SeedPackDefaultsResult | null };

export async function activatePackWithSeed(
  input: ActivatePackWithSeedInput,
  deps: ActivatePackWithSeedDeps,
): Promise<ActivatePackWithSeedResult> {
  const { tenantId, packId, actorId, lockClient } = input;
  const { settingsRepo, packActivationRepo, auditRepo, packSeedDeps } = deps;

  // Read current settings to get existing activeVerticalPacks.
  const existing = await settingsRepo.findByTenant(tenantId);
  const currentPacks = existing?.activeVerticalPacks ?? [];
  const newPacks = Array.from(new Set([...currentPacks, packId])); // Idempotent union

  if (existing) {
    await settingsRepo.update(tenantId, { activeVerticalPacks: newPacks });
  } else {
    // Auto-create minimal settings row if the tenant hasn't set identity yet.
    await settingsRepo.create({
      id: uuidv4(),
      tenantId,
      businessName: '', // Will remain empty until identity is set.
      // No guessed timezone — the zone stays unset until the tenant
      // chooses one, matching createSettings/ensureTenantSettings, so
      // the scheduling gate never mistakes a seeded value for a choice.
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1001,
      nextInvoiceNumber: 1001,
      defaultPaymentTermDays: 30,
      activeVerticalPacks: newPacks,
      // Seed the platform default AI model so the onboarding "AI check"
      // finds aiConfigPresent=true. Same value ensureTenantSettings uses.
      aiModel: resolveBootstrapAiModel(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // Serialize pack activation + seed per (tenant, pack). Two concurrent
  // callers for the same tenant+pack could both pass the "already
  // activated" branch and reach the seed probe before either commits;
  // both would then observe an empty catalog/template set and insert a
  // full duplicate. Only taken when the caller supplies a request-scoped
  // client (see lockClient doc above).
  if (lockClient) {
    const lockRes = await lockClient.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS locked`,
      [`pack:${tenantId}:${packId}`],
    );
    if (!lockRes.rows[0]?.locked) {
      return { status: 'locked' };
    }
  }

  try {
    await activatePack({ tenantId, packId }, packActivationRepo);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (!msg.includes('already activated')) {
      throw err;
    }
  }

  // Auto-seed canonical job types, price book, and message-template
  // defaults so the "we'll set this up for you" promise is real.
  // Idempotent: each helper checks for the canonical names first.
  let seedResult: SeedPackDefaultsResult | null = null;
  if (packSeedDeps) {
    seedResult = await seedPackDefaults({ tenantId, packId, actorId }, packSeedDeps);
  }

  await auditRepo.create(
    createAuditEvent({
      tenantId,
      actorId,
      actorRole: 'owner',
      eventType: 'tenant.pack_activated',
      entityType: 'tenant_packs',
      entityId: packId,
      metadata: {
        packId,
        ...(seedResult
          ? {
              seedAlreadyApplied: seedResult.alreadySeeded,
              catalogItemsCreated: seedResult.catalogItemsCreated,
              templatesCreated: seedResult.templatesCreated,
            }
          : {}),
      },
    }),
  );

  return { status: 'activated', seedResult };
}
