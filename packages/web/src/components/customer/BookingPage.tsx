import { useEffect, useMemo, useState } from 'react';
import { Calendar, Check, ChevronRight, ArrowLeft, AlertCircle, Phone, Clock } from 'lucide-react';
import {
  fetchBookingAvailability,
  submitBooking,
  type BookingSlot,
} from '../../api/public-booking';
import { fetchIntakeTenantInfo, type IntakeTenantInfo } from '../../api/public-intake';
import { businessInitial } from '../../utils/business-initial';

/**
 * Public online booking — the prospect-facing self-scheduling page
 * (Jobber "Online Booking" parity). Lands at `/book?t=<tenantId>`.
 *
 * Flow: pick a real open slot → enter contact + service address → submit.
 * The booking is never auto-confirmed; the API creates a held appointment
 * and an owner-approved proposal, so the success copy says "we'll confirm
 * shortly", not "you're booked".
 */

type Step = 'slot' | 'details' | 'done';

interface Details {
  name: string;
  phone: string;
  email: string;
  street1: string;
  city: string;
  state: string;
  postalCode: string;
  summary: string;
}

const EMPTY_DETAILS: Details = {
  name: '',
  phone: '',
  email: '',
  street1: '',
  city: '',
  state: '',
  postalCode: '',
  summary: '',
};

function todayPlus(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function tenantIdFromUrl(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('t') ?? '';
}

/** Group slots by local day for a readable picker. */
function groupByDay(slots: BookingSlot[], timezone: string): { day: string; slots: BookingSlot[] }[] {
  const fmtDay = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: timezone,
  });
  const groups = new Map<string, BookingSlot[]>();
  for (const s of slots) {
    const key = fmtDay.format(new Date(s.start));
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }
  return Array.from(groups.entries()).map(([day, daySlots]) => ({ day, slots: daySlots }));
}

