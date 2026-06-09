/**
 * Feature 2 — Voice → structured slot extraction (launch-readiness pass).
 *
 * Drives `extractLaunchSlots` from 8 transcript fixtures, asserts each result
 * validates against the `voiceSlotsSchema` Zod contract and equals the expected
 * slot JSON, and exercises the clarifying-turn cap (max 2 re-asks before human
 * handoff) on the incomplete calls.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ExtractedEntities } from '../../src/ai/orchestration/intent-classifier';
import {
  extractLaunchSlots,
  planSlotFollowup,
  voiceSlotsSchema,
  VoiceSlots,
  LaunchSlotInput,
  MAX_SLOT_REASKS,
} from '../../src/voice/launch-slots';

const TRANSCRIPTS_DIR = path.join(
  __dirname, '..', '..', '..', '..', 'fixtures', 'ai', 'transcripts',
);

function assertFixtureExists(file: string): void {
  // Ties each case to a real transcript fixture on disk.
  expect(fs.existsSync(path.join(TRANSCRIPTS_DIR, file))).toBe(true);
}

interface SlotCase {
  file: string;
  entities: ExtractedEntities;
  input: LaunchSlotInput;
  expected: VoiceSlots;
  complete: boolean;
}

// 8 transcript fixtures -> expected structured slots. Phones on the "complete"
// scheduling calls model caller-ID capture where the caller didn't read a
// number aloud. The two appliance/vague calls are intentionally incomplete to
// drive the clarifying-turn path.
const CASES: SlotCase[] = [
  {
    file: 'hvac-ac-not-cooling.json',
    entities: { customerName: 'Sarah Johnson', phone: '555-0101', serviceAddress: '456 Oak Avenue, Springfield', dateTimeDescription: 'Tomorrow 8-10 AM' },
    input: { serviceType: 'hvac', problemDescription: 'AC unit not cooling' },
    expected: {
      caller_name: 'Sarah Johnson', phone: '555-0101', address: '456 Oak Avenue, Springfield',
      service_type: 'hvac', preferred_time_window: 'Tomorrow 8-10 AM', problem_description: 'AC unit not cooling',
    },
    complete: true,
  },
  {
    file: 'plumbing-water-heater.json',
    entities: { customerName: 'Bob Martinez', phone: '555-0102', serviceAddress: '789 Pine Road, Portland', dateTimeDescription: 'Thursday 1-3 PM', lineItemDescriptions: ['Water heater inspection'] },
    input: { serviceType: 'plumbing' },
    expected: {
      caller_name: 'Bob Martinez', phone: '555-0102', address: '789 Pine Road, Portland',
      service_type: 'plumbing', preferred_time_window: 'Thursday 1-3 PM', problem_description: 'Water heater inspection',
    },
    complete: true,
  },
  {
    file: 'hvac-furnace-repair.json',
    entities: { customerName: 'Mike Anderson', phone: '555-0103', serviceAddress: '321 Elm Boulevard', dateTimeDescription: 'Today within 2 hours', noteBody: 'Furnace short cycling' },
    input: { serviceType: 'hvac' },
    expected: {
      caller_name: 'Mike Anderson', phone: '555-0103', address: '321 Elm Boulevard',
      service_type: 'hvac', preferred_time_window: 'Today within 2 hours', problem_description: 'Furnace short cycling',
    },
    complete: true,
  },
  {
    file: 'estimate-roof-quote.json',
    entities: { customerName: 'Dana Whitfield', phone: '555-0104', serviceAddress: '12 Cedar Court', lineItemDescriptions: ['Shingle replacement, 400 sq ft asphalt'] },
    input: { serviceType: 'roofing' },
    expected: {
      caller_name: 'Dana Whitfield', phone: '555-0104', address: '12 Cedar Court',
      service_type: 'roofing', problem_description: 'Shingle replacement, 400 sq ft asphalt',
    },
    complete: true,
  },
  {
    file: 'status-check-appointment.json',
    entities: { customerName: 'Priya Raman', phone: '555-0105', serviceAddress: '5 Maple Way', noteBody: 'Status of this afternoon appointment' },
    input: { serviceType: 'hvac' },
    expected: {
      caller_name: 'Priya Raman', phone: '555-0105', address: '5 Maple Way',
      service_type: 'hvac', problem_description: 'Status of this afternoon appointment',
    },
    complete: true,
  },
  {
    file: 'electrical-panel-upgrade.json',
    entities: { customerName: 'Tomas Reyes', phone: '555-0142', serviceAddress: '88 Birch Lane, Eugene', dateTimeDescription: 'Friday morning', noteBody: 'Panel upgrade; breakers trip under load' },
    input: { serviceType: 'electrical' },
    expected: {
      caller_name: 'Tomas Reyes', phone: '555-0142', address: '88 Birch Lane, Eugene',
      service_type: 'electrical', preferred_time_window: 'Friday morning', problem_description: 'Panel upgrade; breakers trip under load',
    },
    complete: true,
  },
  {
    // Incomplete: classifier got a name but no phone/address -> clarifying turn.
    file: 'appliance-vague-incomplete.json',
    entities: { customerName: 'Unknown caller', noteBody: 'Unspecified appliance malfunction' },
    input: { serviceType: 'appliance' },
    expected: {
      caller_name: 'Unknown caller', service_type: 'appliance', problem_description: 'Unspecified appliance malfunction',
    },
    complete: false,
  },
  {
    // Fully ambiguous: only a problem hint -> still needs name/phone/address.
    file: 'appliance-vague-incomplete.json',
    entities: { noteBody: 'Something wrong with an appliance' },
    input: {},
    expected: { problem_description: 'Something wrong with an appliance' },
    complete: false,
  },
];

describe('Feature 2 — Voice → structured slot extraction', () => {
  it('extracts 8 transcript fixtures to schema-valid slot JSON', () => {
    expect(CASES).toHaveLength(8);
    for (const c of CASES) {
      assertFixtureExists(c.file);
      const slots = extractLaunchSlots(c.entities, c.input);
      // Schema validation passes for every extracted slot object.
      expect(voiceSlotsSchema.safeParse(slots).success).toBe(true);
      // Extracted slots equal the expected slot JSON.
      expect(slots).toEqual(c.expected);
    }
  });

  it('proceeds when all required slots are present', () => {
    for (const c of CASES.filter((x) => x.complete)) {
      const slots = extractLaunchSlots(c.entities, c.input);
      expect(planSlotFollowup(slots, 0)).toEqual({ action: 'proceed', missing: [] });
    }
  });

  it('re-asks for missing slots, then hands off to a human after the cap (max 2)', () => {
    const incomplete = CASES.find((x) => !x.complete)!;
    const slots = extractLaunchSlots(incomplete.entities, incomplete.input);

    // First two turns re-ask for the missing required slots.
    const turn0 = planSlotFollowup(slots, 0);
    expect(turn0.action).toBe('reask');
    expect(turn0.missing.length).toBeGreaterThan(0);
    expect(planSlotFollowup(slots, 1).action).toBe('reask');

    // At the cap, escalate to a human instead of looping forever.
    expect(planSlotFollowup(slots, MAX_SLOT_REASKS).action).toBe('handoff');
  });

  it('rejects unknown slot keys via the strict Zod contract', () => {
    const bad = { caller_name: 'X', not_a_slot: 'nope' };
    expect(voiceSlotsSchema.safeParse(bad).success).toBe(false);
  });
});
