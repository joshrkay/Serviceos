/**
 * #842 — the voice action catalog is GENERATED from the capability
 * declarations. These pin the renderer at its public seam; the drift gate
 * (committed doc == regenerate) lives in test/ai/voice-action-catalog.contract.test.ts.
 */
import { describe, it, expect } from 'vitest';

import {
  applyGeneratedBlocks,
  renderCatalogBlocks,
  type CatalogInputs,
} from '../../src/capabilities/catalog';
import type { CapabilityDeclaration } from '../../src/capabilities/capabilities';

function inputs(overrides: Partial<CatalogInputs> = {}): CatalogInputs {
  const capabilities: Record<string, CapabilityDeclaration> = {
    record_payment: { kind: 'proposal', proposalType: 'record_payment', example: 'Mark the Smith invoice paid' },
    mark_lead_lost: { kind: 'proposal', proposalType: 'mark_lead_lost', example: 'Mark the Wagner lead lost' },
    emergency_dispatch: {
      kind: 'proposal',
      proposalType: 'emergency_dispatch',
      example: 'Emergency at the Hayes place',
      unavailableOn: { chat: 'surface-specific by design' },
    },
    en_route: { kind: 'direct_act', example: 'On my way to the Garcia job' },
    lookup_jobs: { kind: 'lookup' },
    lookup_balance: { kind: 'lookup' },
    approve_proposal: { kind: 'approval', unavailableOn: { memo: 'never from a transcript', chat: 'D-025' } },
    confirm: { kind: 'dialogue' },
  };
  return {
    capabilities,
    actionClassOf: (t) => (t === 'record_payment' ? 'money' : t === 'emergency_dispatch' ? 'irreversible' : 'capture'),
    handlerTypes: ['record_payment', 'mark_lead_lost', 'emergency_dispatch', 'callback', 'create_booking'],
    proofs: new Map([
      ['record_payment', ['record-payment-refund-proposal-flow.test.ts']],
      ['en_route', ['en-route-voice.test.ts']],
    ]),
    grandfathered: new Set(['mark_lead_lost']),
    ...overrides,
  };
}

describe('#842 catalog renderer', () => {
  const blocks = renderCatalogBlocks(inputs());

  it('renders the speakable table from the declarations: example, intent, type, class, surfaces, proof', () => {
    const table = blocks.get('speakable')!;
    expect(table).toContain(
      '| "Mark the Smith invoice paid" | `record_payment` | `record_payment` | money | all | integration (`integration/record-payment-refund-proposal-flow.test.ts`) |',
    );
    expect(table).toContain('3 actions');
  });

  it('prints a grandfathered gap as a gap — never as proof', () => {
    expect(blocks.get('speakable')!).toContain(
      '| "Mark the Wagner lead lost" | `mark_lead_lost` | `mark_lead_lost` | capture | all | **none** — grandfathered gap (#841) |',
    );
  });

  it('prints a surface opt-out in the surfaces column with the surface it skips', () => {
    expect(blocks.get('speakable')!).toContain('| irreversible | phone, memo (not chat) |');
  });

  it('derives "handler, no on-ramp" as execution handlers no declaration maps to', () => {
    const noOnramp = blocks.get('handler-no-onramp')!;
    expect(noOnramp).toContain('`callback`');
    expect(noOnramp).toContain('`create_booking`');
    expect(noOnramp).not.toContain('`record_payment`');
  });

  it('lists lookups, gated approvals and direct acts from their kinds', () => {
    expect(blocks.get('lookups')!).toContain('2 `lookup_*` intents');
    expect(blocks.get('lookups')!).toContain('`lookup_balance`, `lookup_jobs`');
    expect(blocks.get('gated')!).toContain('`approve_proposal`');
    expect(blocks.get('direct-acts')!).toContain(
      '| "On my way to the Garcia job" | `en_route` | integration (`integration/en-route-voice.test.ts`) |',
    );
  });

  it('keeps the machine-readable JSON shape the web + API contract tests parse', () => {
    const json = blocks.get('voice-action-catalog')!;
    const parsed = JSON.parse(json.slice(json.indexOf('{'), json.lastIndexOf('}') + 1));
    expect(parsed.speakable).toContainEqual({ intent: 'record_payment', proposalType: 'record_payment', actionClass: 'money' });
    expect(parsed.lookups).toEqual(['lookup_balance', 'lookup_jobs']);
    expect(parsed.handlerNoOnramp).toEqual(['callback', 'create_booking']);
    expect(parsed.gated).toEqual(['approve_proposal']);
  });

  it('NEGATIVE CONTROL — declaring a capability changes the rendered catalog (so drift is detectable)', () => {
    const planted = inputs();
    (planted.capabilities as Record<string, CapabilityDeclaration>).plant_x = {
      kind: 'proposal',
      proposalType: 'add_note',
      example: 'A planted capability',
    };
    expect(renderCatalogBlocks(planted).get('speakable')).not.toEqual(blocks.get('speakable'));
  });
});

describe('#842 applyGeneratedBlocks', () => {
  const doc = [
    'prose before',
    '<!-- BEGIN generated: lookups -->',
    'stale content',
    '<!-- END generated: lookups -->',
    'prose between',
    '<!-- BEGIN machine-readable: voice-action-catalog -->',
    '{"old": true}',
    '<!-- END machine-readable: voice-action-catalog -->',
    'prose after',
  ].join('\n');

  it('replaces only the content between markers and leaves prose untouched', () => {
    const out = applyGeneratedBlocks(
      doc,
      new Map([
        ['lookups', 'fresh'],
        ['voice-action-catalog', '{"new": true}'],
      ]),
    );
    expect(out).toBe(
      [
        'prose before',
        '<!-- BEGIN generated: lookups -->',
        'fresh',
        '<!-- END generated: lookups -->',
        'prose between',
        '<!-- BEGIN machine-readable: voice-action-catalog -->',
        '{"new": true}',
        '<!-- END machine-readable: voice-action-catalog -->',
        'prose after',
      ].join('\n'),
    );
  });

  it('refuses a document missing a block the renderer produces (a deleted marker is not silently skipped)', () => {
    expect(() => applyGeneratedBlocks(doc, new Map([['gated', 'x']]))).toThrow(/gated/);
  });
});
