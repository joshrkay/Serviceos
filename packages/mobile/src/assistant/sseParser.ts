/**
 * U13 — pure, transport-agnostic SSE event-block parser for the in-app voice
 * session stream (`GET /api/voice/sessions/:id/events`).
 *
 * This module contains ZERO React Native / Expo / network code so it can be
 * unit-tested headless. It is fed raw text chunks (however the transport
 * happens to read them — `expo/fetch` streaming today, `react-native-sse` if
 * the spike ever fails) and yields the fully-parsed JSON `data:` payloads.
 *
 * Server framing (see packages/api/src/routes/voice-sessions.ts):
 *   - Each event is a block terminated by a blank line (`\n\n`).
 *   - The payload rides on one or more `data:` lines (the server emits one).
 *   - Heartbeats are SSE comments (`: hb\n\n`) with no `data:` line.
 *   - The snapshot frame and every FSM event are `data: <json>` blocks.
 *
 * Robustness contract (exercised in sseParser.test.ts):
 *   - Event boundaries can split across chunk reads — the buffer is retained
 *     between `push()` calls and only complete blocks are emitted.
 *   - Multiple complete events can arrive in a single chunk.
 *   - Comment/heartbeat blocks are silently skipped.
 *   - Malformed JSON is tolerated (that block yields nothing) so one bad frame
 *     never tears down the stream.
 *   - `\r\n` and lone `\r` line endings are normalized to `\n`.
 */

/**
 * Shape of a parsed voice-session SSE message. Mirrors the server's
 * `VoiceSessionEvent` union plus the `snapshot` frame; only the fields the
 * client acts on are typed, and every field is optional because a malformed
 * (but JSON-valid) frame must not crash the consumer.
 */
export interface VoiceSessionMessage {
  type?: string;
  state?: string;
  event?: string;
  reason?: string;
  proposalId?: string;
  [key: string]: unknown;
}

export interface SseParser {
  /**
   * Feed one raw text chunk. Returns the JSON-parsed `data:` payloads for
   * every event block that completed within (or across prior) chunks. A chunk
   * that completes no block returns an empty array; the partial tail is kept.
   */
  push(chunk: string): VoiceSessionMessage[];
}

/** Extract and JSON-parse the `data:` payload from a single event block. */
function parseBlock(block: string): VoiceSessionMessage | null {
  const dataLines: string[] = [];
  for (const rawLine of block.split('\n')) {
    // A leading colon marks an SSE comment (our heartbeats) — ignore it.
    if (rawLine.startsWith(':')) continue;
    if (!rawLine.startsWith('data:')) continue; // ignore event:/id:/retry: fields
    // Per the SSE spec, a single optional space after the colon is stripped.
    let value = rawLine.slice('data:'.length);
    if (value.startsWith(' ')) value = value.slice(1);
    dataLines.push(value);
  }
  if (dataLines.length === 0) return null; // pure heartbeat / comment block
  const data = dataLines.join('\n').trim();
  if (!data) return null;
  try {
    return JSON.parse(data) as VoiceSessionMessage;
  } catch {
    return null; // tolerate a malformed frame — skip it, keep the stream alive
  }
}

/** Create a stateful parser that retains a partial buffer between chunks. */
export function createSseParser(): SseParser {
  let buffer = '';
  return {
    push(chunk: string): VoiceSessionMessage[] {
      // Normalize CRLF / lone CR so `\n\n` boundary detection is uniform.
      buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const messages: VoiceSessionMessage[] = [];
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const msg = parseBlock(block);
        if (msg) messages.push(msg);
      }
      return messages;
    },
  };
}
