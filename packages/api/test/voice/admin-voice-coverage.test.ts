/**
 * Admin-task inventory ↔ live speakable catalog.
 *
 * Gates the product claim: ≥90% of day-in-the-life admin tasks are
 * voice-completable (draft/lookup path exists); human-only residual ≤10%.
 *
 * Uses real INTENT_TO_PROPOSAL_TYPE + execution handler registry — not mocks
 * of the catalog facts.
 */
import { describe, it, expect } from 'vitest';
import {
  ADMIN_TASK_INVENTORY,
  ADMIN_TASK_INVENTORY_VERSION,
  computeAdminVoiceCoverage,
  buildSpeakableCatalogFactsFromCode,
  evaluateTask,
  DEFAULT_MIN_VOICE_RATIO,
  DEFAULT_MAX_HUMAN_ONLY_RATIO,
} from '../../src/ai/voice-quality/admin-tasks';
import { INTENT_TO_PROPOSAL_TYPE } from '../../src/proposals/voice-intent-map';
import { pathSmokeRequiredPaths } from '../../src/ai/voice-quality/graph';
import { allPathSmokePathIds } from '../../src/ai/voice-quality/path-smoke';

describe('admin-task inventory shape', () => {
  it('is versioned and non-empty', () => {
    expect(ADMIN_TASK_INVENTORY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ADMIN_TASK_INVENTORY.length).toBeGreaterThanOrEqual(20);
  });

  it('has unique task ids', () => {
    const ids = ADMIN_TASK_INVENTORY.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('humanOnly tasks are mode human_only and vice versa', () => {
    for (const t of ADMIN_TASK_INVENTORY) {
      if (t.humanOnly) expect(t.mode).toBe('human_only');
      if (t.mode === 'human_only') expect(t.humanOnly).toBe(true);
    }
  });

  it('covers day-in-the-life critical admin categories', () => {
    const ids = new Set(ADMIN_TASK_INVENTORY.map((t) => t.id));
    for (const required of [
      'inbound_csr_book',
      'book_appointment',
      'draft_estimate',
      'send_estimate',
      'draft_invoice',
      'payment_chase',
      'lookup_quote',
      'add_note',
      'notify_delay',
      'create_customer',
    ]) {
      expect(ids.has(required)).toBe(true);
    }
  });
});

describe('admin voice coverage against live code', () => {
  const facts = buildSpeakableCatalogFactsFromCode();
  const report = computeAdminVoiceCoverage(facts);

  it('builds facts from real INTENT_TO_PROPOSAL_TYPE (not empty)', () => {
    expect(Object.keys(facts.intentToProposal).length).toBe(
      Object.keys(INTENT_TO_PROPOSAL_TYPE).length,
    );
    expect(facts.intentToProposal['create_appointment']).toBe('create_appointment');
    expect(facts.intentToProposal['create_invoice']).toBe('draft_invoice');
    expect(facts.handlerProposalTypes.has('draft_invoice')).toBe(true);
    expect(facts.lookupIntents.has('lookup_estimates')).toBe(true);
    expect(facts.specialIntents.has('negotiation')).toBe(true);
  });

  it(`voice-completable ratio ≥ ${DEFAULT_MIN_VOICE_RATIO} and human-only ≤ ${DEFAULT_MAX_HUMAN_ONLY_RATIO}`, () => {
    if (!report.gatePassed) {
      // eslint-disable-next-line no-console
      console.log(report.summaryLines.join('\n'));
    }
    expect(report.brokenSpeakable.map((r) => r.task.id)).toEqual([]);
    expect(report.voiceCompletableRatio).toBeGreaterThanOrEqual(DEFAULT_MIN_VOICE_RATIO);
    expect(report.humanOnlyRatio).toBeLessThanOrEqual(DEFAULT_MAX_HUMAN_ONLY_RATIO);
    expect(report.gatePassed).toBe(true);
  });

  it('every non-human inventory task that claims a proposal triple is in the live map', () => {
    for (const t of ADMIN_TASK_INVENTORY) {
      if (t.mode !== 'proposal') continue;
      const r = evaluateTask(t, facts);
      expect(r.voiceCompletable, `${t.id}: ${r.reason}`).toBe(true);
      if (t.proposalType) {
        expect(facts.intentToProposal[t.intents[0]!]).toBe(t.proposalType);
      }
    }
  });

  it('critical book/quote/invoice/chase/lookup inventory tasks resolve speakable', () => {
    const critical = [
      'book_appointment',
      'draft_estimate',
      'draft_invoice',
      'payment_chase',
      'lookup_quote',
    ];
    for (const id of critical) {
      const task = ADMIN_TASK_INVENTORY.find((t) => t.id === id);
      expect(task, id).toBeDefined();
      const r = evaluateTask(task!, facts);
      expect(r.voiceCompletable, `${id}: ${r.reason}`).toBe(true);
    }
  });
});

describe('inventory ↔ graph/path-smoke critical spine', () => {
  it('every inventory criticalPathId is a pathSmokeRequired graph path or optional', () => {
    const smokeRequired = new Set(pathSmokeRequiredPaths().map((p) => p.id));
    const smokeCases = new Set(allPathSmokePathIds());
    for (const t of ADMIN_TASK_INVENTORY) {
      if (!t.criticalPathId || t.humanOnly) continue;
      // Inventory-linked critical paths must be in path-smoke case list.
      expect(
        smokeCases.has(t.criticalPathId),
        `${t.id} criticalPathId=${t.criticalPathId} missing from path-smoke cases`,
      ).toBe(true);
      expect(
        smokeRequired.has(t.criticalPathId),
        `${t.id} criticalPathId=${t.criticalPathId} not pathSmokeRequired in graph`,
      ).toBe(true);
    }
  });
});
