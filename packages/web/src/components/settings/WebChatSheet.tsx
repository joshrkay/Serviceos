import { useEffect, useState, FormEvent } from 'react';
import { MessageCircle, AlertCircle, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

/**
 * Web chat widget — Settings sheet (#1737).
 *
 * The owner turns the embeddable chat on, lists the websites allowed to show
 * it, sets the daily turn/cost caps, copies the one-line snippet, and can pause
 * everything at once. Off by default. Anything the chat AI drafts still waits
 * for the owner's approval, like a phone call.
 */

interface WebChatSettings {
  enabled: boolean;
  killed: boolean;
  allowedOrigins: string[];
  dailyTurnCap: number;
  dailyCostCapCents: number;
  snippet: string | null;
  available: boolean;
  usageToday: { turns: number; costCents: number };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** "5", "5.5", "$5.50" -> integer cents; null when it is not a money amount. */
export function dollarsToCents(input: string): number | null {
  const match = /^\$?\s*(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

function centsToDollars(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  return body.message ?? `${fallback} (HTTP ${res.status})`;
}

export function WebChatSheet({ open, onOpenChange }: Props) {
  const [settings, setSettings] = useState<WebChatSettings | null>(null);
  const [sites, setSites] = useState('');
  const [turnCap, setTurnCap] = useState('');
  const [costCap, setCostCap] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);

  function adopt(next: WebChatSettings) {
    setSettings(next);
    setSites(next.allowedOrigins.join('\n'));
    setTurnCap(String(next.dailyTurnCap));
    setCostCap(centsToDollars(next.dailyCostCapCents));
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch('/api/webchat')
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res, 'Failed to load web chat settings'));
        return ((await res.json()) as { data: WebChatSettings }).data;
      })
      .then((data) => {
        if (!cancelled) adopt(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function send(path: string, init: RequestInit, success: string) {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(path, init);
      if (!res.ok) throw new Error(await readError(res, 'Save failed'));
      adopt(((await res.json()) as { data: WebChatSettings }).data);
      toast.success(success);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  function put(patch: Record<string, unknown>, success: string): void {
    void send('/api/webchat', { method: 'PUT', body: JSON.stringify(patch) }, success);
  }

  function handleSave(event: FormEvent): void {
    event.preventDefault();
    const cents = dollarsToCents(costCap);
    const turns = Number(turnCap);
    if (cents === null || cents < 1) return setError('Enter the daily spend limit as dollars, like 5.00');
    if (!Number.isInteger(turns) || turns < 1) return setError('Enter the daily message limit as a whole number');
    const allowedOrigins = sites.split('\n').map((s) => s.trim()).filter(Boolean);
    put({ allowedOrigins, dailyTurnCap: turns, dailyCostCapCents: cents }, 'Web chat settings saved');
  }

  function copySnippet(): void {
    if (!settings?.snippet) return;
    navigator.clipboard.writeText(settings.snippet).then(
      () => toast.success('Snippet copied'),
      () => toast.error('Could not copy — select the snippet and copy it by hand'),
    );
  }

  if (!open) return null;

  const live = settings?.enabled === true && !settings.killed;

  return (
    <div
      role="dialog"
      aria-label="Web chat"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 backdrop-blur-sm md:items-center"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-2xl bg-white rounded-t-2xl md:rounded-2xl shadow-xl border border-slate-200 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-5 border-b border-slate-100 flex items-start gap-3 sm:px-6">
          <div className="size-10 rounded-xl bg-sky-50 flex items-center justify-center shrink-0">
            <MessageCircle size={18} className="text-sky-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-slate-900">Web chat</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              Put the same AI that answers your phone on your website. Anything it drafts waits for your approval.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="min-h-11 min-w-11 text-slate-400 hover:text-slate-600 text-sm"
          >
            Close
          </button>
        </div>

        {error && (
          <div className="px-4 py-3 bg-red-50 border-b border-red-100 flex items-center gap-2 text-sm text-red-700 sm:px-6" role="alert">
            <AlertCircle size={14} className="shrink-0" /> {error}
          </div>
        )}
        {loading && <p className="px-4 py-4 text-sm text-slate-500 sm:px-6">Loading…</p>}

        {settings && (
          <div className="px-4 py-4 space-y-5 sm:px-6">
            {!settings.available && (
              <p className="text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2" data-testid="webchat-unavailable">
                Web chat is not switched on for your account yet. Ask us to enable it.
              </p>
            )}

            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">Show chat on my website</p>
                <p className="text-xs text-slate-500" data-testid="webchat-status">
                  {settings.killed ? 'Paused' : live ? 'On' : 'Off'} · today {settings.usageToday.turns} messages, $
                  {centsToDollars(settings.usageToday.costCents)}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.enabled}
                aria-label="Show chat on my website"
                disabled={saving || !settings.available}
                onClick={() => put({ enabled: !settings.enabled }, settings.enabled ? 'Web chat turned off' : 'Web chat turned on')}
                className={`min-h-11 min-w-11 w-16 rounded-full px-1 transition-colors disabled:opacity-50 ${
                  settings.enabled ? 'bg-slate-900' : 'bg-slate-300'
                }`}
                data-testid="webchat-toggle"
              >
                <span
                  className={`block size-6 rounded-full bg-white transition-transform ${
                    settings.enabled ? 'translate-x-8' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-3">
              <label className="block">
                <span className="text-sm font-medium text-slate-900">Websites allowed to show the chat</span>
                <span className="block text-xs text-slate-500">One per line, like https://www.yourbusiness.com</span>
                <textarea
                  value={sites}
                  onChange={(e) => setSites(e.target.value)}
                  rows={3}
                  className="mt-1 block w-full min-h-11 rounded-lg border border-slate-200 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                  data-testid="webchat-sites"
                />
              </label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-sm font-medium text-slate-900">Messages per day</span>
                  <input
                    inputMode="numeric"
                    value={turnCap}
                    onChange={(e) => setTurnCap(e.target.value)}
                    className="mt-1 block w-full min-h-11 rounded-lg border border-slate-200 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                    data-testid="webchat-turn-cap"
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium text-slate-900">Daily spend limit ($)</span>
                  <input
                    inputMode="decimal"
                    value={costCap}
                    onChange={(e) => setCostCap(e.target.value)}
                    className="mt-1 block w-full min-h-11 rounded-lg border border-slate-200 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                    data-testid="webchat-cost-cap"
                  />
                </label>
              </div>
              <button
                type="submit"
                disabled={saving}
                className="min-h-11 min-w-11 w-full rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-50 sm:w-auto"
                data-testid="webchat-save"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </form>

            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-900">Your snippet</p>
              {settings.snippet ? (
                <>
                  <p className="text-xs text-slate-500">Paste this just before the closing body tag of your website.</p>
                  <textarea
                    readOnly
                    value={settings.snippet}
                    rows={3}
                    className="block w-full min-h-11 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs"
                    data-testid="webchat-snippet"
                  />
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      onClick={copySnippet}
                      className="min-h-11 min-w-11 inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-800"
                      data-testid="webchat-copy"
                    >
                      <Copy size={14} /> Copy snippet
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        if (!confirmRotate) return setConfirmRotate(true);
                        setConfirmRotate(false);
                        void send('/api/webchat/rotate-token', { method: 'POST' }, 'New snippet created — update your website');
                      }}
                      className="min-h-11 min-w-11 rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-800 disabled:opacity-50"
                      data-testid="webchat-rotate"
                    >
                      {confirmRotate ? 'Tap again: the old snippet will stop working' : 'Get a new snippet'}
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-xs text-slate-500" data-testid="webchat-no-snippet">
                  Add your website above and save to get your snippet.
                </p>
              )}
            </div>

            <div className="border-t border-slate-100 pt-4">
              <button
                type="button"
                disabled={saving}
                onClick={() => put({ killed: !settings.killed }, settings.killed ? 'Web chat resumed' : 'Web chat paused')}
                className="min-h-11 min-w-11 w-full rounded-lg border border-red-200 px-4 py-2 text-sm text-red-700 disabled:opacity-50 sm:w-auto"
                data-testid="webchat-kill"
              >
                {settings.killed ? 'Resume web chat' : 'Pause web chat now'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
