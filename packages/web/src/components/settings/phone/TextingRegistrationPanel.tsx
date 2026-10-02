/**
 * #1564 — Settings → Phone: US A2P 10DLC texting registration.
 *
 * Self-contained (form + status panel) so the Settings → Phone page (#1563)
 * can mount it as-is. The owner enters the business's legal identity once;
 * Rivet registers the Brand and campaign with the carriers (fees are on
 * Rivet) and the status here follows the review. Carrier rejection reasons
 * are shown verbatim so the owner can correct and resubmit.
 */
import { useEffect, useState } from 'react';
import {
  BUSINESS_TYPES,
  JOB_POSITIONS,
  TextingRegistrationError,
  fetchTextingRegistration,
  submitTextingRegistration,
  type TextingRegistrationSubmission,
  type TextingRegistrationView,
} from '../../../api/texting-registration';

const inputClass =
  'mt-1.5 w-full min-h-11 rounded-xl border border-slate-200 px-3 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none';

const EMPTY: TextingRegistrationSubmission = {
  legalBusinessName: '',
  ein: '',
  businessType: BUSINESS_TYPES[0],
  businessIndustry: 'CONSTRUCTION',
  websiteUrl: '',
  address: { street: '', street2: '', city: '', region: '', postalCode: '' },
  contact: { firstName: '', lastName: '', email: '', phone: '', title: '', jobPosition: JOB_POSITIONS[0] },
};

const INDUSTRIES: Array<{ value: string; label: string }> = [
  { value: 'CONSTRUCTION', label: 'Construction & home services' },
  { value: 'PROFESSIONAL_SERVICES', label: 'Professional services' },
  { value: 'ENERGY', label: 'Energy' },
  { value: 'AUTOMOTIVE', label: 'Automotive' },
  { value: 'REAL_ESTATE', label: 'Real estate' },
  { value: 'RETAIL', label: 'Retail' },
];

function prefill(view: TextingRegistrationView): TextingRegistrationSubmission {
  if (!view.details) return EMPTY;
  const d = view.details;
  return {
    legalBusinessName: d.legalBusinessName,
    ein: '', // never returned — the owner re-enters it to resubmit
    businessType: d.businessType,
    businessIndustry: d.businessIndustry,
    websiteUrl: d.websiteUrl ?? '',
    address: { ...d.address, street2: d.address.street2 ?? '' },
    contact: { ...d.contact },
  };
}

const STATUS_COPY: Record<string, { title: string; body: string; tone: 'info' | 'ok' }> = {
  submitted: {
    title: 'Registration submitted',
    body: 'We are sending your business details to the carriers now.',
    tone: 'info',
  },
  brand_pending: {
    title: 'Business under carrier review',
    body: 'The carriers are verifying your business. This usually takes a few business days — nothing for you to do.',
    tone: 'info',
  },
  campaign_pending: {
    title: 'Texting campaign under review',
    body: 'Your business is verified. The carriers are reviewing how you text customers (usually 1–3 weeks).',
    tone: 'info',
  },
  approved: {
    title: 'Texting registered',
    body: 'Your business is registered for US texting. Messages to customers are delivered as registered traffic.',
    tone: 'ok',
  },
};

