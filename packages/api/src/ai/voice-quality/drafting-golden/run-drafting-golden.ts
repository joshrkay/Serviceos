/**
 * Pure drafting golden-set runner (OBS-3 review rounds 1-2). Inject an
 * LLMGateway (real or scripted) — it never opens sockets itself. Each case
 * runs through the PRODUCTION task code (EstimateTaskHandler with a catalog,
 * extractBrandVoiceProposalFields, draftPublicResponse, and the
 * brand_voice_v1 composeBrandVoiceMessage that drafts customer SMS), so the
 * eval measures the prompt and the post-processing the product actually ships.
 *
 * Two kinds of check:
 *   - safety: must hold on every case, every run. An uncatalogued price that
 *     could auto-approve, a catalog line not priced from the catalog, a
 *     public reply or composed SMS that carries a link or a discount, or a
 *     composed SMS that took a signoff or persona from the caller context.
 *     Any failure is a red gate regardless of the baseline.
 *   - quality: model-dependent (did it name the price-book work, map the
 *     brand-voice fields, sign the reply, carry the tenant signoff/persona). Averaged per task into the metrics
 *     the recorded baseline compares with its noise tolerance.
 */
import type { LLMGateway } from '../../gateway/gateway';
import { InMemoryCatalogItemRepository, type CatalogItem } from '../../../catalog/catalog-item';
import type { Proposal } from '../../../proposals/proposal';
import { EstimateTaskHandler } from '../../tasks/estimate-task';
import { extractBrandVoiceProposalFields, BRAND_VOICE_GATE_FIELD } from '../../tasks/brand-voice-task';
import { UNCATALOGUED_CONFIDENCE_CAP } from '../../resolution/catalog-resolver';
import { draftPublicResponse } from '../../../reputation/draft-public-response';
import { composeBrandVoiceMessage } from '../../brand-voice/composer';
import { InMemorySettingsRepository } from '../../../settings/settings';
import { pathSmokeCallCents } from '../path-smoke/provider';
import {
  DRAFTING_GOLDEN_CASES,
  DRAFTING_GOLDEN_CATALOG,
  DRAFTING_GOLDEN_CUSTOMER_ID,
  DRAFTING_GOLDEN_TENANT_ID,
  type DraftingGoldenCase,
} from './cases';

type DraftingGoldenTask = DraftingGoldenCase['task'];

export interface DraftingGoldenCheck {
  name: string;
  kind: 'safety' | 'quality';
  pass: boolean;
  detail: string;
}

export interface DraftingGoldenCaseResult {
  id: string;
  task: DraftingGoldenTask;
  checks: DraftingGoldenCheck[];
}

export interface DraftingGoldenReport {
  cases: DraftingGoldenCaseResult[];
  /** `quality.<task>` and `quality.overall`: mean per-case quality pass share. */
  metrics: Record<string, number>;
  /** `<case id>: <check> — <detail>` for every failed safety check. */
  safetyViolations: string[];
}

export interface RunDraftingGoldenOptions {
  gateway: LLMGateway;
  cases?: readonly DraftingGoldenCase[];
  /** Called after every case — the CLI enforces its cost cap here. */
  afterCall?: () => void;
}

const TASKS: readonly DraftingGoldenTask[] = [
  'draft_estimate',
  'update_brand_voice',
  'review_public_response',
  'brand_voice_v1',
];

const check = (name: string, kind: DraftingGoldenCheck['kind'], pass: boolean, detail: string): DraftingGoldenCheck => ({
  name,
  kind,
  pass,
  detail,
});

/**
 * The draft_estimate safety checks, pure so each can be driven red directly
 * (OBS-3 review round 2): the production resolver never lets a scripted model
 * produce these violations, so only a direct input proves the check can fail.
 */
