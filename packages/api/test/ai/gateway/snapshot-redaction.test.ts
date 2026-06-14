/**
 * F-A U3 — ai_runs snapshot redaction.
 *
 * Image bytes / URLs must never reach the audit snapshot; text content is
 * preserved and text-only messages stay byte-identical to the old snapshot.
 */
import { describe, it, expect } from 'vitest';
import { redactMessagesForSnapshot } from '../../../src/ai/gateway/gateway';
import type { LLMMessage } from '../../../src/ai/gateway/gateway';

describe('redactMessagesForSnapshot', () => {
  it('leaves text-only messages byte-identical (no parts key)', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ];
    expect(redactMessagesForSnapshot(messages)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('redacts a base64 data: image — no bytes leak, keeps a reference', () => {
    // 1x1 transparent PNG
    const b64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const url = `data:image/png;base64,${b64}`;
    const out = redactMessagesForSnapshot([
      { role: 'user', content: 'see attached', parts: [{ type: 'image', url }] },
    ]);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(b64);
    expect(serialized).not.toContain('data:image');

    const part = (out[0].parts as Array<Record<string, unknown>>)[0];
    expect(part.type).toBe('image');
    expect(part.redacted).toBe(true);
    expect(part.mimeType).toBe('image/png');
    expect(part.bytes as number).toBeGreaterThan(0);
    expect((part.sha256 as string).length).toBe(64);
    expect(out[0].content).toBe('see attached');
  });

  it('does not store an http(s) image url raw — replaces it with a hash', () => {
    const url = 'https://signed.example.com/photo.jpg?token=secrettoken';
    const out = redactMessagesForSnapshot([
      { role: 'user', content: '', parts: [{ type: 'image', url }] },
    ]);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('secrettoken');
    expect(serialized).not.toContain(url);

    const part = (out[0].parts as Array<Record<string, unknown>>)[0];
    expect(part.redacted).toBe(true);
    expect((part.sha256 as string).length).toBe(64);
  });

  it('preserves text parts verbatim', () => {
    const out = redactMessagesForSnapshot([
      { role: 'user', content: 'c', parts: [{ type: 'text', text: 'keep me' }] },
    ]);
    expect(out[0].parts).toEqual([{ type: 'text', text: 'keep me' }]);
  });
});
