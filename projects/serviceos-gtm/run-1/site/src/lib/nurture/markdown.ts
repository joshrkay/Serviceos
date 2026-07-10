/**
 * Tiny markdown -> {HTML, plain text} renderer for nurture email bodies.
 *
 * Deliberately minimal: the 8 nurture emails only ever use paragraphs, ordered
 * lists (`1. `), unordered lists (`- `), inline **bold**, and a single embedded
 * `<a href="...">...</a>` link per email (already written as raw HTML in the
 * source markdown). This is not a general-purpose markdown parser — it exists
 * to transcribe `nurture/emails/*.md` bodies faithfully without hand-writing
 * duplicate HTML/text copies that could drift from the source of truth.
 */

/** Inline formatting shared by both renderers' HTML path: **bold** -> <strong>. */
function boldToStrong(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function splitBlocks(markdown: string): string[] {
  return markdown
    .trim()
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
}

/** Render a markdown email body to simple HTML: <p>, <a> (passed through), <ol>/<ul>/<li>, <strong>. */
export function markdownBodyToHtml(markdown: string): string {
  const blocks = splitBlocks(markdown);
  const html: string[] = [];

  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const isOrdered = lines.every((line) => /^\d+\.\s+/.test(line));
    const isUnordered = !isOrdered && lines.every((line) => /^-\s+/.test(line));

    if (isOrdered) {
      const items = lines
        .map((line) => `<li>${boldToStrong(line.replace(/^\d+\.\s+/, ''))}</li>`)
        .join('');
      html.push(`<ol>${items}</ol>`);
    } else if (isUnordered) {
      const items = lines
        .map((line) => `<li>${boldToStrong(line.replace(/^-\s+/, ''))}</li>`)
        .join('');
      html.push(`<ul>${items}</ul>`);
    } else {
      // Paragraph. Lines already containing raw `<a href="...">` HTML pass through
      // untouched; this is source content we author, not user input, so no escaping.
      html.push(`<p>${boldToStrong(lines.join(' '))}</p>`);
    }
  }

  return html.join('\n');
}

/** Render a markdown email body to plain text (anchors become "text (url)", bold markers stripped). */
export function markdownBodyToText(markdown: string): string {
  return markdown
    .trim()
    .replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '$2 ($1)')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\n{3,}/g, '\n\n');
}