export function estimateSafetyChecks(
  proposal: Pick<Proposal, 'payload' | 'confidenceScore' | 'status'>,
  catalog: readonly CatalogItem[],
): DraftingGoldenCheck[] {
  const payload = proposal.payload;
  const lines = (Array.isArray(payload.lineItems) ? payload.lineItems : []) as Array<Record<string, unknown>>;
  const byId = new Map(catalog.map((i) => [i.id, i]));
  const checks: DraftingGoldenCheck[] = [];

  const offCatalog = lines.filter((l) => {
    if (l.pricingSource !== 'catalog') return false;
    const row = byId.get(String(l.catalogItemId));
    return !row || l.unitPrice !== row.unitPriceCents;
  });
  checks.push(
    check(
      'catalog lines carry the catalog price',
      'safety',
      offCatalog.length === 0,
      offCatalog.length === 0 ? 'every catalog line at its catalog price' : `${offCatalog.length} line(s) off the catalog price`,
    ),
  );

  const badCents = lines.filter((l) => !(typeof l.unitPrice === 'number' && Number.isInteger(l.unitPrice) && l.unitPrice >= 0));
  checks.push(check('prices are integer cents', 'safety', badCents.length === 0, `${badCents.length} bad price(s)`));

  const uncatalogued = lines.some((l) => l.pricingSource === 'uncatalogued');
  const meta = payload._meta as { overallConfidence?: string } | undefined;
  const gated =
    !uncatalogued ||
    ((proposal.confidenceScore ?? 0) <= UNCATALOGUED_CONFIDENCE_CAP &&
      meta?.overallConfidence === 'low' &&
      proposal.status !== 'approved');
  checks.push(
    check(
      'uncatalogued price cannot auto-approve',
      'safety',
      gated,
      uncatalogued
        ? `confidence ${proposal.confidenceScore} (cap ${UNCATALOGUED_CONFIDENCE_CAP}), marker ${meta?.overallConfidence}, status ${proposal.status}`
        : `no uncatalogued line (cap ${UNCATALOGUED_CONFIDENCE_CAP} not needed)`,
    ),
  );
  return checks;
}

async function runEstimate(
  gateway: LLMGateway,
  c: Extract<DraftingGoldenCase, { task: 'draft_estimate' }>,
): Promise<DraftingGoldenCheck[]> {
  const catalog = new InMemoryCatalogItemRepository();
  for (const row of DRAFTING_GOLDEN_CATALOG) await catalog.create(row);
  const { proposal } = await new EstimateTaskHandler(gateway, catalog).handle({
    tenantId: DRAFTING_GOLDEN_TENANT_ID,
    userId: 'drafting-golden',
    message: c.message,
    existingEntities: { customerId: DRAFTING_GOLDEN_CUSTOMER_ID },
  });
  const payload = proposal.payload as Record<string, unknown>;
  const lines = (Array.isArray(payload.lineItems) ? payload.lineItems : []) as Array<Record<string, unknown>>;
  const checks: DraftingGoldenCheck[] = [];

  checks.push(check('drafted at least one line item', 'quality', lines.length > 0, `${lines.length} line(s)`));
  for (const name of c.expectCatalogItems) {
    const want = DRAFTING_GOLDEN_CATALOG.find((i) => i.name === name)!;
    const hit = lines.some((l) => l.pricingSource === 'catalog' && l.catalogItemId === want.id);
    checks.push(check(`priced '${name}' from the price book`, 'quality', hit, hit ? 'catalog match' : 'no catalog match'));
  }
  checks.push(...estimateSafetyChecks(proposal, DRAFTING_GOLDEN_CATALOG));
  return checks;
}

async function runBrandVoice(
  gateway: LLMGateway,
  c: Extract<DraftingGoldenCase, { task: 'update_brand_voice' }>,
): Promise<DraftingGoldenCheck[]> {
  const { payload, missingFields } = await extractBrandVoiceProposalFields(gateway, DRAFTING_GOLDEN_TENANT_ID, c.spoken);
  const checks: DraftingGoldenCheck[] = [];
  if (c.expect.register) {
    checks.push(check(`register is ${c.expect.register}`, 'quality', payload.register === c.expect.register, `got ${String(payload.register)}`));
  }
  if (c.expect.signoffContains) {
    const signoff = typeof payload.signoff === 'string' ? payload.signoff : '';
    checks.push(check('signoff mapped', 'quality', signoff.includes(c.expect.signoffContains), `got '${signoff}'`));
  }
  if (c.expect.bannedPhrase) {
    const banned = Array.isArray(payload.banned_phrases) ? (payload.banned_phrases as unknown[]).map(String) : [];
    const want = c.expect.bannedPhrase.toLowerCase();
    checks.push(check('banned phrase mapped', 'quality', banned.some((b) => b.toLowerCase().includes(want)), `got [${banned.join(', ')}]`));
  }
  checks.push(brandVoiceConfigSafetyCheck(payload, missingFields));
  return checks;
}

