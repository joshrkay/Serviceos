'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PLAN_ORDER, PLANS, DEFAULT_PLAN, VERTICALS, isPlanId, type PlanId } from '@/lib/plans';

interface FieldErrors {
  businessName?: string;
  yourName?: string;
  email?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SignupForm() {
  const searchParams = useSearchParams();
  const planParam = searchParams.get('plan');
  const canceled = searchParams.get('canceled') === '1';
  const initialPlan: PlanId = isPlanId(planParam) ? planParam : DEFAULT_PLAN;

  const [businessName, setBusinessName] = useState('');
  const [yourName, setYourName] = useState('');
  const [email, setEmail] = useState('');
  const [vertical, setVertical] = useState<(typeof VERTICALS)[number]>('HVAC');
  const [plan, setPlan] = useState<PlanId>(initialPlan);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function validate(): boolean {
    const next: FieldErrors = {};
    if (businessName.trim().length < 2) next.businessName = 'Please enter your business name.';
    if (yourName.trim().length < 2) next.yourName = 'Please enter your name.';
    if (!EMAIL_RE.test(email.trim())) next.email = 'Please enter a valid email address.';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!validate()) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessName: businessName.trim(),
          yourName: yourName.trim(),
          email: email.trim(),
          vertical,
          plan,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Something went wrong. Please try again.');
      }
      const { url } = (await res.json()) as { url: string };
      window.location.assign(url);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unexpected error.');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      {canceled && (
        <p
          role="status"
          className="rounded border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-fg"
        >
          Checkout canceled — no worries. Pick up where you left off below.
        </p>
      )}
      {formError && (
        <p role="alert" className="rounded border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-fg">
          {formError}
        </p>
      )}

      <div>
        <label htmlFor="businessName" className="field-label">
          Business name
        </label>
        <input
          id="businessName"
          name="businessName"
          type="text"
          autoComplete="organization"
          className="field-input"
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          aria-invalid={Boolean(errors.businessName)}
          aria-describedby={errors.businessName ? 'businessName-error' : undefined}
        />
        {errors.businessName && (
          <p id="businessName-error" className="mt-1 text-sm text-danger">
            {errors.businessName}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="yourName" className="field-label">
          Your name
        </label>
        <input
          id="yourName"
          name="yourName"
          type="text"
          autoComplete="name"
          className="field-input"
          value={yourName}
          onChange={(e) => setYourName(e.target.value)}
          aria-invalid={Boolean(errors.yourName)}
          aria-describedby={errors.yourName ? 'yourName-error' : undefined}
        />
        {errors.yourName && (
          <p id="yourName-error" className="mt-1 text-sm text-danger">
            {errors.yourName}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="email" className="field-label">
          Work email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          className="field-input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? 'email-error' : undefined}
        />
        {errors.email && (
          <p id="email-error" className="mt-1 text-sm text-danger">
            {errors.email}
          </p>
        )}
      </div>

      <fieldset>
        <legend className="field-label">Your trade</legend>
        <div className="flex flex-wrap gap-2">
          {VERTICALS.map((v) => (
            <label
              key={v}
              className={`flex min-h-11 cursor-pointer items-center rounded border px-4 text-sm font-medium ${
                vertical === v ? 'border-primary bg-primary/10 text-fg' : 'border-border text-fg-muted'
              }`}
            >
              <input
                type="radio"
                name="vertical"
                value={v}
                checked={vertical === v}
                onChange={() => setVertical(v)}
                className="sr-only"
              />
              {v}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="field-label">Plan</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {PLAN_ORDER.map((id) => {
            const p = PLANS[id];
            return (
              <label
                key={id}
                className={`flex min-h-11 cursor-pointer flex-col rounded border p-3 ${
                  plan === id ? 'border-primary bg-primary/10' : 'border-border'
                }`}
              >
                <span className="flex items-center justify-between">
                  <span className="font-semibold text-fg">{p.name}</span>
                  <input
                    type="radio"
                    name="plan"
                    value={id}
                    checked={plan === id}
                    onChange={() => setPlan(id)}
                  />
                </span>
                <span className="mt-1 text-sm text-fg-muted">{p.priceLabel}/mo</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <button type="submit" className="btn-primary w-full" disabled={submitting}>
        {submitting ? 'Starting…' : 'Start 14-day free trial'}
      </button>
      <p className="text-center text-xs text-fg-muted">
        Card required. You will not be charged until the trial ends. Cancel anytime.
      </p>
    </form>
  );
}
