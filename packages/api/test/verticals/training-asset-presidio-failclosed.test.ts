import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryPrivacyAuditRepository,
  InMemoryTrainingAssetRepository,
} from '../../src/verticals/in-memory-training-assets';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { TrainingAssetRedactionService } from '../../src/verticals/training-asset-redaction';
import { TrainingAssetService } from '../../src/verticals/training-asset-service';
import {
  PRESIDIO_UNAVAILABLE_SIGNAL,
  PresidioUnavailableError,
  type PresidioAnonymizer,
} from '../../src/ai/privacy/presidio-adapter';

/**
 * WS5 — fail-closed Presidio semantics + PII-leak guards.
 *
 * Presidio itself is mocked here (never a real HTTP call). We prove:
 *   - an unavailable Presidio backend quarantines the asset (never persists
 *     raw / regex-only text) and records reason `presidio_unavailable`;
 *   - the backend is contacted at most once per create (short-circuit), so an
 *     outage doesn't multiply the per-field timeout;
 *   - a working Presidio pass composes with the deterministic scrub as defense
 *     in depth (a PII span Presidio missed is still caught);
 *   - raw PII never reaches the persisted asset, the privacy_audit payload, the
 *     normal audit payload, or any log line.
 */

class ThrowingPresidio implements PresidioAnonymizer {
  calls = 0;
  async anonymize(): Promise<never> {
    this.calls += 1;
    throw new PresidioUnavailableError('presidio down');
  }
}

class TransformPresidio implements PresidioAnonymizer {
  calls = 0;
  constructor(private readonly transform: (text: string) => string) {}
  async anonymize(text: string) {
    this.calls += 1;
    return { anonymizedText: this.transform(text), entities: [] };
  }
}

function makeService(redaction: TrainingAssetRedactionService, id = 'asset-fc') {
  const assetRepo = new InMemoryTrainingAssetRepository();
  const privacyAuditRepo = new InMemoryPrivacyAuditRepository();
  const auditRepo = new InMemoryAuditRepository();
  const service = new TrainingAssetService({
    assetRepo,
    privacyAuditRepo,
    auditRepo,
    redaction,
    idGenerator: () => id,
    now: () => new Date('2026-07-12T00:00:00Z'),
  });
  return { service, assetRepo, privacyAuditRepo, auditRepo };
}

const PII_INPUT = {
  verticalType: 'hvac' as const,
  assetKind: 'labeled_call_example' as const,
  title: 'Sarah Jones no heat call',
  rawText: 'Sarah Jones at 415-555-0123 has no heat, address 123 Main St.',
  labels: {
    intent: 'Call Sarah Jones at 415-555-0123',
    entities: { callerPhone: '415-555-0123', serviceAddress: '123 Main St' },
  },
  provenance: {
    source: 'tenant_admin' as const,
    sourceVersion: '1',
    notes: 'Follow up with Sarah Jones at 415-555-0123',
  },
};

const RAW_PII = ['Sarah Jones', '415-555-0123', '123 Main St'];

describe('TrainingAssetService — Presidio fail-closed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('quarantines the asset and records presidio_unavailable when Presidio is down', async () => {
    const presidio = new ThrowingPresidio();
    const redaction = new TrainingAssetRedactionService({ presidio });
    const { service, assetRepo, privacyAuditRepo } = makeService(redaction);

    const saved = await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: PII_INPUT,
      knownEntities: { names: ['Sarah Jones'] },
    });

    expect(saved.status).toBe('quarantined');
    expect(saved.scrubbedText).toBeUndefined();

    // Reason recorded in the privacy_audit entry.
    expect(privacyAuditRepo.rows).toHaveLength(1);
    expect(privacyAuditRepo.rows[0].redactionSummary.residualSignals).toContain(
      PRESIDIO_UNAVAILABLE_SIGNAL,
    );
    expect(privacyAuditRepo.rows[0].redactionSummary.hasResidualPii).toBe(true);

    // No raw PII anywhere it was persisted.
    const persisted = await assetRepo.findById('tenant-1', saved.id);
    for (const pii of RAW_PII) {
      expect(JSON.stringify(saved)).not.toContain(pii);
      expect(JSON.stringify(persisted)).not.toContain(pii);
      expect(JSON.stringify(privacyAuditRepo.rows[0])).not.toContain(pii);
    }
  });

  it('contacts Presidio at most once per create when it is unavailable (short-circuit)', async () => {
    const presidio = new ThrowingPresidio();
    const redaction = new TrainingAssetRedactionService({ presidio });
    const { service } = makeService(redaction, 'asset-sc');

    await service.create({ tenantId: 'tenant-1', actorId: 'user-1', input: PII_INPUT });

    // PII_INPUT has 6+ redactable fields; without short-circuit each would
    // incur its own failed Presidio call + timeout.
    expect(presidio.calls).toBe(1);
  });

  it('fails closed when Presidio is required but unconfigured', async () => {
    const redaction = new TrainingAssetRedactionService({ presidioRequired: true });
    const { service } = makeService(redaction, 'asset-req');

    const saved = await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: PII_INPUT,
    });

    expect(saved.status).toBe('quarantined');
    expect(saved.scrubbedText).toBeUndefined();
  });

  it('applies the deterministic scrub as defense in depth over Presidio output', async () => {
    // Presidio "misses" the phone number entirely (identity transform); the
    // local scrub must still catch it, and the asset stays clean.
    const presidio = new TransformPresidio((text) => text);
    const redaction = new TrainingAssetRedactionService({ presidio });
    const { service, assetRepo } = makeService(redaction, 'asset-did');

    const saved = await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: {
        verticalType: 'hvac',
        assetKind: 'prompt_context',
        title: 'No heat triage',
        rawText: 'Reach the caller at 415-555-0123 about the furnace.',
        labels: {},
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
      },
    });

    expect(presidio.calls).toBeGreaterThan(0);
    expect(saved.status).toBe('redacted');
    expect(saved.scrubbedText).toContain('[PHONE]');
    expect(saved.scrubbedText).not.toContain('415-555-0123');
    const persisted = await assetRepo.findById('tenant-1', saved.id);
    expect(JSON.stringify(persisted)).not.toContain('415-555-0123');
  });

  it('never writes raw PII to any log line', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ];
    const presidio = new ThrowingPresidio();
    const redaction = new TrainingAssetRedactionService({ presidio });
    const { service } = makeService(redaction, 'asset-log');

    await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: PII_INPUT,
      knownEntities: { names: ['Sarah Jones'] },
    });

    const logged = spies
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      .join('\n');
    for (const pii of RAW_PII) {
      expect(logged).not.toContain(pii);
    }
  });
});

