import Link from 'next/link';
import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { pageMetadata } from '@/lib/metadata';
import { ARTICLES } from '@/lib/articles';

export const metadata: Metadata = pageMetadata({
  title: 'Resources',
  description: 'Placeholder resources index description.', // COPY-TODO
  path: '/resources',
});

export default function ResourcesPage() {
  const articles = [...ARTICLES].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));

  return (
    <>
      <Section as="div" className="pt-16">
        <div className="mx-auto max-w-3xl text-center">
          <p className="eyebrow">Resources</p>
          <h1 className="mt-4 font-display text-4xl font-bold text-fg">Guides & playbooks</h1>
          <p className="mt-6 text-lg text-fg-muted">{/* COPY-TODO */}Placeholder resources intro.</p>
        </div>
      </Section>

      <Section aria-labelledby="articles-heading">
        <h2 id="articles-heading" className="sr-only">
          Articles
        </h2>
        <ul className="grid gap-6 md:grid-cols-3">
          {articles.map((article) => (
            <li key={article.slug}>
              <Link
                href={`/resources/${article.slug}`}
                className="flex h-full flex-col rounded-lg border border-border bg-surface p-6 hover:border-primary"
              >
                <span className="eyebrow">{article.category}</span>
                <h3 className="mt-2 font-display text-lg font-semibold text-fg">{article.title}</h3>
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
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
