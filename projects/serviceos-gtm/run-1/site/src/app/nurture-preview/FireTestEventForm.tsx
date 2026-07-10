'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TEST_CONTACT_ALLOWLIST } from '@/lib/nurture/allowlist';

type Status = 'idle' | 'sending' | 'sent' | 'error';

/**
 * Fires a `trial_started` lifecycle event for a chosen test contact via
 * POST /api/nurture/fire-test-event, then refreshes this server page so the
 * mailbox section below picks up the newly-sent welcome email.
 */
export function FireTestEventForm() {
  const router = useRouter();
  const [contact, setContact] = useState<string>(TEST_CONTACT_ALLOWLIST[0]);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus('sending');
    setMessage(null);
    try {
      const res = await fetch('/api/nurture/fire-test-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact }),
      });
      const json = (await res.json()) as { ok?: boolean; contact?: string; error?: string };
      if (!res.ok || !json.ok) {
        throw new Error(json.error || 'Request failed');
      }
      setStatus('sent');
      setMessage(`trial_started fired for ${json.contact}. Check the mailbox below for the welcome email.`);
      router.refresh();
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex-1">
        <label className="field-label" htmlFor="fire-test-contact">
          Test contact
        </label>
        <select
          id="fire-test-contact"
          className="field-input"
          value={contact}
          onChange={(event) => setContact(event.target.value)}
        >
          {TEST_CONTACT_ALLOWLIST.map((address) => (
            <option key={address} value={address}>
              {address}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="btn-primary" disabled={status === 'sending'}>
        {status === 'sending' ? 'Firing…' : 'Fire trial_started'}
      </button>
      {message && (
        <p
          className={`text-sm sm:basis-full ${status === 'error' ? 'text-danger' : 'text-fg-muted'}`}
          role="status"
        >
          {message}
        </p>
      )}
    </form>
  );
}