export function BookingPage() {
  const tenantId = useMemo(tenantIdFromUrl, []);
  const [step, setStep] = useState<Step>('slot');
  const [tenantInfo, setTenantInfo] = useState<IntakeTenantInfo | null>(null);
  const [timezone, setTimezone] = useState<string>('UTC');
  const [slots, setSlots] = useState<BookingSlot[] | null>(null);
  const [selected, setSelected] = useState<BookingSlot | null>(null);
  const [details, setDetails] = useState<Details>(EMPTY_DETAILS);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    fetchIntakeTenantInfo(tenantId).then(setTenantInfo).catch(() => {
      /* branding is best-effort */
    });
  }, [tenantId]);

  async function loadSlots() {
    if (!tenantId) {
      setLoadError('This booking link is missing its business id.');
      return;
    }
    setLoadError(null);
    try {
      const res = await fetchBookingAvailability(tenantId, {
        from: todayPlus(0),
        to: todayPlus(14),
        durationMin: 60,
      });
      setTimezone(res.timezone);
      setSlots(res.slots);
    } catch {
      setLoadError('We could not load available times. Please call us to book.');
    }
  }

  useEffect(() => {
    void loadSlots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const fmtTime = useMemo(
    () => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }),
    [timezone],
  );

  const grouped = useMemo(() => (slots ? groupByDay(slots, timezone) : []), [slots, timezone]);

  function update(partial: Partial<Details>) {
    setDetails((prev) => ({ ...prev, ...partial }));
  }

  const canSubmit =
    !!details.name &&
    (!!details.phone || !!details.email) &&
    !!details.street1 &&
    !!details.city &&
    !!details.state &&
    !!details.postalCode &&
    details.summary.trim().length >= 3;

  async function submit() {
    if (!selected) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const [firstName, ...rest] = details.name.trim().split(/\s+/);
      const result = await submitBooking(tenantId, {
        firstName,
        lastName: rest.join(' ') || undefined,
        primaryPhone: details.phone || undefined,
        email: details.email || undefined,
        street1: details.street1,
        city: details.city,
        state: details.state,
        postalCode: details.postalCode,
        summary: details.summary,
        slotStart: selected.start,
        slotEnd: selected.end,
        _company_url: '',
      });
      if ('error' in result) {
        // Slot was claimed between fetch and submit — refresh and bounce back.
        setSlots(result.alternatives);
        setSelected(null);
        setStep('slot');
        setSubmitError('That time was just booked. Please pick another slot below.');
        return;
      }
      setStep('done');
    } catch {
      setSubmitError('Something went wrong. Please try again or call us to book.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Business header */}
      <div className="bg-white border-b border-slate-100 px-5 py-4 flex items-center gap-3">
        <div
          className="flex size-9 items-center justify-center rounded-xl bg-primary shrink-0 text-sm font-medium text-primary-foreground"
          aria-hidden
        >
          {businessInitial(tenantInfo?.businessName)}
        </div>
        <div>
          <p className="text-slate-900">{tenantInfo?.businessName ?? 'Book an appointment'}</p>
          <p className="text-xs text-slate-400 mt-0.5">
            {tenantInfo?.businessHoursSummary ?? 'Pick a time that works for you'}
            {tenantInfo?.businessPhone ? ` · ${tenantInfo.businessPhone}` : ''}
          </p>
        </div>
      </div>

      <div className="flex-1 flex flex-col px-5 py-6 max-w-md mx-auto w-full">
        {/* ── Step: pick a slot ── */}
        {step === 'slot' && (
          <div className="flex flex-col gap-5 flex-1">
            <div>
              <h1 className="text-slate-900" style={{ fontSize: '1.3rem', lineHeight: 1.3 }}>
                Choose a time
              </h1>
              <p className="text-slate-500 mt-1.5">Times shown in {timezone.replace('_', ' ')}</p>
            </div>

            {loadError && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
                <p className="text-xs text-red-700 flex items-center gap-1.5">
                  <AlertCircle size={12} className="shrink-0" /> {loadError}
                </p>
              </div>
            )}
            {submitError && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                <p className="text-xs text-amber-700 flex items-center gap-1.5">
                  <AlertCircle size={12} className="shrink-0" /> {submitError}
                </p>
              </div>
            )}

            {slots === null && !loadError && (
              <p className="text-sm text-slate-400">Loading available times…</p>
            )}
            {slots !== null && slots.length === 0 && (
              <p className="text-sm text-slate-400">
                No online slots are open right now. Please call us to book.
              </p>
            )}

            <div className="flex flex-col gap-4">
              {grouped.map((g) => (
                <div key={g.day}>
                  <p className="text-xs text-slate-500 mb-2 flex items-center gap-1.5">
                    <Calendar size={12} /> {g.day}
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {g.slots.map((s) => {
                      const isSel = selected?.start === s.start;
                      return (
                        <button
                          key={s.start}
                          data-testid={`booking-slot-${s.start}`}
                          onClick={() => setSelected(s)}
                          className={`flex min-h-11 items-center justify-center rounded-xl border-2 px-2 py-2.5 text-sm transition-all ${
                            isSel
                              ? 'border-slate-900 bg-slate-900 text-white'
                              : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                          }`}
                        >
                          {fmtTime.format(new Date(s.start))}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Step: details ── */}
        {step === 'details' && (
          <div className="flex flex-col gap-5 flex-1">
            <button
              onClick={() => setStep('slot')}
              className="flex min-h-11 items-center gap-1 text-xs text-slate-400 hover:text-slate-600 self-start"
            >
              <ArrowLeft size={12} /> Back to times
            </button>
            <div>
              <h1 className="text-slate-900" style={{ fontSize: '1.3rem', lineHeight: 1.3 }}>
                Your details
              </h1>
              {selected && (
                <p className="text-slate-500 mt-1.5 flex items-center gap-1.5">
                  <Clock size={13} /> {fmtTime.format(new Date(selected.start))} ·{' '}
                  {new Intl.DateTimeFormat('en-US', {
                    weekday: 'long',
                    month: 'short',
                    day: 'numeric',
                    timeZone: timezone,
                  }).format(new Date(selected.start))}
                </p>
              )}
            </div>

            {([
              { key: 'name', label: 'Full name *', placeholder: 'Your name', type: 'text' },
              { key: 'phone', label: 'Phone *', placeholder: '(555) 000-0000', type: 'tel' },
              { key: 'email', label: 'Email', placeholder: 'you@email.com', type: 'email' },
              { key: 'street1', label: 'Service address *', placeholder: 'Street address', type: 'text' },
              { key: 'city', label: 'City *', placeholder: 'City', type: 'text' },
              { key: 'state', label: 'State *', placeholder: 'State', type: 'text' },
              { key: 'postalCode', label: 'ZIP *', placeholder: 'ZIP', type: 'text' },
            ] as const).map(({ key, label, placeholder, type }) => (
              <div key={key}>
                <label className="text-xs text-slate-500 mb-1.5 block">{label}</label>
                <input
                  data-testid={`booking-field-${key}`}
                  value={details[key]}
                  onChange={(e) => update({ [key]: e.target.value })}
                  placeholder={placeholder}
                  type={type}
                  className="w-full min-h-11 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 placeholder-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                />
              </div>
            ))}
            <div>
              <label className="text-xs text-slate-500 mb-1.5 block">What do you need? *</label>
              <textarea
                data-testid="booking-field-summary"
                value={details.summary}
                onChange={(e) => update({ summary: e.target.value })}
                placeholder='e.g. "AC not cooling — needs a diagnostic."'
                rows={3}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 placeholder-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all resize-none"
              />
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
                Request received!
              </h1>
              <p className="text-slate-500 mt-2 leading-relaxed">
                Thanks {details.name.split(' ')[0] || 'for reaching out'}. We've reserved your
                requested time and will confirm shortly.
              </p>
            </div>
            {tenantInfo?.businessPhone && (
              <a
                href={`tel:${tenantInfo.businessPhone.replace(/\s/g, '')}`}
                className="flex min-h-11 items-center gap-4 rounded-xl bg-white border border-slate-200 px-4 py-3.5 w-full hover:border-blue-300"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-100">
                  <Phone size={15} className="text-slate-500" />
                </span>
                <div className="text-left">
                  <p className="text-sm text-slate-800">Need to reach us sooner?</p>
                  <p className="text-xs mt-0.5 text-blue-600">{tenantInfo.businessPhone}</p>
                </div>
              </a>
            )}
          </div>
        )}

        {/* CTA */}
        {step !== 'done' && (
          <div className="mt-auto pt-6">
            {step === 'details' && submitError && (
              <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
                <p className="text-xs text-red-700 flex items-center gap-1.5">
                  <AlertCircle size={12} className="shrink-0" /> {submitError}
                </p>
              </div>
            )}
            <button
              data-testid="booking-cta"
              onClick={() => (step === 'slot' ? setStep('details') : void submit())}
              disabled={
                (step === 'slot' && !selected) ||
                (step === 'details' && (!canSubmit || submitting))
              }
              className="w-full flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary py-4 text-sm text-primary-foreground hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <span className="animate-spin size-4 border-2 border-white/30 border-t-white rounded-full" />
              ) : step === 'slot' ? (
                <>
                  Continue <ChevronRight size={15} />
                </>
              ) : (
                <>
                  <Check size={15} /> Request this time
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
