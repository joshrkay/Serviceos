/**
 * #6 phase 4e — customer portal "card on file" for membership auto-billing.
 *
 * Lists saved cards and lets the customer add one via a Stripe SetupIntent
 * (Elements confirm) — card data is entered in Stripe's iframe, never our
 * server. The saved card is persisted by the setup_intent.succeeded webhook,
 * so it appears here once that lands (a beat after confirmation).
 */
import { useEffect, useMemo, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, Stripe } from '@stripe/stripe-js';
import { portalApi, PortalPaymentMethod } from '../../api/portal';
import { getRuntimeConfigValue } from '../../lib/runtimeConfig';

function getPublishableKey(): string | undefined {
  return getRuntimeConfigValue('VITE_STRIPE_PUBLISHABLE_KEY');
}

function AddCardForm({ onSaved }: { onSaved: () => void }): JSX.Element {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    const result = await stripe.confirmSetup({ elements, redirect: 'if_required' });
    setSubmitting(false);
    if (result.error) {
      setError(result.error.message ?? 'Could not save your card.');
      return;
    }
    onSaved();
  };

  return (
    <div className="space-y-3" data-testid="add-card-form">
      <PaymentElement />
      {error && <p className="text-sm text-rose-600">{error}</p>}
      <button
        type="button"
        onClick={submit}
        disabled={!stripe || submitting}
        className="rounded-lg bg-slate-900 text-white px-4 py-2 text-sm disabled:opacity-50"
      >
        {submitting ? 'Saving…' : 'Save card'}
      </button>
    </div>
  );
}

export function PortalPaymentMethods({ token }: { token: string }): JSX.Element {
  const [cards, setCards] = useState<PortalPaymentMethod[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  const stripePromise = useMemo<Promise<Stripe | null>>(() => {
    const key = getPublishableKey();
    return key ? loadStripe(key) : Promise.resolve(null);
  }, []);

  const load = () => {
    portalApi
      .paymentMethods(token)
      .then((r) => {
        setCards(r.paymentMethods);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const startAddCard = async () => {
    setStarting(true);
    setError(null);
    try {
      const { clientSecret: secret } = await portalApi.startCardSetup(token);
      setClientSecret(secret);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start card setup.');
    } finally {
      setStarting(false);
    }
  };

  const onSaved = () => {
    setClientSecret(null);
    setSavedNotice(true);
    // The webhook persists the card asynchronously; refetch so it shows once it lands.
    load();
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
      <div className="text-lg font-semibold text-slate-900">Payment methods</div>
      <p className="text-sm text-slate-500">
        Save a card so membership dues can be charged automatically.
      </p>
      {error && <p className="text-sm text-rose-600">{error}</p>}

      {cards === null && !error && <p className="text-sm text-slate-500">Loading…</p>}
      {cards !== null && cards.length === 0 && (
        <p className="text-sm text-slate-500" data-testid="no-cards">
          No card on file yet.
        </p>
      )}
      <ul className="space-y-2">
        {(cards ?? []).map((c) => (
          <li
            key={c.id}
            data-testid="saved-card"
            className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm"
          >
            <span className="text-slate-800">
              {c.brand ?? 'Card'} •••• {c.last4 ?? '????'}
              {c.expMonth && c.expYear ? ` · ${c.expMonth}/${c.expYear}` : ''}
            </span>
            {c.isDefault && (
              <span className="text-xs rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
                Default
              </span>
            )}
          </li>
        ))}
      </ul>

      {savedNotice && !clientSecret && (
        <p className="text-sm text-green-600" data-testid="card-saved-notice">
          Card saved — it&apos;ll appear here once confirmed.
        </p>
      )}

      {clientSecret ? (
        <Elements stripe={stripePromise} options={{ clientSecret }}>
          <AddCardForm onSaved={onSaved} />
        </Elements>
      ) : (
        <button
          type="button"
          onClick={startAddCard}
          disabled={starting}
          data-testid="add-card-button"
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {starting ? 'Starting…' : 'Add a card'}
        </button>
      )}
    </div>
  );
}
