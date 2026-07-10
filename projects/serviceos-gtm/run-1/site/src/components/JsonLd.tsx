/**
 * Renders a JSON-LD <script> block. Pass any schema.org object as `data`.
 * Used for Organization / Product / FAQPage structured data across the site.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // JSON.stringify output is safe to inline; no user input flows in here.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
