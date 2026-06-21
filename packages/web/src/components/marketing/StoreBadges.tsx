import { Apple, Play } from 'lucide-react';
import { track } from '../../lib/analytics';
import { appStoreUrl, playStoreUrl } from './storeLinks';

/**
 * App Store + Google Play download badges.
 *
 * These are accessible, glove-friendly (min-h-11 ≥44px) link buttons —
 * inline approximations of the official store badges. The links resolve
 * to the configured store URLs, falling back to /download until the real
 * listings are live (see storeLinks.ts).
 *
 * TODO(launch): swap these for the official "Download on the App Store" /
 * "Get it on Google Play" badge artwork once the listings are published —
 * the official lockups are required by Apple/Google brand guidelines for
 * production marketing. The inline version keeps the page link-complete
 * (no dead `#`) in the meantime.
 */
export function StoreBadges({ className }: { className?: string }) {
  return (
    <div className={'flex flex-col gap-3 sm:flex-row ' + (className ?? '')}>
      <StoreBadge
        href={appStoreUrl()}
        store="ios"
        Icon={Apple}
        kicker="Download on the"
        name="App Store"
      />
      <StoreBadge
        href={playStoreUrl()}
        store="android"
        Icon={Play}
        kicker="Get it on"
        name="Google Play"
      />
    </div>
  );
}

function StoreBadge({
  href,
  store,
  Icon,
  kicker,
  name,
}: {
  href: string;
  store: 'ios' | 'android';
  Icon: typeof Apple;
  kicker: string;
  name: string;
}) {
  const isExternal = href.startsWith('http');
  return (
    <a
      href={href}
      onClick={() => track('download_app_clicked', { store })}
      aria-label={`${kicker} ${name}`}
      target={isExternal ? '_blank' : undefined}
      rel={isExternal ? 'noreferrer' : undefined}
      className="inline-flex min-h-11 items-center gap-3 rounded-xl bg-slate-900 px-5 py-2.5 text-white transition-colors hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-1"
    >
      <Icon size={22} className="shrink-0" />
      <span className="flex flex-col leading-tight text-left">
        <span className="text-[10px] uppercase tracking-wide text-slate-300">
          {kicker}
        </span>
        <span className="text-sm font-medium">{name}</span>
      </span>
    </a>
  );
}
