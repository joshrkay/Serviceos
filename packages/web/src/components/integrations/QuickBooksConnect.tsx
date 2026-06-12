import { useEffect, useState } from 'react';
import { Link, RefreshCw, AlertCircle } from 'lucide-react';
import {
  connectQuickBooks,
  disconnectQuickBooks,
  fetchIntegrations,
  fetchQuickBooksStatus,
  triggerQuickBooksSync,
  type AccountingIntegrationSummary,
  type QuickBooksStatus,
} from '../../api/integrations';

export function QuickBooksConnect({ onConnected }: { onConnected?: () => void }) {
  const [integration, setIntegration] = useState<AccountingIntegrationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const rows = await fetchIntegrations();
        setIntegration(rows.find((r) => r.provider === 'quickbooks') ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load integration');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleConnect() {
    setConnecting(true);
    setError(null);
    try {
      const url = await connectQuickBooks('/settings');
      window.open(url, '_self');
      onConnected?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connect failed');
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setError(null);
    try {
      await disconnectQuickBooks();
      setIntegration(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disconnect failed');
    }
  }

  if (loading) {
    return <p className="text-sm text-slate-500">Loading QuickBooks status…</p>;
  }

  const connected = integration?.status === 'active';

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="flex items-start gap-2 rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-700">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          {error}
        </div>
      )}
      {connected ? (
        <>
          <p className="text-sm text-green-700">
            Connected · QBO company {integration?.realmId}
          </p>
          <QuickBooksSyncStatus />
          <button
            type="button"
            onClick={() => void handleDisconnect()}
            className="min-h-11 rounded-xl border border-red-200 bg-red-50 text-red-600 py-3 text-sm"
          >
            Disconnect QuickBooks
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void handleConnect()}
          disabled={connecting}
          className="min-h-11 flex items-center justify-center gap-2 rounded-xl bg-[#2CA01C] text-white py-3.5 text-sm disabled:opacity-60"
        >
          <Link size={14} />
          {connecting ? 'Connecting…' : 'Connect QuickBooks'}
        </button>
      )}
    </div>
  );
}

export function QuickBooksSyncStatus() {
  const [status, setStatus] = useState<QuickBooksStatus | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    void fetchQuickBooksStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  async function handleRetry() {
    setSyncing(true);
    try {
      await triggerQuickBooksSync();
      setStatus(await fetchQuickBooksStatus());
    } finally {
      setSyncing(false);
    }
  }

  if (!status) return null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-slate-800">Sync status</p>
          <p className="text-xs text-slate-400 mt-0.5">
            Last sync: {status.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString() : 'Never'}
            {status.errorCount24h > 0 ? ` · ${status.errorCount24h} errors (24h)` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleRetry()}
          disabled={syncing}
          className="min-h-11 min-w-11 flex items-center justify-center rounded-lg border border-slate-200 hover:bg-slate-50"
          aria-label="Retry sync"
        >
          <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
        </button>
      </div>
      {status.recentSync.length > 0 && (
        <ul className="text-xs text-slate-600 flex flex-col gap-1">
          {status.recentSync.slice(0, 3).map((row) => (
            <li key={`${row.entityType}-${row.entityId}-${row.syncedAt}`}>
              {row.entityType} {row.status === 'success' ? 'synced' : 'failed'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
