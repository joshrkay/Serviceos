import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Zap, ArrowLeft, Check } from 'lucide-react';

type Step = 1 | 2 | 3;
type ServiceType = 'HVAC' | 'Plumbing' | 'Painting';

const SERVICE_OPTIONS: { type: ServiceType; emoji: string; label: string; desc: string }[] = [
  { type: 'HVAC',     emoji: '❄️', label: 'HVAC',     desc: 'Heating, cooling & ventilation' },
  { type: 'Plumbing', emoji: '🔧', label: 'Plumbing',  desc: 'Pipes, drains & fixtures' },
  { type: 'Painting', emoji: '🎨', label: 'Painting',  desc: 'Interior & exterior paint' },
];

export function SignupPage() {
  const navigate = useNavigate();
  const [step, setStep]               = useState<Step>(1);
  const [name, setName]               = useState('');
  const [bizName, setBizName]         = useState('');
  const [phone, setPhone]             = useState('');
  const [services, setServices]       = useState<ServiceType[]>([]);
  const [loading, setLoading]         = useState(false);

  function toggleService(type: ServiceType) {
    setServices(prev =>
      prev.includes(type) ? prev.filter(s => s !== type) : [...prev, type]
    );
  }

  function handleStep1(e: React.FormEvent) {
    e.preventDefault();
    if (!name || !bizName) return;
    setStep(2);
  }

  function handleStep2(e: React.FormEvent) {
    e.preventDefault();
    if (services.length === 0) return;
    setLoading(true);
    setStep(3);
    setTimeout(() => { navigate('/onboarding'); }, 2200);
  }

  const stepLabel = step === 1 ? 'Your info' : step === 2 ? 'Your services' : 'Setting up…';

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 pt-6">
        <button
          onClick={() => step === 1 ? navigate('/login') : setStep(s => (s - 1) as Step)}
          className="flex size-9 items-center justify-center rounded-full hover:bg-slate-200 transition-colors"
        >
          <ArrowLeft size={16} className="text-slate-500" />
        </button>
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-xl bg-slate-900">
            <Zap size={15} className="text-white" />
          </span>
          <span className="text-slate-900 tracking-tight">Fieldly</span>
        </div>
      </div>

      {/* Step indicators */}
      <div className="flex items-center gap-2 px-6 pt-5">
        {([1, 2, 3] as Step[]).map(s => (
          <div
            key={s}
            className={`h-1 rounded-full flex-1 transition-all duration-300 ${
              s <= step ? 'bg-slate-900' : 'bg-slate-200'
            }`}
          />
        ))}
      </div>
      <p className="text-xs text-slate-400 px-6 mt-2">{stepLabel}</p>

      <div className="flex-1 flex items-start justify-center px-5 pt-8 pb-12">
        <div className="w-full max-w-sm">

          {/* ── Step 1: Business info ── */}
          {step === 1 && (
            <>
              <div className="mb-8">
                <h1 className="text-slate-900" style={{ fontSize: '1.4rem', lineHeight: 1.25 }}>
                  Create your account
                </h1>
                <p className="text-slate-500 mt-1.5">Set up Fieldly for your service business</p>
              </div>

              <form onSubmit={handleStep1} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-slate-500">Your name</label>
                  <input
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="Mike Ortega"
                    required
                    className="rounded-xl border border-slate-200 bg-white px-4 py-3.5 text-sm text-slate-800 placeholder-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-slate-500">Business name</label>
                  <input
                    value={bizName}
                    onChange={e => setBizName(e.target.value)}
                    placeholder="Ortega HVAC & Services"
                    required
                    className="rounded-xl border border-slate-200 bg-white px-4 py-3.5 text-sm text-slate-800 placeholder-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-slate-500">Phone number <span className="text-slate-300">(optional)</span></label>
                  <input
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                    placeholder="(512) 555-0100"
                    type="tel"
                    className="rounded-xl border border-slate-200 bg-white px-4 py-3.5 text-sm text-slate-800 placeholder-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                  />
                </div>
                <button
                  type="submit"
                  className="flex items-center justify-center rounded-xl bg-slate-900 px-5 py-4 text-sm text-white hover:bg-slate-800 active:scale-[0.98] transition-all mt-2"
                >
                  Continue
                </button>
              </form>

              <p className="text-center text-sm text-slate-400 mt-6">
                Already have an account?{' '}
                <button onClick={() => navigate('/login')} className="text-blue-600 hover:text-blue-700 transition-colors">
                  Sign in
                </button>
              </p>
            </>
          )}

          {/* ── Step 2: Service types ── */}
          {step === 2 && (
            <>
              <div className="mb-8">
                <h1 className="text-slate-900" style={{ fontSize: '1.4rem', lineHeight: 1.25 }}>
                  What do you do?
                </h1>
                <p className="text-slate-500 mt-1.5">Select all that apply — you can add more later</p>
              </div>

              <form onSubmit={handleStep2} className="flex flex-col gap-3">
                {SERVICE_OPTIONS.map(opt => {
                  const selected = services.includes(opt.type);
                  return (
                    <button
                      key={opt.type}
                      type="button"
                      onClick={() => toggleService(opt.type)}
                      className={`flex items-center gap-4 rounded-2xl border-2 px-5 py-4 text-left transition-all ${
                        selected
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                      }`}
                    >
                      <span className="text-2xl shrink-0">{opt.emoji}</span>
                      <div className="flex-1 min-w-0">
                        <p className={selected ? 'text-white' : 'text-slate-900'}>{opt.label}</p>
                        <p className={`text-xs mt-0.5 ${selected ? 'text-white/60' : 'text-slate-400'}`}>{opt.desc}</p>
                      </div>
                      <div className={`flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-all ${
                        selected ? 'bg-white border-white' : 'border-slate-300'
                      }`}>
                        {selected && <Check size={11} className="text-slate-900" />}
                      </div>
                    </button>
                  );
                })}

                <button
                  type="submit"
                  disabled={services.length === 0}
                  className="flex items-center justify-center rounded-xl bg-slate-900 px-5 py-4 text-sm text-white hover:bg-slate-800 active:scale-[0.98] transition-all mt-2 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Create my workspace
                </button>
              </form>
            </>
          )}

          {/* ── Step 3: Loading / setup ── */}
          {step === 3 && (
            <div className="flex flex-col items-center text-center pt-12 gap-6">
              <div className="relative flex size-20 items-center justify-center">
                <div className="absolute inset-0 rounded-full border-4 border-slate-100" />
                <div
                  className="absolute inset-0 rounded-full border-4 border-slate-900 border-t-transparent animate-spin"
                  style={{ animationDuration: '0.8s' }}
                />
                <Zap size={28} className="text-slate-900" />
              </div>
              <div>
                <p className="text-slate-900" style={{ fontSize: '1.2rem' }}>
                  Setting up your workspace
                </p>
                <p className="text-slate-400 mt-2 text-sm">
                  Building {bizName || 'your account'}…
                </p>
              </div>
              <div className="flex flex-col gap-2.5 w-full max-w-xs mt-4">
                {[
                  'Configuring your AI assistant',
                  'Setting up estimate templates',
                  'Preparing your dashboard',
                ].map((item, i) => (
                  <div
                    key={item}
                    className="flex items-center gap-3 rounded-xl bg-white border border-slate-100 px-4 py-3"
                    style={{ animation: `fadeIn 0.4s ease ${i * 0.4 + 0.3}s both` }}
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-green-100">
                      <Check size={11} className="text-green-600" />
                    </span>
                    <p className="text-xs text-slate-600">{item}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </div>
  );
}
