import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, formatDateTime } from '../lib/api';

const ACTOR_STYLES: Record<string, string> = {
  user: 'bg-blue-100 text-blue-800',
  ai: 'bg-purple-100 text-purple-800',
  system: 'bg-stone-200 text-stone-600',
};

const ENTITY_TYPES = ['', 'proposal', 'invoice', 'customer', 'job', 'appointment', 'payment', 'message', 'tenant'];

export default function AuditPage() {
  const [entityType, setEntityType] = useState('');
  const events = useQuery({
    queryKey: ['events', entityType],
    queryFn: async () => {
      const result = await api.events.list({
        query: { limit: 100, ...(entityType ? { entityType } : {}) },
      });
      if (result.status !== 200) throw new Error('failed');
      return result.body.events;
    },
    refetchInterval: 5_000,
  });

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Audit log</h1>
      <p className="mt-1 text-sm text-stone-500">
        Append-only. Every mutation lands here — human, AI, or system.
      </p>
      <div className="mt-4">
        <select
          value={entityType}
          onChange={(event) => setEntityType(event.target.value)}
          className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
        >
          {ENTITY_TYPES.map((type) => (
            <option key={type} value={type}>
              {type === '' ? 'All entities' : type}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-4 overflow-hidden rounded-xl border border-stone-200 bg-white">
        {(events.data ?? []).map((event) => (
          <div key={event.id} className="flex items-center gap-4 border-b border-stone-100 px-5 py-3 last:border-b-0">
            <span
              className={`w-16 shrink-0 rounded-full px-2 py-0.5 text-center text-xs font-medium ${ACTOR_STYLES[event.actorType] ?? ''}`}
            >
              {event.actorType}
            </span>
            <div className="min-w-0 flex-1">
              <span className="font-mono text-sm">{event.eventType}</span>
              {Object.keys(event.payload).length > 0 && (
                <span className="ml-2 truncate text-xs text-stone-400">
                  {JSON.stringify(event.payload)}
                </span>
              )}
            </div>
            <span className="shrink-0 text-xs text-stone-400">{formatDateTime(event.createdAt)}</span>
          </div>
        ))}
        {!events.isLoading && (events.data ?? []).length === 0 && (
          <div className="px-5 py-8 text-center text-sm text-stone-500">No events yet.</div>
        )}
      </div>
    </div>
  );
}
