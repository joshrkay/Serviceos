/**
 * MKT (Jobber parity) — customer email campaign manager.
 *
 * List campaigns with their send results, compose a new one (optionally
 * targeting a customer tag), and send. Talks to /api/marketing/campaigns. API
 * fns are injectable for jsdom.
 */
import { useCallback, useEffect, useState } from 'react';
import { X, Megaphone, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Input, Textarea } from '../ui';
import {
  type Campaign,
  createCampaign as createApi,
  listCampaigns as listApi,
  sendCampaign as sendApi,
} from '../../api/marketing';

export interface MarketingCampaignsSheetApi {
  list: typeof listApi;
  create: typeof createApi;
  send: typeof sendApi;
}

const DEFAULT_API: MarketingCampaignsSheetApi = { list: listApi, create: createApi, send: sendApi };

export function MarketingCampaignsSheet({
  onClose,
  api = DEFAULT_API,
}: {
  onClose: () => void;
  api?: MarketingCampaignsSheetApi;
}) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [segmentTag, setSegmentTag] = useState('');
  const [saving, setSaving] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setCampaigns(await api.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load campaigns');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setError('');
    if (!name.trim() || !subject.trim() || !body.trim()) {
      setError('Name, subject, and message are required.');
      return;
    }
    setSaving(true);
    try {
      await api.create({
        name: name.trim(),
        subject: subject.trim(),
        bodyText: body,
        segmentTag: segmentTag.trim() || null,
      });
      setName('');
      setSubject('');
      setBody('');
      setSegmentTag('');
      await load();
      toast.success('Campaign created');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not create campaign';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const send = async (c: Campaign) => {
    setSendingId(c.id);
    try {
      const sent = await api.send(c.id);
      await load();
      toast.success(`Sent to ${sent.sentCount} customer${sent.sentCount === 1 ? '' : 's'}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send campaign');
    } finally {
      setSendingId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="marketing-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-lg rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 sticky top-0 bg-white">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
            <Megaphone size={16} className="text-slate-700" />
          </span>
          <h2 id="marketing-title" className="flex-1 text-base text-slate-900">
            Email campaigns
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex flex-col gap-3">
            {campaigns.length === 0 && (
              <p className="text-sm text-slate-400 italic">No campaigns yet.</p>
            )}
            {campaigns.map((c) => (
              <div key={c.id} className="rounded-lg border border-border px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm text-slate-900 truncate">{c.name}</p>
                    <p className="text-xs text-slate-500 truncate">{c.subject}</p>
                  </div>
                  {c.status === 'sent' ? (
                    <span className="text-xs text-slate-500 shrink-0">
                      Sent to {c.sentCount}
                      {c.failedCount > 0 ? ` (${c.failedCount} failed)` : ''}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => send(c)}
                      disabled={sendingId === c.id}
                      className="flex items-center gap-1 min-h-11 px-3 rounded-lg bg-primary text-primary-foreground text-xs disabled:opacity-50 shrink-0"
                    >
                      <Send size={12} /> {sendingId === c.id ? 'Sending…' : 'Send'}
                    </button>
                  )}
                </div>
                {c.segmentTag && (
                  <p className="text-xs text-slate-400 mt-1">Segment: {c.segmentTag}</p>
                )}
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-border p-3 flex flex-col gap-2">
            <span className="text-xs font-medium text-slate-600">New campaign</span>
            <Input
              aria-label="Campaign name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="min-h-11"
              placeholder="Internal name (e.g. Spring tune-up promo)"
            />
            <Input
              aria-label="Email subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="min-h-11"
              placeholder="Email subject"
            />
            <Textarea
              aria-label="Message"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Your message…"
            />
            <Input
              aria-label="Segment tag"
              value={segmentTag}
              onChange={(e) => setSegmentTag(e.target.value)}
              className="min-h-11"
              placeholder="Customer tag to target (blank = all customers)"
            />
            <button
              type="button"
              onClick={create}
              disabled={saving}
              className="min-h-11 px-4 self-start rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Create campaign'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
