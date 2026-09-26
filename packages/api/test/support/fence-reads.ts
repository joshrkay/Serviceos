/**
 * #1219 / #1232 / #1065 — request-shape helpers for "does caller text reach
 * this prompt only inside the untrusted-content fence?"
 *
 * Parses the fence by its RENDERED shape (#1240): a BEGIN line ending in a
 * 16-hex fence id and the END line starting with the SAME id. Deliberately
 * independent of the helper's own exports so a regression in the helper
 * cannot make these checks pass by construction.
 */

const BEGIN_LINE_RE = /^=== UNTRUSTED CALLER CONTENT \(BEGIN\) === ([0-9a-f]{16})$/;

/** `prompt` with every well-formed fenced block cut out. */
export function outsideFences(prompt: string): string {
  const lines = prompt.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = BEGIN_LINE_RE.exec(lines[i]);
    if (!m) {
      kept.push(lines[i]);
      continue;
    }
    const end = `${m[1]} === UNTRUSTED CALLER CONTENT (END) ===`;
    const close = lines.indexOf(end, i + 1);
    if (close < 0) {
      kept.push(lines[i]);
      continue;
    }
    i = close;
  }
  return kept.join('\n');
}

/** How many well-formed fenced blocks `prompt` carries. */
export function fenceCount(prompt: string): number {
  const lines = prompt.split('\n');
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = BEGIN_LINE_RE.exec(lines[i]);
    if (!m) continue;
    const close = lines.indexOf(`${m[1]} === UNTRUSTED CALLER CONTENT (END) ===`, i + 1);
    if (close < 0) continue;
    n++;
    i = close;
  }
  return n;
}

/** `needle` is in `prompt`, and only inside a fenced block. */
export function onlyInsideFence(prompt: string, needle: string): boolean {
  return prompt.includes(needle) && !outsideFences(prompt).includes(needle);
}
