/**
 * Every express-rate-limit instance mounted in createApp() must use the
 * shared Redis store. A limiter left on the default per-process MemoryStore
 * silently multiplies its cap by the replica count — /public/intake and
 * /api/public/booking (unauthenticated DB writes) shipped that way.
 *
 * createApp() needs a live Pg pool + prod secrets, so pin it in source.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

function rateLimitBlocks(src: string): Array<{ line: number; body: string }> {
  const blocks: Array<{ line: number; body: string }> = [];
  const re = /rateLimit\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    let end = m.index;
    for (let j = m.index + m[0].length - 1; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) {
        end = j;
        break;
      }
    }
    blocks.push({ line: src.slice(0, m.index).split('\n').length, body: src.slice(m.index, end) });
  }
  return blocks;
}

describe('rate limiters use the shared (cluster-wide) store', () => {
  it('every rateLimit({...}) in app.ts passes store: createRateLimitStore(...)', () => {
    const src = readFileSync(resolve(__dirname, '../../src/app.ts'), 'utf8');
    const blocks = rateLimitBlocks(src);
    expect(blocks.length).toBeGreaterThan(0);
    const missing = blocks.filter((b) => !/store:\s*createRateLimitStore\(/.test(b.body)).map((b) => b.line);
    expect(missing).toEqual([]);
  });
});
