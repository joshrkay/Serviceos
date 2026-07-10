#!/usr/bin/env node
/**
 * validate-schema.mjs — builds the site, reads every generated HTML page from
 * the .next output, extracts all <script type="application/ld+json"> blocks,
 * JSON.parses each, and asserts:
 *   - required fields per schema.org @type (Organization, SoftwareApplication,
 *     FAQPage, BreadcrumbList, Article)
 *   - NO aggregateRating and NO review anywhere (hard rule — no real reviews)
 *   - absolute URLs where schema.org / Google require them
 *   - expected schema types are present on the pages that must carry them
 * Plus an internal-link check: every href="/…" in built HTML maps to a
 * generated route.
 *
 * Usage: node scripts/validate-schema.mjs [--no-build]
 * npm run validate:schema
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const APP_DIR = join(ROOT, '.next', 'server', 'app');

const errors = [];
const notes = [];
function fail(page, msg) {
  errors.push(`[${page}] ${msg}`);
}

// ---------------------------------------------------------------------------
// 1. Build (production env so robots/sitemap reflect the production ruleset).
// ---------------------------------------------------------------------------
if (!process.argv.includes('--no-build')) {
  console.log('Building site (VERCEL_ENV=production)…');
  execSync('next build', {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, VERCEL_ENV: 'production' },
  });
}
if (!existsSync(APP_DIR)) {
  console.error('No .next/server/app output found — build first.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const htmlFiles = walk(APP_DIR).filter((f) => f.endsWith('.html') && !f.endsWith('_not-found.html'));

function routeOf(htmlPath) {
  let r = '/' + relative(APP_DIR, htmlPath).replace(/\.html$/, '');
  if (r === '/index') r = '/';
  return r;
}

// Set of valid internal routes (from generated HTML) + non-HTML public routes.
const validRoutes = new Set(htmlFiles.map(routeOf));
validRoutes.add('/');
validRoutes.add('/llms.txt');

function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    blocks.push(raw);
  }
  return blocks;
}

function deepHasKey(obj, keys) {
  if (obj == null || typeof obj !== 'object') return false;
  for (const k of Object.keys(obj)) {
    if (keys.includes(k)) return true;
    if (deepHasKey(obj[k], keys)) return true;
  }
  return false;
}
function collectPrices(node, acc) {
  if (node == null || typeof node !== 'object') return acc;
  if (typeof node.price === 'string' || typeof node.price === 'number') acc.push(String(node.price));
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((x) => collectPrices(x, acc));
    else if (typeof v === 'object') collectPrices(v, acc);
  }
  return acc;
}
const isAbsUrl = (u) => typeof u === 'string' && /^https?:\/\//.test(u);

// ---------------------------------------------------------------------------
// 2. Per-page JSON-LD validation.
// ---------------------------------------------------------------------------
const REQUIRED_TYPES = {
  '/': ['Organization', 'SoftwareApplication'],
  '/pricing': ['Organization', 'SoftwareApplication', 'FAQPage', 'BreadcrumbList'],
  '/faq': ['Organization', 'FAQPage', 'BreadcrumbList'],
  '/how-it-works': ['Organization', 'BreadcrumbList'],
  '/resources': ['Organization', 'BreadcrumbList'],
  '/vs-jobber': ['Organization', 'FAQPage', 'BreadcrumbList'],
  '/vs-housecall-pro': ['Organization', 'FAQPage', 'BreadcrumbList'],
};

let blockCount = 0;
const typesByPage = {};

for (const file of htmlFiles) {
  const route = routeOf(file);
  const html = readFileSync(file, 'utf8');
  const blocks = extractJsonLd(html);
  const typesHere = [];

  for (const raw of blocks) {
    blockCount++;
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      fail(route, `JSON-LD failed to parse: ${e.message}`);
      continue;
    }
    const nodes = Array.isArray(data) ? data : [data];
    for (const node of nodes) {
      const type = node['@type'];
      typesHere.push(type);

      // Hard rule: never aggregateRating / review.
      if (deepHasKey(node, ['aggregateRating', 'review', 'reviewRating', 'ratingValue'])) {
        fail(route, `${type} contains a forbidden rating/review field`);
      }

      switch (type) {
        case 'Organization':
          if (!node.name) fail(route, 'Organization missing name');
          if (!isAbsUrl(node.url)) fail(route, 'Organization url not absolute');
          if (node.logo && !isAbsUrl(node.logo)) fail(route, 'Organization logo not absolute');
          break;
        case 'SoftwareApplication': {
          if (!node.name) fail(route, 'SoftwareApplication missing name');
          if (!node.applicationCategory) fail(route, 'SoftwareApplication missing applicationCategory');
          if (!node.offers) fail(route, 'SoftwareApplication missing offers');
          const prices = collectPrices(node.offers, []);
          if (prices.length === 0) fail(route, 'SoftwareApplication offers carry no price');
          break;
        }
        case 'FAQPage': {
          if (!Array.isArray(node.mainEntity) || node.mainEntity.length === 0) {
            fail(route, 'FAQPage mainEntity missing/empty');
            break;
          }
          for (const q of node.mainEntity) {
            if (q['@type'] !== 'Question' || !q.name) fail(route, 'FAQPage question malformed');
            const text = q.acceptedAnswer && q.acceptedAnswer.text;
            if (!text || !String(text).trim()) fail(route, `FAQPage answer empty for "${q.name}"`);
          }
          break;
        }
        case 'BreadcrumbList': {
          const items = node.itemListElement;
          if (!Array.isArray(items) || items.length === 0) {
            fail(route, 'BreadcrumbList itemListElement missing/empty');
            break;
          }
          items.forEach((li, i) => {
            if (li.position !== i + 1) fail(route, `BreadcrumbList position out of order at ${i}`);
            if (!li.name) fail(route, 'BreadcrumbList item missing name');
            if (!isAbsUrl(li.item)) fail(route, `BreadcrumbList item URL not absolute: ${li.item}`);
          });
          break;
        }
        case 'Article':
          if (!node.headline) fail(route, 'Article missing headline');
          if (!node.datePublished) fail(route, 'Article missing datePublished');
          if (!node.author || !node.author.name) fail(route, 'Article missing author');
          break;
      }
    }
  }

  typesByPage[route] = typesHere;

  // Expected-type presence check.
  const expected = REQUIRED_TYPES[route];
  if (expected) {
    for (const t of expected) {
      if (!typesHere.includes(t)) fail(route, `expected schema type "${t}" not found`);
    }
  }
  // Every article must carry Article + BreadcrumbList (+ Organization sitewide).
  if (route.startsWith('/resources/')) {
    for (const t of ['Organization', 'Article', 'BreadcrumbList']) {
      if (!typesHere.includes(t)) fail(route, `article expected schema type "${t}" not found`);
    }
  }

  // ------- Internal link check -------
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  for (const href of hrefs) {
    if (!href.startsWith('/')) continue; // external / anchor / mailto
    if (href.startsWith('//')) continue;
    const path = href.split('#')[0].split('?')[0].replace(/\/$/, '') || '/';
    // Ignore asset + framework paths.
    if (path.startsWith('/_next') || path.startsWith('/brand') || path.startsWith('/media') || path.startsWith('/api')) continue;
    if (/\.(png|svg|jpg|jpeg|ico|xml|txt|webmanifest|mp4)$/.test(path)) continue;
    if (!validRoutes.has(path)) fail(route, `internal link to unknown route: ${href}`);
  }
}

// ---------------------------------------------------------------------------
// 3. llms.txt / robots.txt / sitemap.xml body checks.
// ---------------------------------------------------------------------------
const llms = existsSync(join(APP_DIR, 'llms.txt.body')) ? readFileSync(join(APP_DIR, 'llms.txt.body'), 'utf8') : '';
if (!llms) fail('/llms.txt', 'body not generated');
if (/COPY-TODO/.test(llms)) fail('/llms.txt', 'still contains COPY-TODO');
for (const needle of ['# Rivet ServiceOS', '## Key facts', '## Pages', '## Comparison summary']) {
  if (!llms.includes(needle)) fail('/llms.txt', `missing section: ${needle}`);
}

const robots = existsSync(join(APP_DIR, 'robots.txt.body')) ? readFileSync(join(APP_DIR, 'robots.txt.body'), 'utf8') : '';
for (const needle of ['/api/', '/nurture-preview', '/signup/demo-checkout', '/go-live-pending', 'Sitemap:']) {
  if (!robots.includes(needle)) fail('/robots.txt', `production robots missing: ${needle}`);
}

const sitemap = existsSync(join(APP_DIR, 'sitemap.xml.body')) ? readFileSync(join(APP_DIR, 'sitemap.xml.body'), 'utf8') : '';
for (const needle of ['/vs-jobber', '/vs-housecall-pro', '/pricing', '/faq']) {
  if (!sitemap.includes(needle)) fail('/sitemap.xml', `missing url: ${needle}`);
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
console.log('\n── Schema types per page ──');
for (const route of Object.keys(typesByPage).sort()) {
  console.log(`${route.padEnd(52)} ${typesByPage[route].join(', ')}`);
}
console.log(`\nParsed ${blockCount} JSON-LD blocks across ${htmlFiles.length} pages.`);
console.log(`Validated internal links against ${validRoutes.size} known routes.`);
notes.forEach((n) => console.log('note:', n));

if (errors.length) {
  console.error(`\n✗ ${errors.length} validation error(s):`);
  errors.forEach((e) => console.error('  - ' + e));
  process.exit(1);
}
console.log('\n✓ Schema + link validation passed.');