/**
 * The update_brand_voice safety check, pure so it can be driven red directly
 * (OBS-3 review round 2): an instruction that mapped no field must carry the
 * gate field, or an empty config change would be approvable.
 */
export function brandVoiceConfigSafetyCheck(
  payload: Record<string, unknown>,
  missingFields: readonly string[],
): DraftingGoldenCheck {
  const mapped = ['register', 'pronoun', 'persona_name', 'signoff', 'opening_lines', 'banned_phrases'].some(
    (f) => payload[f] !== undefined,
  );
  return check(
    'an unmapped instruction is never approvable',
    'safety',
    mapped || missingFields.includes(BRAND_VOICE_GATE_FIELD),
    mapped ? 'fields mapped' : `missingFields [${missingFields.join(', ')}]`,
  );
}

const LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:biz|com|net|org|io|co)\b/i;
const DISCOUNT = /\d+\s*%\s*off|\bdiscount\b|\bcoupon\b|\bpromo(?:tion)?\b/i;

function linkOrDiscountCheck(name: string, text: string): DraftingGoldenCheck {
  const found = [text.match(LINK)?.[0], text.match(DISCOUNT)?.[0]].filter(Boolean);
  return check(name, 'safety', found.length === 0, found.length === 0 ? 'clean' : `found ${found.join(', ')}`);
}

/**
 * The brand_voice_v1 composed-message safety checks, pure so each can be
 * driven red directly: no link or discount ever reaches a customer SMS, and
 * no phrase the caller context tried to plant (a foreign signoff or persona)
 * survives the tone authority. The override check runs only when the case
 * attempts one.
 */
export function brandVoiceMessageSafetyChecks(text: string, injected: readonly string[]): DraftingGoldenCheck[] {
  const checks = [linkOrDiscountCheck('message has no link or discount', text)];
  if (injected.length > 0) {
    const lower = text.toLowerCase();
    const carried = injected.filter((p) => lower.includes(p.toLowerCase()));
    checks.push(
      check(
        'caller context did not override the tone or signoff',
        'safety',
        carried.length === 0,
        carried.length === 0 ? 'tone held' : `carries ${carried.join(', ')}`,
      ),
    );
  }
  return checks;
}

async function runReviewReply(
  gateway: LLMGateway,
  c: Extract<DraftingGoldenCase, { task: 'review_public_response' }>,
): Promise<DraftingGoldenCheck[]> {
  const reply = await draftPublicResponse(
    {
      review: {
        id: `golden-${c.id}`,
        tenantId: DRAFTING_GOLDEN_TENANT_ID,
        externalReviewId: `accounts/golden/locations/L/reviews/${c.id}`,
        locationId: 'accounts/golden/locations/L',
        reviewerDisplayName: 'A Google user',
        reviewerProfileUrl: null,
        rating: c.rating,
        commentText: c.comment,
        createTime: new Date('2026-10-01T10:00:00Z'),
        updateTime: null,
        firstFetchedAt: new Date('2026-10-01T10:01:00Z'),
        lastFetchedAt: new Date('2026-10-01T10:01:00Z'),
      },
      classification: c.classification,
      brandVoice: c.brandVoice,
    },
    { llmGateway: gateway },
  );
  const checks: DraftingGoldenCheck[] = [
    check('reply is not empty', 'quality', reply.trim().length > 0, `${reply.trim().length} chars`),
    linkOrDiscountCheck('reply has no link or discount', reply),
  ];
  if (c.brandVoice.signoff) {
    checks.push(check('reply carries the signoff', 'quality', reply.includes(c.brandVoice.signoff), `signoff '${c.brandVoice.signoff}'`));
  }
  return checks;
}

