import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Zap, Eye, EyeOff, ArrowRight, AlertCircle } from 'lucide-react';

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) { setError('Please enter your email and password.'); return; }
    setError('');
    setLoading(true);
    setTimeout(() => { setLoading(false); navigate('/'); }, 900);
  }

  function handleDemo() {
    setLoading(true);
    setTimeout(() => { setLoading(false); navigate('/'); }, 600);
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-6 pt-6">
        <span className="flex size-8 items-center justify-center rounded-xl bg-slate-900">
          <Zap size={15} className="text-white" />
        </span>
        <span className="text-slate-900 tracking-tight">Fieldly</span>
      </div>

      {/* Card */}
      <div className="flex-1 flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8">
            <h1 className="text-slate-900" style={{ fontSize: '1.5rem', lineHeight: 1.25 }}>
              Welcome back
            </h1>
            <p className="text-slate-500 mt-1.5">
              Sign in to your Fieldly account
            </p>
          </div>

          {/* Demo shortcut */}
          <button
            onClick={handleDemo}
            disabled={loading}
            className="w-full flex items-center justify-between gap-3 rounded-2xl border-2 border-slate-200 bg-white px-5 py-4 hover:border-blue-300 hover:bg-blue-50/50 transition-all group mb-6 disabled:opacity-60"
          >
            <div className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-full bg-slate-800 text-white text-xs shrink-0">MO</span>
              <div className="text-left">
                <p className="text-sm text-slate-900">Continue as Mike Ortega</p>
                <p className="text-xs text-slate-400">Demo account · Ortega HVAC & Services</p>
              </div>
            </div>
            <ArrowRight size={15} className="text-slate-400 group-hover:text-blue-600 transition-colors shrink-0" />
          </button>

          <div className="flex items-center gap-3 mb-6">
            <div className="flex-1 h-px bg-slate-200" />
            <span className="text-xs text-slate-400">or sign in with email</span>
            <div className="flex-1 h-px bg-slate-200" />
          </div>

          <form onSubmit={handleSignIn} className="flex flex-col gap-4">
            {error && (
              <div className="flex items-center gap-2 rounded-xl bg-red-50 border border-red-100 px-4 py-3">
                <AlertCircle size={14} className="text-red-500 shrink-0" />
                <p className="text-sm text-red-600">{error}</p>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-slate-500">Email address</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@yourbusiness.com"
                className="rounded-xl border border-slate-200 bg-white px-4 py-3.5 text-sm text-slate-800 placeholder-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                autoComplete="email"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs text-slate-500">Password</label>
                <button type="button" className="text-xs text-blue-600 hover:text-blue-700 transition-colors">
                  Forgot password?
                </button>
              </div>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3.5 pr-12 text-sm text-slate-800 placeholder-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                >
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 py-4 text-sm text-white hover:bg-slate-800 active:scale-[0.98] transition-all disabled:opacity-60 mt-1"
            >
              {loading ? (
                <span className="flex size-4 items-center justify-center">
                  <span className="animate-spin size-4 border-2 border-white/30 border-t-white rounded-full" />
                </span>
              ) : 'Sign in'}
            </button>
          </form>

          <p className="text-center text-sm text-slate-400 mt-6">
            New to Fieldly?{' '}
            <button
              onClick={() => navigate('/signup')}
              className="text-blue-600 hover:text-blue-700 transition-colors"
            >
              Start free →
            </button>
          </p>
        </div>
      </div>

      {/* Footer */}
      <div className="px-6 pb-6 text-center">
        <p className="text-xs text-slate-300">
          © 2026 Fieldly · Privacy · Terms
        </p>
      </div>
    </div>
  );
}
