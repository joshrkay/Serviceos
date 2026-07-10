import { getSiteUrl, SITE_NAME } from '@/lib/site';

export const dynamic = 'force-static';

/**
 * /llms.txt — placeholder. Content workers expand this with a real summary and
 * curated links for LLM crawlers. See https://llmstxt.org/ for the convention.
 */
export function GET() {
  const base = getSiteUrl().replace(/\/$/, '');
  const body = `# ${SITE_NAME}

> COPY-TODO: one-line description of ${SITE_NAME} for LLM crawlers.

## Pages
- [Home](${base}/)
- [How it works](${base}/how-it-works)
- [Pricing](${base}/pricing)
- [vs Jobber](${base}/vs-jobber)
- [FAQ](${base}/faq)
- [Resources](${base}/resources)

## Notes
COPY-TODO: key facts, positioning, and constraints for models summarizing this site.
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
