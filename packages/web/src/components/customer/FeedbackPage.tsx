import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { Star, CheckCircle2 } from 'lucide-react';
import { Textarea } from '../ui';
import { NEUTRAL_FIELD } from './portalNeutral';

type Status = 'loading' | 'rating' | 'submitting' | 'submitted' | 'already_submitted' | 'expired' | 'invalid_link' | 'error';

type ReviewUrls = { google?: string; yelp?: string };

type InitialResponse = {
  status: 'pending' | 'submitted' | 'expired';
  jobId: string;
  businessName?: string;
};

type SubmitResponse = {
  ok: true;
  reviewUrls?: ReviewUrls;
};

export function FeedbackPage() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<Status>('loading');
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [businessName, setBusinessName] = useState<string | undefined>();
  const [reviewUrls, setReviewUrls] = useState<ReviewUrls | undefined>();
  const [errorMessage, setErrorMessage] = useState<string>('');

  useEffect(() => {
    if (!token) {
      setStatus('invalid_link');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/public/feedback/${token}`);
        if (!res.ok) {
          if (!cancelled) setStatus('error');
          return;
        }
        const data: InitialResponse = await res.json();
        if (cancelled) return;
        setBusinessName(data.businessName);
        if (data.status === 'pending') setStatus('rating');
        else if (data.status === 'submitted') setStatus('already_submitted');
        else if (data.status === 'expired') setStatus('expired');
        else setStatus('error');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  async function submit() {
    if (rating === 0 || status === 'submitting') return;
    setStatus('submitting');
    try {
      const res = await fetch(`/public/feedback/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, comment: comment.trim() || null }),
      });
      if (!res.ok) {
        setStatus('rating');
        setErrorMessage('Could not submit feedback. Please try again.');
        return;
      }
      const data: SubmitResponse = await res.json();
      setReviewUrls(data.reviewUrls);
      setStatus('submitted');
    } catch {
      setStatus('rating');
      setErrorMessage('Network error. Please try again.');
    }
  }

  const header = (
    <header className="text-center mb-8">
      <h1 className="text-2xl text-foreground">How did we do?</h1>
      {businessName && (
        <p className="text-sm text-muted-foreground mt-1">Share your experience with {businessName}</p>
      )}
    </header>
  );

  if (status === 'loading') {
    return (
      <div className="min-h-screen bg-muted flex items-center justify-center">
        <div className="size-8 border-2 border-border border-t-foreground rounded-full animate-spin" aria-label="Loading" />
      </div>
    );
  }

  if (status === 'already_submitted') {
    return (
      <div className="min-h-screen bg-muted flex items-center justify-center px-4">
        <div className="max-w-md w-full rounded-2xl bg-card border border-border px-6 py-8 text-center">
          <CheckCircle2 size={40} className="mx-auto text-success mb-3" />
          <h2 className="text-lg text-foreground mb-1">Feedback already submitted</h2>
          <p className="text-sm text-muted-foreground">Thanks — we already have your response for this visit.</p>
        </div>
      </div>
    );
  }

  if (status === 'expired') {
    return (
      <div className="min-h-screen bg-muted flex items-center justify-center px-4">
        <div className="max-w-md w-full rounded-2xl bg-card border border-border px-6 py-8 text-center">
          <h2 className="text-lg text-foreground mb-1">This link has expired</h2>
          <p className="text-sm text-muted-foreground">Please reach out directly if you'd still like to share feedback.</p>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="min-h-screen bg-muted flex items-center justify-center px-4">
        <div className="max-w-md w-full rounded-2xl bg-card border border-border px-6 py-8 text-center">
          <h2 className="text-lg text-foreground mb-1">Something went wrong</h2>
          <p className="text-sm text-muted-foreground">We couldn't load this feedback request. Check the link and try again.</p>
        </div>
      </div>
    );
  }

  if (status === 'invalid_link') {
    return (
      <div className="min-h-screen bg-muted flex items-center justify-center px-4">
        <div className="max-w-md w-full rounded-2xl bg-card border border-border px-6 py-8 text-center">
          <h2 className="text-lg text-foreground mb-1">Invalid feedback link</h2>
          <p className="text-sm text-muted-foreground">This link is missing required information or is malformed. Please request a new feedback link.</p>
        </div>
      </div>
    );
  }

  if (status === 'submitted') {
    return (
      <div className="min-h-screen bg-muted flex items-center justify-center px-4">
        <div className="max-w-md w-full rounded-2xl bg-card border border-border px-6 py-8 text-center">
          <CheckCircle2 size={44} className="mx-auto text-success mb-3" />
          <h2 className="text-xl text-foreground mb-1">Thank you!</h2>
          <p className="text-sm text-muted-foreground mb-6">Your feedback helps us get better.</p>

          {(reviewUrls?.google || reviewUrls?.yelp) && (
            <div className="space-y-3 text-left">
              <p className="text-sm text-foreground text-center">
                Mind sharing a quick public review?
              </p>
              {reviewUrls.google && (
                <a
                  href={reviewUrls.google}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 rounded-2xl bg-foreground text-white py-3.5 hover:bg-foreground/80 active:scale-[0.98] transition"
                >
                  Leave a Google review
                </a>
              )}
              {reviewUrls.yelp && (
                <a
                  href={reviewUrls.yelp}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 rounded-2xl bg-destructive text-white py-3.5 hover:bg-destructive/90 active:scale-[0.98] transition"
                >
                  Leave a Yelp review
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // rating / submitting
  return (
    <div className="min-h-screen bg-muted px-4 py-8">
      <div className="max-w-md mx-auto">
        {header}

        <div className="rounded-2xl bg-card border border-border px-5 py-6">
          <div className="flex justify-center gap-1 mb-6" data-testid="star-rating">
            {[1, 2, 3, 4, 5].map(n => {
              const active = (hover || rating) >= n;
              return (
                <button
                  key={n}
                  type="button"
                  aria-label={`${n} star${n === 1 ? '' : 's'}`}
                  onMouseEnter={() => setHover(n)}
                  onMouseLeave={() => setHover(0)}
                  onClick={() => setRating(n)}
                  className="p-1 rounded-lg hover:bg-muted active:scale-95 transition"
                >
                  <Star
                    size={40}
                    className={active ? 'fill-warning text-warning' : 'fill-none text-muted-foreground'}
                  />
                </button>
              );
            })}
          </div>

          <label className="block">
            <span className="text-sm text-foreground">Anything you'd like to share? (optional)</span>
            <Textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              maxLength={1000}
              rows={4}
              placeholder="Tell us about your experience…"
              className={`mt-2 ${NEUTRAL_FIELD} resize-none`}
            />
          </label>

          {errorMessage && (
            <p className="mt-3 text-sm text-destructive">{errorMessage}</p>
          )}

          <button
            type="button"
            onClick={submit}
            disabled={rating === 0 || status === 'submitting'}
            className="mt-5 w-full flex items-center justify-center gap-2 rounded-2xl bg-foreground text-white py-4 hover:bg-foreground/80 active:scale-[0.98] transition disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
          >
            {status === 'submitting' ? 'Submitting…' : 'Submit feedback'}
          </button>
        </div>
      </div>
    </div>
  );
}
