import { useState } from 'react';
import {
  Zap, ChevronRight, Check, AlertCircle, Phone, Mail,
  MapPin, Camera, ArrowLeft, Clock, Star,
} from 'lucide-react';

type Step = 1 | 2 | 3 | 4 | 'done';
type ServiceType = 'HVAC' | 'Plumbing' | 'Painting';
type Urgency = 'Emergency' | 'ASAP' | 'Flexible';

const SERVICE_OPTIONS: { type: ServiceType; emoji: string; label: string; desc: string }[] = [
  { type: 'HVAC',     emoji: '❄️', label: 'Heating & Cooling', desc: 'AC, furnace, heat pumps, ventilation' },
  { type: 'Plumbing', emoji: '🔧', label: 'Plumbing',          desc: 'Leaks, drains, water heaters, pipes' },
  { type: 'Painting', emoji: '🎨', label: 'Painting',          desc: 'Interior & exterior paint, touch-ups' },
];

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
  serviceType: ServiceType | null;
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

  function update(partial: Partial<FormData>) {
    setData(prev => ({ ...prev, ...partial }));
  }

  function next() {
    if (step === 4) {
      setSubmitting(true);
      setTimeout(() => { setSubmitting(false); setStep('done'); }, 1200);
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

  const svc = data.serviceType ? SERVICE_OPTIONS.find(o => o.type === data.serviceType) : null;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Business header */}
      <div className="bg-white border-b border-slate-100 px-5 py-4 flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-xl bg-slate-900 shrink-0">
          <Zap size={16} className="text-white" />
        </div>
        <div>
          <p className="text-slate-900">Ortega HVAC &amp; Services</p>
          <div className="flex items-center gap-2 mt-0.5">
            <div className="flex items-center gap-0.5">
              {[...Array(5)].map((_, i) => (
                <Star key={i} size={10} className="fill-amber-400 text-amber-400" />
              ))}
            </div>
            <p className="text-xs text-slate-400">4.9 · 124 reviews · Austin, TX</p>
          </div>
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
              {SERVICE_OPTIONS.map(opt => {
                const selected = data.serviceType === opt.type;
                return (
                  <button
                    key={opt.type}
                    onClick={() => update({ serviceType: opt.type })}
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
                value={data.description}
                onChange={e => update({ description: e.target.value })}
                placeholder={
                  data.serviceType === 'HVAC'     ? `e.g. "My AC stopped blowing cold air yesterday. It's making a clicking noise."` :
                  data.serviceType === 'Plumbing' ? `e.g. "Kitchen sink is draining very slowly and there's a bad smell."` :
                  `e.g. "Looking to repaint the living room and hallway. Walls have some scuff marks."`
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
              { icon: null,   label: 'Full name *',         key: 'name',    placeholder: 'Sandra Wu',         type: 'text' },
              { icon: Phone,  label: 'Phone number *',      key: 'phone',   placeholder: '(512) 555-0191',    type: 'tel'  },
              { icon: Mail,   label: 'Email',               key: 'email',   placeholder: 'you@email.com',     type: 'email'},
              { icon: MapPin, label: 'Service address',     key: 'address', placeholder: '4821 Burnet Rd, Austin TX', type: 'text' },
            ].map(({ label, key, placeholder, type }) => (
              <div key={key}>
                <label className="text-xs text-slate-500 mb-1.5 block">{label}</label>
                <input
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

              <div className="rounded-xl bg-blue-50 border border-blue-100 px-4 py-3.5">
                <div className="flex items-start gap-2.5">
                  <Clock size={13} className="text-blue-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-blue-700">
                    We typically respond within <span className="text-blue-900">2 hours</span> during business hours (Mon–Sat, 7 AM – 6 PM).
                  </p>
                </div>
              </div>
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
                { icon: Clock,  label: 'Expect a call or text within 2 hours',       sub: 'Mon–Sat · 7 AM – 6 PM' },
                { icon: Phone,  label: 'Call us directly',                            sub: '(512) 555-0100' },
                { icon: Star,   label: 'We look forward to helping you',              sub: 'Ortega HVAC & Services' },
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

            <div className="flex items-center gap-2 mt-2">
              {[...Array(5)].map((_, i) => (
                <Star key={i} size={16} className="fill-amber-400 text-amber-400" />
              ))}
              <p className="text-xs text-slate-400 ml-1">4.9 on Google · 124 reviews</p>
            </div>
          </div>
        )}

        {/* CTA button */}
        {step !== 'done' && (
          <div className="mt-auto pt-6">
            <button
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