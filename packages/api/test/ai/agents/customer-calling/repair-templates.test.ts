import { describe, it, expect } from 'vitest';
import { selectRepairTemplate } from '../../../../src/ai/agents/customer-calling/repair-templates';
import type { RepairTemplate } from '../../../../src/verticals/registry';

const templates: RepairTemplate[] = [
  { trigger: 'ambiguous_service_type', text: 'Heating or cooling?' },
  { trigger: 'low_intent_confidence', text: 'Scheduling or emergency?' },
  { trigger: 'low_audio_confidence', text: 'Could you repeat that?' },
];

describe('selectRepairTemplate', () => {
  it('picks the matching template by trigger', () => {
    const t = selectRepairTemplate(templates, { trigger: 'low_intent_confidence' });
    expect(t?.text).toBe('Scheduling or emergency?');
  });

  it('falls back to low_intent_confidence when the requested trigger is missing', () => {
    const reduced = templates.filter((x) => x.trigger !== 'ambiguous_entity');
    const t = selectRepairTemplate(reduced, { trigger: 'ambiguous_entity' });
    expect(t?.text).toBe('Scheduling or emergency?');
  });

  it('returns undefined when no templates are present at all', () => {
    expect(selectRepairTemplate([], { trigger: 'low_audio_confidence' })).toBeUndefined();
  });
});
