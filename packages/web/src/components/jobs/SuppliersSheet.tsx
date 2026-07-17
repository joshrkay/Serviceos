import { useState } from 'react';
import {
  X, MapPin, ExternalLink, Phone, Navigation, Search,
  Clock, ChevronRight, Star,
} from 'lucide-react';
import type { ServiceType } from '../../types/job-ui';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Store {
  id:           string;
  name:         string;
  category:     string;
  tagline:      string;
  address:      string;
  distance:     string;
  hours:        string;
  closingTime:  string;
  isOpen:       boolean;
  phone:        string;
  mapsQuery:    string;
  shopUrl:      string;
  logo:         string;
  logoBg:       string;
  logoText:     string;
  badge?:       string;
  badgeColor?:  string;
  serviceTypes: ServiceType[];
}

// ─── Store data (Austin, TX) ──────────────────────────────────────────────────
const STORES: Store[] = [
  {
    id: 'hd-airport',
    name: 'The Home Depot',
    category: 'Hardware & Building',
    tagline: 'Full hardware, plumbing, HVAC, & paint aisle',
    address: '5765 Airport Blvd, Austin TX 78751',
    distance: '2.1 mi',
    hours: 'Open today 6 AM – 10 PM',
    closingTime: '10 PM',
    isOpen: true,
    phone: '(512) 454-5700',
    mapsQuery: 'Home+Depot+5765+Airport+Blvd+Austin+TX',
    shopUrl: 'https://www.homedepot.com',
    logo: 'HD',
    logoBg: 'bg-warning',
    logoText: 'text-primary-foreground',
    serviceTypes: ['HVAC', 'Plumbing', 'Painting'],
  },
  {
    id: 'hd-slaughter',
    name: 'The Home Depot',
    category: 'Hardware & Building',
    tagline: 'South Austin location — paint & electrical focus',
    address: '4400 W Slaughter Ln, Austin TX 78749',
    distance: '5.8 mi',
    hours: 'Open today 6 AM – 10 PM',
    closingTime: '10 PM',
    isOpen: true,
    phone: '(512) 891-8888',
    mapsQuery: 'Home+Depot+4400+W+Slaughter+Ln+Austin+TX',
    shopUrl: 'https://www.homedepot.com',
    logo: 'HD',
    logoBg: 'bg-warning',
    logoText: 'text-primary-foreground',
    serviceTypes: ['HVAC', 'Plumbing', 'Painting'],
  },
  {
    id: 'lw-brodie',
    name: "Lowe's",
    category: 'Hardware & Building',
    tagline: 'Large format — great for bulk materials & pipe',
    address: '4970 W US-290, Austin TX 78735',
    distance: '3.4 mi',
    hours: 'Open today 6 AM – 10 PM',
    closingTime: '10 PM',
    isOpen: true,
    phone: '(512) 892-2270',
    mapsQuery: "Lowes+4970+W+US+290+Austin+TX",
    shopUrl: 'https://www.lowes.com',
    logo: "L'S",
    logoBg: 'bg-primary',
    logoText: 'text-primary-foreground',
    serviceTypes: ['HVAC', 'Plumbing', 'Painting'],
  },
  {
    id: 'fg-norwood',
    name: 'Ferguson HVAC',
    category: 'HVAC & Plumbing Wholesale',
    tagline: 'Contractor pricing · capacitors, contactors, coils',
    address: '1006 Norwood Park Blvd, Austin TX 78753',
    distance: '4.8 mi',
    hours: 'Open today 7 AM – 5 PM',
    closingTime: '5 PM',
    isOpen: true,
    phone: '(512) 835-4400',
    mapsQuery: 'Ferguson+HVAC+Austin+TX+78753',
    shopUrl: 'https://www.ferguson.com',
    logo: 'FG',
    logoBg: 'bg-destructive',
    logoText: 'text-primary-foreground',
    badge: 'Contractor',
    badgeColor: 'bg-destructive/15 text-destructive',
    serviceTypes: ['HVAC', 'Plumbing'],
  },
  {
    id: 'jn-rundberg',
    name: 'Johnstone Supply',
    category: 'HVAC Wholesale',
    tagline: 'HVAC-only wholesale · R-410A, filters, equipment',
    address: '835 E Rundberg Ln, Austin TX 78753',
    distance: '3.1 mi',
    hours: 'Open today 7:30 AM – 4:30 PM',
    closingTime: '4:30 PM',
    isOpen: true,
    phone: '(512) 836-6400',
    mapsQuery: 'Johnstone+Supply+Austin+TX',
    shopUrl: 'https://www.johnstonesupply.com',
    logo: 'JS',
    logoBg: 'bg-primary',
    logoText: 'text-primary-foreground',
    badge: 'HVAC Only',
    badgeColor: 'bg-primary/15 text-primary',
    serviceTypes: ['HVAC'],
  },
  {
    id: 'sw-anderson',
    name: 'Sherwin-Williams',
    category: 'Paint & Coatings',
    tagline: 'Pro accounts · Emerald, Duration, Cashmere lines',
    address: '2438 W Anderson Ln, Austin TX 78757',
    distance: '2.6 mi',
    hours: 'Open today 7 AM – 7 PM',
    closingTime: '7 PM',
    isOpen: true,
    phone: '(512) 454-9351',
    mapsQuery: 'Sherwin+Williams+2438+W+Anderson+Ln+Austin+TX',
    shopUrl: 'https://www.sherwin-williams.com',
    logo: 'SW',
    logoBg: 'bg-destructive',
    logoText: 'text-primary-foreground',
    badge: 'Paint Pro',
    badgeColor: 'bg-destructive/15 text-destructive',
    serviceTypes: ['Painting'],
  },
  {
    id: 'sw-south',
    name: 'Sherwin-Williams',
    category: 'Paint & Coatings',
    tagline: 'South Austin — color matching & tinting',
    address: '1717 S Congress Ave, Austin TX 78704',
    distance: '4.1 mi',
    hours: 'Open today 7 AM – 7 PM',
    closingTime: '7 PM',
    isOpen: true,
    phone: '(512) 444-0616',
    mapsQuery: 'Sherwin+Williams+1717+S+Congress+Ave+Austin+TX',
    shopUrl: 'https://www.sherwin-williams.com',
    logo: 'SW',
    logoBg: 'bg-destructive',
    logoText: 'text-primary-foreground',
    serviceTypes: ['Painting'],
  },
  {
    id: 'bm-westlake',
    name: 'Benjamin Moore',
    category: 'Paint & Coatings',
    tagline: 'Premium paint — Aura, Regal, Advance lines',
    address: '3300 Bee Cave Rd #620, Austin TX 78746',
    distance: '6.2 mi',
    hours: 'Open today 8 AM – 6 PM',
    closingTime: '6 PM',
    isOpen: true,
    phone: '(512) 347-8600',
    mapsQuery: 'Benjamin+Moore+Bee+Cave+Rd+Austin+TX',
    shopUrl: 'https://www.benjaminmoore.com',
    logo: 'BM',
    logoBg: 'bg-warning',
    logoText: 'text-primary-foreground',
    serviceTypes: ['Painting'],
  },
  {
    id: 'gr-research',
    name: 'Grainger',
    category: 'Industrial Supply',
    tagline: 'Motors, belts, fasteners, safety gear',
    address: '9521 Research Blvd, Austin TX 78759',
    distance: '7.4 mi',
    hours: 'Open today 7 AM – 5 PM',
    closingTime: '5 PM',
    isOpen: true,
    phone: '(512) 345-5900',
    mapsQuery: 'Grainger+9521+Research+Blvd+Austin+TX',
    shopUrl: 'https://www.grainger.com',
    logo: 'GR',
    logoBg: 'bg-primary',
    logoText: 'text-primary-foreground',
    badge: 'Industrial',
    badgeColor: 'bg-secondary text-foreground',
    serviceTypes: ['HVAC', 'Plumbing'],
  },
  {
    id: 'tv-north',
    name: 'True Value Hardware',
    category: 'Hardware',
    tagline: 'Neighborhood hardware — fittings, fasteners, tools',
    address: '5765 N Lamar Blvd, Austin TX 78751',
    distance: '2.9 mi',
    hours: 'Open today 8 AM – 8 PM',
    closingTime: '8 PM',
    isOpen: true,
    phone: '(512) 459-7806',
    mapsQuery: 'True+Value+N+Lamar+Blvd+Austin+TX',
    shopUrl: 'https://www.truevalue.com',
    logo: 'TV',
    logoBg: 'bg-success',
    logoText: 'text-primary-foreground',
    serviceTypes: ['HVAC', 'Plumbing', 'Painting'],
  },
];

