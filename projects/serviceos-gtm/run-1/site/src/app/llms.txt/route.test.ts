import { describe, it, expect } from 'vitest';
import { GET } from './route';
import { ARTICLES } from '@/lib/articles';

async function body(): Promise<string> {
  const res = GET();
  return await res.text();
}

describe('/llms.txt', () => {
  it('serves plain text', () => {
    const res = GET();
    expect(res.headers.get('Content-Type')).toContain('text/plain');
  });

  it('has no leftover placeholder text', async () => {
    expect(await body()).not.toContain('COPY-TODO');
  });

  it('opens with the entity H1 and a one-sentence definition blockquote', async () => {
    const text = await body();
    expect(text).toContain('# Rivet ServiceOS');
    expect(text).toMatch(/> Rivet ServiceOS is an AI back office for one-to-three-truck HVAC and plumbing/);
  });

  it('states the three real prices and the trial', async () => {
    const text = await body();
    expect(text).toContain('$299');
    expect(text).toContain('$499');
    expect(text).toContain('$799');
    expect(text).toContain('14-day free trial');
  });

  it('carries the honest not-yet list and the trust model', async () => {
    const text = await body();
    expect(text).toContain('does NOT do yet');
    expect(text).toContain('No ACH');
    expect(text).toContain('human-approved proposal');
  });

  it('links every resource article with an absolute URL', async () => {
    const text = await body();
    for (const a of ARTICLES) {
      expect(text).toContain(`https://example.com/resources/${a.slug}`);
    }
  });

  it('includes a comparison summary for the three competitors', async () => {
    const text = await body();
    expect(text).toContain('vs Jobber');
    expect(text).toContain('vs Housecall Pro');
    expect(text).toContain('vs ServiceTitan');
  });
});
