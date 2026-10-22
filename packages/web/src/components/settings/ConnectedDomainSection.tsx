import { useState } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

/** Mirrors the `domain` object on GET /api/tenant-site (D-044 / #1770). */
export interface ConnectedDomain {
  domain: string;
  status: 'pending_dns' | 'pending_certificate' | 'verified' | 'failed';
  verified: boolean;
  record: { type: string; host: string; value: string };
  error: { code: string; message: string | null } | null;
  checkedAt: string | null;
  verifiedAt: string | null;
  url: string;
}

const STATUS_LABEL: Record<ConnectedDomain['status'], string> = {
  pending_dns: 'Waiting for your DNS record',
  pending_certificate: 'Setting up HTTPS',
  verified: 'Verified and secure',
  failed: 'Needs your attention',
};

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message || fallback;
  } catch {
    return fallback;
  }
}

const inputClass =
  'mt-1.5 w-full min-h-11 rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors';
const buttonClass = 'min-h-11 min-w-11 rounded-xl text-sm px-4 py-2 active:scale-[0.98] transition disabled:opacity-50';

/**
 * Settings → Website → "Use a domain you own". The owner types a domain they
 * already have, adds the one CNAME record we show, and sees "Verified and
 * secure" or a plain reason it is not there yet. We never sell or renew domains.
 */
export function ConnectedDomainSection({
  domain,
  published,
  onChanged,
}: {
  domain: ConnectedDomain | null;
  published: boolean;
  onChanged: () => Promise<void>;
}) {
  const [input, setInput] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(path: string, init: RequestInit, failure: string, onDone?: () => void) {
    setBusy(true);
    setProblem('');
    try {
      const res = await apiFetch(path, { ...init, headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) {
        setProblem(await errorMessage(res, failure));
        return;
      }
      onDone?.();
      await onChanged();
    } catch {
      setProblem(failure);
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Copied');
    } catch {
      toast.error('Could not copy. Select the text and copy it instead.');
    }
  }

  return (
    <div className="mt-5 border-t border-slate-100 pt-4" data-testid="website-domain">
      <p className="text-sm text-slate-800">Use a domain you own</p>
      <p className="text-xs text-slate-400 mt-0.5">
        Already have a domain like www.yourbusiness.com? Point it at your site. We never buy, sell or renew domains.
      </p>

      {!domain ? (
        <div className="mt-3">
          <label htmlFor="website-domain-input" className="block text-sm text-slate-700">
            Your domain
            <input
              id="website-domain-input"
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setProblem('');
              }}
              placeholder="www.yourbusiness.com"
              className={inputClass}
            />
          </label>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() =>
                void run(
                  '/api/tenant-site/domain',
                  { method: 'PUT', body: JSON.stringify({ domain: input }) },
                  'Could not connect that domain',
                  () => setInput(''),
                )
              }
              disabled={busy || !input.trim()}
              className={`${buttonClass} bg-slate-900 text-white hover:bg-slate-700`}
            >
              Connect
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3" data-testid="website-domain-state">
          <p className="text-sm text-slate-800 break-all">{domain.domain}</p>
          <p
            className={`mt-1 text-sm ${domain.verified ? 'text-emerald-700' : domain.status === 'failed' ? 'text-red-600' : 'text-slate-600'}`}
            data-testid="website-domain-status"
          >
            {STATUS_LABEL[domain.status]}
          </p>

          {domain.verified ? (
            <p className="mt-1 text-sm text-slate-700 break-words">
              {published ? 'Live at ' : 'Goes live at '}
              <a href={domain.url} target="_blank" rel="noreferrer" className="text-indigo-600 underline">
                {domain.url}
              </a>
              {!published && ' once you publish your site.'}
            </p>
          ) : (
            <div className="mt-3 rounded-xl bg-slate-50 px-3 py-3" data-testid="website-domain-record">
              <p className="text-xs text-slate-500">Add this one record where you manage your domain:</p>
              <dl className="mt-2 text-sm text-slate-800">
                <div className="flex gap-2">
                  <dt className="w-12 shrink-0 text-slate-500">Type</dt>
                  <dd>{domain.record.type}</dd>
                </div>
                <div className="flex gap-2 mt-1">
                  <dt className="w-12 shrink-0 text-slate-500">Name</dt>
                  <dd className="min-w-0 break-all">{domain.record.host}</dd>
                </div>
                <div className="flex gap-2 mt-1">
                  <dt className="w-12 shrink-0 text-slate-500">Value</dt>
                  <dd className="min-w-0 break-all">{domain.record.value}</dd>
                </div>
              </dl>
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => void copy(domain.record.value)}
                  className={`${buttonClass} border border-slate-200 text-slate-800 hover:bg-white`}
                >
                  Copy value
                </button>
              </div>
            </div>
          )}

          {domain.error && (
            <p className="mt-2 text-sm text-red-600" role="alert" data-testid="website-domain-error">
              {domain.error.message ?? 'Something went wrong checking your domain.'}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            {!domain.verified && (
              <button
                type="button"
                onClick={() => void run('/api/tenant-site/domain/check', { method: 'POST', body: '{}' }, 'Could not check your domain')}
                disabled={busy}
                className={`${buttonClass} border border-slate-200 text-slate-800 hover:bg-slate-50`}
              >
                Check again
              </button>
            )}
            <button
              type="button"
              onClick={() => void run('/api/tenant-site/domain', { method: 'DELETE' }, 'Could not remove your domain')}
              disabled={busy}
              className={`${buttonClass} text-red-600 hover:bg-red-50`}
            >
              Remove
            </button>
          </div>
        </div>
      )}

      {problem && (
        <p className="mt-2 text-sm text-red-600" role="alert" data-testid="website-domain-problem">
          {problem}
        </p>
      )}
    </div>
  );
}
