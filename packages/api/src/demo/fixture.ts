/**
 * U7 — the per-trade demo tenant fixture.
 *
 * The plan says each pool tenant is "cloned from that trade's fixture". No
 * fixture file exists on this branch; what exists is the four packs under
 * `verticals/packs/` and `activatePackWithSeed`, the one implementation of
 * "activate a vertical pack and seed its defaults". So this function IS the
 * fixture: identity (business name, timezone), the trade's preset voice, and
 * the pack activation with its catalog and template seeds, written in the
 * caller's transaction. The pool seed (`seed-pool.ts`) calls it once per
 * slot; the reset (S6-4) re-seeds a purged tenant with the same call, which
 * is what makes "the pool tenant looks the same after every call" true.
 *
 * Recording is not a per-tenant switch here: it is emitted only when the
 * Gather adapter is built with `recordingCallbackPath`, so the demo adapter
 * (S6-6) is built without it and the fixture sets nothing for it.
 */
import type { Pool, PoolClient } from 'pg';
import { tenantContextStore } from '../middleware/tenant-context';
import { applyTenantContext } from '../db/rls-runtime-role';
import { PgSettingsRepository } from '../settings/pg-settings';
import { PgPackActivationRepository } from '../settings/pg-pack-activation';
import { PgAuditRepository } from '../audit/pg-audit';
import { PgCatalogItemRepository } from '../catalog/pg-catalog-item';
import { PgEstimateTemplateRepository } from '../templates/pg-estimate-template';
import {
  activatePackWithSeed,
  type ActivatePackWithSeedDeps,
} from '../onboarding/activate-pack-with-seed';
import { resolveBootstrapAiModel } from '../settings/settings';
import { createAuditEvent } from '../audit/audit';
import { VOICE_PRESETS } from '../integrations/vapi/assistant-config';

/** The four packs with a shipped seed, in pool order. */
export const DEMO_TRADES = ['plumbing', 'hvac', 'electrical', 'painting'] as const;
export type DemoTrade = (typeof DEMO_TRADES)[number];

export function isDemoTrade(value: string): value is DemoTrade {
  return (DEMO_TRADES as readonly string[]).includes(value);
}

/**
 * Trade → preset voice (`integrations/vapi/assistant-config.ts` ships three
 * presets and no trade mapping). Owner action: confirm the voices before the
 * landing CTA ships; the default alternates so two demo trades never sound
 * identical back to back.
 */
export const DEMO_TRADE_VOICE: Record<DemoTrade, string> = {
  plumbing: 'rachel',
  hvac: 'adam',
  electrical: 'bella',
  painting: 'adam',
};

export const DEMO_FIXTURE_TIMEZONE = 'America/New_York';
export const DEMO_SEED_ACTOR_ID = 'system:demo-seed';
export const DEMO_TENANT_SEEDED_EVENT = 'demo.tenant_seeded';

const TRADE_LABEL: Record<DemoTrade, string> = {
  plumbing: 'Plumbing',
  hvac: 'HVAC',
  electrical: 'Electrical',
  painting: 'Painting',
};

/** The business name a demo tenant answers as until a call snapshots the visitor's. */
export function demoBusinessName(trade: DemoTrade, slot: number): string {
  return `Demo ${TRADE_LABEL[trade]} Shop ${slot}`;
}

export type DemoFixtureDeps = ActivatePackWithSeedDeps;

/** The real Pg repos behind the fixture; one per pool, shared by every seed. */
export function buildDemoFixtureDeps(pool: Pool): DemoFixtureDeps {
  return {
    settingsRepo: new PgSettingsRepository(pool),
    packActivationRepo: new PgPackActivationRepository(pool),
    auditRepo: new PgAuditRepository(pool),
    packSeedDeps: {
      catalogRepo: new PgCatalogItemRepository(pool),
      templateRepo: new PgEstimateTemplateRepository(pool),
    },
  };
}

export interface SeedDemoTenantInput {
  tenantId: string;
  trade: DemoTrade;
  /** 1-based slot in the trade's pool; only names the business. */
  slot: number;
}

export interface SeedDemoTenantResult {
  businessName: string;
  voiceId: string;
  packId: DemoTrade;
}

/**
 * Seed one demo tenant in the caller's open transaction. `client` must be
 * inside `BEGIN`: the tenant context is applied `SET LOCAL` on it and every
 * repository write reuses it through the tenant context store, so the seed
 * commits or rolls back with whatever the caller wraps around it (the
 * tenants INSERT in the pool seed, the purge walk in the reset).
 */
export async function seedDemoTenantFromFixture(
  client: PoolClient,
  input: SeedDemoTenantInput,
  deps: DemoFixtureDeps,
): Promise<SeedDemoTenantResult> {
  const { tenantId, trade, slot } = input;
  const businessName = demoBusinessName(trade, slot);
  const voiceId = DEMO_TRADE_VOICE[trade];
  if (!VOICE_PRESETS.some((p) => p.id === voiceId)) {
    throw new Error(`demo fixture: no voice preset named ${voiceId} for ${trade}`);
  }

  await applyTenantContext(client, tenantId, { transactional: true });
  return tenantContextStore.run({ client, tenantId }, async () => {
    await deps.settingsRepo.upsertIdentityFields(tenantId, {
      businessName,
      timezone: DEMO_FIXTURE_TIMEZONE,
      bootstrapAiModel: resolveBootstrapAiModel(),
    });
    // The generic settings update does not write voice_id (pg-settings.ts
    // reads it only); voice/voice-config.ts writes it raw the same way.
    await client.query(
      `UPDATE tenant_settings SET voice_id = $1, updated_at = now() WHERE tenant_id = $2`,
      [voiceId, tenantId],
    );

    const activated = await activatePackWithSeed(
      { tenantId, packId: trade, actorId: DEMO_SEED_ACTOR_ID, lockClient: client },
      deps,
    );
    if (activated.status === 'locked') {
      // Only another seed of the same tenant in flight can hold the
      // (tenant, pack) lock; two seeds of one demo tenant is a bug, not a retry.
      throw new Error(`demo fixture: pack ${trade} is being activated for ${tenantId} elsewhere`);
    }

    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: DEMO_SEED_ACTOR_ID,
        actorRole: 'system',
        eventType: DEMO_TENANT_SEEDED_EVENT,
        entityType: 'tenant',
        entityId: tenantId,
        metadata: {
          trade,
          slot,
          voiceId,
          catalogItemsCreated: activated.seedResult?.catalogItemsCreated ?? 0,
          templatesCreated: activated.seedResult?.templatesCreated ?? 0,
        },
      }),
    );

    return { businessName, voiceId, packId: trade };
  });
}
