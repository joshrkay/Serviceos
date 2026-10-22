import { useCallback, useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

/** Mirrors GET /api/tenant-site (D-044 / #1768). */
interface TenantSiteInfo {
  enabled: boolean;
  baseDomain: string | null;
  site: { slug: string; published: boolean; publishedAt: string | null; url: string } | null;
  suggestedSlug: string;
  websiteUrl: string | null;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Settings → Website. The owner either types the site they already have, or
 * makes one: pick an address, preview it, publish it, and unpublish it later.
 * Owner-only (the API enforces it too); mounted for owners only.
 */
export function WebsiteCard() {
  const [info, setInfo] = useState<TenantSiteInfo | null>(null);
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [slug, setSlug] = useState('');
  const [slugProblem, setSlugProblem] = useState('');
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/tenant-site');
      if (!res?.ok) return;
      const data = ((await res.json()) as { data: TenantSiteInfo }).data;
      setInfo(data);
      setWebsiteUrl(data.websiteUrl ?? '');
      setSlug((current) => current || data.site?.slug || data.suggestedSlug);
    } catch {
      // A settings widget never breaks the page.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!info) return null;
  const published = info.site?.published ?? false;

  async function call(path: string, init: RequestInit, failure: string): Promise<boolean> {
    setBusy(true);
    try {
      const res = await apiFetch(path, {
        ...init,
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const message = await errorMessage(res, failure);
        if (path.endsWith('/address')) setSlugProblem(message);
        else toast.error(message);
        return false;
      }
      return true;
    } catch {
      toast.error(failure);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveWebsiteUrl() {
    const ok = await call(
      '/api/settings',
      { method: 'PUT', body: JSON.stringify({ websiteUrl: websiteUrl.trim() || null }) },
      'Could not save your website. It must start with https://',
    );
    if (ok) {
      toast.success('Website saved');
      await load();
    }
  }

  async function saveAddress() {
    setSlugProblem('');
    const ok = await call(
      '/api/tenant-site/address',
      { method: 'PUT', body: JSON.stringify({ slug }) },
      'Could not save the address',
    );
    if (ok) {
      toast.success('Address saved');
      await load();
    }
  }

  async function preview() {
    setBusy(true);
    try {
      const res = await apiFetch('/api/tenant-site/preview');
      if (!res.ok) {
        toast.error(await errorMessage(res, 'Could not build the preview'));
        return;
      }
      setPreviewHtml(((await res.json()) as { data: { html: string } }).data.html);
    } catch {
      toast.error('Could not build the preview');
    } finally {
      setBusy(false);
    }
  }

  async function setLive(action: 'publish' | 'unpublish') {
    const ok = await call(
      `/api/tenant-site/${action}`,
      { method: 'POST', body: '{}' },
      action === 'publish' ? 'Could not publish your site' : 'Could not unpublish your site',
    );
    if (ok) {
      toast.success(action === 'publish' ? 'Your site is live' : 'Your site is unpublished');
      await load();
    }
  }

  const inputClass =
    'mt-1.5 w-full min-h-11 rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors';
  const buttonClass =
    'min-h-11 min-w-11 rounded-xl text-sm px-4 py-2 active:scale-[0.98] transition disabled:opacity-50';

  return (
    <div className="mb-4" data-testid="website-card" id="website-card">
      <p className="text-xs text-slate-400 mb-2 px-1">WEBSITE</p>
      <div className="rounded-xl bg-white border border-slate-200 px-4 py-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="flex size-7 items-center justify-center rounded-lg bg-sky-100">
            <Globe size={14} className="text-sky-600" />
          </span>
          <div className="min-w-0">
            <p className="text-sm text-slate-800">Your website</p>
            <p className="text-xs text-slate-400 mt-0.5">So customers who search for you can find you</p>
          </div>
        </div>

        <label htmlFor="website-url" className="block">
          <span className="text-sm text-slate-700">I have a website</span>
          <input
            id="website-url"
            type="url"
            value={websiteUrl}
            onChange={(e) => setWebsiteUrl(e.target.value)}
            placeholder="https://www.yourbusiness.com"
            className={inputClass}
          />
        </label>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => void saveWebsiteUrl()}
            disabled={busy}
            className={`${buttonClass} bg-slate-900 text-white hover:bg-slate-700`}
          >
            Save
          </button>
        </div>

        {info.enabled && (
          <div className="mt-5 border-t border-slate-100 pt-4" data-testid="website-make-one">
            <p className="text-sm text-slate-800">Don&apos;t have one? We&apos;ll make you one</p>
            <p className="text-xs text-slate-400 mt-0.5">
              A simple page with your services, hours, phone and booking form, kept up to date from your settings.
            </p>

            <label htmlFor="website-address" className="block mt-3">
              <span className="text-sm text-slate-700">Site address</span>
              <div className="flex items-center gap-1 min-w-0">
                <input
                  id="website-address"
                  type="text"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  value={slug}
                  disabled={published}
                  onChange={(e) => {
                    setSlug(e.target.value.toLowerCase());
                    setSlugProblem('');
                  }}
                  className={`${inputClass} min-w-0 flex-1`}
                />
              </div>
              <span className="block text-xs text-slate-400 mt-1 break-words">
                .{info.baseDomain}
                {published && ' (unpublish to change it)'}
              </span>
            </label>
            {slugProblem && (
              <p className="mt-1 text-sm text-red-600" role="alert">
                {slugProblem}
              </p>
            )}

            {published && info.site && (
              <p className="mt-3 text-sm text-slate-700 break-words">
                Live at{' '}
                <a href={info.site.url} target="_blank" rel="noreferrer" className="text-indigo-600 underline">
                  {info.site.url}
                </a>
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              {!published && (
                <button
                  type="button"
                  onClick={() => void saveAddress()}
                  disabled={busy || !slug.trim()}
                  className={`${buttonClass} border border-slate-200 text-slate-800 hover:bg-slate-50`}
                >
                  Save address
                </button>
              )}
              <button
                type="button"
                onClick={() => void preview()}
                disabled={busy}
                className={`${buttonClass} border border-slate-200 text-slate-800 hover:bg-slate-50`}
              >
                Preview
              </button>
              {published ? (
                <button
                  type="button"
                  onClick={() => void setLive('unpublish')}
                  disabled={busy}
                  className={`${buttonClass} bg-red-600 text-white hover:bg-red-700`}
                >
                  Unpublish
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void setLive('publish')}
                  disabled={busy || !info.site}
                  className={`${buttonClass} bg-slate-900 text-white hover:bg-slate-700`}
                >
                  Publish
                </button>
              )}
            </div>

            {previewHtml !== null && (
              <div className="mt-4">
                <iframe
                  title="Site preview"
                  data-testid="website-preview"
                  sandbox=""
                  srcDoc={previewHtml}
                  className="h-[480px] w-full rounded-lg border border-slate-200"
                />
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setPreviewHtml(null)}
                    className={`${buttonClass} text-slate-600 hover:bg-slate-50`}
                  >
                    Close preview
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
