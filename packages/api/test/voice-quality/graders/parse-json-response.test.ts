import { describe, expect, it } from 'vitest';
import { parseJsonResponse } from '../../../src/ai/voice-quality/graders/parse-json-response';

describe('parseJsonResponse', () => {
  it('parses plain JSON', () => {
    expect(parseJsonResponse('{"passed":true}')).toEqual({ passed: true });
  });

  it('parses Anthropic-style fenced JSON', () => {
    expect(parseJsonResponse('```json\n{"passed":true}\n```')).toEqual({
      passed: true,
    });
  });

  it('does not accept prose around JSON', () => {
    expect(() => parseJsonResponse('Result: {"passed":true}')).toThrow();
  });
});
