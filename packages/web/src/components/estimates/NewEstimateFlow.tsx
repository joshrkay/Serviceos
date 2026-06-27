import { useState, useEffect, useRef } from 'react';
import { useUser } from '@clerk/clerk-react';
import { useApiClient } from '../../lib/apiClient';
import { firstNameFromUser } from '../../utils/greeting';
import {
  X, Search, MapPin, Check, Plus, Trash2, Send,
  ArrowLeft, FileText, Phone, Mail, ChevronDown,
  Mic, Camera, Image, Sparkles, RotateCcw, StopCircle,
  Pencil, Minus, ListChecks,
} from 'lucide-react';
import { apiFetch } from '../../utils/api-fetch';
import { useListQuery } from '../../hooks/useListQuery';
import { useEstimateTerm } from '../../hooks/useEstimateTerm';

type ServiceType = 'HVAC' | 'Plumbing' | 'Painting';

interface EstimateCustomer {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  serviceType: ServiceType;
  locations: Array<{
    id: string;
    nickname: string;
    address: string;
    serviceTypes: ServiceType[];
    isPrimary: boolean;
  }>;
}

interface ApiCustomer {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  primaryPhone?: string;
  email?: string;
  locations?: Array<{
    id: string;
    label?: string;
    street1?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    serviceTypes?: ServiceType[];
    isPrimary?: boolean;
  }>;
}

function mapApiCustomers(apiCustomers: ApiCustomer[]): EstimateCustomer[] {
  return apiCustomers.map((c) => {
    const locations = (c.locations ?? []).map((loc) => ({
      id: loc.id,
      nickname: loc.label || 'Location',
      address: [loc.street1, loc.city, loc.state, loc.postalCode].filter(Boolean).join(', '),
      serviceTypes: loc.serviceTypes?.length ? loc.serviceTypes : (['HVAC'] as ServiceType[]),
      isPrimary: !!loc.isPrimary,
    }));
    const primary = locations.find((l) => l.isPrimary) ?? locations[0];
    return {
      id: c.id,
      name: c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Customer',
      phone: c.primaryPhone || '',
      email: c.email || '',
      address: primary?.address || '',
      serviceType: (primary?.serviceTypes[0] ?? 'HVAC') as ServiceType,
      locations,
    };
  });
}

// A job belonging to the selected customer, as returned by GET /api/jobs.
interface ApiJob {
  id: string;
  jobNumber?: string;
  summary?: string;
  customerId?: string;
}

// ─── Types ────────────────────────────────────────────────────────────────────
type LineItem   = { description: string; qty: number; rate: number };
type AILineItem = LineItem & { note?: string };
type InputMode  = 'voice' | 'manual' | 'photo';
type VoicePhase = 'idle' | 'recording' | 'processing' | 'transcribed' | 'generating' | 'done';
type PhotoPhase = 'idle' | 'analyzing' | 'done';
type FlowStep   = 'start' | 'describe' | 'review' | 'send';
type StartMode  = 'voice' | 'manual' | null;

interface AIResult {
  description: string;
  items: AILineItem[];
  explanation: string;
  // proposalId of the persisted draft_estimate proposal when the items
  // came from /api/estimates/suggest. Captured here so the save flow
  // can link the resulting Estimate back to its source proposal once
  // the createEstimate API accepts a proposalId (follow-up).
  proposalId?: string;
}

interface ManualItem {
  id: string;
  description: string;
  qty: number;
  rate: number;
  isCustom?: boolean;
}

// ─── Style constants ──────────────────────────────────────────────────────────
// Service type is a category, not a status — Path A keeps the chip neutral; the
// emoji (SVC_ICON) + label carry the per-type distinction.
const SVC_CHIP: Record<ServiceType, string> = {
  HVAC:     'bg-secondary text-foreground border-border',
  Plumbing: 'bg-secondary text-foreground border-border',
  Painting: 'bg-secondary text-foreground border-border',
};
const SVC_ICON: Record<ServiceType, string> = { HVAC: '❄️', Plumbing: '🔧', Painting: '🎨' };

// ─── Catalog for manual estimate building ────────────────────────────────────
interface CatalogItem {
  id: string; name: string; defaultRate: number; defaultQty: number;
  unit?: string; category: string;
}
const MANUAL_CATALOG: Record<ServiceType, CatalogItem[]> = {
  HVAC: [
    { id: 'diag',    name: 'Diagnostic fee',               defaultRate: 85,    defaultQty: 1, category: 'Service'   },
    { id: 'tune',    name: 'AC tune-up & inspection',       defaultRate: 129,   defaultQty: 1, category: 'Service'   },
    { id: 'labor',   name: 'Labor',                         defaultRate: 95,    defaultQty: 1, unit: 'per hr',   category: 'Labor'     },
    { id: 'cap',     name: 'Run capacitor 35/5 MFD',        defaultRate: 28.50, defaultQty: 1, category: 'Part'      },
    { id: 'cont',    name: 'Contactor 40A 24V',             defaultRate: 22,    defaultQty: 1, category: 'Part'      },
    { id: 'refrig',  name: 'R-410A refrigerant',            defaultRate: 18,    defaultQty: 1, unit: 'per lb',   category: 'Material'  },
    { id: 'filter',  name: 'Air filter (20×25)',             defaultRate: 9.50,  defaultQty: 1, category: 'Part'      },
    { id: 'nest',    name: 'Nest thermostat',               defaultRate: 199,   defaultQty: 1, category: 'Equipment' },
    { id: 'drain',   name: 'Drain line treatment',          defaultRate: 14,    defaultQty: 1, category: 'Material'  },
    { id: 'coil',    name: 'Coil cleaning',                 defaultRate: 85,    defaultQty: 1, category: 'Service'   },
  ],
  Plumbing: [
    { id: 'svc',     name: 'Service call fee',              defaultRate: 85,    defaultQty: 1, category: 'Service'   },
    { id: 'labor',   name: 'Labor',                         defaultRate: 110,   defaultQty: 1, unit: 'per hr',   category: 'Labor'     },
    { id: 'drain',   name: 'Drain cleaning (main line)',    defaultRate: 185,   defaultQty: 1, category: 'Service'   },
    { id: 'ptrap',   name: 'P-trap replacement',           defaultRate: 65,    defaultQty: 1, category: 'Parts+Labor'},
    { id: 'wax',     name: 'Wax ring & toilet reseat',      defaultRate: 75,    defaultQty: 1, category: 'Parts+Labor'},
    { id: 'faucet',  name: 'Faucet repair/replace',         defaultRate: 145,   defaultQty: 1, category: 'Service'   },
    { id: 'heater',  name: 'Water heater (40-gal Rheem)',   defaultRate: 620,   defaultQty: 1, category: 'Equipment' },
    { id: 'bio',     name: 'Bio enzyme treatment',          defaultRate: 45,    defaultQty: 1, category: 'Material'  },
  ],
  Painting: [
    { id: 'day',     name: 'Labor – full day',              defaultRate: 650,   defaultQty: 1, category: 'Labor'     },
    { id: 'half',    name: 'Labor – half day',              defaultRate: 350,   defaultQty: 1, category: 'Labor'     },
    { id: 'prep',    name: 'Surface prep & taping',         defaultRate: 120,   defaultQty: 1, category: 'Service'   },
    { id: 'wash',    name: 'Power wash',                    defaultRate: 180,   defaultQty: 1, category: 'Service'   },
    { id: 'int',     name: 'SW Cashmere interior (gal)',    defaultRate: 58,    defaultQty: 1, unit: 'per gal',  category: 'Material'  },
    { id: 'ext',     name: 'SW Emerald exterior (gal)',     defaultRate: 68,    defaultQty: 1, unit: 'per gal',  category: 'Material'  },
    { id: 'primer',  name: 'Primer (gal)',                  defaultRate: 34,    defaultQty: 1, unit: 'per gal',  category: 'Material'  },
    { id: 'caulk',   name: 'Caulking & patching',           defaultRate: 85,    defaultQty: 1, category: 'Service'   },
  ],
};

// ─── AI suggestion call ──────────────────────────────────────────────────────
// Posts to the real /api/estimates/suggest endpoint, which invokes
// EstimateTaskHandler on the API and persists a draft_estimate proposal.
// On any failure (no auth, 503 not-configured, network), falls back to
// the local mock generator so the wizard remains usable in dev/demo.
async function suggestEstimate(input: string, svcHint?: ServiceType): Promise<AIResult> {
  try {
    const res = await apiFetch('/api/estimates/suggest', {
      method: 'POST',
      body: JSON.stringify({ description: input, ...(svcHint ? { serviceType: svcHint } : {}) }),
    });
    if (!res.ok) return generateEstimate(input, svcHint);
    const data = (await res.json()) as {
      proposalId?: string;
      lineItems?: Array<{ description: string; quantity: number; unitPrice: number; category?: string }>;
      notes?: string;
    };
    const items: AILineItem[] = (data.lineItems ?? []).map(li => ({
      description: li.description,
      qty: li.quantity,
      rate: li.unitPrice,
      ...(li.category ? { note: li.category } : {}),
    }));
    if (items.length === 0) return generateEstimate(input, svcHint);
    return {
      description: input.length > 60 ? input.slice(0, 60) + '…' : input || 'Service',
      explanation: data.notes ?? '',
      items,
      ...(data.proposalId ? { proposalId: data.proposalId } : {}),
    };
  } catch {
    return generateEstimate(input, svcHint);
  }
}