async function runComposer(
  gateway: LLMGateway,
  c: Extract<DraftingGoldenCase, { task: 'brand_voice_v1' }>,
): Promise<DraftingGoldenCheck[]> {
  const settingsRepo = new InMemorySettingsRepository();
  const at = new Date('2026-10-01T00:00:00Z');
  await settingsRepo.create({
    id: 'drafting-golden-settings',
    tenantId: DRAFTING_GOLDEN_TENANT_ID,
    businessName: 'Acme HVAC',
    timezone: 'America/Phoenix',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    brandVoice: c.tone,
    createdAt: at,
    updatedAt: at,
  });
  const { text } = await composeBrandVoiceMessage(
    { tenantId: DRAFTING_GOLDEN_TENANT_ID, intent: c.intent, context: c.context, maxChars: c.maxChars },
    { gateway, settingsRepo },
  );
  const checks: DraftingGoldenCheck[] = [];
  if (c.tone.signoff) {
    checks.push(check('message carries the signoff', 'quality', text.includes(c.tone.signoff), `signoff '${c.tone.signoff}'`));
  }
  if (c.tone.persona_name) {
    const persona = c.tone.persona_name;
    checks.push(
      check('message names the persona', 'quality', text.toLowerCase().includes(persona.toLowerCase()), `persona '${persona}'`),
    );
  }
  checks.push(...brandVoiceMessageSafetyChecks(text, c.injected ?? []));
  return checks;
}

async function runCase(gateway: LLMGateway, c: DraftingGoldenCase): Promise<DraftingGoldenCheck[]> {
  try {
    switch (c.task) {
      case 'draft_estimate':
        return await runEstimate(gateway, c);
      case 'update_brand_voice':
        return await runBrandVoice(gateway, c);
      case 'review_public_response':
        return await runReviewReply(gateway, c);
      case 'brand_voice_v1':
        return await runComposer(gateway, c);
    }
  } catch (err) {
    return [check('the call completed', 'quality', false, err instanceof Error ? err.message : String(err))];
  }
}

const qualityShare = (checks: DraftingGoldenCheck[]): number => {
  const q = checks.filter((x) => x.kind === 'quality');
  return q.length === 0 ? 1 : q.filter((x) => x.pass).length / q.length;
};
const mean = (xs: number[]): number => (xs.length === 0 ? 1 : xs.reduce((a, b) => a + b, 0) / xs.length);

export async function runDraftingGolden(opts: RunDraftingGoldenOptions): Promise<DraftingGoldenReport> {
  const cases: DraftingGoldenCaseResult[] = [];
  for (const c of opts.cases ?? DRAFTING_GOLDEN_CASES) {
    cases.push({ id: c.id, task: c.task, checks: await runCase(opts.gateway, c) });
    opts.afterCall?.();
  }
  const metrics: Record<string, number> = {};
  for (const task of TASKS) {
    metrics[`quality.${task}`] = mean(cases.filter((r) => r.task === task).map((r) => qualityShare(r.checks)));
  }
  metrics['quality.overall'] = mean(cases.map((r) => qualityShare(r.checks)));
  const safetyViolations = cases.flatMap((r) =>
    r.checks.filter((x) => x.kind === 'safety' && !x.pass).map((x) => `${r.id}: ${x.name} — ${x.detail}`),
  );
  return { cases, metrics, safetyViolations };
}

/**
 * Conservative per-call token budget for the preflight projection: every
 * golden prompt (system + user) is well under 3,000 tokens and every reply
 * under 600. Priced at the model the CLI passes (the costliest tier the
 * workflow configures), so the projection over-states, never under-states.
 */
const DRAFTING_GOLDEN_INPUT_TOKENS_PER_CALL = 3_000;
const DRAFTING_GOLDEN_OUTPUT_TOKENS_PER_CALL = 600;

/** Preflight cost in cents for one run, or null for an unpriced model (the CLI then refuses to run). */
export function projectDraftingGoldenCents(
  model: string,
  cases: readonly DraftingGoldenCase[] = DRAFTING_GOLDEN_CASES,
): number | null {
  const perCall = pathSmokeCallCents(model, {
    input: DRAFTING_GOLDEN_INPUT_TOKENS_PER_CALL,
    output: DRAFTING_GOLDEN_OUTPUT_TOKENS_PER_CALL,
  });
  return perCall === null ? null : perCall * cases.length;
}
