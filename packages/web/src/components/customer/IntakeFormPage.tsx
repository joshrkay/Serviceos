import { useEffect, useRef, useState } from 'react';
import {
  ChevronRight, Check, AlertCircle, Phone, Mail,
  MapPin, Camera, ArrowLeft, Clock, Star,
} from 'lucide-react';
import { submitIntakeLead, fetchIntakeTenantInfo, type IntakeTenantInfo } from '../../api/public-intake';
import { businessInitial } from '../../utils/business-initial';

/**
 * Marketing-attribution params we capture from the URL on mount and ship
 * with the lead. Tracking blob lives in `attribution` JSONB; the three
 * named UTM cols on the lead are indexed for grouped reporting.
 *
 * The recognized keys list is shared with the API enums.ts whitelist
 * (which is documentation, not validation) so reviewers can grep for
 * "ATTRIBUTION_KEYS" and find both ends of the wire.
 */
const ATTRIBUTION_KEYS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'gclid', 'fbclid', 'msclkid',
] as const;

interface CapturedAttribution {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  attribution: Record<string, string>;
}

function captureAttributionFromUrl(): CapturedAttribution {
  if (typeof window === 'undefined') return { attribution: {} };
  const params = new URLSearchParams(window.location.search);
  const attribution: Record<string, string> = {};
  for (const key of ATTRIBUTION_KEYS) {
    const v = params.get(key);
    if (v) attribution[key] = v.slice(0, 500);
  }
  if (document.referrer) attribution.referrer = document.referrer.slice(0, 500);
  attribution.landing_page = window.location.pathname.slice(0, 500);
  return {
    utmSource: attribution.utm_source,
    utmMedium: attribution.utm_medium,
    utmCampaign: attribution.utm_campaign,
    attribution,
  };
}

type Step = 1 | 2 | 3 | 4 | 'done';
type Urgency = 'Emergency' | 'ASAP' | 'Flexible';

interface ServicePresentation {
  emoji: string;
  desc: string;
  placeholder: string;
}

// Presentation only — emoji + copy keyed by known verticalType values.
// Unknown packs from the API still render using displayName + defaults.
const SERVICE_PRESENTATION: Record<string, ServicePresentation> = {
  hvac: {
    emoji: '❄️',
    desc: 'AC, furnace, heat pumps, ventilation',
    placeholder: `e.g. "My AC stopped blowing cold air yesterday. It's making a clicking noise."`,
  },
  plumbing: {
    emoji: '🔧',
    desc: 'Leaks, drains, water heaters, pipes',
    placeholder: `e.g. "Kitchen sink is draining very slowly and there's a bad smell."`,
  },
  electrical: {
    emoji: '⚡',
    desc: 'Panels, wiring, outlets, and lighting',
    placeholder: 'e.g. "A breaker keeps tripping when we run the dryer."',
  },
};

const DEFAULT_SERVICE_PRESENTATION: ServicePresentation = {
  emoji: '🛠️',
  desc: 'Describe what you need and we will match you with the right technician',
  placeholder: 'e.g. "Briefly describe what you need help with."',
};

const FALLBACK_PLACEHOLDER = DEFAULT_SERVICE_PRESENTATION.placeholder;

function presentationForVertical(
  verticalType: string,
  displayName?: string,
): ServicePresentation {
  const known = SERVICE_PRESENTATION[verticalType];
  if (known) return known;
  return {
    emoji: DEFAULT_SERVICE_PRESENTATION.emoji,
    desc: displayName ?? DEFAULT_SERVICE_PRESENTATION.desc,
    placeholder: DEFAULT_SERVICE_PRESENTATION.placeholder,
  };
}

const URGENCY_OPTIONS: { value: Urgency; label: string; desc: string; color: string }[] = [
  { value: 'Emergency', label: '🚨 Emergency',    desc: 'Need someone today',                   color: 'border-red-300    bg-red-50    text-red-700'    },
  { value: 'ASAP',      label: '⚡ Soon',          desc: 'Within the next few days',             color: 'border-amber-300  bg-amber-50  text-amber-700'  },
  { value: 'Flexible',  label: '📅 Flexible',     desc: 'I can schedule around your availability', color: 'border-green-300 bg-green-50 text-green-700' },
];

