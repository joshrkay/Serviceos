/**
 * D-044 / #1768 — the tenant site page: escaped, mobile-first, tap-to-call,
 * chat bubble to the lead form.
 */
import { describe, expect, it } from 'vitest';
import { escapeHtml, renderTenantSiteNotFound, renderTenantSitePage, telHref, TenantSiteView } from '../../src/tenant-site/render';

const VIEW: TenantSiteView = {
  businessName: "Joe's Plumbing",
  services: ['Plumbing', 'HVAC'],
  serviceArea: 'Austin, TX',
  hoursSummary: 'Mon–Fri 8:00 AM – 5:00 PM',
  phone: '(512) 555-0100',
  aboutText: null,
  requestUrl: 'https://app.example.com/intake?t=t-1',
  bookUrl: 'https://app.example.com/book?t=t-1',
};

describe('renderTenantSitePage', () => {
  it('builds the page from the settings', () => {
    const html = renderTenantSitePage(VIEW);
    expect(html).toContain('<title>Joe&#39;s Plumbing</title>');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('<li>Plumbing</li>');
    expect(html).toContain('Austin, TX');
    expect(html).toContain('Mon–Fri 8:00 AM – 5:00 PM');
  });

  it('tap-to-call, booking and the request form are links', () => {
    const html = renderTenantSitePage(VIEW);
    expect(html).toContain('href="tel:5125550100"');
    expect(html).toContain('href="https://app.example.com/book?t=t-1"');
    expect(html).toContain('href="https://app.example.com/intake?t=t-1"');
  });

  it('the chat bubble opens the lead form', () => {
    const html = renderTenantSitePage(VIEW);
    expect(html).toMatch(/<a class="chat" href="https:\/\/app\.example\.com\/intake\?t=t-1"/);
  });

  it('keeps tap targets at 44px and contains no script', () => {
    const html = renderTenantSitePage(VIEW);
    expect(html).toMatch(/\.btn\{[^}]*min-height:48px/);
    expect(html).toMatch(/\.chat\{[^}]*width:56px;height:56px/);
    expect(html).not.toMatch(/<script(?![^>]*ld\+json)/);
  });

  it('omits sections it has nothing for, and tap-to-call without a phone', () => {
    const html = renderTenantSitePage({ ...VIEW, services: [], serviceArea: null, hoursSummary: null, phone: null });
    expect(html).not.toContain('id="services"');
    expect(html).not.toContain('id="area"');
    expect(html).not.toContain('id="hours"');
    expect(html).not.toContain('tel:');
    expect(html).toContain('Book online');
  });

  it('shows the about copy when there is some, and no empty heading when there is not', () => {
    expect(renderTenantSitePage(VIEW)).not.toContain('About us');
    const html = renderTenantSitePage({ ...VIEW, aboutText: 'We fix pipes.\n\nFast & fair.' });
    expect(html).toContain('<h2>About us</h2><p>We fix pipes.</p><p>Fast &amp; fair.</p>');
  });

  it('escapes everything the owner typed', () => {
    const html = renderTenantSitePage({
      ...VIEW,
      businessName: '<script>alert(1)</script>',
      services: ['"><img src=x onerror=1>'],
      aboutText: '<b>bold</b>',
      phone: '555-0100"><x>',
    });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).not.toContain('<x>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('cannot break out of the JSON-LD block', () => {
    const html = renderTenantSitePage({ ...VIEW, businessName: '</script><p>x' });
    const ld = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1]!;
    expect(ld).not.toContain('</script>');
    expect(JSON.parse(ld).name).toBe('</script><p>x');
  });
});

describe('telHref / escapeHtml / not found', () => {
  it('telHref keeps digits and a leading plus only', () => {
    expect(telHref('+1 (512) 555-0100')).toBe('tel:+15125550100');
    expect(telHref('ext 12')).toBeNull();
  });

  it('escapeHtml covers the five characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('the not-found page names no business and is not indexed', () => {
    const html = renderTenantSiteNotFound();
    expect(html).toContain('noindex');
    expect(html).toContain('available');
  });
});
