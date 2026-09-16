/**
 * Parse a model JSON response while tolerating a single Markdown JSON fence.
 * Anthropic's OpenAI-compatible endpoint may wrap valid JSON even when the
 * request asks for JSON mode; the schema validator remains responsible for
 * rejecting every other malformed shape.
 */
export function parseJsonResponse(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return JSON.parse((fenced?.[1] ?? trimmed).trim());
}
