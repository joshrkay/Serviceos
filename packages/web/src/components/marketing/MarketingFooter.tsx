import { Link } from 'react-router';
import { Zap } from 'lucide-react';

/**
 * Shared marketing footer. Every link resolves to a real route — no dead
 * anchors. Product/company/legal columns plus the brand mark.
 */
export function MarketingFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="grid gap-10 sm:grid-cols-2 md:grid-cols-4">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="flex size-7 items-center justify-center rounded-lg bg-slate-900">
                <Zap size={13} className="text-white" />
              </span>
              <span className="text-sm tracking-tight text-slate-900">Rivet</span>
            </div>
            <p className="mt-3 max-w-xs text-xs leading-relaxed text-slate-500">
              The AI back office for solo HVAC &amp; plumbing operators. You
              learned the trade. We&apos;ll run the business.
            </p>
          </div>

          <FooterColumn
            title="Product"
            links={[
              { label: 'Features', to: '/features' },
              { label: 'Pricing', to: '/pricing' },
              { label: 'Get the app', to: '/download' },
            ]}
          />
          <FooterColumn
            title="Company"
            links={[
              { label: 'About', to: '/about' },
              { label: 'Log in', to: '/login' },
              { label: 'Start free trial', to: '/signup' },
            ]}
          />
          <FooterColumn
            title="Legal"
            links={[
              { label: 'Privacy', to: '/privacy' },
              { label: 'Terms', to: '/terms' },
            ]}
          />
        </div>

        <div className="mt-10 border-t border-slate-200 pt-6">
          <p className="text-xs text-slate-500">
            &copy; {new Date().getFullYear()} Rivet. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: { label: string; to: string }[];
}) {
  return (
    <div>
      <h3 className="text-xs font-medium uppercase tracking-widest text-slate-400">
        {title}
      </h3>
      <ul className="mt-4 space-y-2.5">
        {links.map((link) => (
          <li key={link.to + link.label}>
            <Link to={link.to} className="text-sm text-slate-600 hover:text-slate-900">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
