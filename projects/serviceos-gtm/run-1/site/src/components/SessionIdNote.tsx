'use client';

import { useSearchParams } from 'next/navigation';

/** Small client readout of the Stripe session id, kept out of the static shell. */
export function SessionIdNote() {
  const sessionId = useSearchParams().get('session_id');
  if (!sessionId) return null;
  return (
    <p className="mt-2 text-xs text-fg-muted">
      Reference: <code className="rounded bg-surface-muted px-1.5 py-0.5">{sessionId}</code>
    </p>
  );
}
