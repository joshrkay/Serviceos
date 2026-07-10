/**
 * Typed article data module powering /resources and /resources/[slug].
 * Content workers fill in real bodies later; these are PLACEHOLDER stubs so the
 * index + template render and statically generate. Body is an ordered list of
 * simple blocks rendered to HTML by the template (no MDX toolchain needed).
 */

export type ArticleBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] };

export interface Article {
  slug: string;
  title: string;
  description: string;
  category: string;
  /** ISO date. */
  publishedAt: string;
  readingMinutes: number;
  body: ArticleBlock[];
}

export const ARTICLES: Article[] = [
  {
    slug: 'hvac-quote-to-cash',
    title: 'Placeholder: HVAC quote-to-cash in one afternoon' /* COPY-TODO */,
    description: 'Placeholder description for an HVAC operations article.' /* COPY-TODO */,
    category: 'HVAC',
    publishedAt: '2026-06-01',
    readingMinutes: 6,
    body: [
      { kind: 'paragraph', text: 'COPY-TODO: intro paragraph.' },
      { kind: 'heading', text: 'COPY-TODO: section heading' },
      { kind: 'paragraph', text: 'COPY-TODO: body paragraph.' },
      { kind: 'list', items: ['COPY-TODO point one', 'COPY-TODO point two', 'COPY-TODO point three'] },
    ],
  },
  {
    slug: 'plumbing-dispatch-basics',
    title: 'Placeholder: Plumbing dispatch without the whiteboard' /* COPY-TODO */,
    description: 'Placeholder description for a plumbing dispatch article.' /* COPY-TODO */,
    category: 'Plumbing',
    publishedAt: '2026-06-08',
    readingMinutes: 5,
    body: [
      { kind: 'paragraph', text: 'COPY-TODO: intro paragraph.' },
      { kind: 'heading', text: 'COPY-TODO: section heading' },
      { kind: 'paragraph', text: 'COPY-TODO: body paragraph.' },
    ],
  },
  {
    slug: 'switching-from-jobber',
    title: 'Placeholder: What to check before switching from Jobber' /* COPY-TODO */,
    description: 'Placeholder description for a migration comparison article.' /* COPY-TODO */,
    category: 'Guides',
    publishedAt: '2026-06-15',
    readingMinutes: 8,
    body: [
      { kind: 'paragraph', text: 'COPY-TODO: intro paragraph.' },
      { kind: 'heading', text: 'COPY-TODO: section heading' },
      { kind: 'paragraph', text: 'COPY-TODO: body paragraph.' },
    ],
  },
];

export function getArticle(slug: string): Article | undefined {
  return ARTICLES.find((a) => a.slug === slug);
}

export function allArticleSlugs(): string[] {
  return ARTICLES.map((a) => a.slug);
}
