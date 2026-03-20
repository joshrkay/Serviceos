import { describe, it, expect, beforeEach } from 'vitest';
import { createMockLLMGateway } from '../../../../src/ai/gateway/factory';
import { TeamExtractor } from '../../../../src/ai/tasks/onboarding/team-extractor';
import { ExtractionContext } from '../../../../src/ai/tasks/onboarding/types';
import { MockLLMProvider } from '../../../../src/ai/providers/mock';
import { LLMGateway } from '../../../../src/ai/gateway/gateway';
import * as fs from 'fs';
import * as path from 'path';

const fixturesDir = path.join(__dirname, '../../../fixtures/onboarding');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf-8');
}

function makeContext(transcript: string): ExtractionContext {
  return { tenantId: 'tenant-001', transcript, userId: 'user-001' };
}

describe('P4-EXT-004 — Team member extraction from voice transcript', () => {
  let gateway: LLMGateway;
  let provider: MockLLMProvider;
  let extractor: TeamExtractor;

  beforeEach(() => {
    const mock = createMockLLMGateway();
    gateway = mock.gateway;
    provider = mock.provider;
    extractor = new TeamExtractor(gateway);
  });

  // T3-006: Team extraction — "I've got three techs — Mike, Dave, and Rosa"
  it('T3-006 — extracts team members with names', async () => {
    provider.setDefaultResponse(JSON.stringify({
      members: [
        { name: 'Marcus', inferred_role: 'technician', confidence: 0.9, source_text: "I've got two techs — Marcus and Tony" },
        { name: 'Tony', inferred_role: 'technician', confidence: 0.9, source_text: "I've got two techs — Marcus and Tony" },
      ],
      confidence_score: 0.9,
    }));

    const result = await extractor.extract(makeContext(loadFixture('fixture-01-hvac-happy-path.txt')));

    expect(result.data.members).toHaveLength(2);
    const names = result.data.members.map((m) => m.name).sort();
    expect(names).toEqual(['Marcus', 'Tony']);
    expect(result.data.members.every((m) => m.inferredRole === 'technician')).toBe(true);
  });

  // T3-007: Role disambiguation — "Rosa handles the office, Mike and Dave are in the field"
  it('T3-007 — distinguishes dispatcher from technician roles', async () => {
    provider.setDefaultResponse(JSON.stringify({
      members: [
        { name: 'Mike', inferred_role: 'owner', confidence: 0.8, source_text: 'I run the trucks myself' },
        { name: 'Javier', inferred_role: 'technician', confidence: 0.9, source_text: "I've got two guys, Javier and Sam" },
        { name: 'Sam', inferred_role: 'technician', confidence: 0.9, source_text: "I've got two guys, Javier and Sam" },
        { name: 'Linda', inferred_role: 'dispatcher', confidence: 0.85, source_text: 'my wife Linda answers the phones' },
      ],
      confidence_score: 0.87,
    }));

    const result = await extractor.extract(makeContext(loadFixture('fixture-02-plumbing.txt')));

    const linda = result.data.members.find((m) => m.name === 'Linda');
    expect(linda).toBeDefined();
    expect(linda!.inferredRole).toBe('dispatcher');

    const techs = result.data.members.filter((m) => m.inferredRole === 'technician');
    expect(techs.length).toBeGreaterThanOrEqual(2);
  });

  it('handles empty team gracefully', async () => {
    provider.setDefaultResponse(JSON.stringify({
      members: [],
      confidence_score: 0.5,
    }));

    const result = await extractor.extract(makeContext('I work alone'));

    expect(result.data.members).toHaveLength(0);
    expect(result.needsClarification).toBe(false);
  });

  it('filters out members with invalid roles', async () => {
    provider.setDefaultResponse(JSON.stringify({
      members: [
        { name: 'Bob', inferred_role: 'technician', confidence: 0.9, source_text: 'Bob is a tech' },
        { name: 'Eve', inferred_role: 'accountant', confidence: 0.5, source_text: 'Eve does the books' },
      ],
      confidence_score: 0.7,
    }));

    const result = await extractor.extract(makeContext('Bob is a tech, Eve does the books'));

    expect(result.data.members).toHaveLength(1);
    expect(result.data.members[0].name).toBe('Bob');
  });
});
