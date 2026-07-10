import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Section } from '@/components/Section';
import { JsonLd } from '@/components/JsonLd';
import { pageMetadata } from '@/lib/metadata';
import { ARTICLES, allArticleSlugs, getArticle, type ArticleBlock } from '@/lib/articles';
import { SITE_NAME } from '@/lib/site';

// Statically generate every article at build time.
export function generateStaticParams() {
  return allArticleSlugs().map((slug) => ({ slug }));
}

export const dynamicParams = false;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const article = getArticle(slug);
  if (!article) return pageMetadata({ title: 'Not found', description: '' });
  return pageMetadata({
    title: article.title,
    description: article.description,
    path: `/resources/${article.slug}`,
  });
}

function Block({ block }: { block: ArticleBlock }) {
  switch (block.kind) {
    case 'heading':
      return <h2 className="mt-8 font-display text-2xl font-bold text-fg">{block.text}</h2>;
    case 'paragraph':
      return <p className="mt-4 text-fg-muted">{block.text}</p>;
    case 'list':
      return (
        <ul className="mt-4 list-disc space-y-2 pl-6 text-fg-muted">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
  }
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = getArticle(slug);
  if (!article) notFound();

  const articleJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: article.description,
    datePublished: article.publishedAt,
    publisher: { '@type': 'Organization', name: SITE_NAME },
  };

  const related = ARTICLES.filter((a) => a.slug !== article.slug).slice(0, 3);

  return (
    <>
      <JsonLd data={articleJsonLd} />
      <Section as="div" className="pt-16">
        <article className="mx-auto max-w-2xl">
          <p className="eyebrow">{article.category}</p>
          <h1 className="mt-3 font-display text-4xl font-bold text-fg">{article.title}</h1>
          <p className="mt-3 text-sm text-fg-muted">
            {article.readingMinutes} min read &middot;{' '}
            {new Date(article.publishedAt).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </p>
          <div className="mt-8">
            {article.body.map((block, i) => (
              <Block key={i} block={block} />
            ))}
          </div>

          {related.length > 0 && (
            <aside className="mt-16 border-t border-border pt-8">
              <h2 className="font-display text-lg font-semibold text-fg">More resources</h2>
              <ul className="mt-4 space-y-2">
                {related.map((r) => (
                  <li key={r.slug}>
                    <Link href={`/resources/${r.slug}`} className="text-primary hover:underline">
                      {r.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </aside>
          )}
        </article>
      </Section>
    </>
  );
}