// ─── Mock AI generator (fallback) ─────────────────────────────────────────────
function generateEstimate(input: string, svcHint?: ServiceType): AIResult {
  const t = input.toLowerCase();
  const isHVAC  = svcHint === 'HVAC'     || /hvac|ac |condenser|refrigerant|furnace|duct|thermostat|heat pump|tune.?up|air filter/.test(t);
  const isPlumb = svcHint === 'Plumbing' || /drain|pipe|water heater|faucet|toilet|leak|clog|plumb|sewer/.test(t);
  const isPaint = svcHint === 'Painting' || /paint|primer|wall|exterior|interior|stain/.test(t);

  if (isHVAC) {
    if (/condenser|replace.*unit|full.*system/.test(t)) return {
      description: 'AC condenser replacement',
      explanation: "Replacing the 4-ton Carrier — using current Austin wholesale pricing. Added refrigerant, hardware, and 4 hours labor at $95/hr. Total's competitive for this market.",
      items: [
        { description: 'Carrier 4-ton condenser unit (16 SEER)', qty: 1, rate: 2200, note: 'Current Austin wholesale for a 16 SEER unit.' },
        { description: 'Refrigerant R-410A (2 lbs)',             qty: 2, rate: 85,   note: 'Standard recharge for a 4-ton system.' },
        { description: 'Disconnect box & line-set fittings',     qty: 1, rate: 145,  note: 'Required hardware for the swap.' },
        { description: 'Installation labor (4 hrs)',             qty: 4, rate: 95,   note: '$95/hr is the Austin market rate.' },
      ],
    };
    if (/thermostat/.test(t)) return {
      description: 'Smart thermostat installation',
      explanation: "Quick thermostat swap — Nest at installed price, wiring check, and 1 hour labor. Standard Austin rate.",
      items: [
        { description: 'Nest Learning Thermostat (Pro install)', qty: 1, rate: 175, note: 'Pro install kit.' },
        { description: 'Wiring & compatibility check',           qty: 1, rate: 65,  note: 'Some systems need a C-wire adapter.' },
        { description: 'Installation & programming (1 hr)',      qty: 1, rate: 95,  note: 'One hour including app pairing.' },
      ],
    };
    if (/tune.?up|maintenance|service|annual/.test(t)) return {
      description: 'AC tune-up & seasonal maintenance',
      explanation: "Seasonal tune-up package — inspection, filter, coil cleaning, and a refrigerant top-off.",
      items: [
        { description: 'AC tune-up & full inspection',   qty: 1, rate: 129, note: '21-point inspection.' },
        { description: 'Air filter replacement (20×25)', qty: 1, rate: 45,  note: 'Standard MERV-8 filter.' },
        { description: 'Refrigerant top-off (0.5 lb)',   qty: 1, rate: 65,  note: 'Small top-off only.' },
        { description: 'Coil cleaning & flush',          qty: 1, rate: 85,  note: 'Evaporator and condenser coil cleaning.' },
      ],
    };
    return {
      description: 'HVAC service & repair',
      explanation: "Diagnostic, parts estimate, and 2 hours labor. Adjust parts cost after you've seen the job.",
      items: [
        { description: 'Diagnostic fee',    qty: 1, rate: 85,  note: 'Applied toward repair if work is approved.' },
        { description: 'Parts & materials', qty: 1, rate: 120, note: 'Estimated — refine once on-site.' },
        { description: 'Labor (2 hrs)',     qty: 2, rate: 95,  note: 'Adjust based on actual complexity.' },
      ],
    };
  }

  if (isPlumb) {
    if (/water heater/.test(t)) return {
      description: 'Water heater replacement',
      explanation: "Rheem 40-gal, expansion tank (Austin code), 3 hrs labor, permit.",
      items: [
        { description: '40-gal water heater (Rheem Performance)', qty: 1, rate: 620, note: 'Rheem Performance 40-gal. 6yr warranty.' },
        { description: 'Expansion tank & fittings',               qty: 1, rate: 85,  note: 'Required by Austin code on closed-loop systems.' },
        { description: 'Installation labor (3 hrs)',              qty: 3, rate: 95,  note: 'Disconnect, drain, install, test.' },
        { description: 'Permit & inspection',                     qty: 1, rate: 150, note: 'City of Austin requires permit.' },
      ],
    };
    if (/drain|clog/.test(t)) return {
      description: 'Drain cleaning service',
      explanation: "Service call, main line cleaning, optional bio-treatment.",
      items: [
        { description: 'Service call fee',         qty: 1, rate: 85,  note: 'Applied toward total if work done same visit.' },
        { description: 'Main line drain cleaning', qty: 1, rate: 185, note: 'Snake + hydro flush.' },
        { description: 'Bio-treatment (optional)', qty: 1, rate: 45,  note: 'Enzyme treatment. Customer can skip.' },
      ],
    };
    return {
      description: 'Plumbing repair',
      explanation: "Service call, parts, and 2 hours labor. Refine parts after on-site.",
      items: [
        { description: 'Service call fee',  qty: 1, rate: 85,  note: 'Dispatch and assessment.' },
        { description: 'Parts & materials', qty: 1, rate: 120, note: 'Update once scope confirmed.' },
        { description: 'Labor (2 hrs)',     qty: 2, rate: 95,  note: 'Adjust if job runs longer.' },
      ],
    };
  }

  if (isPaint) {
    if (/exterior/.test(t)) return {
      description: 'Exterior house painting',
      explanation: "Power wash, primer on problem walls, 4 gal SW Emerald, 2 days labor.",
      items: [
        { description: 'Power wash & surface prep',                   qty: 1, rate: 280, note: 'Full exterior power wash and crack repair.' },
        { description: 'Primer coat (problem walls)',                 qty: 1, rate: 350, note: 'Spot-prime bare wood and peeling sections.' },
        { description: 'Sherwin-Williams Emerald exterior (2 coats)', qty: 4, rate: 68,  note: 'SW Emerald — $68/gal contractor pricing.' },
        { description: 'Labor (2 days)',                              qty: 2, rate: 650, note: '2 full days for prep + 2-coat finish.' },
      ],
    };
    if (/interior|room/.test(t)) return {
      description: 'Interior painting',
      explanation: "Prep, 2 gal SW Cashmere for 2 rooms, $350/room labor.",
      items: [
        { description: 'Surface prep, tape & drop cloths', qty: 1, rate: 120, note: 'Spackle, sand, tape, lay drop cloths.' },
        { description: 'Sherwin-Williams Cashmere (2 gal)', qty: 2, rate: 58, note: 'Contractor rate $58/gal.' },
        { description: 'Labor per room',                   qty: 2, rate: 350, note: '$350/room is Austin market standard.' },
      ],
    };
    return {
      description: 'Painting service',
      explanation: "Prep, paint, and a day of labor. Adjust labor if it's a shorter job.",
      items: [
        { description: 'Surface prep & primer',  qty: 1, rate: 220 },
        { description: 'Paint & materials',      qty: 2, rate: 58  },
        { description: 'Labor',                  qty: 1, rate: 650 },
      ],
    };
  }

  return {
    description: input.length > 60 ? input.slice(0, 60) + '…' : input || 'Service',
    explanation: "Basic line item set up — fill in the rate once you've assessed the job.",
    items: [{ description: 'Service & labor', qty: 1, rate: 0, note: 'Update after on-site assessment.' }],
  };
}

const VOICE_TRANSCRIPTS: Record<ServiceType, string> = {
  HVAC:     "Replace the outdoor condenser unit on the AC system, recharge the refrigerant, and swap out the air filter while we're there.",
  Plumbing: "Fix the slow drain in the master bath sink, check the P-trap under the kitchen sink, and clean out the main line.",
  Painting: "Paint the exterior of the house — south and west walls need prep work and a primer coat first before the finish coat.",
};
const PHOTO_PROMPTS: Record<ServiceType, string> = {
  HVAC:     'condenser unit showing corrosion on coil fins and refrigerant oil staining',
  Plumbing: 'slow drain with visible buildup and P-trap access panel',
  Painting: 'exterior south wall with peeling paint and bare wood near the trim',
};

