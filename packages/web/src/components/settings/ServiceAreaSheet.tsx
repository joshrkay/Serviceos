/**
 * Service area editor (#874) — free-text area + radius + the ZIP
 * allowlist that actually gates public bookings
 * (packages/api/src/scheduling/service-area.ts).
 *
 * Pattern: GET /api/settings on open, save via PUT /api/onboarding/identity,
 * Sonner toast on success/failure (matches BusinessProfileSheet).
 *
 * Why the onboarding identity route and not PUT /api/settings: the
 * settings updateSettingsSchema (shared/contracts.ts) does not include
 * serviceAreaText/serviceAreaRadius, and z.object STRIPS unknown keys —
 * a settings-surface PUT of those fields would 200 and write nothing
 * (the schema documents this exact failure mode for businessHours).
 * PUT /api/onboarding/identity accepts all three service-area fields
 * today, so no API change is needed. That route REQUIRES businessName,
 * jobBufferMinutes and hourlyRateCents (businessHours defaults to {}),
 * so we echo those back exactly as loaded; its upsert COALESCEs every
 * field, leaving anything we echo untouched.
 */
import { useEffect, useState } from 'react';
import { X, MapPin } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

export interface ServiceAreaFields {
  serviceAreaText: string;
  serviceAreaRadius: number | null;
  serviceAreaZips: string[];
}

/** The identity fields the PUT requires us to echo back unchanged. */
interface IdentityEcho {
  businessName: string;
  businessHours: Record<string, { open: string; close: string } | null> | null;
  jobBufferMinutes: number;
  hourlyRateCents: number | null;
}

interface ServiceAreaSheetProps {
  onClose: () => void;
  /** Called after a successful save so the Settings row can refresh. */
  onSaved?: (fields: ServiceAreaFields) => void;
}

/** "78701, 78702 78703" → ['78701','78702','78703']; null = invalid input. */
function parseZips(raw: string): string[] | null {
  const tokens = raw
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.some((t) => !/^\d{5}$/.test(t))) return null;
  // De-dupe while preserving order.
  return [...new Set(tokens)];
}

export function ServiceAreaSheet({ onClose, onSaved }: ServiceAreaSheetProps) {
  const [areaText, setAreaText] = useState('');
  const [radius, setRadius] = useState('');
  const [zips, setZips] = useState('');
  const [echo, setEcho] = useState<IdentityEcho | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/settings');
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const data = (await res.json()) as {
          businessName?: string;
          businessHours?: Record<string, { open: string; close: string } | null> | null;
          jobBufferMinutes?: number | null;
          hourlyRateCents?: number | null;
          serviceAreaText?: string | null;
          serviceAreaRadius?: number | null;
          serviceAreaZips?: string[] | null;
        };
        if (cancelled) return;
        setAreaText(data.serviceAreaText ?? '');
        setRadius(
          typeof data.serviceAreaRadius === 'number' ? String(data.serviceAreaRadius) : '',
        );
        setZips((data.serviceAreaZips ?? []).join(', '));
        setEcho({
          businessName: (data.businessName ?? '').trim(),
          businessHours: data.businessHours ?? null,
          jobBufferMinutes:
            typeof data.jobBufferMinutes === 'number' ? data.jobBufferMinutes : 30,
          hourlyRateCents:
            typeof data.hourlyRateCents === 'number' ? data.hourlyRateCents : null,
        });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load settings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The identity route requires a business name and an hourly rate; a
  // tenant that never finished setup has neither, and echoing nulls
  // would 400. Send them to the setup assistant instead of failing.
  const setupIncomplete = !loading && echo !== null && (!echo.businessName || echo.hourlyRateCents === null);

  async function save() {
    setError('');
    if (!echo || setupIncomplete) return;
    const parsedZips = parseZips(zips);
    if (parsedZips === null) {
      setError('ZIP codes must be 5 digits, separated by commas.');
      return;
    }
    const trimmedRadius = radius.trim();
    let radiusNumber: number | null = null;
    if (trimmedRadius !== '') {
      radiusNumber = Number(trimmedRadius);
      if (!Number.isInteger(radiusNumber) || radiusNumber < 1 || radiusNumber > 500) {
        setError('Radius must be a whole number between 1 and 500 miles.');
        return;
      }
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/onboarding/identity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Echoes — the route requires these; the upsert COALESCEs them
          // so sending the loaded values leaves them untouched.
          businessName: echo.businessName,
          jobBufferMinutes: echo.jobBufferMinutes,
          hourlyRateCents: echo.hourlyRateCents,
          // Omit unset hours: the schema defaults to {} which, like the
          // stored NULL, reads as "not configured" downstream — but a
          // stored schedule must be echoed or {} would overwrite it.
          ...(echo.businessHours ? { businessHours: echo.businessHours } : {}),
          // The actual edit. Empty text writes '' (an honest "not set");
          // an empty radius is omitted (the upsert keeps the stored one);
          // [] clears the ZIP allowlist back to unbounded.
          serviceAreaText: areaText.trim(),
          ...(radiusNumber !== null ? { serviceAreaRadius: radiusNumber } : {}),
          serviceAreaZips: parsedZips,
        }),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = typeof body?.message === 'string' ? body.message : '';
        } catch {
          /* non-JSON */
        }
        throw new Error(detail || `Save failed (${res.status})`);
      }
      toast.success('Service area saved');
      onSaved?.({
        serviceAreaText: areaText.trim(),
        serviceAreaRadius: radiusNumber,
        serviceAreaZips: parsedZips,
      });
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not save';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="service-area-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
            <MapPin size={16} className="text-slate-700" />
          </span>
          <h2 id="service-area-title" className="flex-1 text-base text-slate-900">
            Service area
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex size-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : setupIncomplete ? (
            <p className="text-sm text-slate-600" data-testid="service-area-setup-hint">
              Finish the setup assistant first — it captures the business
              basics this editor builds on. You can then set your service
              area here any time.
            </p>
          ) : (
            <>
              <label htmlFor="sa-text" className="block">
                <span className="text-sm text-slate-700">Where you work</span>
                <span className="block text-xs text-slate-500 mt-0.5">
                  Helps the AI quote travel time and decline jobs out of range.
                </span>
                <input
                  id="sa-text"
                  type="text"
                  value={areaText}
                  onChange={(e) => setAreaText(e.target.value)}
                  placeholder="Phoenix, AZ"
                  className="mt-1.5 w-full min-h-11 rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
                />
              </label>

              <label htmlFor="sa-radius" className="block">
                <span className="text-sm text-slate-700">Radius (miles)</span>
                <input
                  id="sa-radius"
                  type="number"
                  min={1}
                  max={500}
                  inputMode="numeric"
                  value={radius}
                  onChange={(e) => setRadius(e.target.value)}
                  placeholder="30"
                  className="mt-1.5 w-full min-h-11 rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
                />
              </label>

              <label htmlFor="sa-zips" className="block">
                <span className="text-sm text-slate-700">ZIP codes you serve</span>
                <span className="block text-xs text-slate-500 mt-0.5">
                  Comma-separated 5-digit ZIPs. Online bookings outside this
                  list are declined; leave empty for no restriction.
                </span>
                <input
                  id="sa-zips"
                  type="text"
                  value={zips}
                  onChange={(e) => setZips(e.target.value)}
                  placeholder="78701, 78702, 78703"
                  className="mt-1.5 w-full min-h-11 rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
                />
              </label>
            </>
          )}

          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded-xl px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || loading || setupIncomplete}
            className="min-h-11 rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
