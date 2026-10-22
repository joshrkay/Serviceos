/**
 * #1736 — the correction flywheel: an owner's correction becomes a corpus case
 * in the existing on-disk format, PII-redacted, loadable by the real loader.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildCorrectionCase,
  correctionScriptId,
  redactForCorpus,
  writeCorrectionCase,
} from '../../src/ai/voice-quality/corpus/correction-case';
import { exportPendingCorrections } from '../../src/ai/voice-quality/corpus/export-corrections';
import { loadCorpus, loadScript } from '../../src/ai/voice-quality/corpus/loader';
import { loadGoldenForScript } from '../../src/ai/voice-quality/graders/disposition-structured';
import { InMemoryVoiceSessionGradeStore } from '../../src/voice/quality/voice-session-grade-store';
import { InMemoryCallScoreStore } from '../../src/voice/scoring/call-score-store';

const CORRECTION_ID = 'abcdef12-0000-4000-8000-000000000001';
const TENANT = '11111111-1111-4111-8111-111111111111';
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function tmpCorpus(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vq-corrections-'));
}

describe('redactForCorpus (#1736)', () => {
  it('scrubs phones, emails, card numbers, street addresses and a self-introduced name', () => {
    const out = redactForCorpus(
      "Hi my name is Dana Keller, call me at (602) 555-0142 or dana@example.com, I'm at 1420 West Maple Street, card 4242 4242 4242 4242",
    );
    expect(out).not.toMatch(/Dana|Keller|555-0142|dana@|1420|4242/);
    expect(out).toContain('[phone]');
    expect(out).toContain('[email]');
    expect(out).toContain('[address]');
    expect(out).toContain('my name is [name]');
  });

  it('leaves ordinary service talk untouched', () => {
    const s = 'My AC is blowing warm air and I need someone Thursday morning';
    expect(redactForCorpus(s)).toBe(s);
  });
});

describe('buildCorrectionCase (#1736)', () => {
  const turns = ['My AC is out, call me at 602-555-0142', 'Can you come Thursday?', 'Yes please book it'];

  it('builds a schema-valid script from the caller lines up to the corrected turn, expectation on the last', () => {
    const { scriptId, script } = buildCorrectionCase(
      { id: CORRECTION_ID, kind: 'should_have_booked', turnIndex: 1, note: '' },
      turns,
    );
    expect(scriptId).toBe('owner-correction-abcdef12');
    expect(script.id).toBe(scriptId);
    expect(script.bucket).toBe('13-owner-corrections');
    expect(script.turns).toHaveLength(2);
    expect(script.turns[0].caller).toBe('My AC is out, call me at [phone]');
    expect(script.turns[0].expected).toEqual({});
    expect(script.turns[1].expected).toMatchObject({ intent: 'create_appointment', proposalType: 'create_appointment' });
    expect(script.callerId).toBe('+15555550199');
    expect(script.layer2Eligible).toBe(false);
  });

  it('defaults to the final caller turn and maps each kind to the owner expectation', () => {
    const last = (kind: Parameters<typeof buildCorrectionCase>[0]['kind'], note = '') =>
      buildCorrectionCase({ id: CORRECTION_ID, kind, turnIndex: null, note }, turns).script.turns.at(-1)!.expected;
    expect(last('should_have_escalated')).toMatchObject({ escalates: true });
    expect(last('should_not_have_escalated')).toMatchObject({ escalates: false });
    expect(last('wrong_price').spokenAnswerMatches).toMatch(/catalog/);
    expect(last('other', 'Ask for the unit age, call 602-555-0142').spokenAnswerMatches).toBe(
      'owner expectation: Ask for the unit age, call [phone]',
    );
  });

  it('includes the escalation criterion only for escalation corrections', () => {
    const grading = (kind: 'should_have_escalated' | 'wrong_price') =>
      buildCorrectionCase({ id: CORRECTION_ID, kind, turnIndex: null, note: '' }, turns).script.grading;
    expect(grading('should_have_escalated').appliesDisposition).toEqual([9, 11, 12]);
    expect(grading('wrong_price').appliesDisposition).toEqual([9, 12]);
  });

  it('clamps an out-of-range turn to the last one and rejects a call with no caller turns', () => {
    const { script } = buildCorrectionCase({ id: CORRECTION_ID, kind: 'other', turnIndex: 99, note: '' }, turns);
    expect(script.turns).toHaveLength(3);
    expect(() => buildCorrectionCase({ id: CORRECTION_ID, kind: 'other', turnIndex: null, note: '' }, [])).toThrow(
      /no caller turns/,
    );
  });

  it('script ids are stable per correction', () => {
    expect(correctionScriptId(CORRECTION_ID)).toBe(correctionScriptId(CORRECTION_ID));
    expect(correctionScriptId('ABCDEF12-0000-4000-8000-000000000002')).toBe('owner-correction-abcdef12');
  });
});

describe('writeCorrectionCase (#1736)', () => {
  it('writes script + empty golden + empty cassette that the real loaders accept', () => {
    const root = tmpCorpus();
    const built = buildCorrectionCase(
      { id: CORRECTION_ID, kind: 'should_have_escalated', turnIndex: null, note: '' },
      ['I want a refund and to talk to the owner'],
    );
    const files = writeCorrectionCase(built, root);
    expect(files).toHaveLength(3);

    const script = loadScript(path.join(root, 'scripts', '13-owner-corrections', `${built.scriptId}.json`));
    expect(script.turns[0].expected.escalates).toBe(true);
    expect(loadGoldenForScript(built.scriptId, root)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'cassettes', `${built.scriptId}.json`), 'utf-8'))).toEqual({
      scriptId: built.scriptId,
      version: 1,
      rubricVersion: 'v1',
      entries: [],
    });
    // the corpus loader walks the new bucket directory
    expect(loadCorpus(path.join(root, 'scripts')).map((s) => s.id)).toEqual([built.scriptId]);
  });

  it('rewrites the script on re-export but never wipes a recorded cassette', () => {
    const root = tmpCorpus();
    const built = buildCorrectionCase({ id: CORRECTION_ID, kind: 'other', turnIndex: null, note: '' }, ['hello']);
    writeCorrectionCase(built, root);
    const cassette = path.join(root, 'cassettes', `${built.scriptId}.json`);
    fs.writeFileSync(cassette, JSON.stringify({ scriptId: built.scriptId, version: 1, rubricVersion: 'v1', entries: [{ recorded: true }] }));
    expect(writeCorrectionCase(built, root)).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(cassette, 'utf-8')).entries).toHaveLength(1);
  });
});

describe('exportPendingCorrections (#1736)', () => {
  it('drains pending corrections into the corpus, stamps them exported, and reports unbuildable ones without blocking', async () => {
    const root = tmpCorpus();
    const store = new InMemoryCallScoreStore();
    const sessions = new InMemoryVoiceSessionGradeStore();
    sessions.seedSession({
      id: SESSION,
      tenantId: TENANT,
      channel: 'voice_inbound',
      startedAt: new Date('2026-10-04T15:00:00.000Z'),
      endedAt: new Date('2026-10-04T15:02:00.000Z'),
      outcome: 'completed',
      transcript: ['agent: Hi', 'caller: Can you come Thursday? Ring 602-555-0142', 'agent: One moment'],
      recordingDisclosed: true,
      billable: true,
    });
    const base = { tenantId: TENANT, kind: 'should_have_booked' as const, turnIndex: null, note: '', createdBy: 'u', createdAt: new Date('2026-10-05T00:00:00.000Z'), exportedAt: null, corpusScriptId: null };
    await store.saveCorrection({ ...base, id: CORRECTION_ID, sessionId: SESSION });
    await store.saveCorrection({ ...base, id: 'abcdef12-0000-4000-8000-000000000009', sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });

    const now = new Date('2026-10-06T00:00:00.000Z');
    const result = await exportPendingCorrections([TENANT], { store, sessions, corpusRoot: root, now: () => now });

    expect(result.exported).toHaveLength(1);
    expect(result.failed).toEqual([
      { tenantId: TENANT, correctionId: 'abcdef12-0000-4000-8000-000000000009', reason: 'call no longer exists' },
    ]);
    const script = loadScript(path.join(root, 'scripts', '13-owner-corrections', 'owner-correction-abcdef12.json'));
    expect(script.turns[0].caller).toBe('Can you come Thursday? Ring [phone]');
    expect(await store.findCorrection(TENANT, SESSION)).toMatchObject({ exportedAt: now, corpusScriptId: 'owner-correction-abcdef12' });
    // only the unbuildable one is still pending
    expect((await store.listPendingExport(TENANT)).map((c) => c.sessionId)).toEqual(['dddddddd-dddd-4ddd-8ddd-dddddddddddd']);
  });
});
