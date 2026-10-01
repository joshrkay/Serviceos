/**
 * #1331 — the per-script production wiring the Layer 2 harness hands
 * `createVoiceTurnProcessor`, built from the script's fixtures the way app.ts
 * builds it from the tenant's rows (and the way the Layer 1 driver factory
 * already builds it for the text-mode driver):
 *
 *   - a settings row carrying the fixture tenant's zone (+ business hours), so
 *     spoken times resolve in the tenant zone — without it every "Tuesday at
 *     2pm" stayed unresolved and the booking gated on scheduledStart;
 *   - an on-call rotation, so an escalation reaches a dispatcher;
 *   - the corpus clock. The corpus is authored in a pinned world; Layer 1
 *     pins its booking scripts to VOICE_QUALITY_CORPUS_EPOCH and a business-
 *     hours script to its own call moment. Layer 2 runs the same world for
 *     every script (lookups included), so fixture dates that are "upcoming" in
 *     the corpus are upcoming on the call too.
 */
import { InMemoryOnCallRepository } from '../../oncall/rotation';
import {
  InMemorySettingsRepository,
  type SettingsRepository,
  type TenantSettings,
} from '../../settings/settings';
import type { VoiceQualityScript } from './schema';
import type { RepoBundle } from './runner';
import type { EntityResolver } from '../resolution/entity-resolver';
import { fixtureEntityResolverForBundle } from './fixture-entity-resolver';

/** The pinned "now" of the voice-quality corpus world (Layer 1's booking clock). */
export const VOICE_QUALITY_CORPUS_EPOCH = '2026-05-01T12:00:00.000Z';

export interface Layer2ProcessorWorld {
  settingsRepo: SettingsRepository;
  onCallRepo: InMemoryOnCallRepository;
  now: () => Date;
  /**
   * #1540 §1 — app.ts wires `PgEntityResolver`; the harness wires the shared
   * fixture resolver over the runner's seeded repo bundle, in this world's
   * zone and clock. Present when the bundle is passed.
   */
  entityResolver?: EntityResolver;
}

/** Settings repo whose one row is synthesized from the fixture tenant. */
class FixtureSettingsRepository extends InMemorySettingsRepository {
  constructor(
    private readonly tenantId: string,
    private readonly row: TenantSettings,
  ) {
    super();
  }

  override async findByTenant(tenantId: string): Promise<TenantSettings | null> {
    return tenantId === this.tenantId ? this.row : super.findByTenant(tenantId);
  }
}

export function buildLayer2ProcessorWorld(
  script: VoiceQualityScript,
  tenantId: string,
  repos?: RepoBundle,
): Layer2ProcessorWorld {
  const tenant = (script.fixtures.tenant ?? {}) as Record<string, unknown>;
  const businessHours = tenant.businessHours as
    | { timezone?: string; schedule?: unknown; callMomentLocal?: string }
    | undefined;
  const timezone =
    businessHours?.timezone ??
    (typeof tenant.timezone === 'string' ? tenant.timezone : 'America/Los_Angeles');

  const settingsRepo = new FixtureSettingsRepository(tenantId, {
    tenantId,
    timezone,
    businessHoursSchedule: businessHours?.schedule ?? [],
  } as unknown as TenantSettings);

  const onCallRepo = new InMemoryOnCallRepository(
    new Map([[tenantId, [{ id: 'oncall_vq', userId: 'dispatcher_vq', orderIndex: 0 }]]]),
  );

  const fixed = new Date(businessHours?.callMomentLocal ?? VOICE_QUALITY_CORPUS_EPOCH);
  const now = (): Date => fixed;
  return {
    settingsRepo,
    onCallRepo,
    now,
    ...(repos ? { entityResolver: fixtureEntityResolverForBundle(repos, { tenantId, timezone, now }) } : {}),
  };
}
