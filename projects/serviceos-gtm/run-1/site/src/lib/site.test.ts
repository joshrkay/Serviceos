import { describe, it, expect } from 'vitest';
import { SITE_NAME, PRIMARY_NAV, FOOTER_NAV } from './site';

describe('brand naming', () => {
  it('site brand is Rivet (not ServiceOS)', () => {
    expect(SITE_NAME).toBe('Rivet');
  });
});

describe('primary nav', () => {
  it('exposes a Compare entry pointing at /vs-jobber', () => {
    const compare = PRIMARY_NAV.find((n) => n.label === 'Compare');
    expect(compare?.href).toBe('/vs-jobber');
  });
  it('no longer carries a bare "vs Jobber" label', () => {
    expect(PRIMARY_NAV.some((n) => n.label === 'vs Jobber')).toBe(false);
  });
});

describe('footer nav', () => {
  const allLinks = FOOTER_NAV.flatMap((c) => c.links.map((l) => l.href));
  it('links to both comparison pages', () => {
    expect(allLinks).toContain('/vs-jobber');
    expect(allLinks).toContain('/vs-housecall-pro');
  });
  it('groups the comparisons under a Compare heading', () => {
    const compare = FOOTER_NAV.find((c) => c.heading === 'Compare');
    expect(compare?.links.map((l) => l.href).sort()).toEqual(['/vs-housecall-pro', '/vs-jobber']);
  });
  it('keeps legal links', () => {
    expect(allLinks).toContain('/legal/privacy');
    expect(allLinks).toContain('/legal/terms');
  });
});
