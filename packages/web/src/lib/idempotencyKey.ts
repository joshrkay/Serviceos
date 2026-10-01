/**
 * #1489 — `Idempotency-Key` for create forms.
 *
 * One key per form submission: every retry of the same submission (the
 * request failed or its response was lost, and the user presses Create
 * again) reuses the key, so the API replays the first result instead of
 * creating a duplicate. Once the create succeeds, or the user changes what
 * they are submitting, the next submission gets a fresh key.
 */
import { useRef } from 'react';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

export interface SubmissionKeyer {
  /** The key for submitting `body`; stable while `body` is unchanged. */
  keyFor(body: unknown): string;
  /** The submission succeeded: the next one starts a new key. */
  settle(): void;
}

function randomKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createSubmissionKeyer(generate: () => string = randomKey): SubmissionKeyer {
  let pending: { body: string; key: string } | null = null;
  return {
    keyFor(body: unknown): string {
      const serialized = JSON.stringify(body) ?? '';
      if (!pending || pending.body !== serialized) {
        pending = { body: serialized, key: generate() };
      }
      return pending.key;
    },
    settle(): void {
      pending = null;
    },
  };
}

/** A {@link SubmissionKeyer} that lives as long as the component. */
export function useIdempotencyKey(): SubmissionKeyer {
  const ref = useRef<SubmissionKeyer | null>(null);
  if (!ref.current) ref.current = createSubmissionKeyer();
  return ref.current;
}