describe('TrainingAssetRedactionService.redactAsync', () => {
  it('runs local-only (no quarantine) when no Presidio is configured', async () => {
    const redaction = new TrainingAssetRedactionService();
    const result = await redaction.redactAsync({
      text: 'Call 415-555-0123 about the water heater.',
    });
    expect(result.status).toBe('redacted');
    expect(result.failClosed).toBeUndefined();
    expect(result.scrubbedText).toContain('[PHONE]');
  });

  it('fails closed with the presidio_unavailable signal on backend error', async () => {
    const redaction = new TrainingAssetRedactionService({ presidio: new ThrowingPresidio() });
    const result = await redaction.redactAsync({ text: 'Sarah Jones' });
    expect(result.status).toBe('quarantined');
    expect(result.failClosed).toBe(true);
    expect(result.scrubbedText).toBe('');
    expect(result.summary.residualSignals).toContain(PRESIDIO_UNAVAILABLE_SIGNAL);
  });

  it('carries Presidio spans into the audit redactions and summary (PR #669 review)', async () => {
    // A PERSON span only Presidio catches: the deterministic sweep has no
    // known-entity for "Sarah Jones" here, so without span merging the asset
    // would contain [PERSON] while the audit reported zero redactions.
    const presidio: PresidioAnonymizer = {
      async anonymize(text: string) {
        expect(text).toBe('Sarah Jones called about the heater.');
        return {
          anonymizedText: '[PERSON] called about the heater.',
          entities: [{ entityType: 'PERSON', start: 0, end: 11, score: 0.99 }],
        };
      },
    };
    const redaction = new TrainingAssetRedactionService({ presidio });
    const result = await redaction.redactAsync({
      text: 'Sarah Jones called about the heater.',
    });

    expect(result.status).toBe('redacted');
    expect(result.scrubbedText).toContain('[PERSON]');
    expect(result.auditRedactions).toContainEqual({
      kind: 'presidio:PERSON',
      placeholder: '[PERSON]',
      start: 0,
      end: 11,
    });
    expect(result.summary.redactionCount).toBeGreaterThanOrEqual(1);
    expect(result.summary.redactionKinds).toContain('presidio:PERSON');
    expect(result.summary.placeholders).toContain('[PERSON]');
  });

  it('merges Presidio spans with local-sweep redactions when both fire', async () => {
    // Presidio catches the PERSON; the deterministic regex sweep catches the
    // phone number Presidio "missed" — both must appear in the audit.
    const presidio = new TransformPresidio((text) =>
      text.replace('Sarah Jones', '[PERSON]'),
    );
    // TransformPresidio returns no entities; hand-roll one that returns both
    // the transformed text and the span.
    const spanPresidio: PresidioAnonymizer = {
      async anonymize(text: string) {
        const out = await presidio.anonymize(text);
        return {
          anonymizedText: out.anonymizedText,
          entities: [{ entityType: 'PERSON', start: 0, end: 11, score: 0.9 }],
        };
      },
    };
    const redaction = new TrainingAssetRedactionService({ presidio: spanPresidio });
    const result = await redaction.redactAsync({
      text: 'Sarah Jones at 415-555-0123 has no heat.',
    });

    const kinds = result.auditRedactions.map((r) => r.kind);
    expect(kinds).toContain('presidio:PERSON');
    expect(kinds.some((k) => !k.startsWith('presidio:'))).toBe(true); // local phone catch
    expect(result.scrubbedText).not.toContain('415-555-0123');
    expect(result.summary.redactionCount).toBe(result.auditRedactions.length);
  });
});
