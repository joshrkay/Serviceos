import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { Button } from '../ui/button';
import { track } from '../../lib/analytics';

/**
 * The recurring "start your free trial" band shared by the standalone
 * marketing pages. `location` tags the analytics event so we can see which
 * page drove the click.
 */
export function MarketingCTA({
  location,
  heading = 'Stop dispatching from the attic.',
  sub = '14-day free trial. Card held, nothing charged until day 15. Live in 15 minutes.',
}: {
  location: string;
  heading?: string;
  sub?: string;
}) {
  return (
    <section className="bg-slate-50">
      <div className="mx-auto max-w-3xl px-6 py-20 text-center">
        <h2 className="text-3xl font-medium tracking-tight text-slate-900 sm:text-4xl">
          {heading}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-base text-slate-600">{sub}</p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/signup"
            onClick={() => track('landing_signup_clicked', { location })}
          >
            <Button variant="brand" size="lg" rightIcon={<ArrowRight size={16} />}>
              Start free trial
            </Button>
          </Link>
          <Link to="/login">
            <Button variant="outline" size="lg">Log in</Button>
          </Link>
        </div>
      </div>
    </section>
  );
}