// ─── Category order by service type ──────────────────────────────────────────
const CATEGORY_ORDER: Record<ServiceType, string[]> = {
  HVAC:     ['HVAC Wholesale', 'HVAC & Plumbing Wholesale', 'Hardware & Building', 'Industrial Supply'],
  Plumbing: ['HVAC & Plumbing Wholesale', 'Hardware & Building', 'Industrial Supply'],
  Painting: ['Paint & Coatings', 'Hardware & Building'],
};

function categoryPriority(cat: string, svcType: ServiceType): number {
  const order = CATEGORY_ORDER[svcType] ?? [];
  const idx   = order.findIndex(c => cat.includes(c) || c.includes(cat));
  return idx === -1 ? 99 : idx;
}

// ─── Store card ───────────────────────────────────────────────────────────────
function StoreCard({ store }: { store: Store }) {
  const mapsUrl = `https://maps.google.com/?q=${store.mapsQuery}`;

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      {/* Header row */}
      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        {/* Logo */}
        <div className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${store.logoBg}`}>
          <span className={`${store.logoText} text-xs font-mono`} style={{ letterSpacing: '-0.5px' }}>
            {store.logo}
          </span>
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm text-foreground">{store.name}</p>
            {store.badge && (
              <span className={`text-xs rounded-full px-2 py-0.5 ${store.badgeColor}`}>
                {store.badge}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{store.category}</p>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{store.tagline}</p>
        </div>

        {/* Distance badge */}
        <span className="shrink-0 text-xs bg-secondary text-foreground rounded-full px-2.5 py-1">
          {store.distance}
        </span>
      </div>

      {/* Hours + address row */}
      <div className="flex items-center gap-3 px-4 pb-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <Clock size={11} className={store.isOpen ? 'text-success' : 'text-muted-foreground'} />
          <span className={`text-xs ${store.isOpen ? 'text-success' : 'text-muted-foreground'}`}>
            {store.isOpen ? 'Open' : 'Closed'}
          </span>
          <span className="text-xs text-muted-foreground">· closes {store.closingTime}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <MapPin size={11} className="text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground truncate max-w-[200px]">{store.address.split(',')[0]}</span>
        </div>
      </div>

      {/* Action buttons */}
      <div className="grid grid-cols-3 border-t border-border divide-x divide-border">
        <a
          href={`tel:${store.phone.replace(/[^0-9]/g, '')}`}
          className="flex flex-col items-center gap-1 py-3 hover:bg-secondary transition-colors group"
        >
          <Phone size={14} className="text-muted-foreground group-hover:text-foreground transition-colors" />
          <span className="text-xs text-muted-foreground">Call</span>
        </a>
        <a
          href={mapsUrl}
          target="_blank"
          rel="noreferrer"
          className="flex flex-col items-center gap-1 py-3 hover:bg-primary/10 transition-colors group"
        >
          <Navigation size={14} className="text-muted-foreground group-hover:text-primary transition-colors" />
          <span className="text-xs text-muted-foreground group-hover:text-primary transition-colors">Directions</span>
        </a>
        <a
          href={store.shopUrl}
          target="_blank"
          rel="noreferrer"
          className="flex flex-col items-center gap-1 py-3 hover:bg-primary/10 transition-colors group"
        >
          <ExternalLink size={14} className="text-muted-foreground group-hover:text-primary transition-colors" />
          <span className="text-xs text-muted-foreground group-hover:text-primary transition-colors">Shop online</span>
        </a>
      </div>
    </div>
  );
}

// ─── Main sheet ───────────────────────────────────────────────────────────────
export function SuppliersSheet({
  serviceType,
  onClose,
}: {
  serviceType: ServiceType;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');

  // Filter by service type then by search
  const relevant = STORES
    .filter(s => s.serviceTypes.includes(serviceType))
    .filter(s =>
      !search ||
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.category.toLowerCase().includes(search.toLowerCase()) ||
      s.tagline.toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => categoryPriority(a.category, serviceType) - categoryPriority(b.category, serviceType));

  // Group by category for display
  const groups = relevant.reduce<Record<string, Store[]>>((acc, s) => {
    if (!acc[s.category]) acc[s.category] = [];
    acc[s.category].push(s);
    return acc;
  }, {});

  const SVC_LABEL: Record<ServiceType, string> = {
    HVAC: '❄️ HVAC',
    Plumbing: '🔧 Plumbing',
    Painting: '🎨 Painting',
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/50" onClick={onClose}>
      <div
        className="mt-auto bg-card rounded-t-3xl w-full max-h-[90vh] flex flex-col shadow-2xl"
        style={{ animation: 'sheetUp 0.28s cubic-bezier(0.32,0.72,0,1)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 shrink-0">
          <div className="w-9 h-1 rounded-full bg-border" />
        </div>

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3.5 shrink-0 border-b border-border">
          <div className="flex-1">
            <p className="text-foreground text-sm">Nearby Suppliers</p>
            <p className="text-xs text-muted-foreground mt-0.5">{SVC_LABEL[serviceType]} · Austin, TX</p>
          </div>
          <button
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-full hover:bg-secondary transition-colors"
          >
            <X size={15} className="text-muted-foreground" />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-3 shrink-0">
          <div className="flex items-center gap-2.5 rounded-xl bg-secondary px-3.5 py-2.5">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search stores…"
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            />
            {search && (
              <button onClick={() => setSearch('')}>
                <X size={12} className="text-muted-foreground" />
              </button>
            )}
          </div>
        </div>

        {/* All service-type tabs */}
        <div className="px-5 pb-2 flex gap-2 shrink-0">
          <span className="text-xs bg-primary text-primary-foreground rounded-full px-3 py-1.5">
            {SVC_LABEL[serviceType]}
          </span>
          <span className="text-xs text-muted-foreground flex items-center">
            {relevant.length} stores nearby
          </span>
        </div>

        {/* Scrollable list */}
        <div className="flex-1 overflow-y-auto px-5 pb-8 pt-2" style={{ scrollbarWidth: 'thin' }}>
          {Object.keys(groups).length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <MapPin size={28} className="text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No stores match your search</p>
            </div>
          ) : (
            Object.entries(groups).map(([category, stores]) => (
              <div key={category} className="mb-5">
                {/* Category header */}
                <div className="flex items-center gap-2 mb-3">
                  <p className="text-xs text-muted-foreground">{category}</p>
                  <div className="flex-1 h-px bg-secondary" />
                  <span className="text-xs text-muted-foreground">{stores.length}</span>
                </div>
                <div className="flex flex-col gap-3">
                  {stores.map(store => (
                    <StoreCard key={store.id} store={store} />
                  ))}
                </div>
              </div>
            ))
          )}

          {/* Pro tip */}
          <div className="rounded-xl bg-warning/10 border border-warning/20 px-4 py-3 mt-2">
            <div className="flex items-start gap-2.5">
              <Star size={13} className="text-warning shrink-0 mt-0.5" />
              <p className="text-xs text-warning leading-relaxed">
                <span className="text-warning">Pro tip:</span> Ferguson and Johnstone offer contractor accounts with net-30 billing and volume discounts. Ask about a trade account when you visit.
              </p>
            </div>
          </div>
        </div>
      </div>

      <style>{`@keyframes sheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }`}</style>
    </div>
  );
}
