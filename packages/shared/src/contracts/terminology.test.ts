import { describe, it, expect } from 'vitest';
import {
  ENTITY_TERM_KEYS,
  DEFAULT_ENTITY_LABELS,
  ENTITY_TERM_SYNONYMS,
  resolveEntityLabel,
  resolveEntityLabels,
  canonicalEntityForTerm,
} from './terminology.js';

describe('terminology — defaults', () => {
  it('exposes one default (singular + plural) for every canonical key', () => {
    for (const key of ENTITY_TERM_KEYS) {
      expect(DEFAULT_ENTITY_LABELS[key].singular.length).toBeGreaterThan(0);
      expect(DEFAULT_ENTITY_LABELS[key].plural.length).toBeGreaterThan(0);
    }
  });

  it('uses "Technician" as the default worker label (not "Worker")', () => {
    expect(DEFAULT_ENTITY_LABELS.workerTerm.singular).toBe('Technician');
  });
});

describe('resolveEntityLabel — render direction', () => {
  it('falls back to the platform default when no preference is set', () => {
    expect(resolveEntityLabel(undefined, 'estimateTerm')).toBe('Estimate');
    expect(resolveEntityLabel(null, 'jobTerm')).toBe('Job');
    expect(resolveEntityLabel({}, 'invoiceTerm')).toBe('Invoice');
  });

  it('returns the tenant override when set', () => {
    expect(resolveEntityLabel({ estimateTerm: 'Quote' }, 'estimateTerm')).toBe('Quote');
    expect(resolveEntityLabel({ jobTerm: 'Project' }, 'jobTerm')).toBe('Project');
  });

  it('treats a blank / whitespace override as "use default"', () => {
    expect(resolveEntityLabel({ estimateTerm: '   ' }, 'estimateTerm')).toBe('Estimate');
    expect(resolveEntityLabel({ estimateTerm: '' }, 'estimateTerm')).toBe('Estimate');
  });

  it('trims surrounding whitespace from an override', () => {
    expect(resolveEntityLabel({ jobTerm: '  Project  ' }, 'jobTerm')).toBe('Project');
  });

  it('pluralizes the default form', () => {
    expect(resolveEntityLabel(undefined, 'estimateTerm', { plural: true })).toBe('Estimates');
    expect(resolveEntityLabel(undefined, 'appointmentTerm', { plural: true })).toBe('Appointments');
  });

  it('pluralizes an override form with the minimal inflector', () => {
    expect(resolveEntityLabel({ estimateTerm: 'Quote' }, 'estimateTerm', { plural: true })).toBe('Quotes');
    expect(resolveEntityLabel({ jobTerm: 'Bid' }, 'jobTerm', { plural: true })).toBe('Bids');
    // -y → -ies and sibilant → -es paths
    expect(resolveEntityLabel({ workerTerm: 'Buddy' }, 'workerTerm', { plural: true })).toBe('Buddies');
    expect(resolveEntityLabel({ appointmentTerm: 'Dispatch' }, 'appointmentTerm', { plural: true })).toBe('Dispatches');
    // "Tech" ends in "ch" but takes a plain -s (hard /k/), not "Teches".
    expect(resolveEntityLabel({ workerTerm: 'Tech' }, 'workerTerm', { plural: true })).toBe('Techs');
  });
});

describe('resolveEntityLabels — full map', () => {
  it('returns a label for every canonical key, mixing overrides and defaults', () => {
    const labels = resolveEntityLabels({ estimateTerm: 'Quote', customerTerm: 'Client' });
    expect(labels).toEqual({
      jobTerm: 'Job',
      estimateTerm: 'Quote',
      invoiceTerm: 'Invoice',
      customerTerm: 'Client',
      appointmentTerm: 'Appointment',
      workerTerm: 'Technician',
    });
  });

  it('ignores non-label keys stored alongside (e.g. teamSize, ownerName)', () => {
    const labels = resolveEntityLabels({ teamSize: '5', ownerName: 'Dana', jobTerm: 'Project' });
    expect(labels.jobTerm).toBe('Project');
    expect(Object.keys(labels).sort()).toEqual([...ENTITY_TERM_KEYS].sort());
  });
});

describe('canonicalEntityForTerm — capture direction', () => {
  it('maps estimate synonyms to the estimate entity', () => {
    for (const word of ['estimate', 'Quote', 'BID', '  proposal  ']) {
      expect(canonicalEntityForTerm(word)).toBe('estimateTerm');
    }
  });

  it('maps job/appointment/customer/worker synonyms to their entities', () => {
    expect(canonicalEntityForTerm('ticket')).toBe('jobTerm');
    expect(canonicalEntityForTerm('project')).toBe('jobTerm');
    expect(canonicalEntityForTerm('visit')).toBe('appointmentTerm');
    expect(canonicalEntityForTerm('service call')).toBe('appointmentTerm');
    expect(canonicalEntityForTerm('client')).toBe('customerTerm');
    expect(canonicalEntityForTerm('tech')).toBe('workerTerm');
  });

  it('tolerates a trailing plural "s"', () => {
    expect(canonicalEntityForTerm('quotes')).toBe('estimateTerm');
    expect(canonicalEntityForTerm('Visits')).toBe('appointmentTerm');
  });

  it('returns null for an unknown term rather than guessing', () => {
    expect(canonicalEntityForTerm('sprocket')).toBeNull();
    expect(canonicalEntityForTerm('')).toBeNull();
    expect(canonicalEntityForTerm('   ')).toBeNull();
  });

  it('every enumerated synonym resolves back to its own entity', () => {
    for (const key of ENTITY_TERM_KEYS) {
      for (const syn of ENTITY_TERM_SYNONYMS[key]) {
        expect(canonicalEntityForTerm(syn)).toBe(key);
      }
    }
  });
});
