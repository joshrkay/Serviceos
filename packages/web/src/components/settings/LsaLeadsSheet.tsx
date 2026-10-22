/**
 * Google Local Services Ads leads (#1738) — owner-only. Link/unlink LSA lead
 * intake, opt in to the instant text reply, and see the most recent LSA leads.
 * Backend: /api/lsa-integration.
 *
 * Linking is a webhook secret shown ONCE (copy it into whatever relays your
 * LSA leads); Google OAuth is a later step.
 */
import { useEffect, useState } from 'react';
import { X, Megaphone } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

interface LsaLeadView {
  leadId: string;
  name: string | null;
  stage: string | null;
  leadType: 'phone_call' | 'message' | 'booking';
  receivedAt: string;
  speedToLead: string | null;
  disposition: string | null;
}

interface LsaIntegrationView {
  enabled: boolean;
  autoRespond: boolean;
  secretHint: string;
  accountId: string | null;
  webhookUrl: string | null;
  recentLeads?: LsaLeadView[];
}

const LEAD_TYPE_LABEL: Record<LsaLeadView['leadType'], string> = {
  phone_call: 'Phone call',
  message: 'Message',
  booking: 'Booking',
};

async function errorDetail(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.message === 'string') return body.message;
  } catch {
    /* non-JSON */
  }
  return fallback;
}

export function LsaLeadsSheet({ onClose }: { onClose: () => void }) {
  const [integration, setIntegration] = useState<LsaIntegrationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Plaintext secret from the last link call — shown once, then dropped. */
  const [newSecret, setNewSecret] = useState<string | null>(null);

  async function load() {
    try {
      const res = await apiFetch('/api/lsa-integration');
      if (!res.ok) throw new Error(await errorDetail(res, `Could not load (${res.status})`));
      const json = (await res.json()) as { data: LsaIntegrationView | null };
      setIntegration(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function call(path: string, init: RequestInit, fallback: string) {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch(path, {
        ...init,
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error(await errorDetail(res, `${fallback} (${res.status})`));
      return res;
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function link() {
    const res = await call('/api/lsa-integration/link', { method: 'POST', body: '{}' }, 'Could not link');
    if (!res) return;
    const json = (await res.json()) as { data: LsaIntegrationView & { webhookSecret: string } };
    setNewSecret(json.data.webhookSecret);
    await load();
  }

  async function setAutoRespond(autoRespond: boolean) {
    const res = await call(
      '/api/lsa-integration',
      { method: 'PUT', body: JSON.stringify({ autoRespond }) },
      'Could not save',
    );
    if (res) await load();
  }

  async function unlink() {
    const res = await call('/api/lsa-integration', { method: 'DELETE' }, 'Could not unlink');
    if (!res) return;
    setNewSecret(null);
    setIntegration(null);
    toast.success('Google Local Services leads unlinked');
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="lsa-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 sticky top-0 bg-white">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
            <Megaphone size={16} className="text-slate-700" />
          </span>
          <h2 id="lsa-title" className="flex-1 text-base text-slate-900">
            Google Local Services leads
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex size-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4 min-w-0">
          <p className="text-xs text-slate-500">
            Leads from your Google Local Services Ads land in your lead list with their source, so
            you can see what the ads bring in. Texting a new lead back is off until you turn it on,
            and it never texts a number that opted out.
          </p>

          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : integration === null ? (
            <div data-testid="lsa-not-linked" className="space-y-3">
              <p className="text-sm text-slate-500 italic">Not linked.</p>
              <button
                type="button"
                onClick={() => void link()}
                disabled={busy}
                data-testid="lsa-link"
                className="min-h-11 w-full rounded-xl bg-slate-900 px-4 text-sm text-white disabled:opacity-60"
              >
                {busy ? 'Linking…' : 'Link Google Local Services'}
              </button>
            </div>
          ) : (
            <>
              <div
                data-testid="lsa-linked"
                className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 min-w-0"
              >
                <p className="text-sm font-medium text-emerald-900">
                  {integration.enabled ? 'Linked' : 'Linked, paused'}
                </p>
                {integration.webhookUrl && (
                  <p className="text-xs text-emerald-800 mt-1 break-all">
                    Send leads to: {integration.webhookUrl}
                  </p>
                )}
                <p className="text-xs text-emerald-800 mt-0.5">
                  Secret ending in {integration.secretHint}
                </p>
              </div>

              {newSecret && (
                <div
                  data-testid="lsa-new-secret"
                  className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 min-w-0"
                >
                  <p className="text-sm text-amber-900">Copy your secret now. It is shown once.</p>
                  <p className="mt-1 break-all font-mono text-xs text-amber-900">{newSecret}</p>
                </div>
              )}

              <label className="flex min-h-11 items-center gap-3 text-sm text-slate-900">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={integration.autoRespond}
                  disabled={busy}
                  onChange={(e) => void setAutoRespond(e.target.checked)}
                  data-testid="lsa-auto-respond"
                />
                <span>Text new leads back right away</span>
              </label>

              <div data-testid="lsa-recent">
                <p className="text-sm text-slate-900 mb-2">Recent leads</p>
                {(integration.recentLeads ?? []).length === 0 ? (
                  <p className="text-sm text-slate-500">No leads yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {integration.recentLeads!.map((l) => (
                      <li
                        key={l.leadId}
                        data-testid="lsa-recent-lead"
                        className="rounded-xl border border-slate-200 px-3 py-2 min-w-0"
                      >
                        <p className="text-sm text-slate-900 break-words">{l.name ?? 'Unnamed lead'}</p>
                        <p className="text-xs text-slate-500">
                          {LEAD_TYPE_LABEL[l.leadType]} · {new Date(l.receivedAt).toLocaleString()}
                          {l.stage ? ` · ${l.stage}` : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void link()}
                  disabled={busy}
                  data-testid="lsa-rotate"
                  className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm text-slate-700 disabled:opacity-60"
                >
                  Make a new secret
                </button>
                <button
                  type="button"
                  onClick={() => void unlink()}
                  disabled={busy}
                  data-testid="lsa-unlink"
                  className="min-h-11 rounded-xl border border-red-200 px-4 text-sm text-red-700 disabled:opacity-60"
                >
                  Unlink
                </button>
              </div>
            </>
          )}

          {error && (
            <p data-testid="lsa-error" className="text-sm text-red-600">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
