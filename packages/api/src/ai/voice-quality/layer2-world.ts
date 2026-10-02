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
import type { VoiceSession } from '../agents/customer-calling/voice-session-store';
import type { CustomerRepository } from '../../customers/customer';
import { normalizePhone } from '../../compliance/dnc';
import { lookupExecutedEvent } from './events';

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

/**
 * Skill name on the `lookup_executed` stamp emitted when caller-ID identified
 * exactly one customer. The floor PII grader treats it as identity-resolving
 * (graders/floor.ts IDENTITY_RESOLVING_LOOKUPS).
 */
export const CALLER_ID_IDENTITY_LOOKUP_SKILL = 'identify_caller_by_caller_id';

/**
 * #1331 — Layer 2 session establishment, as twilio-adapter establishes an
 * inbound call: bootstrap the FSM, stamp Twilio `From` on the session, and
 * identify the caller by caller-ID. Exactly one match → `session.customerId`
 * + `caller_known` (the identity the phone lookup surface answers a
 * customer's own-records question for), recorded on the event log as an
 * identity stamp — the customer-line twin of the owner line's
 * `verify_owner_identity` stamp. Unknown, blocked or ambiguous → no identity.
 */
export async function establishLayer2Caller(
  session: VoiceSession,
  opts: { callerId?: string | null; callerIdBlocked?: boolean },
  customerRepo: Pick<CustomerRepository, 'findByPhoneNormalized'>,
): Promise<void> {
  session.machine.dispatch({
    type: 'session_started',
    userId: 'voice-quality-layer2',
    tenantId: session.tenantId,
    conversationId: session.conversationId ?? session.id,
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  const callerId = !opts.callerIdBlocked && opts.callerId ? opts.callerId : undefined;
  if (callerId) session.callerPhone = callerId;
  const matches =
    callerId && customerRepo.findByPhoneNormalized
      ? await customerRepo.findByPhoneNormalized(session.tenantId, normalizePhone(callerId))
      : [];
  if (matches.length === 1) {
    session.customerId = matches[0]!.id;
    session.events.emit('voice-event', lookupExecutedEvent(CALLER_ID_IDENTITY_LOOKUP_SKILL, 0, true));
    session.machine.dispatch({ type: 'caller_known', customerId: matches[0]!.id });
  } else {
    session.machine.dispatch({ type: 'unknown_caller' });
  }
}

function fixtureBusinessHours(
  script: VoiceQualityScript,
): { timezone?: string; schedule?: unknown; callMomentLocal?: string } | undefined {
  const tenant = (script.fixtures.tenant ?? {}) as Record<string, unknown>;
  return tenant.businessHours as
    | { timezone?: string; schedule?: unknown; callMomentLocal?: string }
    | undefined;
}

/** The fixture tenant's IANA zone (business-hours zone first; LA default). */
export function corpusTimezone(script: VoiceQualityScript): string {
  const tenant = (script.fixtures.tenant ?? {}) as Record<string, unknown>;
  return (
    fixtureBusinessHours(script)?.timezone ??
    (typeof tenant.timezone === 'string' ? tenant.timezone : 'America/Los_Angeles')
  );
}

/**
 * The moment the script's call happens in the corpus world: its own
 * business-hours call moment, else {@link VOICE_QUALITY_CORPUS_EPOCH}. The
 * Layer 2 processor's clock, and the date the judges grade dates against.
 */
export function corpusCallMoment(script: VoiceQualityScript): Date {
  return new Date(fixtureBusinessHours(script)?.callMomentLocal ?? VOICE_QUALITY_CORPUS_EPOCH);
}

/**
 * #1331 — who is calling and on what date, for the LLM judges: a drafted
 * reply is graded against the right persona, and a spoken date against the
 * corpus world's calendar (not the judge's guess at "this year").
 */
export function describeCorpusCall(script: VoiceQualityScript): string {
  const caller = script.callerIsOwner
    ? 'Caller: the business owner, calling their own business line.'
    : 'Caller: a customer of the business.';
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: corpusTimezone(script),
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(corpusCallMoment(script));
  return `${caller}\nCall date: ${date}`;
}

export function buildLayer2ProcessorWorld(
  script: VoiceQualityScript,
  tenantId: string,
  repos?: RepoBundle,
): Layer2ProcessorWorld {
  const businessHours = fixtureBusinessHours(script);
  const timezone = corpusTimezone(script);

  const settingsRepo = new FixtureSettingsRepository(tenantId, {
    tenantId,
    timezone,
    businessHoursSchedule: businessHours?.schedule ?? [],
  } as unknown as TenantSettings);

  const onCallRepo = new InMemoryOnCallRepository(
    new Map([[tenantId, [{ id: 'oncall_vq', userId: 'dispatcher_vq', orderIndex: 0 }]]]),
  );

  const fixed = corpusCallMoment(script);
  const now = (): Date => fixed;
  return {
    settingsRepo,
    onCallRepo,
    now,
    ...(repos ? { entityResolver: fixtureEntityResolverForBundle(repos, { tenantId, timezone, now }) } : {}),
  };
}