const STEPS_LABEL: Record<Exclude<Step, 'done'>, string> = {
  1: 'What do you need?',
  2: 'Tell us more',
  3: 'Your contact info',
  4: 'Review & submit',
};

interface FormData {
  serviceType: string | null;
  description: string;
  urgency: Urgency | null;
  preferredDates: string;
  name: string;
  phone: string;
  email: string;
  address: string;
}

export function IntakeFormPage() {
  const [step, setStep] = useState<Step>(1);
  const [data, setData] = useState<FormData>({
    serviceType: null,
    description: '',
    urgency: null,
    preferredDates: '',
    name: '',
    phone: '',
    email: '',
    address: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [tenantInfo, setTenantInfo] = useState<IntakeTenantInfo | null>(null);

  // Service options = tenant packs from the API + optional local emoji/copy.
  const serviceOptions = (tenantInfo?.serviceTypes ?? []).map((st) => {
    const presentation = presentationForVertical(st.verticalType);
    return {
      verticalType: st.verticalType,
      label: st.displayName,
      ...presentation,
    };
  });

  // Attribution captured once on mount. Storing in a ref so re-renders
  // don't lose or duplicate it.
  const attributionRef = useRef<CapturedAttribution>({ attribution: {} });
  useEffect(() => {
    attributionRef.current = captureAttributionFromUrl();
  }, []);

  // Load the tenant's public branding + service types. Non-fatal on
  // failure — the form still submits; only the header/branding degrades.
  useEffect(() => {
    const tenantId = new URLSearchParams(window.location.search).get('t');
    if (!tenantId) return;
    fetchIntakeTenantInfo(tenantId)
      .then(setTenantInfo)
      .catch(() => {
        /* branding is best-effort; submit path still reports a hard error */
      });
  }, []);

  function update(partial: Partial<FormData>) {
    setData(prev => ({ ...prev, ...partial }));
  }

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Tenant id comes from `?t=<uuid>` on the marketing landing page.
      // Public intake doesn't have a logged-in user to derive it from.
      const tenantId =
        new URLSearchParams(window.location.search).get('t') ?? '';
      if (!tenantId) {
        throw new Error('This intake form is missing its tenant id.');
      }
      const [firstName, ...rest] = data.name.trim().split(/\s+/);
      const lastName = rest.join(' ') || undefined;
      const description = [
        svc ? `Service: ${svc.label}` : null,
        data.urgency ? `Urgency: ${data.urgency}` : null,
        data.description || null,
      ].filter(Boolean).join(' — ');

      await submitIntakeLead(tenantId, {
        firstName,
        lastName,
        primaryPhone: data.phone || undefined,
        email: data.email || undefined,
        serviceType: svc?.label ?? undefined,
        urgency: data.urgency ?? undefined,
        description: description || undefined,
        preferredDates: data.preferredDates || undefined,
        address: data.address || undefined,
        utmSource: attributionRef.current.utmSource,
        utmMedium: attributionRef.current.utmMedium,
        utmCampaign: attributionRef.current.utmCampaign,
        attribution: attributionRef.current.attribution,
        // Honeypot — never set by the form, here so a bot that walks
        // the DOM and fills every input still trips it.
        _company_url: '',
      });
      setStep('done');
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : 'Something went wrong. Please try calling us instead.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  function next() {
    if (step === 4) {
      void submit();
    } else {
      setStep(s => (s as number + 1) as Step);
    }
  }

  function back() {
    setStep(s => (s as number - 1) as Step);
  }

  const canAdvance =
    (step === 1 && !!data.serviceType) ||
    (step === 2 && data.description.length >= 10 && !!data.urgency) ||
    (step === 3 && !!data.name && !!data.phone) ||
    step === 4;

  const svc = data.serviceType
    ? serviceOptions.find((o) => o.verticalType === data.serviceType) ?? null
    : null;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Business header */}
      <div className="bg-white border-b border-slate-100 px-5 py-4 flex items-center gap-3">
        <div
          className="flex size-9 items-center justify-center rounded-xl bg-slate-900 shrink-0 text-sm font-medium text-white"
          aria-hidden
        >
          {businessInitial(tenantInfo?.businessName)}
        </div>
        <div>
          <p className="text-slate-900">{tenantInfo?.businessName ?? 'Service Request'}</p>
          <p className="text-xs text-slate-400 mt-0.5">
            {tenantInfo?.intakeTagline ?? 'Request service online'}
          </p>
        </div>
      </div>

      {step !== 'done' && (
        <>
          {/* Progress bar */}
          <div className="flex gap-1 px-5 pt-4">
            {([1, 2, 3, 4] as const).map(s => (
              <div
                key={s}
                className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${
                  (step as number) >= s ? 'bg-slate-900' : 'bg-slate-200'
                }`}
              />
            ))}
          </div>
          <div className="flex items-center justify-between px-5 pt-2">
            {(step as number) > 1 ? (
              <button onClick={back} className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 transition-colors">
                <ArrowLeft size={12} /> Back
              </button>
            ) : <span />}
            <p className="text-xs text-slate-400">Step {step} of 4</p>
          </div>
        </>
      )}

      <div className="flex-1 flex flex-col px-5 py-6 max-w-md mx-auto w-full">

        {/* ── Step 1: Service type ── */}
        {step === 1 && (
          <div className="flex flex-col gap-5 flex-1">
            <div>
              <h1 className="text-slate-900" style={{ fontSize: '1.3rem', lineHeight: 1.3 }}>
                What can we help you with?
              </h1>
              <p className="text-slate-500 mt-1.5">Select the type of service you need</p>
            </div>
            <div className="flex flex-col gap-3">
              {tenantInfo === null && (
                <p className="text-sm text-slate-400">Loading services…</p>
              )}
              {tenantInfo !== null && serviceOptions.length === 0 && (
                <p className="text-sm text-slate-400">
                  This business hasn't set up online intake yet. Please call to book.
                </p>
              )}
              {serviceOptions.map(opt => {
                const selected = data.serviceType === opt.verticalType;
                return (
                  <button
                    key={opt.verticalType}
                    data-testid={`intake-service-${opt.verticalType}`}
                    onClick={() => update({ serviceType: opt.verticalType })}
                    className={`flex items-center gap-4 rounded-2xl border-2 px-5 py-4 text-left transition-all ${
                      selected
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <span className="text-2xl shrink-0">{opt.emoji}</span>
                    <div className="flex-1">
                      <p className={selected ? 'text-white' : 'text-slate-900'}>{opt.label}</p>
                      <p className={`text-xs mt-0.5 ${selected ? 'text-white/60' : 'text-slate-400'}`}>{opt.desc}</p>
                    </div>
                    <div className={`flex size-5 shrink-0 items-center justify-center rounded-full border-2 ${selected ? 'bg-white border-white' : 'border-slate-300'}`}>
                      {selected && <Check size={11} className="text-slate-900" />}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Step 2: Description + urgency ── */}
        {step === 2 && (
          <div className="flex flex-col gap-5 flex-1">
            <div>
              <div className="flex items-center gap-2 mb-1">
                {svc && <span className="text-xl">{svc.emoji}</span>}
                <h1 className="text-slate-900" style={{ fontSize: '1.3rem', lineHeight: 1.3 }}>
                  Tell us about the issue
                </h1>
              </div>
              <p className="text-slate-500">Help us understand what you need so we can prepare</p>
            </div>

            <div>
              <label className="text-xs text-slate-500 mb-1.5 block">Describe the problem *</label>
              <textarea
                data-testid="intake-description"
                value={data.description}
                onChange={e => update({ description: e.target.value })}
                placeholder={
                  data.serviceType
                    ? presentationForVertical(data.serviceType).placeholder
                    : FALLBACK_PLACEHOLDER
                }
                rows={5}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 placeholder-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all resize-none"
              />
              {data.description.length > 0 && data.description.length < 10 && (
                <p className="text-xs text-amber-600 mt-1.5 flex items-center gap-1">
                  <AlertCircle size={11} /> Add a little more detail to help us help you
                </p>
              )}
            </div>

            <div>
              <label className="text-xs text-slate-500 mb-2 block">How urgent is this? *</label>
              <div className="flex flex-col gap-2">
                {URGENCY_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => update({ urgency: opt.value })}
                    className={`flex items-center gap-4 rounded-xl border-2 px-4 py-3 text-left transition-all ${
                      data.urgency === opt.value ? opt.color + ' border-current' : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div className="flex-1">
                      <p className="text-sm">{opt.label}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{opt.desc}</p>
                    </div>
                    {data.urgency === opt.value && <Check size={14} className="shrink-0" />}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs text-slate-500 mb-1.5 block">Preferred dates or times <span className="text-slate-300">(optional)</span></label>
              <input
                value={data.preferredDates}
                onChange={e => update({ preferredDates: e.target.value })}
                placeholder="e.g. Weekday mornings, or Mar 14–16"
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 placeholder-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
              />
            </div>

            <div className="rounded-xl bg-slate-50 border border-slate-100 px-4 py-3">
              <p className="text-xs text-slate-500 flex items-center gap-1.5">
                <Camera size={12} className="shrink-0" />
                Once we're in touch, you can easily send photos to help us diagnose the issue faster.
              </p>
            </div>
          </div>
        )}

        {/* ── Step 3: Contact info ── */}
        {step === 3 && (
          <div className="flex flex-col gap-5 flex-1">
            <div>
              <h1 className="text-slate-900" style={{ fontSize: '1.3rem', lineHeight: 1.3 }}>
                Your contact info
              </h1>
              <p className="text-slate-500 mt-1.5">So we can confirm your appointment and reach you</p>
            </div>

            {[
              { icon: null,   label: 'Full name *',         key: 'name',    placeholder: 'Your name',              type: 'text' },
              { icon: Phone,  label: 'Phone number *',      key: 'phone',   placeholder: '(555) 000-0000',         type: 'tel'  },
              { icon: Mail,   label: 'Email',               key: 'email',   placeholder: 'you@email.com',          type: 'email'},
              { icon: MapPin, label: 'Service address',     key: 'address', placeholder: 'Street, city, state',    type: 'text' },
            ].map(({ label, key, placeholder, type }) => (
              <div key={key}>
                <label className="text-xs text-slate-500 mb-1.5 block">{label}</label>
                <input
                  data-testid={`intake-field-${key}`}
                  value={data[key as keyof FormData] as string}
                  onChange={e => update({ [key]: e.target.value })}
                  placeholder={placeholder}
                  type={type}
                  required={label.includes('*')}
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 placeholder-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                />
              </div>
            ))}

            <p className="text-xs text-slate-400">
              We'll only use your info to contact you about this service request. No spam.
            </p>
          </div>
        )}

        {/* ── Step 4: Review ── */}
        {step === 4 && (
          <div className="flex flex-col gap-5 flex-1">
            <div>
              <h1 className="text-slate-900" style={{ fontSize: '1.3rem', lineHeight: 1.3 }}>
                Review your request
              </h1>
              <p className="text-slate-500 mt-1.5">Looks good? Submit to send us your request.</p>
            </div>

            <div className="flex flex-col gap-3">
              <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
                <div className="bg-slate-50 border-b border-slate-100 px-4 py-2.5">
                  <p className="text-xs text-slate-500">Service Request</p>
                </div>
                <div className="px-4 py-4 flex flex-col gap-3">
                  <div className="flex items-center gap-3">
                    <span className="text-xl">{svc?.emoji}</span>
                    <div>
                      <p className="text-sm text-slate-900">{svc?.label}</p>
                      <p className="text-xs text-slate-400">{data.urgency}</p>
                    </div>
                  </div>
                  <p className="text-sm text-slate-600 leading-relaxed">{data.description}</p>
                  {data.preferredDates && (
                    <p className="text-xs text-slate-400">
                      <span className="text-slate-600">Preferred: </span>{data.preferredDates}
                    </p>
                  )}
                </div>
              </div>

              <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
                <div className="bg-slate-50 border-b border-slate-100 px-4 py-2.5">
                  <p className="text-xs text-slate-500">Contact</p>
                </div>
                <div className="px-4 py-4 flex flex-col gap-2">
                  <p className="text-sm text-slate-900">{data.name}</p>
                  <p className="text-sm text-slate-600">{data.phone}</p>
                  {data.email   && <p className="text-sm text-slate-600">{data.email}</p>}
                  {data.address && <p className="text-sm text-slate-600">{data.address}</p>}
                </div>
              </div>

              {tenantInfo?.businessHoursSummary && (
                <div className="rounded-xl bg-blue-50 border border-blue-100 px-4 py-3.5">
                  <div className="flex items-start gap-2.5">
                    <Clock size={13} className="text-blue-500 shrink-0 mt-0.5" />
                    <p className="text-xs text-blue-700">
                      We respond during business hours:
                      {' '}
                      <span className="text-blue-900">{tenantInfo.businessHoursSummary}</span>
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Success ── */}
        {step === 'done' && (
          <div className="flex flex-col items-center text-center pt-10 gap-6 flex-1">
            <div className="flex size-20 items-center justify-center rounded-full bg-green-100">
              <Check size={36} className="text-green-600" />
            </div>
            <div>
              <h1 className="text-slate-900" style={{ fontSize: '1.4rem', lineHeight: 1.3 }}>
                Request submitted!
              </h1>
              <p className="text-slate-500 mt-2 leading-relaxed">
                Thanks {data.name.split(' ')[0] || 'for reaching out'}. We've received your {svc?.label?.toLowerCase()} request and will be in touch shortly.
              </p>
            </div>
            <div className="w-full flex flex-col gap-3">
              {[
                ...(tenantInfo?.businessHoursSummary
                  ? [{
                      icon: Clock,
                      label: 'We will reach out during business hours',
                      sub: tenantInfo.businessHoursSummary,
                    }]
                  : []),
                ...(tenantInfo?.businessPhone
                  ? [{ icon: Phone, label: 'Call us directly', sub: tenantInfo.businessPhone }]
                  : []),
                { icon: Star, label: 'We look forward to helping you', sub: tenantInfo?.businessName ?? 'Your service team' },
              ].map(({ icon: Icon, label, sub }) => (
                <div key={label} className="flex items-center gap-4 rounded-xl bg-white border border-slate-200 px-4 py-3.5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-100">
                    <Icon size={15} className="text-slate-500" />
                  </span>
                  <div className="text-left">
                    <p className="text-sm text-slate-800">{label}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{sub}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* CTA button */}
        {step !== 'done' && (
          <div className="mt-auto pt-6">
            {submitError && (
              <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
                <p className="text-xs text-red-700 flex items-center gap-1.5">
                  <AlertCircle size={12} className="shrink-0" />
                  {submitError}
                </p>
              </div>
            )}
            <button
              data-testid="intake-cta"
              onClick={next}
              disabled={!canAdvance || submitting}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-slate-900 py-4 text-sm text-white hover:bg-slate-800 active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <span className="animate-spin size-4 border-2 border-white/30 border-t-white rounded-full" />
              ) : step === 4 ? (
                <>
                  <Check size={15} /> Submit request
                </>
              ) : (
                <>
                  {STEPS_LABEL[(step as number + 1) as Exclude<Step, 'done'>] ?? 'Continue'}
                  <ChevronRight size={15} />
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}