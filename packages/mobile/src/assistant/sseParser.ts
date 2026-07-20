/**
 * Incremental SSE parser (U13) — transport-agnostic on purpose. The assistant
 * hook feeds it whatever chunks its transport yields (`expo/fetch` streaming
 * today; `react-native-sse` is the named plan-B), and it emits the `data:`
 * payloads of every COMPLETE event, buffering partials across chunk
 * boundaries. Comment lines (`: hb` heartbeats) and other SSE fields are
 * ignored — the voice-sessions endpoint only ever sends `data:` frames.
 */

export interface SseParser {
  /** Feed a decoded chunk; returns the data payloads of completed events. */
  push(chunk: string): string[];
}

export function createSseParser(): SseParser {
  let buffer = '';
  return {
    push(chunk: string): string[] {
      // Normalize CRLF so a proxy that rewrites line endings can't break framing.
      buffer += chunk.replace(/\r\n/g, '\n');
      const out: string[] = [];
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .filter((line) => line.length > 0);
        if (dataLines.length > 0) out.push(dataLines.join('\n'));
      }
      return out;
    },
  };
}

/** Parse an event payload as JSON; malformed payloads become null, never throws. */
export function parseSseJson<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
