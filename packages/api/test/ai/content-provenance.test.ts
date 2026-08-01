import { describe, it, expect } from 'vitest';
import {
  classifyMessageProvenance,
  classifyTranscriptTurnProvenance,
  classifyRecordingProvenance,
} from '../../src/ai/content-provenance';

/**
 * RIVET I13 — the classifier is the single "is this caller-authored?"
 * decision. The load-bearing property is FAIL CLOSED: anything unmarked or
 * unknown classifies untrusted, so legacy rows and forgetful writers can
 * never silently launder caller text into a trusted prompt.
 */
describe('classifyMessageProvenance', () => {
  it('customer sender → untrusted', () => {
    expect(classifyMessageProvenance({ senderRole: 'customer' })).toBe('untrusted');
  });

  it('is tolerant of case/whitespace on the marker (mirrors suggest-reply isCustomer)', () => {
    expect(classifyMessageProvenance({ senderRole: ' Customer ' })).toBe('untrusted');
    expect(classifyMessageProvenance({ senderRole: 'CUSTOMER' })).toBe('untrusted');
  });

  it('tenant/system senders → trusted', () => {
    for (const senderRole of ['owner', 'user', 'assistant', 'system']) {
      expect(classifyMessageProvenance({ senderRole })).toBe('trusted');
    }
  });
});

describe('classifyTranscriptTurnProvenance', () => {
  it('caller turn → untrusted; agent turn → trusted', () => {
    expect(classifyTranscriptTurnProvenance({ speaker: 'caller' })).toBe('untrusted');
    expect(classifyTranscriptTurnProvenance({ speaker: 'agent' })).toBe('trusted');
  });
});

describe('classifyRecordingProvenance', () => {
  it('inbound call → untrusted regardless of metadata (caller audio is on it)', () => {
    expect(
      classifyRecordingProvenance({
        source: 'inbound_call',
        transcriptMetadata: { provenance: 'operator' },
      }),
    ).toBe('untrusted');
  });

  it('operator memo with a verified operator stamp → trusted', () => {
    expect(
      classifyRecordingProvenance({
        source: 'inapp_voice',
        transcriptMetadata: { provenance: 'operator' },
      }),
    ).toBe('trusted');
  });

  it('operator memo whose stamp says caller/mixed → untrusted', () => {
    for (const provenance of ['caller', 'mixed']) {
      expect(
        classifyRecordingProvenance({
          source: 'inapp_voice',
          transcriptMetadata: { provenance },
        }),
      ).toBe('untrusted');
    }
  });

  it('FAILS CLOSED: missing/empty/unknown metadata or source → untrusted', () => {
    expect(classifyRecordingProvenance({ source: 'inapp_voice' })).toBe('untrusted');
    expect(
      classifyRecordingProvenance({ source: 'inapp_voice', transcriptMetadata: {} }),
    ).toBe('untrusted');
    expect(
      classifyRecordingProvenance({
        source: 'inapp_voice',
        transcriptMetadata: { provenance: 'somebody-elses-string' },
      }),
    ).toBe('untrusted');
    expect(
      classifyRecordingProvenance({ source: 'batch_upload', transcriptMetadata: { provenance: 'operator' } }),
    ).toBe('untrusted');
    expect(classifyRecordingProvenance({ source: null })).toBe('untrusted');
    expect(classifyRecordingProvenance({})).toBe('untrusted');
  });
});
