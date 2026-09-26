/**
 * #841 — the proven bar is a GATE, not a report.
 *
 * "Proven" (CONTEXT.md) means a real-database integration test. Every
 * capability that writes — every proposal capability and the direct act —
 * must be proven, or sit in the explicit grandfather register. Proof is
 * DERIVED from evidence (D-031): a `provesExecution('<key>')` tag in a file
 * under test/integration/ that opens a real pool. It is never asserted in the
 * declaration, so it cannot rot the way the catalog's hand-kept
 * "Persistence proof" column did (stale in both directions).
 *
 * The register only shrinks: a grandfathered capability that gains a proof
 * fails here until it is removed from the register, and a new capability
 * that ships unproven fails here unless someone adds it to the register — a
 * visible, reviewable act, pinned by the exact-set assertion below.
 */
import path from 'path';
import { describe, it, expect } from 'vitest';

import { CAPABILITIES } from '../../src/capabilities/capabilities';
import {
  KNOWN_PROOF_GAPS,
  evaluateProvenBar,
  proofKeyOf,
  provesExecution,
  scanExecutionProofs,
  type ExecutionProofScan,
} from '../../src/capabilities/proven-bar';

const INTEGRATION_DIR = path.resolve(__dirname, '../integration');
const scan = scanExecutionProofs(INTEGRATION_DIR);

describe('#841 proven bar — over the real declarations and the real integration suite', () => {
  it('the scan is not vacuous: it finds real-database proofs', () => {
    expect(scan.proofs.size).toBeGreaterThanOrEqual(30);
  });

  it('every tag lives in a file that opens a real database (directory location is not evidence — D-031)', () => {
    expect(scan.tagsWithoutDatabase).toEqual([]);
  });

  it('GATE: every writing capability is proven or grandfathered; the register is honest in both directions', () => {
    const verdict = evaluateProvenBar(CAPABILITIES, scan, KNOWN_PROOF_GAPS);
    expect(verdict.unproven, 'ship a real-database integration test tagged provesExecution(<key>)').toEqual([]);
    expect(verdict.staleGrandfathered, 'now proven — remove from KNOWN_PROOF_GAPS').toEqual([]);
    expect(verdict.strayGrandfathered, 'not a declared writing capability').toEqual([]);
    expect(verdict.unknownTags, 'tag names no declared capability').toEqual([]);
  });

  it('the grandfather register is pinned: it can shrink, and growing it is an edit to this line', () => {
    expect([...KNOWN_PROOF_GAPS].sort()).toEqual([
      'add_catalog_item',
      'add_service_location',
      'batch_invoice',
      'convert_lead',
      'create_service_agreement',
      'create_standing_instruction',
      'mark_lead_lost',
      'send_customer_message',
    ]);
  });

  it('the risk ranking holds: the money-or-new-table capabilities are proven, not grandfathered', () => {
    for (const intent of ['record_payment', 'record_refund', 'add_material', 'apply_credit'] as const) {
      expect(KNOWN_PROOF_GAPS.has(intent), intent).toBe(false);
      expect(scan.proofs.has(proofKeyOf(CAPABILITIES[intent])!), intent).toBe(true);
    }
  });

  it('proof keys: a proposal capability is proven by its proposal type, the direct act by its intent', () => {
    expect(proofKeyOf(CAPABILITIES.log_mileage)).toBe('log_expense');
    expect(proofKeyOf(CAPABILITIES.en_route, 'en_route')).toBe('en_route');
    expect(proofKeyOf(CAPABILITIES.lookup_jobs)).toBeUndefined();
  });

  it('the tag renders into the test title so the claim is visible where the test runs', () => {
    expect(provesExecution('record_payment', 'record_refund')).toBe(
      '[proves execution: record_payment, record_refund] ',
    );
  });
});

describe('#841 proven bar — NEGATIVE CONTROLS (the gate notices what it exists to catch)', () => {
  const emptyScan: ExecutionProofScan = { proofs: new Map(), tagsWithoutDatabase: [] };
  const oneCap = {
    add_note: { kind: 'proposal', proposalType: 'add_note', example: 'Note on the Patel job' },
  } as unknown as typeof CAPABILITIES;

  it('a new capability with no proof and no register entry fails', () => {
    expect(evaluateProvenBar(oneCap, emptyScan, new Set()).unproven).toEqual(['add_note']);
  });

  it('a register entry that has since been proven is reported stale', () => {
    const proven: ExecutionProofScan = { proofs: new Map([['add_note', ['x.test.ts']]]), tagsWithoutDatabase: [] };
    expect(evaluateProvenBar(oneCap, proven, new Set(['add_note'])).staleGrandfathered).toEqual(['add_note']);
  });

  it('a register entry naming no writing capability is reported stray', () => {
    const verdict = evaluateProvenBar(oneCap, emptyScan, new Set(['add_note', 'lookup_jobs']));
    expect(verdict.strayGrandfathered).toEqual(['lookup_jobs']);
  });

  it('a tag naming no declared capability is reported unknown', () => {
    const typo: ExecutionProofScan = {
      proofs: new Map([['add_note', ['a.test.ts']], ['add_nte', ['b.test.ts']]]),
      tagsWithoutDatabase: [],
    };
    expect(evaluateProvenBar(oneCap, typo, new Set()).unknownTags).toEqual(['add_nte']);
  });

  it('the scanner refuses a tag in a file that never opens a pool, and credits one that does', () => {
    const fixtureDir = path.resolve(__dirname, 'fixtures/proof-scan');
    const fixture = scanExecutionProofs(fixtureDir, { suffix: '.fixture.txt' });
    expect(fixture.tagsWithoutDatabase).toEqual(['in-memory-only.fixture.txt']);
    expect(fixture.proofs.get('record_payment')).toEqual(['real-db.fixture.txt']);
    expect(fixture.proofs.has('add_note')).toBe(false);
  });
});