export function TextingRegistrationPanel() {
  const [view, setView] = useState<TextingRegistrationView | null>(null);
  const [form, setForm] = useState<TextingRegistrationSubmission>(EMPTY);
  const [loadError, setLoadError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Array<{ path: string; message: string }>>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchTextingRegistration()
      .then((v) => {
        if (cancelled) return;
        setView(v);
        setForm(prefill(v));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          err instanceof TextingRegistrationError && err.status === 503
            ? 'Texting registration is not available yet.'
            : 'Could not load your texting registration.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const set = (patch: Partial<TextingRegistrationSubmission>) => setForm((f) => ({ ...f, ...patch }));
  const setAddress = (patch: Partial<TextingRegistrationSubmission['address']>) =>
    setForm((f) => ({ ...f, address: { ...f.address, ...patch } }));
  const setContact = (patch: Partial<TextingRegistrationSubmission['contact']>) =>
    setForm((f) => ({ ...f, contact: { ...f.contact, ...patch } }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSubmitError('');
    setFieldErrors([]);
    try {
      const next = await submitTextingRegistration(form);
      setView(next);
      setForm(prefill(next));
    } catch (err) {
      if (err instanceof TextingRegistrationError) {
        setSubmitError(err.message);
        setFieldErrors(err.fields);
      } else {
        setSubmitError('Could not submit your registration. Try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <section aria-labelledby="texting-registration-title" className="space-y-2">
        <h3 id="texting-registration-title" className="text-base text-slate-900">Texting registration</h3>
        <p className="text-sm text-slate-500">{loadError}</p>
      </section>
    );
  }
  if (!view) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  const showForm = view.status === 'not_started' || view.status === 'failed';
  const copy = STATUS_COPY[view.status];

  return (
    <section aria-labelledby="texting-registration-title" className="space-y-4">
      <div>
        <h3 id="texting-registration-title" className="text-base text-slate-900">Texting registration</h3>
        <p className="mt-1 text-xs text-slate-500">
          US carriers require every business that texts customers to register (A2P 10DLC). Rivet registers
          your business for you — there is no fee to you.
        </p>
      </div>

      {copy && (
        <div
          role="status"
          className={`rounded-xl border px-4 py-3 ${
            copy.tone === 'ok' ? 'border-emerald-200 bg-emerald-50' : 'border-indigo-200 bg-indigo-50'
          }`}
        >
          <p className="text-sm text-slate-900">{copy.title}</p>
          <p className="mt-0.5 text-xs text-slate-600">{copy.body}</p>
          {view.details && (
            <p className="mt-2 text-xs text-slate-500">
              {view.details.legalBusinessName} · EIN ending {view.details.einLast4}
            </p>
          )}
        </div>
      )}

      {view.status === 'failed' && (
        <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
          <p className="text-sm text-rose-900">The carriers did not approve your registration</p>
          <ul className="mt-1 list-disc pl-5 text-xs text-rose-800">
            {view.failureReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-rose-800">Correct the details below and submit again.</p>
        </div>
      )}

      {showForm && (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <fieldset className="space-y-3">
            <legend className="text-sm text-slate-700">Business</legend>
            <div>
              <label htmlFor="tr-legal-name" className="text-sm text-slate-700">Legal business name</label>
              <input id="tr-legal-name" className={inputClass} value={form.legalBusinessName}
                onChange={(e) => set({ legalBusinessName: e.target.value })} autoComplete="organization" />
              <p className="mt-1 text-xs text-slate-500">Exactly as it appears on your IRS EIN letter.</p>
            </div>
            <div>
              <label htmlFor="tr-ein" className="text-sm text-slate-700">EIN (federal tax ID)</label>
              <input id="tr-ein" className={inputClass} value={form.ein} inputMode="numeric" autoComplete="off"
                placeholder="12-3456789" onChange={(e) => set({ ein: e.target.value })} />
            </div>
            <div>
              <label htmlFor="tr-type" className="text-sm text-slate-700">Business type</label>
              <select id="tr-type" className={inputClass} value={form.businessType}
                onChange={(e) => set({ businessType: e.target.value })}>
                {BUSINESS_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="tr-industry" className="text-sm text-slate-700">Industry</label>
              <select id="tr-industry" className={inputClass} value={form.businessIndustry}
                onChange={(e) => set({ businessIndustry: e.target.value })}>
                {INDUSTRIES.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="tr-website" className="text-sm text-slate-700">Website</label>
              <input id="tr-website" className={inputClass} value={form.websiteUrl} type="url"
                placeholder="https://" onChange={(e) => set({ websiteUrl: e.target.value })} />
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm text-slate-700">Business address</legend>
            <div>
              <label htmlFor="tr-street" className="text-sm text-slate-700">Street address</label>
              <input id="tr-street" className={inputClass} value={form.address.street}
                autoComplete="address-line1" onChange={(e) => setAddress({ street: e.target.value })} />
            </div>
            <div>
              <label htmlFor="tr-street2" className="text-sm text-slate-700">Suite / unit (optional)</label>
              <input id="tr-street2" className={inputClass} value={form.address.street2}
                autoComplete="address-line2" onChange={(e) => setAddress({ street2: e.target.value })} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="tr-city" className="text-sm text-slate-700">City</label>
                <input id="tr-city" className={inputClass} value={form.address.city}
                  autoComplete="address-level2" onChange={(e) => setAddress({ city: e.target.value })} />
              </div>
              <div>
                <label htmlFor="tr-state" className="text-sm text-slate-700">State</label>
                <input id="tr-state" className={inputClass} value={form.address.region} maxLength={2}
                  autoComplete="address-level1" onChange={(e) => setAddress({ region: e.target.value })} />
              </div>
              <div>
                <label htmlFor="tr-zip" className="text-sm text-slate-700">ZIP code</label>
                <input id="tr-zip" className={inputClass} value={form.address.postalCode} inputMode="numeric"
                  autoComplete="postal-code" onChange={(e) => setAddress({ postalCode: e.target.value })} />
              </div>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm text-slate-700">Authorized contact</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="tr-first" className="text-sm text-slate-700">First name</label>
                <input id="tr-first" className={inputClass} value={form.contact.firstName}
                  autoComplete="given-name" onChange={(e) => setContact({ firstName: e.target.value })} />
              </div>
              <div>
                <label htmlFor="tr-last" className="text-sm text-slate-700">Last name</label>
                <input id="tr-last" className={inputClass} value={form.contact.lastName}
                  autoComplete="family-name" onChange={(e) => setContact({ lastName: e.target.value })} />
              </div>
            </div>
            <div>
              <label htmlFor="tr-email" className="text-sm text-slate-700">Email</label>
              <input id="tr-email" className={inputClass} value={form.contact.email} type="email"
                autoComplete="email" onChange={(e) => setContact({ email: e.target.value })} />
            </div>
            <div>
              <label htmlFor="tr-phone" className="text-sm text-slate-700">Mobile phone</label>
              <input id="tr-phone" className={inputClass} value={form.contact.phone} type="tel"
                autoComplete="tel" onChange={(e) => setContact({ phone: e.target.value })} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="tr-title" className="text-sm text-slate-700">Your title</label>
                <input id="tr-title" className={inputClass} value={form.contact.title} placeholder="Owner"
                  autoComplete="organization-title" onChange={(e) => setContact({ title: e.target.value })} />
              </div>
              <div>
                <label htmlFor="tr-position" className="text-sm text-slate-700">Position</label>
                <select id="tr-position" className={inputClass} value={form.contact.jobPosition}
                  onChange={(e) => setContact({ jobPosition: e.target.value })}>
                  {JOB_POSITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>
          </fieldset>

          {submitError && (
            <div role="alert" className="text-sm text-rose-700">
              <p>{submitError}</p>
              {fieldErrors.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-xs">
                  {fieldErrors.map((f) => (
                    <li key={f.path}>{f.path}: {f.message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="w-full min-h-11 rounded-xl bg-indigo-600 px-4 text-sm text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {saving ? 'Submitting…' : 'Submit for registration'}
          </button>
        </form>
      )}
    </section>
  );
}
