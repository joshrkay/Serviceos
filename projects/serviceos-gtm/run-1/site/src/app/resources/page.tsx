import Link from 'next/link';
import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { pageMetadata } from '@/lib/metadata';
import { ARTICLES, articleCategories, type Article } from '@/lib/articles';

export const metadata: Metadata = pageMetadata({
  title: 'Resources — guides for owner-operator home-service businesses',
  description:
    'Honest guides on AI receptionists, missed calls, and software for 1-3-truck HVAC and plumbing shops — including where Rivet fits and where it doesn\'t.',
  path: '/resources',
});

function ArticleCard({ article }: { article: Article }) {
  return (
    <Link
      href={`/resources/${article.slug}`}
      className="flex h-full flex-col rounded-lg border border-border bg-surface p-6 hover:border-primary"
    >
      <h3 className="font-display text-lg font-semibold text-fg">{article.title}</h3>
      <p className="mt-2 flex-1 text-sm text-fg-muted">{article.description}</p>
      <span className="mt-4 text-xs text-fg-muted">
        {article.readingMinutes} min read &middot;{' '}
        {new Date(article.publishedAt).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })}
      </span>
    </Link>
  );
}

export default function ResourcesPage() {
  const categories = articleCategories();

  return (
    <>
      <Section as="div" className="pt-16">
        <div className="mx-auto max-w-3xl text-center">
          <p className="eyebrow">Resources</p>
          <h1 className="mt-4 font-display text-4xl font-bold text-fg">
            Guides for owner-operator home-service businesses
          </h1>
          <p className="mt-6 text-lg text-fg-muted">
            Straight answers on AI receptionists, missed calls, and software for 1-3-truck HVAC and plumbing
            shops — with real sources, and an honest read on where Rivet fits and where it doesn&apos;t.
          </p>
        </div>
      </Section>

      {categories.map((category) => {
        const articles = ARTICLES.filter((a) => a.category === category).sort((a, b) =>
          a.publishedAt < b.publishedAt ? 1 : -1,
        );
        const headingId = `articles-${category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        return (
          <Section key={category} aria-labelledby={headingId}>
            <h2 id={headingId} className="font-display text-2xl font-bold text-fg">
              {category}
            </h2>
            <ul className="mt-6 grid gap-6 md:grid-cols-3">
              {articles.map((article) => (
                <li key={article.slug}>
                  <ArticleCard article={article} />
                </li>
              ))}
            </ul>
          </Section>
        );
      })}
    </>
  );
}