// ─── Waveform ─────────────────────────────────────────────────────────────────
function Waveform({ active }: { active: boolean }) {
  return (
    <div className="flex items-center justify-center gap-[3px] h-8">
      {Array.from({ length: 22 }).map((_, i) => (
        <div key={i}
          className={`w-[3px] rounded-full ${active ? 'bg-destructive' : 'bg-muted'}`}
          style={{
            animation: active ? 'waveBar 0.7s ease-in-out infinite' : 'none',
            animationDelay: `${i * 0.035}s`, height: '100%',
          }}
        />
      ))}
      <style>{`@keyframes waveBar { 0%,100%{transform:scaleY(0.12)} 50%{transform:scaleY(1)} }`}</style>
    </div>
  );
}

// ─── AI Result card ───────────────────────────────────────────────────────────
function AIResultCard({ result, editable, onToggleEdit, onUpdateItems }: {
  result: AIResult; editable: boolean;
  onToggleEdit: () => void;
  onUpdateItems: (items: AILineItem[]) => void;
}) {
  const [draft,   setDraft]   = useState<AILineItem[]>(result.items);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const total      = result.items.reduce((s, i) => s + i.qty * i.rate, 0);
  const draftTotal = draft.reduce((s, i) => s + i.qty * i.rate, 0);

  function update(idx: number, field: keyof LineItem, val: string) {
    setDraft(p => p.map((item, i) =>
      i === idx ? { ...item, [field]: field === 'description' ? val : parseFloat(val) || 0 } : item
    ));
  }
  function save()   { onUpdateItems(draft); onToggleEdit(); }
  function cancel() { setDraft(result.items); onToggleEdit(); }

  return (
    <div className="flex flex-col gap-3" style={{ animation: 'fadeUp 0.3s ease' }}>
      <div className="flex items-start gap-2.5">
        <div className="flex size-7 items-center justify-center rounded-full bg-primary shrink-0 mt-0.5">
          <Sparkles size={12} className="text-primary-foreground" />
        </div>
        <div className="flex-1 bg-primary/10 border border-primary/20 rounded-2xl rounded-tl-sm px-4 py-3">
          <p className="text-xs text-primary mb-1">Rivet AI</p>
          <p className="text-sm text-primary leading-relaxed">{result.explanation}</p>
        </div>
      </div>

      <div className="rounded-xl border border-border overflow-hidden bg-card">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="text-xs text-muted-foreground">
            {result.items.length} items · <span className="text-foreground">{result.description}</span>
          </p>
          {!editable ? (
            <button onClick={onToggleEdit}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground border border-border rounded-lg px-2.5 py-1 hover:bg-secondary transition-colors">
              <Pencil size={10} /> Edit
            </button>
          ) : (
            <div className="flex gap-1.5">
              <button onClick={save} className="flex items-center gap-1 text-xs text-primary-foreground bg-primary rounded-lg px-2.5 py-1">
                <Check size={10} /> Save
              </button>
              <button onClick={cancel} className="text-xs text-muted-foreground border border-border rounded-lg px-2.5 py-1 hover:bg-secondary">
                Cancel
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-[1fr_40px_70px_70px] gap-x-2 px-4 py-2 bg-secondary border-b border-border">
          <p className="text-xs text-muted-foreground">Item</p>
          <p className="text-xs text-muted-foreground text-right">Qty</p>
          <p className="text-xs text-muted-foreground text-right">Rate</p>
          <p className="text-xs text-muted-foreground text-right">Total</p>
        </div>

        <div className="divide-y divide-border">
          {(editable ? draft : result.items).map((item, i) => (
            <div key={i}>
              {editable ? (
                <div className="grid grid-cols-[1fr_40px_70px_70px_16px] gap-x-2 px-4 py-2.5 items-center">
                  <input value={item.description} onChange={e => update(i, 'description', e.target.value)}
                    className="text-sm border border-border rounded-lg px-2 py-1 focus:outline-none focus:border-primary w-full" />
                  <input value={item.qty || ''} onChange={e => update(i, 'qty', e.target.value)}
                    type="number" min="1"
                    className="text-sm border border-border rounded-lg px-1 py-1 text-right focus:outline-none focus:border-primary w-full" />
                  <input value={item.rate || ''} onChange={e => update(i, 'rate', e.target.value)}
                    type="number" min="0"
                    className="text-sm border border-border rounded-lg px-1 py-1 text-right focus:outline-none focus:border-primary w-full" />
                  <p className="text-sm text-foreground text-right">${(item.qty * item.rate).toLocaleString()}</p>
                  <button onClick={() => setDraft(p => p.filter((_, j) => j !== i))}
                    className="text-muted-foreground hover:text-destructive transition-colors">
                    <Trash2 size={12} />
                  </button>
                </div>
              ) : (
                <>
                  <button onClick={() => item.note ? setOpenIdx(openIdx === i ? null : i) : undefined}
                    className={`w-full grid grid-cols-[1fr_40px_70px_70px_16px] gap-x-2 px-4 py-2.5 items-center text-left ${item.note ? 'hover:bg-secondary cursor-pointer' : 'cursor-default'} transition-colors`}>
                    <p className="text-sm text-foreground leading-snug">{item.description}</p>
                    <p className="text-sm text-muted-foreground text-right">{item.qty}</p>
                    <p className="text-sm text-muted-foreground text-right">${item.rate.toLocaleString()}</p>
                    <p className="text-sm text-foreground text-right">${(item.qty * item.rate).toLocaleString()}</p>
                    {item.note
                      ? <ChevronDown size={12} className={`text-muted-foreground transition-transform shrink-0 ${openIdx === i ? 'rotate-180' : ''}`} />
                      : <span />
                    }
                  </button>
                  {item.note && openIdx === i && (
                    <div className="px-4 pb-3 pt-1 bg-primary/10 border-t border-primary/20"
                      style={{ animation: 'fadeUp 0.15s ease' }}>
                      <p className="text-xs text-primary leading-relaxed">{item.note}</p>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>

        {editable && (
          <button onClick={() => setDraft(p => [...p, { description: '', qty: 1, rate: 0 }])}
            className="flex items-center gap-1.5 px-4 py-2.5 text-xs text-primary hover:bg-primary/10 w-full border-t border-border">
            <Plus size={11} /> Add line item
          </button>
        )}

        <div className="flex items-center justify-between px-4 py-3.5 border-t border-border bg-secondary">
          <p className="text-sm text-foreground">Total</p>
          <p className="text-foreground">${(editable ? draftTotal : total).toLocaleString()}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Voice input ──────────────────────────────────────────────────────────────
function VoiceInput({ svcType, onResult }: { svcType?: ServiceType; onResult: (r: AIResult) => void }) {
  const [phase,      setPhase]      = useState<VoicePhase>('idle');
  const [seconds,    setSeconds]    = useState(0);
  const [transcript, setTranscript] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (phase !== 'recording') return;
    timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phase]);

  useEffect(() => {
    if (phase === 'recording' && seconds >= 9) stop();
  }, [seconds, phase]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Cleanup media stream on unmount
  useEffect(() => {
    return () => { mediaRecorderRef.current?.stream?.getTracks().forEach(t => t.stop()); };
  }, []);

  async function start() {
    setPhase('recording'); setSeconds(0);
    audioChunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.start();
    } catch {
      setTranscript('(Microphone not available)');
      setPhase('transcribed');
    }
  }

  function stop() {
    if (timerRef.current) clearInterval(timerRef.current);
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      setPhase('transcribed');
      return;
    }
    setPhase('processing');
    recorder.onstop = async () => {
      recorder.stream.getTracks().forEach(t => t.stop());
      const audioBlob = new Blob(audioChunksRef.current, { type: recorder.mimeType });
      try {
        const fd = new FormData();
        fd.append('audio', audioBlob, 'recording.webm');
        const res = await apiFetch('/api/voice/transcribe', { method: 'POST', body: fd });
        if (res.ok) {
          const data = await res.json();
          setTranscript(data.transcript || '(Could not transcribe)');
        } else {
          setTranscript('(Transcription service unavailable)');
        }
      } catch {
        setTranscript('(Transcription service unavailable)');
      }
      setPhase('transcribed');
    };
    recorder.stop();
  }

  function build() {
    setPhase('generating');
    void suggestEstimate(transcript, svcType).then(result => {
      onResult(result);
      setPhase('done');
    });
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  if (phase === 'idle') return (
    <div className="flex flex-col items-center gap-5 py-6">
      <p className="text-sm text-muted-foreground text-center px-4 leading-relaxed">
        Describe what needs to be done — parts, problems, scope. AI builds the estimate from your words.
      </p>
      <button onClick={start} className="group flex flex-col items-center gap-3">
        <div className="relative flex size-20 items-center justify-center rounded-full bg-primary shadow-xl shadow-border/20 hover:bg-primary/90 active:scale-95 transition-all">
          <Mic size={28} className="text-primary-foreground" />
          <div className="absolute inset-0 rounded-full border-2 border-primary/20 scale-110 group-hover:scale-125 transition-transform" />
        </div>
        <p className="text-sm text-foreground">Tap to start recording</p>
      </button>
    </div>
  );

  if (phase === 'recording') return (
    <div className="flex flex-col items-center gap-4 py-6">
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-full bg-destructive animate-pulse" />
        <p className="text-sm text-destructive">{fmt(seconds)} · Recording…</p>
      </div>
      <Waveform active />
      <button onClick={stop}
        className="flex items-center gap-2 rounded-xl bg-destructive text-primary-foreground px-6 py-3 text-sm hover:bg-destructive active:scale-95 transition-all shadow-lg shadow-destructive/30">
        <StopCircle size={16} /> Tap to stop
      </button>
      <p className="text-xs text-muted-foreground">Auto-stops at 10s</p>
    </div>
  );

  if (phase === 'processing') return (
    <div className="flex flex-col items-center gap-3 py-10">
      <Waveform active={false} />
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="size-4 rounded-full border-2 border-border border-t-border animate-spin" />
        Transcribing…
      </div>
    </div>
  );

  if (phase === 'transcribed') return (
    <div className="flex flex-col gap-4 py-2">
      <div className="flex items-start gap-2.5">
        <div className="flex size-7 items-center justify-center rounded-full bg-primary shrink-0 mt-0.5">
          <Mic size={12} className="text-primary-foreground" />
        </div>
        <div className="flex-1 bg-secondary rounded-2xl rounded-tl-sm px-4 py-3">
          <p className="text-xs text-muted-foreground mb-1">Your recording</p>
          <p className="text-sm text-foreground leading-relaxed italic">"{transcript}"</p>
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={() => { setPhase('idle'); setTranscript(''); }}
          className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-2.5 text-sm text-foreground hover:bg-secondary transition-colors">
          <RotateCcw size={13} /> Re-record
        </button>
        <button onClick={build}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-primary text-primary-foreground py-2.5 text-sm hover:bg-primary transition-colors">
          <Sparkles size={14} /> Build estimate
        </button>
      </div>
    </div>
  );

  if (phase === 'generating') return (
    <div className="flex flex-col items-center gap-4 py-10">
      <div className="flex size-12 items-center justify-center rounded-full bg-primary/15">
        <Sparkles size={20} className="text-primary animate-pulse" />
      </div>
      <div className="text-center">
        <p className="text-sm text-foreground">Building your estimate…</p>
        <p className="text-xs text-muted-foreground mt-1">Matching parts to Austin market rates</p>
      </div>
    </div>
  );

  return null;
}

// ─── Manual catalog build input ───────────────────────────────────────────────
// Line-item category is a label, not a status — collapse to one neutral chip;
// the category text itself differentiates the rows (Path A stays calm).
const CATEGORY_COLOR: Record<string, string> = {
  Service:     'bg-secondary text-muted-foreground',
  Labor:       'bg-secondary text-muted-foreground',
  // The live catalog API (CatalogCategory) returns plural 'Parts' / 'Materials';
  // the bundled MANUAL_CATALOG uses the singular forms. Key on both so real
  // Price Book items don't fall through to the default chip.
  Part:        'bg-secondary text-muted-foreground',
  Parts:       'bg-secondary text-muted-foreground',
  Material:    'bg-secondary text-muted-foreground',
  Materials:   'bg-secondary text-muted-foreground',
  Equipment:   'bg-secondary text-muted-foreground',
  'Parts+Labor':'bg-secondary text-muted-foreground',
};

// Shape of a catalog item from GET /api/catalog/items, mapped into the
// wizard's CatalogItem so real Price Book entries render in the toggle list.
interface ApiCatalogItem {
  id: string;
  name: string;
  unitPriceCents: number;
  unit?: string;
  category?: string;
}
function apiCatalogToCatalogItem(it: ApiCatalogItem): CatalogItem {
  return {
    id: it.id,
    name: it.name,
    defaultRate: it.unitPriceCents / 100,
    defaultQty: 1,
    ...(it.unit ? { unit: it.unit } : {}),
    category: it.category ?? 'Service',
  };
}

function ManualBuildInput({ svcType: initialSvc, onResult }: {
  svcType?: ServiceType;
  onResult: (r: AIResult) => void;
}) {
  const [svcType,  setSvcType]  = useState<ServiceType>(initialSvc ?? 'HVAC');
  const [selected, setSelected] = useState<ManualItem[]>([]);
  const [showCustom, setShowCustom] = useState(false);
  const [customDraft, setCustom] = useState({ desc: '', qty: '1', rate: '' });

  // Prefer the tenant's real Price Book. Catalog items aren't service-typed,
  // so when they exist we show them all (the service tabs still set the
  // estimate's summary label). With an empty Price Book we fall back to the
  // bundled starter catalog keyed by service type — same fallback spirit as
  // the AI-suggest path's local generator.
  // This toggle list has no in-flow search/paging, so request the API's max
  // page size (500, matching the CSV import cap) so larger Price Books are
  // fully reachable here. The shared editor's CatalogPicker pages smaller
  // because it has server-side search.
  const { data: apiCatalog, isLoading: catalogLoading } = useListQuery<ApiCatalogItem>('/api/catalog/items', { pageSize: 500 });
  const realCatalog = Array.isArray(apiCatalog) ? apiCatalog.map(apiCatalogToCatalogItem) : [];
  // Don't fall back to the bundled starter catalog while the Price Book is
  // still loading — otherwise a tenant that *has* items could briefly tap
  // hardcoded starter pricing before the real list lands. Only fall back once
  // the fetch has settled and confirmed there are no items (covers empty + error).
  const catalog = realCatalog.length > 0
    ? realCatalog
    : (catalogLoading ? [] : MANUAL_CATALOG[svcType]);
  const total   = selected.reduce((s, i) => s + i.qty * i.rate, 0);

  function toggleItem(item: CatalogItem) {
    if (selected.find(s => s.id === item.id)) {
      setSelected(p => p.filter(s => s.id !== item.id));
    } else {
      setSelected(p => [...p, {
        id:          item.id,
        description: item.name,
        qty:         item.defaultQty,
        rate:        item.defaultRate,
      }]);
    }
  }

  function updateItem(id: string, field: 'qty' | 'rate', val: string) {
    const n = parseFloat(val) || 0;
    setSelected(p => p.map(s => s.id === id ? { ...s, [field]: field === 'qty' ? Math.max(1, Math.round(n)) : n } : s));
  }

  function addCustom() {
    if (!customDraft.desc.trim() || !customDraft.rate) return;
    setSelected(p => [...p, {
      id:          `custom-${Date.now()}`,
      description: customDraft.desc.trim(),
      qty:         parseInt(customDraft.qty) || 1,
      rate:        parseFloat(customDraft.rate) || 0,
      isCustom:    true,
    }]);
    setCustom({ desc: '', qty: '1', rate: '' });
    setShowCustom(false);
  }

  function build() {
    const DESCS: Record<ServiceType, string> = {
      HVAC:     'HVAC service & repair',
      Plumbing: 'Plumbing service & repair',
      Painting: 'Painting services',
    };
    onResult({
      description: DESCS[svcType],
      explanation: `${selected.length} item${selected.length !== 1 ? 's' : ''} added from your catalog — prices pre-populated and ready to edit.`,
      items: selected.map(s => ({ description: s.description, qty: s.qty, rate: s.rate })),
    });
  }

  return (
    <div className="flex flex-col gap-4 py-2">

      {/* Service type selector */}
      <div>
        <p className="text-xs text-muted-foreground mb-2">Service type</p>
        <div className="flex gap-2">
          {(['HVAC', 'Plumbing', 'Painting'] as ServiceType[]).map(s => (
            <button key={s} onClick={() => { setSvcType(s); setSelected([]); }}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-full border py-2 text-sm transition-all ${
                svcType === s
                  ? `${SVC_CHIP[s]} border-current shadow-sm`
                  : 'border-border text-muted-foreground hover:border-border bg-card'
              }`}>
              {SVC_ICON[s]} {s}
            </button>
          ))}
        </div>
      </div>

      {/* Catalog list */}
      <div>
        <p className="text-xs text-muted-foreground mb-2">Tap items to add — prices pre-filled &amp; editable</p>
        <div className="flex flex-col gap-1.5">
          {catalogLoading && catalog.length === 0 && (
            <p className="text-xs text-muted-foreground">Loading your price book…</p>
          )}
          {catalog.map(item => {
            const isSel = !!selected.find(s => s.id === item.id);
            return (
              <button key={item.id} onClick={() => toggleItem(item)}
                className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-all ${
                  isSel
                    ? 'border-primary/30 bg-primary/10 shadow-sm'
                    : 'border-border bg-card hover:border-border hover:bg-secondary'
                }`}>
                {/* Checkbox */}
                <div className={`flex size-5 items-center justify-center rounded-full border-2 transition-all shrink-0 ${
                  isSel ? 'border-primary bg-primary' : 'border-border'
                }`}>
                  {isSel && <Check size={11} className="text-primary-foreground" />}
                </div>
                {/* Name + category */}
                <div className="flex-1 min-w-0">
                  <p className={`text-sm ${isSel ? 'text-primary' : 'text-foreground'}`}>{item.name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={`text-xs rounded-full px-1.5 py-0.5 ${CATEGORY_COLOR[item.category] ?? 'bg-secondary text-muted-foreground'}`}>
                      {item.category}
                    </span>
                    {item.unit && <span className="text-xs text-muted-foreground">{item.unit}</span>}
                  </div>
                </div>
                {/* Pre-populated price */}
                <p className={`text-sm shrink-0 ${isSel ? 'text-primary' : 'text-muted-foreground'}`}>
                  ${item.defaultRate % 1 === 0 ? item.defaultRate.toLocaleString() : item.defaultRate.toFixed(2)}
                </p>
              </button>
            );
          })}

          {/* Other — custom row */}
          {!showCustom ? (
            <button onClick={() => setShowCustom(true)}
              className="flex items-center gap-3 rounded-xl border-2 border-dashed border-border px-3.5 py-3 hover:border-primary/30 hover:bg-primary/10 transition-all">
              <div className="flex size-5 items-center justify-center rounded-full border-2 border-border shrink-0">
                <Plus size={10} className="text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">Other — add custom item</p>
            </button>
          ) : (
            <div className="rounded-xl border-2 border-primary/30 bg-primary/10 p-3 flex flex-col gap-2.5"
              style={{ animation: 'fadeUp 0.15s ease' }}>
              <input
                autoFocus
                value={customDraft.desc}
                onChange={e => setCustom(d => ({ ...d, desc: e.target.value }))}
                placeholder="Item description"
                className="w-full rounded-xl border border-border bg-card px-3.5 py-2.5 text-sm focus:outline-none focus:border-primary transition-colors"
              />
              <div className="flex gap-2 items-center">
                <div className="flex flex-col gap-0.5">
                  <p className="text-xs text-muted-foreground px-0.5">Qty</p>
                  <input
                    value={customDraft.qty}
                    onChange={e => setCustom(d => ({ ...d, qty: e.target.value }))}
                    type="number" min="1"
                    className="w-14 rounded-xl border border-border bg-card px-2 py-2.5 text-sm text-center focus:outline-none focus:border-primary"
                  />
                </div>
                <div className="flex-1 flex flex-col gap-0.5">
                  <p className="text-xs text-muted-foreground px-0.5">Unit price</p>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                    <input
                      value={customDraft.rate}
                      onChange={e => setCustom(d => ({ ...d, rate: e.target.value }))}
                      type="number" min="0" placeholder="0.00"
                      className="w-full rounded-xl border border-border bg-card pl-7 pr-3 py-2.5 text-sm focus:outline-none focus:border-primary"
                    />
                  </div>
                </div>
                <div className="flex gap-1.5 pt-5">
                  <button
                    onClick={addCustom}
                    disabled={!customDraft.desc.trim() || !customDraft.rate}
                    className="flex items-center gap-1 rounded-xl bg-primary text-primary-foreground px-3.5 py-2.5 text-sm disabled:opacity-40 hover:bg-primary/90 transition-colors">
                    <Plus size={13} /> Add
                  </button>
                  <button onClick={() => { setShowCustom(false); setCustom({ desc: '', qty: '1', rate: '' }); }}
                    className="flex size-10 items-center justify-center rounded-xl border border-border bg-card">
                    <X size={14} className="text-muted-foreground" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Selected items cart */}
      {selected.length > 0 && (
        <div className="rounded-2xl border border-border overflow-hidden bg-card"
          style={{ animation: 'fadeUp 0.2s ease' }}>
          <div className="flex items-center justify-between px-4 py-2.5 bg-secondary border-b border-border">
            <p className="text-xs text-muted-foreground">{selected.length} item{selected.length !== 1 ? 's' : ''} — edit qty &amp; price</p>
            <p className="text-sm text-foreground">${total % 1 === 0 ? total.toLocaleString() : total.toFixed(2)}</p>
          </div>
          <div className="divide-y divide-border">
            {selected.map(item => (
              <div key={item.id} className="flex items-center gap-2 px-4 py-3">
                <p className="flex-1 text-sm text-foreground truncate pr-1">{item.description}</p>
                {/* Qty stepper */}
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => updateItem(item.id, 'qty', String(item.qty - 1))}
                    className="flex size-7 items-center justify-center rounded-lg border border-border hover:bg-secondary active:scale-90 transition-all">
                    <Minus size={10} className="text-muted-foreground" />
                  </button>
                  <span className="w-6 text-center text-sm text-foreground">{item.qty}</span>
                  <button onClick={() => updateItem(item.id, 'qty', String(item.qty + 1))}
                    className="flex size-7 items-center justify-center rounded-lg border border-border hover:bg-secondary active:scale-90 transition-all">
                    <Plus size={10} className="text-muted-foreground" />
                  </button>
                </div>
                {/* Price (editable) */}
                <div className="relative w-[72px] shrink-0">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">$</span>
                  <input
                    value={item.rate || ''}
                    onChange={e => updateItem(item.id, 'rate', e.target.value)}
                    type="number" min="0"
                    className="w-full rounded-lg border border-border pl-5 pr-1.5 py-1.5 text-sm text-right focus:outline-none focus:border-primary transition-colors"
                  />
                </div>
                <button onClick={() => setSelected(p => p.filter(s => s.id !== item.id))}
                  className="text-muted-foreground hover:text-destructive transition-colors shrink-0">
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-secondary">
            <p className="text-xs text-muted-foreground">Estimated total</p>
            <p className="text-sm text-foreground">${total % 1 === 0 ? total.toLocaleString() : total.toFixed(2)}</p>
          </div>
        </div>
      )}

      {selected.length > 0 && (
        <button onClick={build}
          className="flex items-center justify-center gap-2 w-full rounded-xl bg-primary text-primary-foreground py-3.5 text-sm hover:bg-primary/90 transition-colors">
          <Check size={14} /> Review estimate · ${total % 1 === 0 ? total.toLocaleString() : total.toFixed(2)}
        </button>
      )}
    </div>
  );
}

// ─── Photo input ──────────────────────────────────────────────────────────────
function PhotoInput({ svcType, onResult }: { svcType?: ServiceType; onResult: (r: AIResult) => void }) {
  const [phase,  setPhase]  = useState<PhotoPhase>('idle');
  const [photos, setPhotos] = useState<{ id: number; label: string }[]>([]);
  const svc    = svcType ?? 'HVAC';
  const COLORS = ['bg-primary', 'bg-muted-foreground', 'bg-primary', 'bg-muted-foreground'];

  function add() {
    if (photos.length >= 4) return;
    const labels = ['Job site', 'Equipment', 'Damage detail', 'Access area'];
    setPhotos(p => [...p, { id: Date.now(), label: labels[p.length] }]);
  }
  function analyze() {
    setPhase('analyzing');
    void suggestEstimate(PHOTO_PROMPTS[svc], svc).then(result => {
      onResult(result);
      setPhase('done');
    });
  }

  if (phase === 'idle' || phase === 'analyzing') return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-sm text-muted-foreground">Add photos of the job site or damaged equipment. AI identifies what's needed.</p>
      {photos.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {photos.map((ph, i) => (
            <div key={ph.id} className={`relative rounded-xl overflow-hidden ${COLORS[i]} aspect-video flex items-center justify-center`}
              style={{ animation: 'fadeUp 0.2s ease' }}>
              <div className="flex flex-col items-center gap-1">
                <Image size={20} className="text-primary-foreground/60" />
                <p className="text-xs text-primary-foreground/60">{ph.label}</p>
              </div>
              <button onClick={() => setPhotos(p => p.filter(x => x.id !== ph.id))}
                className="absolute top-2 right-2 flex size-5 items-center justify-center rounded-full bg-black/40">
                <X size={10} className="text-primary-foreground" />
              </button>
            </div>
          ))}
          {photos.length < 4 && (
            <button onClick={add} className="rounded-xl border-2 border-dashed border-border aspect-video flex flex-col items-center justify-center gap-1.5 hover:border-border hover:bg-secondary transition-colors">
              <Plus size={18} className="text-muted-foreground" />
              <p className="text-xs text-muted-foreground">Add photo</p>
            </button>
          )}
        </div>
      )}
      {photos.length === 0 ? (
        <button onClick={add} className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-border py-10 hover:border-border hover:bg-secondary transition-colors">
          <div className="flex size-14 items-center justify-center rounded-full bg-secondary">
            <Camera size={24} className="text-muted-foreground" />
          </div>
          <div className="text-center">
            <p className="text-sm text-foreground">Take or upload a photo</p>
            <p className="text-xs text-muted-foreground mt-0.5">Up to 4 photos</p>
          </div>
        </button>
      ) : (
        phase === 'analyzing' ? (
          <div className="flex items-center justify-center gap-2 py-4">
            <span className="size-4 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
            <p className="text-sm text-foreground">Analyzing {photos.length} photo{photos.length > 1 ? 's' : ''}…</p>
          </div>
        ) : (
          <button onClick={analyze} className="flex items-center justify-center gap-1.5 w-full rounded-xl bg-primary text-primary-foreground py-3 text-sm hover:bg-primary transition-colors">
            <Sparkles size={14} /> Analyze photos &amp; build estimate
          </button>
        )
      )}
    </div>
  );
  return null;
}

// ─── Inline customer picker ───────────────────────────────────────────────────
function InlineCustomerPicker({ selectedId, onSelect, customers }: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  customers: EstimateCustomer[];
}) {
  const [search, setSearch] = useState('');
  const filtered = search
    ? customers.filter(c => c.name.toLowerCase().includes(search.toLowerCase()))
    : customers;

  return (
    <div className="rounded-xl border border-warning/30 bg-warning/10 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-warning/30 bg-warning/10">
        <p className="text-xs text-warning">Who is this estimate for?</p>
      </div>
      <div className="px-3 py-2">
        <div className="flex items-center gap-2 rounded-lg bg-card border border-warning/30 px-3 py-1.5 mb-2">
          <Search size={12} className="text-warning shrink-0" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            className="flex-1 bg-transparent text-sm text-foreground placeholder-warning/70 outline-none" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {filtered.map(c => (
            <button key={c.id} onClick={() => onSelect(c.id)}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs transition-all ${
                selectedId === c.id
                  ? 'bg-primary border-primary text-primary-foreground'
                  : 'bg-card border-border text-foreground hover:border-border'
              }`}>
              <span className="size-4 flex items-center justify-center rounded-full bg-secondary text-foreground" style={{ fontSize: 9 }}>
                {c.name[0]}
              </span>
              {c.name.split(' ')[0]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main flow ────────────────────────────────────────────────────────────────
export function NewEstimateFlow({ onClose, onCreated, preSelectedCustomerId }: {
  onClose: () => void;
  onCreated: () => void;
  preSelectedCustomerId?: string;
}) {
  const { user } = useUser();
  const apiClient = useApiClient();
  const estimateTerm = useEstimateTerm();
  const { data: apiCustomers } = useListQuery<ApiCustomer>('/api/customers');
  const customers = mapApiCustomers(apiCustomers);
  const [businessName, setBusinessName] = useState('');

  const ownerFirstName = firstNameFromUser(
    user?.fullName,
    user?.primaryEmailAddress?.emailAddress,
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiClient('/api/settings');
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { businessName?: string };
        if (typeof data.businessName === 'string' && data.businessName.trim()) {
          setBusinessName(data.businessName.trim());
        }
      } catch {
        /* non-fatal — preview falls back to owner first name only */
      }
    })();
    return () => { alive = false; };
  }, [apiClient]);

  const [step,       setStep]      = useState<FlowStep>('start');
  const [startMode,  setStartMode] = useState<StartMode>(null);
  const [customerId, setCustId]    = useState<string | null>(preSelectedCustomerId ?? null);
  const [locationId, setLocId]     = useState<string | null>(null);
  const [inputMode,  setInputMode] = useState<InputMode>('voice');
  const [aiResult,   setAiResult]  = useState<AIResult | null>(null);
  const [editMode,   setEditMode]  = useState(false);
  const [validUntil, setValidUntil]= useState('Apr 10, 2026');
  const [channel,    setChannel]   = useState<'sms' | 'email'>('sms');
  const [sending,    setSending]   = useState(false);
  const [sent,       setSent]      = useState(false);
  const [savedDraft, setSaved]     = useState(false);
  const [voiceKey,   setVoiceKey]  = useState(0);
  const [manualKey,  setManualKey] = useState(0);
  const [photoKey,   setPhotoKey]  = useState(0);

  // U1 (E1) — a real estimate requires a jobId (createEstimateSchema is
  // strict; the money/job graph hangs off it). We fetch the chosen
  // customer's jobs for a picker, and offer "create a job for this
  // customer" when there are none, so a jobId always exists before create.
  const [jobs,        setJobs]        = useState<ApiJob[]>([]);
  const [jobsLoaded,  setJobsLoaded]  = useState(false);
  const [jobId,       setJobId]       = useState<string | null>(null);
  const [creatingJob, setCreatingJob] = useState(false);
  // Surfaced API error from the create/send flow (no silent mock success).
  const [submitError, setSubmitError] = useState<string | null>(null);
  // viewUrl returned by POST /api/estimates/:id/send — used for the real
  // share link in the SMS/email preview (replaces the fake rivet.ai link).
  const [viewUrl,     setViewUrl]     = useState<string | null>(null);

  // Fetch the selected customer's jobs whenever the customer changes.
  useEffect(() => {
    if (!customerId) { setJobs([]); setJobsLoaded(false); setJobId(null); return; }
    let alive = true;
    setJobsLoaded(false);
    setJobId(null);
    apiFetch(`/api/jobs?customerId=${encodeURIComponent(customerId)}`)
      .then(r => (r.ok ? r.json() : []))
      .then((data: ApiJob[] | { data?: ApiJob[] }) => {
        if (!alive) return;
        const list = Array.isArray(data) ? data : (data?.data ?? []);
        setJobs(list);
        // Auto-select when the customer has exactly one job.
        if (list.length === 1) setJobId(list[0].id);
        setJobsLoaded(true);
      })
      .catch(() => { if (alive) { setJobs([]); setJobsLoaded(true); } });
    return () => { alive = false; };
  }, [customerId]);

  async function createJobForCustomer(): Promise<string | null> {
    if (!customerId) return null;
    const locId = locationId ?? primaryLoc?.id ?? customer?.locations[0]?.id;
    if (!locId) {
      setSubmitError('This customer has no service location — add one before creating a job.');
      return null;
    }
    setCreatingJob(true);
    setSubmitError(null);
    try {
      const res = await apiFetch('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({
          customerId,
          locationId: locId,
          summary: aiResult?.description || 'New job',
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { message?: string })?.message ?? `HTTP ${res.status}`);
      }
      const created = await res.json() as ApiJob;
      setJobs(prev => [created, ...prev]);
      setJobId(created.id);
      return created.id;
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to create job');
      return null;
    } finally {
      setCreatingJob(false);
    }
  }

  const customer   = customers.find(c => c.id === customerId);
  const multiLoc   = (customer?.locations.length ?? 0) > 1;
  const location   = customer?.locations.find(l => l.id === locationId);
  const primaryLoc = customer?.locations.find(l => l.isPrimary) ?? customer?.locations[0];
  const address    = (locationId ? location?.address : primaryLoc?.address) ?? customer?.address ?? '';
  const svcType    = (locationId ? location?.serviceTypes[0] : primaryLoc?.serviceTypes[0]) ?? customer?.serviceType;
  const firstName  = customer?.name.split(' ')[0] ?? 'there';
  const estNum     = 'EST-0049';
  const lineItems  = aiResult?.items ?? [];
  const total      = lineItems.reduce((s, i) => s + i.qty * i.rate, 0);

  function selectCustomer(id: string) {
    setCustId(id);
    const c = customers.find(c => c.id === id);
    setLocId((c?.locations.length ?? 0) <= 1 ? (c?.locations[0]?.id ?? null) : null);
  }

  function switchMode(mode: InputMode) {
    setInputMode(mode); setAiResult(null); setEditMode(false);
    if (mode === 'voice')  setVoiceKey(k => k + 1);
    if (mode === 'manual') setManualKey(k => k + 1);
    if (mode === 'photo')  setPhotoKey(k => k + 1);
  }

  const canReview = !!aiResult && !!customerId;

  function goBack() {
    if (step === 'send')    { setStep('review'); return; }
    if (step === 'review')  { setStep('describe'); return; }
    if (step === 'describe') { setAiResult(null); setStep('start'); return; }
  }

  const MODE_TABS: { key: InputMode; icon: typeof Mic; label: string }[] = [
    { key: 'voice',  icon: Mic,        label: 'Voice'  },
    { key: 'manual', icon: ListChecks, label: 'Manual' },
    { key: 'photo',  icon: Camera,     label: 'Photos' },
  ];

  const stepOrder: FlowStep[] = ['describe', 'review'];
  const dotIndex = stepOrder.indexOf(step === 'send' ? 'review' : step);

  const senderLine = businessName
    ? `${ownerFirstName}, ${businessName}`
    : ownerFirstName;
  // The share link is the real `viewUrl` returned by the send endpoint.
  // Before the estimate is sent we show a neutral placeholder rather than a
  // fabricated rivet.ai/… string (which never resolved to anything).
  const shareLink = viewUrl ?? 'Link generated when you send';
  const smsMsg   = `Hi ${firstName},\n\nEstimate for ${aiResult?.description ?? 'your job'} is ready.\n\nTotal: $${total.toLocaleString()}\n\nReview here:\n${shareLink}\n\n– ${senderLine}`;
  const emailMsg = `Hi ${firstName},\n\n${estNum} is ready for your review.\n\nService: ${aiResult?.description}\nTotal: $${total.toLocaleString()}\n\n${shareLink}\n\nThank you,\n${ownerFirstName}\n${businessName || 'Your team'}`;

  // Map the wizard's dollar-based line items to the strict create contract
  // (integer cents — never qty*rate/100 for the stored price).
  function buildLineItemsPayload() {
    return lineItems.map((it, i) => {
      const unitPriceCents = Math.round(it.rate * 100);
      return {
        id: `li-${i}-${Date.now().toString(36)}`,
        description: it.description.trim(),
        quantity: it.qty,
        unitPriceCents,
        totalCents: Math.round(it.rate * 100 * it.qty),
        sortOrder: i,
        taxable: false,
      };
    });
  }

  // Ensure a jobId exists (auto-create one for the customer if none chosen),
  // then POST /api/estimates. Returns the new estimate id, or null on error
  // (error surfaced via submitError; the caller must not claim success).
  async function createEstimate(): Promise<string | null> {
    setSubmitError(null);
    let useJobId = jobId;
    if (!useJobId) {
      useJobId = await createJobForCustomer();
      if (!useJobId) return null;
    }
    let validUntilIso: string | undefined;
    if (validUntil.trim()) {
      const d = new Date(validUntil);
      if (!Number.isNaN(d.getTime())) validUntilIso = d.toISOString();
    }
    try {
      const res = await apiFetch('/api/estimates', {
        method: 'POST',
        body: JSON.stringify({
          jobId: useJobId,
          lineItems: buildLineItemsPayload(),
          validUntil: validUntilIso,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { message?: string })?.message ?? `HTTP ${res.status}`);
      }
      const created = await res.json() as { id: string };
      return created.id;
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to create estimate');
      return null;
    }
  }

  async function handleSend() {
    setSending(true);
    setSubmitError(null);
    const id = await createEstimate();
    if (!id) { setSending(false); return; }
    try {
      const res = await apiFetch(`/api/estimates/${id}/send`, {
        method: 'POST',
        body: JSON.stringify({ channel }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { message?: string })?.message ?? `HTTP ${res.status}`);
      }
      const result = await res.json() as { viewUrl?: string };
      if (result.viewUrl) setViewUrl(result.viewUrl);
      setSending(false);
      setSent(true);
      setTimeout(() => { onCreated(); onClose(); }, 1200);
    } catch (err) {
      setSending(false);
      setSubmitError(err instanceof Error ? err.message : 'Send failed');
    }
  }

  async function saveAsDraft() {
    setSubmitError(null);
    const id = await createEstimate();
    if (!id) return;
    setSaved(true);
    setTimeout(() => { onCreated(); onClose(); }, 1100);
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/50 md:items-center md:justify-center" onClick={onClose}>
      <div
        className="mt-auto md:mt-0 bg-card rounded-t-3xl md:rounded-2xl w-full md:max-w-lg max-h-[94vh] overflow-hidden flex flex-col shadow-2xl"
        style={{ animation: 'sheetUp 0.28s cubic-bezier(0.32,0.72,0,1)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            {step !== 'start' && (
              <button onClick={goBack} className="text-muted-foreground hover:text-foreground transition-colors">
                <ArrowLeft size={16} />
              </button>
            )}
            {step !== 'start' && dotIndex >= 0 && (
              <div className="flex gap-1.5">
                {stepOrder.map((_, i) => (
                  <div key={i} className={`rounded-full transition-all duration-200 ${
                    i < dotIndex   ? 'w-2 h-2 bg-primary' :
                    i === dotIndex ? 'w-5 h-2 bg-primary' : 'w-2 h-2 bg-border'
                  }`} />
                ))}
              </div>
            )}
            <p className="text-sm text-foreground">
              {step === 'start'    ? `New ${estimateTerm.toLowerCase()}` :
               step === 'describe' ? 'Describe the job' :
               step === 'send'     ? `Send ${estimateTerm.toLowerCase()}` : 'Review & send'}
            </p>
          </div>
          <button onClick={onClose} className="flex size-7 items-center justify-center rounded-full hover:bg-secondary transition-colors">
            <X size={15} className="text-muted-foreground" />
          </button>
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto">

          {/* ── Start screen ── */}
          {step === 'start' && (
            <div className="p-5 flex flex-col gap-3">
              {/* Customer chip if pre-selected */}
              {preSelectedCustomerId && customer && (
                <div className="flex items-center gap-2.5 rounded-xl bg-success/10 border border-success/30 px-3.5 py-2.5 mb-1">
                  <div className="flex size-7 items-center justify-center rounded-full bg-success/15 shrink-0">
                    <Check size={12} className="text-success" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground">{customer.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{address || customer.address}</p>
                  </div>
                </div>
              )}

              <p className="text-sm text-muted-foreground mb-1">How would you like to build this {estimateTerm.toLowerCase()}?</p>

              {/* Speak it */}
              <button
                onClick={() => { setStartMode('voice'); setInputMode('voice'); setStep('describe'); }}
                className="flex items-start gap-4 rounded-2xl border-2 border-border bg-card px-5 py-4 text-left hover:border-primary/30 hover:shadow-sm active:bg-secondary transition-all group">
                <div className="flex size-11 items-center justify-center rounded-2xl bg-primary shrink-0 group-hover:bg-primary transition-colors">
                  <Mic size={20} className="text-primary-foreground" />
                </div>
                <div>
                  <p className="text-foreground">Speak it</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Describe the job out loud — AI builds the estimate from your voice. Fastest for the field.
                  </p>
                </div>
              </button>

              {/* Start new (manual catalog) */}
              <button
                onClick={() => { setStartMode('manual'); setInputMode('manual'); setStep('describe'); }}
                className="flex items-start gap-4 rounded-2xl border-2 border-border bg-card px-5 py-4 text-left hover:border-primary/30 hover:shadow-sm active:bg-secondary transition-all group">
                <div className="flex size-11 items-center justify-center rounded-2xl bg-secondary shrink-0 group-hover:bg-primary/10 transition-colors">
                  <ListChecks size={20} className="text-foreground group-hover:text-primary transition-colors" />
                </div>
                <div>
                  <p className="text-foreground">Start new</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Pick items from your catalog — costs are pre-filled and fully editable. Add custom items too.
                  </p>
                </div>
              </button>
            </div>
          )}

          {/* ── Describe step ── */}
          {step === 'describe' && (
            <div className="flex flex-col">

              {/* Customer chip / inline picker */}
              {customer ? (
                <div className="flex items-center gap-2.5 mx-5 mt-4 rounded-xl bg-secondary border border-border px-3.5 py-2.5">
                  <span className="flex size-7 items-center justify-center rounded-full bg-border text-xs text-foreground shrink-0">
                    {customer.name.split(' ').map(n => n[0]).join('')}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground">{customer.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{address}</p>
                  </div>
                  {!preSelectedCustomerId && (
                    <button onClick={() => { setCustId(null); setLocId(null); }}
                      className="text-xs text-primary hover:underline shrink-0">Change</button>
                  )}
                </div>
              ) : (
                /* Show picker for manual path upfront; voice shows it after result */
                startMode === 'manual' && (
                  <div className="mx-5 mt-4">
                    <InlineCustomerPicker selectedId={customerId} onSelect={selectCustomer} customers={customers} />
                  </div>
                )
              )}

              {/* Multi-location picker */}
              {customerId && multiLoc && !locationId && (
                <div className="mx-5 mt-3 flex flex-col gap-2">
                  <p className="text-xs text-muted-foreground">Select service location</p>
                  {customer?.locations.map(loc => (
                    <button key={loc.id} onClick={() => setLocId(loc.id)}
                      className="flex items-center gap-3 rounded-xl px-4 py-3 text-left border border-border bg-card hover:border-primary/30 hover:bg-primary/10 transition-all">
                      <MapPin size={14} className="text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground">{loc.nickname}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{loc.address}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* Mode tabs */}
              <div className="flex mx-5 mt-3 rounded-xl bg-secondary p-1 gap-1">
                {MODE_TABS.map(({ key, icon: Icon, label }) => (
                  <button key={key} onClick={() => switchMode(key)}
                    className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm transition-all ${
                      inputMode === key ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                    }`}>
                    <Icon size={14} /> {label}
                  </button>
                ))}
              </div>

              <div className="px-5 pb-2 mt-3">
                {/* Input panels */}
                {!aiResult && (
                  <>
                    {inputMode === 'voice'  && <VoiceInput  key={voiceKey}  svcType={svcType} onResult={setAiResult} />}
                    {inputMode === 'manual' && <ManualBuildInput key={manualKey} svcType={svcType} onResult={setAiResult} />}
                    {inputMode === 'photo'  && <PhotoInput  key={photoKey}  svcType={svcType} onResult={setAiResult} />}
                  </>
                )}

                {/* AI / manual result */}
                {aiResult && (
                  <div className="flex flex-col gap-3 pb-4">
                    {/* Inline customer picker for voice-first when no customer yet */}
                    {startMode === 'voice' && !customerId && (
                      <InlineCustomerPicker selectedId={customerId} onSelect={selectCustomer} customers={customers} />
                    )}
                    <AIResultCard
                      result={aiResult}
                      editable={editMode}
                      onToggleEdit={() => setEditMode(e => !e)}
                      onUpdateItems={items => setAiResult(r => r ? { ...r, items } : r)}
                    />
                    <button onClick={() => { setAiResult(null); setEditMode(false); }}
                      className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1">
                      <RotateCcw size={11} /> Start over
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Review step ── */}
          {step === 'review' && (
            <div className="p-5 flex flex-col gap-4">
              <div className="rounded-2xl border border-border overflow-hidden">
                <div className="bg-primary px-5 py-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="size-6 rounded-lg bg-card/10 flex items-center justify-center">
                        <span className="text-primary-foreground" style={{ fontSize: 11 }}>F</span>
                      </div>
                      <p className="text-sm text-primary-foreground">Rivet Pro</p>
                    </div>
                    <span className="text-xs text-muted-foreground">{estNum}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-1">{aiResult?.description}</p>
                  <p className="text-2xl text-primary-foreground">${total.toLocaleString()}</p>
                </div>
                <div className="px-5 py-3 bg-card flex justify-between items-start">
                  <div>
                    <p className="text-xs text-muted-foreground">Prepared for</p>
                    <p className="text-sm text-foreground mt-0.5">{customer?.name ?? '—'}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[200px]">{address}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs text-muted-foreground">Items</p>
                    <p className="text-sm text-foreground mt-0.5">{lineItems.length}</p>
                  </div>
                </div>
                <div className="divide-y divide-border border-t border-border">
                  {lineItems.map((item, i) => (
                    <div key={i} className="flex items-center justify-between px-5 py-2">
                      <p className="text-xs text-foreground flex-1 truncate pr-3">{item.description}</p>
                      <p className="text-xs text-foreground shrink-0">
                        {item.qty > 1 && <span className="text-muted-foreground">{item.qty}× </span>}
                        ${(item.qty * item.rate).toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between px-5 py-3 bg-secondary border-t border-border">
                  <p className="text-sm text-foreground">Total</p>
                  <p className="text-sm text-foreground">${total.toLocaleString()}</p>
                </div>
              </div>

              {/* Job selection — a real estimate must hang off a job. */}
              <div>
                <label className="block text-xs text-muted-foreground mb-1.5">Job</label>
                {!jobsLoaded ? (
                  <p className="text-xs text-muted-foreground">Loading jobs…</p>
                ) : jobs.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {jobs.map(j => (
                      <button key={j.id} onClick={() => setJobId(j.id)}
                        className={`flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-left text-sm transition-all ${
                          jobId === j.id
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border bg-card text-foreground hover:bg-secondary'
                        }`}>
                        <div className={`flex size-4 items-center justify-center rounded-full border-2 shrink-0 ${
                          jobId === j.id ? 'border-primary bg-primary' : 'border-border'
                        }`}>
                          {jobId === j.id && <Check size={9} className="text-primary-foreground" />}
                        </div>
                        <span className="truncate">{j.jobNumber ? `${j.jobNumber} — ` : ''}{j.summary || 'Job'}</span>
                      </button>
                    ))}
                    <button onClick={() => void createJobForCustomer()} disabled={creatingJob}
                      className="flex items-center gap-1.5 text-xs text-primary hover:underline disabled:opacity-50 mt-0.5">
                      <Plus size={11} /> {creatingJob ? 'Creating job…' : 'Create a new job for this customer'}
                    </button>
                  </div>
                ) : (
                  <div className="rounded-xl border border-border bg-secondary px-3.5 py-3 flex flex-col gap-2">
                    <p className="text-xs text-muted-foreground">No job for this customer yet — create one to attach this {estimateTerm.toLowerCase()}.</p>
                    <button onClick={() => void createJobForCustomer()} disabled={creatingJob}
                      className="flex items-center justify-center gap-1.5 rounded-lg bg-primary text-primary-foreground py-2 text-sm hover:bg-primary/90 disabled:opacity-50 transition-colors">
                      <Plus size={13} /> {creatingJob ? 'Creating job…' : 'Create a job for this customer'}
                    </button>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs text-muted-foreground mb-1.5">Valid until</label>
                <input value={validUntil} onChange={e => setValidUntil(e.target.value)}
                  className="w-full rounded-xl border border-border px-4 py-3 text-sm focus:outline-none focus:border-primary transition-colors" />
              </div>

              {submitError && (
                <p role="alert" className="text-xs text-destructive">{submitError}</p>
              )}

              {savedDraft ? (
                <div className="flex flex-col items-center py-8 gap-3" style={{ animation: 'fadeUp 0.2s ease' }}>
                  <div className="flex size-12 items-center justify-center rounded-full bg-success/15">
                    <Check size={20} className="text-success" />
                  </div>
                  <p className="text-foreground">Draft saved</p>
                  <p className="text-xs text-muted-foreground">{estNum} · {customer?.name}</p>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <button onClick={() => setStep('send')} disabled={!jobId || creatingJob}
                    className="flex items-center justify-center gap-2 w-full rounded-xl bg-primary text-primary-foreground py-3.5 text-sm disabled:opacity-40 hover:bg-primary/90 transition-colors">
                    <Send size={14} /> Send to customer
                  </button>
                  <button onClick={() => void saveAsDraft()} disabled={!jobId || creatingJob}
                    className="w-full rounded-xl border border-border py-3 text-sm text-foreground disabled:opacity-40 hover:bg-secondary transition-colors">
                    Save as draft
                  </button>
                  {!jobId && (
                    <p className="text-xs text-muted-foreground text-center">Select or create a job to continue</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Send step ── */}
          {step === 'send' && (
            <div className="p-5 flex flex-col gap-4">
              {/* Channel picker */}
              <div className="flex rounded-xl bg-secondary p-1 gap-1">
                {([{ key: 'sms', icon: Phone, label: 'Text' }, { key: 'email', icon: Mail, label: 'Email' }] as const).map(({ key, icon: Icon, label }) => (
                  <button key={key} onClick={() => setChannel(key)}
                    className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm transition-all ${
                      channel === key ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                    }`}>
                    <Icon size={14} /> {label}
                  </button>
                ))}
              </div>

              {/* Preview */}
              <div className="rounded-xl bg-secondary border border-border px-4 py-3">
                <p className="text-xs text-muted-foreground mb-1">{channel === 'sms' ? `To: ${customer?.phone ?? '—'}` : `To: ${customer?.email ?? '—'}`}</p>
                <pre className="text-sm text-foreground whitespace-pre-wrap leading-relaxed font-sans">
                  {channel === 'sms' ? smsMsg : emailMsg}
                </pre>
              </div>

              {submitError && (
                <p role="alert" className="text-xs text-destructive">{submitError}</p>
              )}

              {sent ? (
                <div className="flex flex-col items-center py-6 gap-3" style={{ animation: 'fadeUp 0.2s ease' }}>
                  <div className="flex size-12 items-center justify-center rounded-full bg-success/15">
                    <Check size={20} className="text-success" />
                  </div>
                  <p className="text-foreground">{estimateTerm} sent!</p>
                  <p className="text-xs text-muted-foreground">{estNum} · {customer?.name}</p>
                </div>
              ) : (
                <button onClick={() => void handleSend()} disabled={sending}
                  className="flex items-center justify-center gap-2 w-full rounded-xl bg-primary text-primary-foreground py-3.5 text-sm disabled:opacity-70 hover:bg-primary/90 transition-colors">
                  {sending
                    ? <><span className="size-4 rounded-full border-2 border-primary-foreground/30 border-t-white animate-spin" /> Sending…</>
                    : <><Send size={14} /> Send via {channel === 'sms' ? 'SMS' : 'Email'}</>
                  }
                </button>
              )}
            </div>
          )}

        </div>

        {/* ── Footer CTA (describe step) ── */}
        {step === 'describe' && aiResult && (
          <div className="shrink-0 px-5 py-4 border-t border-border bg-card">
            {!customerId ? (
              <p className="text-xs text-muted-foreground text-center pb-1">Select a customer above to continue</p>
            ) : null}
            <button
              onClick={() => setStep('review')}
              disabled={!canReview}
              className="flex items-center justify-center gap-2 w-full rounded-xl bg-primary text-primary-foreground py-3.5 text-sm disabled:opacity-40 hover:bg-primary/90 transition-colors">
              <FileText size={14} /> Review estimate →
            </button>
          </div>
        )}

      </div>

      <style>{`
        @keyframes sheetUp { from { transform:translateY(100%); opacity:0 } to { transform:translateY(0); opacity:1 } }
        @keyframes fadeUp  { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }
      `}</style>
    </div>
  );
}
