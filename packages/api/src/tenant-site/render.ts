/**
 * D-044 / #1768 — the hosted tenant site: ONE server-rendered, mobile-first
 * HTML page, no client framework and no script. Pure: everything it shows
 * arrives in the view, built from tenant settings by tenant-site/view.ts.
 *
 * Mobile contract (pinned by e2e/tenant-site-mobile.spec.ts): every link and
 * button is at least 44px tall, and nothing overflows at 320px wide.
 */

export interface TenantSiteView {
  businessName: string;
  services: string[];
  serviceArea: string | null;
  hoursSummary: string | null;
  /** Dialable phone as the owner entered it; null hides tap-to-call. */
  phone: string | null;
  /** AI-drafted, owner-approved "about" copy (#1769); null shows the empty state. */
  aboutText: string | null;
  /** The existing public lead form; the chat bubble opens it. */
  requestUrl: string;
  /** The existing public booking page. */
  bookUrl: string;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

/** `tel:` target from a display phone: digits and a leading plus only. */
export function telHref(phone: string): string | null {
  const cleaned = phone.trim().replace(/(?!^\+)[^\d]/g, '');
  return /^\+?\d{7,15}$/.test(cleaned) ? `tel:${cleaned}` : null;
}

/** About copy is plain text: paragraphs split on blank lines, never HTML. */
function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

const STYLES = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:0 0 88px;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1c2330;background:#f6f7f9;overflow-wrap:anywhere}
main{max-width:720px;margin:0 auto}
header{padding:32px 16px 24px;background:#16324f;color:#fff}
h1{margin:0 0 8px;font-size:1.75rem;line-height:1.2}
.tag{margin:0;color:#d5e1ee}
section{padding:20px 16px;margin:12px 16px 0;background:#fff;border:1px solid #e1e5ea;border-radius:12px}
h2{margin:0 0 8px;font-size:1.1rem}
p{margin:0 0 10px}
p:last-child{margin-bottom:0}
ul{margin:0;padding-left:20px}
.actions{display:flex;flex-direction:column;gap:10px;margin-top:20px}
.btn{display:flex;align-items:center;justify-content:center;min-height:48px;padding:0 20px;border-radius:10px;font-weight:600;text-decoration:none;text-align:center}
.btn-primary{background:#f2a33a;color:#1c2330}
.btn-secondary{background:#fff;color:#16324f;border:2px solid #fff}
.chat{position:fixed;right:16px;bottom:16px;display:flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:#16324f;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.3)}
.chat svg{width:26px;height:26px}
footer{padding:20px 16px;color:#5b6573;font-size:.85rem;text-align:center}
@media(min-width:560px){.actions{flex-direction:row}.btn{flex:1}}
`;

const CHAT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

export function renderTenantSitePage(view: TenantSiteView): string {
  const name = escapeHtml(view.businessName);
  const tel = view.phone ? telHref(view.phone) : null;

  const description = view.services.length
    ? `${view.businessName}: ${view.services.join(', ')}${view.serviceArea ? ` in ${view.serviceArea}` : ''}.`
    : `${view.businessName}. Call or send a request and we will get back to you.`;

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: view.businessName,
    ...(view.phone ? { telephone: view.phone } : {}),
    ...(view.serviceArea ? { areaServed: view.serviceArea } : {}),
  }).replace(/</g, '\\u003c');

  const sections: string[] = [];
  if (view.aboutText?.trim()) {
    sections.push(`<section id="about"><h2>About us</h2>${paragraphs(view.aboutText)}</section>`);
  }
  if (view.services.length) {
    sections.push(
      `<section id="services"><h2>Services</h2><ul>${view.services
        .map((s) => `<li>${escapeHtml(s)}</li>`)
        .join('')}</ul></section>`,
    );
  }
  if (view.serviceArea) {
    sections.push(`<section id="area"><h2>Where we work</h2><p>${escapeHtml(view.serviceArea)}</p></section>`);
  }
  if (view.hoursSummary) {
    sections.push(`<section id="hours"><h2>Hours</h2><p>${escapeHtml(view.hoursSummary)}</p></section>`);
  }
  sections.push(
    `<section id="contact"><h2>Get in touch</h2>` +
      (view.phone && tel
        ? `<p>Call us at <a href="${escapeHtml(tel)}">${escapeHtml(view.phone)}</a>, or send a request and we will get back to you.</p>`
        : `<p>Send us a request and we will get back to you.</p>`) +
      `</section>`,
  );

  const actions =
    `<div class="actions">` +
    (tel ? `<a class="btn btn-primary" href="${escapeHtml(tel)}">Call ${escapeHtml(view.phone!)}</a>` : '') +
    `<a class="btn ${tel ? 'btn-secondary' : 'btn-primary'}" href="${escapeHtml(view.bookUrl)}">Book online</a>` +
    `<a class="btn btn-secondary" href="${escapeHtml(view.requestUrl)}">Request a quote</a>` +
    `</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<meta name="description" content="${escapeHtml(description)}">
<style>${STYLES}</style>
<script type="application/ld+json">${jsonLd}</script>
</head>
<body>
<main>
<header><h1>${name}</h1>${view.serviceArea ? `<p class="tag">Serving ${escapeHtml(view.serviceArea)}</p>` : ''}${actions}</header>
${sections.join('\n')}
<footer>&copy; ${name}</footer>
</main>
<a class="chat" href="${escapeHtml(view.requestUrl)}" aria-label="Message ${name}" rel="nofollow">${CHAT_ICON}</a>
</body>
</html>`;
}

/** The page for a host with no live site: no tenant is named, nothing is leaked. */
export function renderTenantSiteNotFound(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Site not found</title>
<style>body{margin:0;padding:48px 16px;font:16px/1.5 system-ui,sans-serif;text-align:center;color:#1c2330}</style></head>
<body><h1>This site isn't available</h1><p>The address may be wrong, or the business hasn't published its site.</p></body></html>`;
}
