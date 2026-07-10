import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { Section } from '@/components/Section';
import { JsonLd } from '@/components/JsonLd';
import { pageMetadata, OG_IMAGE } from '@/lib/metadata';
import { allArticleSlugs, getArticle, getRelatedArticles, type ArticleBlock } from '@/lib/articles';
import { SITE_NAME } from '@/lib/site';
import { articleJsonLd, faqPageJsonLd, breadcrumbJsonLd, plainText } from '@/lib/schema';

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

  const base = pageMetadata({
    title: article.title,
    description: article.description,
    path: `/resources/${article.slug}`,
    // Article headlines already read as complete titles (and several would run
    // past 60 chars with a "— Rivet" suffix), so use them verbatim.
    titleAbsolute: true,
  });

  // Articles are OG type "article" (not the default "website"), with the
  // publish date and author surfaced for link-preview / AEO purposes.
  return {
    ...base,
    openGraph: {
      title: article.title,
      description: article.description,
      siteName: SITE_NAME,
      url: `/resources/${article.slug}`,
      type: 'article',
      publishedTime: article.publishedAt,
      authors: [article.author],
      images: [OG_IMAGE],
    },
  };
}

/**
 * Minimal inline-markdown-link renderer: turns `[label](url)` into a real
 * anchor (internal links use next/link, external links open in a new tab
 * with rel=noopener). This is how sourced facts and internal cross-links
 * render without a heavier MDX pipeline — see the module doc in articles.ts.
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = linkPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const [, label, href] = match;
    const key = `${keyPrefix}-link-${i}`;
    if (href.startsWith('/')) {
      parts.push(
        <Link key={key} href={href} className="text-primary underline underline-offset-2 hover:no-underline">
          {label}
        </Link>,
      );
    } else {
      parts.push(
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="text-primary underline underline-offset-2 hover:no-underline"
        >
          {label}
        </a>,
      );
    }
    lastIndex = linkPattern.lastIndex;
    i += 1;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

function Block({ block, index }: { block: ArticleBlock; index: number }) {
  switch (block.kind) {
    case 'heading':
      return (
        <h2 className="mt-10 font-display text-2xl font-bold text-fg">{renderInline(block.text, `h-${index}`)}</h2>
      );
    case 'paragraph':
      return <p className="mt-4 text-fg-muted">{renderInline(block.text, `p-${index}`)}</p>;
    case 'list':
      return (
        <ul className="mt-4 list-disc space-y-2 pl-6 text-fg-muted">
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item, `l-${index}-${i}`)}</li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[520px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-surface">
                {block.headers.map((h, i) => (
                  <th key={i} className="py-3 px-4 font-semibold text-fg">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri} className="border-b border-border last:border-0">
                  {row.map((cell, ci) => (
                    <td key={ci} className="py-3 px-4 align-top text-fg-muted">
                      {renderInline(cell, `t-${index}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {block.caption && <p className="border-t border-border px-4 py-2 text-xs text-fg-muted">{block.caption}</p>}
        </div>
      );
    case 'faq':
      return (
        <div className="mt-6 space-y-6">
          {block.items.map((item, i) => (
            <div key={i}>
              <h3 className="font-display text-lg font-semibold text-fg">{item.question}</h3>
              <p className="mt-2 text-fg-muted">{renderInline(item.answer, `faq-${index}-${i}`)}</p>
            </div>
          ))}
        </div>
      );
    case 'cta':
      return (
        <div className="mt-10 rounded-lg border border-border bg-surface p-6 text-center">
          <p className="font-display text-lg font-semibold text-fg">{block.heading}</p>
          <p className="mt-2 text-fg-muted">{block.text}</p>
          <Link href={block.href} className="btn-primary mt-4 inline-flex">
            {block.label}
          </Link>
        </div>
      );
  }
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = getArticle(slug);
  if (!article) notFound();

  const articleLd = articleJsonLd({
    title: article.title,
    description: article.description,
    datePublished: article.publishedAt,
    authorName: article.author,
    path: `/resources/${article.slug}`,
  });

  const breadcrumbLd = breadcrumbJsonLd([
    { name: 'Home', path: '/' },
    { name: 'Resources', path: '/resources' },
    { name: article.title, path: `/resources/${article.slug}` },
  ]);

  const faqItems = article.body
    .filter((b): b is Extract<ArticleBlock, { kind: 'faq' }> => b.kind === 'faq')
    .flatMap((b) => b.items);

  // Answer text is collapsed to plain text (markdown links → their label) so
  // the FAQPage JSON-LD matches the rendered answer exactly (Google parity).
  const faqLd =
    faqItems.length > 0
      ? faqPageJsonLd(faqItems.map((item) => ({ q: item.question, a: plainText(item.answer) })))
      : null;

  const related = getRelatedArticles(article, 3);

  return (
    <>
      <JsonLd data={articleLd} />
      <JsonLd data={breadcrumbLd} />
      {faqLd && <JsonLd data={faqLd} />}
      <Section as="div" className="pt-16">
        <article className="mx-auto max-w-2xl">
          <p className="eyebrow">{article.category}</p>
          <h1 className="mt-3 font-display text-4xl font-bold text-fg">{article.title}</h1>
          <p className="mt-3 text-sm text-fg-muted">
            By {article.author} &middot; {article.readingMinutes} min read &middot;{' '}
            {new Date(article.publishedAt).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </p>
          <div className="mt-8">
            {article.body.map((block, i) => (
              <Block key={i} block={block} index={i} />
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
