import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setDevUserId } from '../lib/api';

/**
 * Dev-auth login. With CLERK_JWKS_URL configured the API expects Clerk JWTs
 * and this page would be replaced by Clerk's sign-in component; in dev mode
 * a seeded user id identifies the operator.
 */
export default function LoginPage() {
  const navigate = useNavigate();
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDevUserId(userId.trim());
    const result = await api.me();
    setBusy(false);
    if (result.status === 200) {
      navigate('/inbox');
    } else {
      setError('Unknown user id — run the seed and paste the printed ownerUserId.');
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-900">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-xl">
        <div className="text-2xl font-bold tracking-tight">Rivet</div>
        <p className="mt-1 text-sm text-stone-500">
          The AI back office for home-service shops.
        </p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <label className="block text-sm font-medium text-stone-700">
            Dev user id
            <input
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              placeholder="paste seeded ownerUserId"
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 font-mono text-xs focus:border-amber-500 focus:outline-none"
              required
            />
          </label>
          {error && <div className="text-sm text-red-600">{error}</div>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-amber-500 px-4 py-2 font-semibold text-stone-900 transition hover:bg-amber-400 disabled:opacity-50"
          >
            {busy ? 'Checking…' : 'Sign in'}
          </button>
        </form>
        <p className="mt-4 text-xs text-stone-400">
          Dev-auth mode. Production uses Clerk JWTs against the same API.
        </p>
      </div>
    </div>
  );
}
