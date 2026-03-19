/** Maximum characters of transcript sent to the LLM per extraction call. */
export const MAX_TRANSCRIPT_CHARS = 8000;

/**
 * Safely parse a JSON string from LLM output.
 * Returns null on any parse failure rather than throwing.
 */
export function tryParseJson(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
