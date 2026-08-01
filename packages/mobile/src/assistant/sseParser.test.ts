import { describe, expect, it } from 'vitest';
import { createSseParser } from './sseParser';

describe('createSseParser', () => {
  it('parses a single complete data event', () => {
    const p = createSseParser();
    expect(p.push('data: {"type":"snapshot","state":"intent_capture"}\n\n')).toEqual([
      { type: 'snapshot', state: 'intent_capture' },
    ]);
  });

  it('parses multiple complete events in one chunk', () => {
    const p = createSseParser();
    const chunk =
      'data: {"type":"snapshot","state":"a"}\n\n' +
      'data: {"type":"proposal_created","proposalId":"p1"}\n\n' +
      'data: {"type":"ended","reason":"caller_hangup"}\n\n';
    expect(p.push(chunk)).toEqual([
      { type: 'snapshot', state: 'a' },
      { type: 'proposal_created', proposalId: 'p1' },
      { type: 'ended', reason: 'caller_hangup' },
    ]);
  });

  it('retains a partial event across chunk reads and completes it later', () => {
    const p = createSseParser();
    // First read cuts the JSON in half — no complete block yet.
    expect(p.push('data: {"type":"transition","sta')).toEqual([]);
    // Second read finishes the payload but not the boundary.
    expect(p.push('te":"closing"}')).toEqual([]);
    // Third read supplies the blank-line boundary.
    expect(p.push('\n\n')).toEqual([{ type: 'transition', state: 'closing' }]);
  });

  it('handles an event boundary split across two chunks', () => {
    const p = createSseParser();
    expect(p.push('data: {"state":"x"}\n')).toEqual([]); // only one newline so far
    expect(p.push('\ndata: {"state":"y"}\n\n')).toEqual([
      { state: 'x' },
      { state: 'y' },
    ]);
  });

  it('skips heartbeat / comment blocks', () => {
    const p = createSseParser();
    expect(p.push(': hb\n\n')).toEqual([]);
    expect(p.push(': hb\n\ndata: {"type":"snapshot","state":"a"}\n\n')).toEqual([
      { type: 'snapshot', state: 'a' },
    ]);
  });

  it('tolerates malformed JSON without throwing and keeps later events', () => {
    const p = createSseParser();
    const chunk =
      'data: {not valid json}\n\n' + 'data: {"type":"ended","reason":"done"}\n\n';
    expect(p.push(chunk)).toEqual([{ type: 'ended', reason: 'done' }]);
  });

  it('joins multiple data lines within one event (SSE multi-line payload)', () => {
    const p = createSseParser();
    expect(p.push('data: {"type":\ndata: "snapshot"}\n\n')).toEqual([
      { type: 'snapshot' },
    ]);
  });

  it('strips exactly one optional leading space after the colon', () => {
    const p = createSseParser();
    // No space form must also parse.
    expect(p.push('data:{"state":"z"}\n\n')).toEqual([{ state: 'z' }]);
  });

  it('normalizes CRLF line endings', () => {
    const p = createSseParser();
    expect(p.push('data: {"state":"crlf"}\r\n\r\n')).toEqual([{ state: 'crlf' }]);
  });

  it('ignores empty data blocks', () => {
    const p = createSseParser();
    expect(p.push('data:\n\n')).toEqual([]);
  });

  it('ignores non-data SSE fields (event:/id:/retry:)', () => {
    const p = createSseParser();
    expect(
      p.push('event: voice\nid: 7\ndata: {"type":"snapshot","state":"a"}\n\n'),
    ).toEqual([{ type: 'snapshot', state: 'a' }]);
  });

  it('accumulates state across many small chunks (byte-at-a-time stream)', () => {
    const p = createSseParser();
    const full = 'data: {"type":"proposal_created","proposalId":"abc"}\n\n';
    const out: unknown[] = [];
    for (const ch of full) out.push(...p.push(ch));
    expect(out).toEqual([{ type: 'proposal_created', proposalId: 'abc' }]);
  });
});
