import { describe, expect, it } from 'vitest';
import { createSseParser, parseSseJson } from './sseParser';

describe('createSseParser', () => {
  it('emits each complete event in a multi-event chunk', () => {
    const parser = createSseParser();
    const out = parser.push('data: {"a":1}\n\ndata: {"b":2}\n\n');
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('buffers a partial event across chunk boundaries', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"type":"sna')).toEqual([]);
    expect(parser.push('pshot","state":"intent_capture"}')).toEqual([]);
    expect(parser.push('\n\n')).toEqual(['{"type":"snapshot","state":"intent_capture"}']);
  });

  it('splits events that arrive split mid-delimiter', () => {
    const parser = createSseParser();
    expect(parser.push('data: one\n')).toEqual([]);
    expect(parser.push('\ndata: two\n\n')).toEqual(['one', 'two']);
  });

  it('ignores heartbeat comments and blank frames', () => {
    const parser = createSseParser();
    expect(parser.push(': hb\n\n')).toEqual([]);
    expect(parser.push('\n\n: hb\n\ndata: x\n\n')).toEqual(['x']);
  });

  it('joins multi-line data frames', () => {
    const parser = createSseParser();
    expect(parser.push('data: line1\ndata: line2\n\n')).toEqual(['line1\nline2']);
  });

  it('normalizes CRLF framing', () => {
    const parser = createSseParser();
    expect(parser.push('data: x\r\n\r\n')).toEqual(['x']);
  });
});

describe('parseSseJson', () => {
  it('parses valid JSON and returns null for malformed payloads', () => {
    expect(parseSseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(parseSseJson('{oops')).toBeNull();
  });
});
