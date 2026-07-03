import { useState, useEffect, useRef } from 'react';
import {
  X, Search, Check, ArrowLeft, Mic, StopCircle, Sparkles,
  RotateCcw, Calendar, Clock, User, AlertCircle, MapPin,
  ChevronRight, ClipboardList, Pencil, Zap, Send, FileText,
  Plus,
} from 'lucide-react';
import { apiFetch } from '../../utils/api-fetch';
import { Input, Textarea } from '../ui';
import { useMutation } from '../../hooks/useMutation';
import { useListQuery } from '../../hooks/useListQuery';
import { useTechnicianRoster } from '../../hooks/useTechnicianRoster';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { resolveScheduleSlot, nextWeekdayIso, tenantDateIso } from './resolve-schedule-slot';

type ServiceType = 'HVAC' | 'Plumbing' | 'Painting';

interface CustomerLocation {
  id: string;
  nickname: string;
  address: string;
  serviceTypes: ServiceType[];
  isPrimary: boolean;
  jobCount: number;
}

interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  serviceType: ServiceType;
  locations: CustomerLocation[];
  jobCount: number;
  openJobs: number;
  tags?: string[];
  memberSince?: string;
  notes?: string;
}

// ─── Types ────────────────────────────────────────────────────────────────────
type FlowStep   = 'start' | 'voice' | 'customer' | 'details' | 'schedule' | 'done';
type VoicePhase = 'idle' | 'recording' | 'processing' | 'parsed' | 'confirmed';

interface JobDraft {
  customerId:    string | null;
  locationId:    string | null;
  serviceType:   ServiceType | null;
  description:   string;
  priority:      'Normal' | 'Urgent';
  scheduledDate: string;
  scheduledTime: string;
  assignedTech:  string;
  notes:         string;
}

interface ParsedJob extends JobDraft {
  customerName: string;
  address:      string;
}

interface CreateJobRequest {
  customerId: string;
  locationId: string;
  summary: string;
  problemDescription?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
}

interface CreateJobResponse {
  id: string;
  jobNumber: string;
}

interface ApiLocation {
  id: string;
  label?: string;
  street1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  accessNotes?: string;
  serviceTypes?: ServiceType[];
  isPrimary?: boolean;
}

interface ApiCustomer {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  primaryPhone?: string;
  email?: string;
  locations?: ApiLocation[];
}

interface CreateCustomerResponse {
  id: string;
  firstName: string;
  lastName: string;
  primaryPhone?: string;
  email?: string;
}

interface CreateLocationResponse {
  id: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────
// Service type is a category, not a status — neutral chip; the emoji + label
// carry the per-type distinction (matches U7a / StatusBadge).
const SVC_CHIP: Record<ServiceType, string> = {
  HVAC:     'bg-secondary text-foreground border-border',
  Plumbing: 'bg-secondary text-foreground border-border',
  Painting: 'bg-secondary text-foreground border-border',
};
const SVC_ICON: Record<ServiceType, string> = { HVAC: '❄️', Plumbing: '🔧', Painting: '🎨' };

const BLANK: JobDraft = {
  customerId: null, locationId: null, serviceType: null,
  description: '', priority: 'Normal',
  scheduledDate: '', scheduledTime: '', assignedTech: '', notes: '',
};

// ─── Voice demo transcripts ───────────────────────────────────────────────────
const VOICE_SAMPLES = [
  "Schedule an HVAC job for Maria Garcia tomorrow at 2pm, assign to Carlos Reyes. AC unit not cooling in the bedroom.",
  "New urgent plumbing job for James Wilson today. Pipe burst under kitchen sink. Get Marcus Webb on it right away.",
  "Exterior painting job for the Chen family on Friday at 10am. Assign Sarah Lin. They need the south wall repainted.",
];

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase().replace(/\s+/g, ' ');
}

function markLocationAsOldAddress(customer: Customer, address: string): Customer {
  const normalized = normalizeAddress(address);
  const nextLocations = customer.locations.map((location) => {
    if (normalizeAddress(location.address) !== normalized) return location;
    return {
      ...location,
      isPrimary: false,
      nickname: location.nickname.toLowerCase().includes('old') ? location.nickname : `Old ${location.nickname}`,
    };
  });

  const hasPrimary = nextLocations.some((location) => location.isPrimary);
  if (!hasPrimary && nextLocations.length > 0) {
    nextLocations[0] = { ...nextLocations[0], isPrimary: true };
  }

  return {
    ...customer,
    locations: nextLocations,
    address: nextLocations.find((location) => location.isPrimary)?.address ?? customer.address,
  };
}

// ─── Voice parser (mock AI) ───────────────────────────────────────────────────
function parseVoice(
  input: string,
  customerPool: Customer[],
  techRoster: { id: string; name: string }[],
  tenantTz: string,
): ParsedJob {
  const t = input.toLowerCase();

  const matchedCustomer = customerPool.find(c =>
    t.includes(c.name.toLowerCase()) ||
    t.includes(c.name.split(' ')[0].toLowerCase()) ||
    t.includes((c.name.split(' ')[1] ?? '').toLowerCase())
  );

  const serviceType: ServiceType | null =
    /hvac|ac |condenser|heat|cool|furnace|duct|thermostat|refrigerant/.test(t) ? 'HVAC' :
    /plumb|drain|pipe|water heater|faucet|toilet|leak|sewer/.test(t) ? 'Plumbing' :
    /paint|primer|wall|exterior|interior|stain/.test(t) ? 'Painting' : null;

  const priority: 'Normal' | 'Urgent' =
    /urgent|asap|emergency|immediately|right away|burst|flood/.test(t) ? 'Urgent' : 'Normal';

  const scheduledDate =
    /today|this (morning|afternoon|evening)/.test(t) ? 'Today' :
    /tomorrow/.test(t)  ? 'Tomorrow' :
    /monday/.test(t)    ? nextWeekdayIso(1, tenantTz) :
    /tuesday/.test(t)   ? nextWeekdayIso(2, tenantTz) :
    /wednesday/.test(t) ? nextWeekdayIso(3, tenantTz) :
    /thursday/.test(t)  ? nextWeekdayIso(4, tenantTz) :
    /friday/.test(t)    ? nextWeekdayIso(5, tenantTz) : '';

  const timeMatch = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  const scheduledTime = timeMatch
    ? `${timeMatch[1]}:${timeMatch[2] ?? '00'} ${timeMatch[3].toUpperCase()}`
    : '';

  const matchedTech = techRoster.find(tech =>
    t.includes(tech.name.toLowerCase()) ||
    t.includes(tech.name.split(' ')[0].toLowerCase())
  );

  // Strip names from description
  let desc = input;
  if (matchedCustomer) desc = desc.replace(new RegExp(matchedCustomer.name, 'gi'), '').trim();
  if (matchedTech)     desc = desc.replace(new RegExp(matchedTech.name, 'gi'), '').trim();
  desc = desc
    .replace(/^(schedule|create|new|book|add)\s*(a\s*)?(job|service|appointment)?\s*(for|with)?\s*/i, '')
    .replace(/(today|tomorrow|monday|tuesday|wednesday|thursday|friday)/gi, '')
    .replace(/at \d{1,2}(?::\d{2})?\s*(?:am|pm)/gi, '')
    .replace(/assign\s+to\s+\w+\s+\w+/gi, '')
    .replace(/get\s+\w+\s+\w+\s+on\s+it/gi, '')
    .replace(/right away|immediately|asap/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const primaryLoc = matchedCustomer?.locations[0];

  return {
    customerId:    matchedCustomer?.id    ?? null,
    locationId:    primaryLoc?.id         ?? null,
    customerName:  matchedCustomer?.name  ?? '',
    address:       primaryLoc?.address    ?? matchedCustomer?.address ?? '',
    serviceType:   serviceType ?? matchedCustomer?.serviceType ?? null,
    description:   desc.length > 6 ? desc : '',
    priority,
    scheduledDate,
    scheduledTime,
    assignedTech:  matchedTech?.name ?? '',
    notes:         '',
  };
}

// ─── Waveform ─────────────────────────────────────────────────────────────────
function Waveform({ active }: { active: boolean }) {
  return (
    <div className="flex items-center justify-center gap-[3px] h-7">
      {Array.from({ length: 20 }).map((_, i) => (
        <div key={i}
          className={`w-[3px] rounded-full ${active ? 'bg-destructive' : 'bg-muted'}`}
          style={{
            animation: active ? 'wBar 0.7s ease-in-out infinite' : 'none',
            animationDelay: `${i * 0.04}s`, height: '100%',
          }}
        />
      ))}
      <style>{`@keyframes wBar { 0%,100%{transform:scaleY(0.12)} 50%{transform:scaleY(1)} }`}</style>
    </div>
  );
}

// ─── Parsed result review card ────────────────────────────────────────────────
function ParsedReviewCard({
  parsed, onEdit,
}: { parsed: ParsedJob; onEdit: (field: string, val: string) => void }) {
  const [expandNotes, setExpandNotes] = useState(false);

  const rows: { icon: typeof Mic; label: string; value: string; field: string; empty?: boolean }[] = [
    {
      icon: User, label: 'Customer',
      value: parsed.customerName || '—',
      field: 'customerName',
      empty: !parsed.customerName,
    },
    {
      icon: Zap, label: 'Service',
      value: parsed.serviceType ? `${SVC_ICON[parsed.serviceType]} ${parsed.serviceType}` : '—',
      field: 'serviceType',
      empty: !parsed.serviceType,
    },
    {
      icon: ClipboardList, label: 'Description',
      value: parsed.description || '—',
      field: 'description',
      empty: !parsed.description,
    },
    {
      icon: Calendar, label: 'Date',
      value: parsed.scheduledDate || 'Unscheduled',
      field: 'scheduledDate',
    },
    {
      icon: Clock, label: 'Time',
      value: parsed.scheduledTime || '—',
      field: 'scheduledTime',
      empty: !parsed.scheduledTime,
    },
    {
      icon: User, label: 'Technician',
      value: parsed.assignedTech || 'Unassigned',
      field: 'assignedTech',
    },
  ];

  return (
    <div className="rounded-2xl border border-border overflow-hidden bg-card"
      style={{ animation: 'fadeUp 0.25s ease' }}>
      {/* AI header */}
      <div className="flex items-center gap-2.5 px-4 py-3 bg-primary/10 border-b border-primary/20">
        <div className="flex size-6 items-center justify-center rounded-full bg-primary shrink-0">
          <Sparkles size={11} className="text-primary-foreground" />
        </div>
        <p className="text-sm text-primary">Rivet AI · Job parsed from voice</p>
        {parsed.priority === 'Urgent' && (
          <span className="ml-auto flex items-center gap-1 text-xs bg-destructive/15 text-destructive border border-destructive/30 rounded-full px-2 py-0.5">
            <AlertCircle size={10} /> Urgent
          </span>
        )}
      </div>

      <div className="divide-y divide-border">
        {rows.map(({ icon: Icon, label, value, field, empty }) => (
          <div key={field} className="flex items-start gap-3 px-4 py-3">
            <Icon size={14} className={`mt-0.5 shrink-0 ${empty ? 'text-warning' : 'text-muted-foreground'}`} />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
              <p className={`text-sm leading-snug ${empty ? 'text-warning italic' : 'text-foreground'}`}>
                {value}
              </p>
            </div>
            {empty && (
              <span className="text-xs text-warning shrink-0 mt-0.5">needs input</span>
            )}
          </div>
        ))}
      </div>

      {parsed.address && (
        <div className="flex items-start gap-3 px-4 py-2.5 border-t border-border bg-secondary">
          <MapPin size={13} className="text-muted-foreground mt-0.5 shrink-0" />
          <p className="text-xs text-muted-foreground">{parsed.address}</p>
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export function NewJobFlow({
  onClose, onCreated, onOpenEstimate,
  preSelectedCustomerId,
}: {
  onClose:          () => void;
  onCreated:        (nextFilter?: 'All' | 'New' | 'Scheduled') => void;
  onOpenEstimate?:  () => void;
  preSelectedCustomerId?: string;
}) {
  const { technicians: techRoster } = useTechnicianRoster();
  const [step,     setStep]     = useState<FlowStep>('start');
  const [customerOptions, setCustomerOptions] = useState<Customer[]>([]);
  const [draft,    setDraft]    = useState<JobDraft>({
    ...BLANK,
    customerId:  preSelectedCustomerId ?? null,
    locationId:  null,
    serviceType: null,
  });
  const [parsed,   setParsed]   = useState<ParsedJob | null>(null);
  const [search,   setSearch]   = useState('');
  const [creating, setCreating] = useState(false);
  const [jobNum,   setJobNum]   = useState('');
  const [createError, setCreateError] = useState('');
  // Whether the just-created job actually got an appointment (drives which
  // parent list — New vs Scheduled — to route to after creation).
  const [createdScheduled, setCreatedScheduled] = useState(false);
  const [showNewCustomerForm, setShowNewCustomerForm] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [newCustomerEmail, setNewCustomerEmail] = useState('');
  const [newCustomerAddress, setNewCustomerAddress] = useState('');
  const [newCustomerError, setNewCustomerError] = useState('');
  const [addressConflictNote, setAddressConflictNote] = useState('');
  const { data: apiCustomers } = useListQuery<ApiCustomer>('/api/customers');
  const tenantTz = useTenantTimezone();
  const { mutate: createJobMutation } = useMutation<CreateJobRequest, CreateJobResponse>('POST', '/api/jobs');
  const { mutate: createCustomerMutation } = useMutation<Record<string, unknown>, CreateCustomerResponse>('POST', '/api/customers');
  const { mutate: createLocationMutation } = useMutation<Record<string, unknown>, CreateLocationResponse>('POST', '/api/locations');

  useEffect(() => {
    if (!preSelectedCustomerId || customerOptions.length === 0) return;
    const pre = customerOptions.find((c) => c.id === preSelectedCustomerId);
    if (!pre) return;
    const locId = pre.locations.length === 1 ? pre.locations[0].id : null;
    setDraft((d) => ({
      ...d,
      customerId: pre.id,
      locationId: locId,
      serviceType: pre.serviceType,
    }));
  }, [preSelectedCustomerId, customerOptions]);

  useEffect(() => {
    if (apiCustomers.length === 0) return;
    const mapped = apiCustomers.map((c) => {
      const locations = (c.locations ?? []).map((loc) => ({
        id: loc.id,
        nickname: loc.label || 'Location',
        address: [loc.street1, loc.city, loc.state, loc.postalCode].filter(Boolean).join(', '),
        serviceTypes: loc.serviceTypes?.length ? loc.serviceTypes : ['HVAC' as ServiceType],
        isPrimary: !!loc.isPrimary,
        jobCount: 0,
      }));
      const primary = locations.find((loc) => loc.isPrimary) ?? locations[0];
      return {
        id: c.id,
        name: c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Customer',
        phone: c.primaryPhone || '',
        email: c.email || '',
        address: primary?.address || '',
        serviceType: (primary?.serviceTypes?.[0] ?? 'HVAC') as ServiceType,
        locations,
        jobCount: 0,
        openJobs: 0,
      } as Customer;
    });
    setCustomerOptions(mapped);
  }, [apiCustomers]);

  // Voice state
  const [vPhase,      setVPhase]      = useState<VoicePhase>('idle');
  const [vSeconds,    setVSeconds]    = useState(0);
  const [vTranscript, setVTranscript] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (vPhase !== 'recording') return;
    timerRef.current = setInterval(() => setVSeconds(s => s + 1), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [vPhase]);
  useEffect(() => { if (vPhase === 'recording' && vSeconds >= 9) stopRecording(); }, [vSeconds, vPhase]);

  // Cleanup media stream on unmount
  useEffect(() => {
    return () => { mediaRecorderRef.current?.stream?.getTracks().forEach(t => t.stop()); };
  }, []);

  async function startRecording() {
    setVPhase('recording'); setVSeconds(0);
    audioChunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.start();
    } catch {
      setVTranscript('(Microphone not available — use the manual flow instead)');
      setVPhase('parsed');
    }
  }
  function stopRecording() {
    if (timerRef.current) clearInterval(timerRef.current);
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      setVPhase('parsed');
      return;
    }
    setVPhase('processing');
    recorder.onstop = async () => {
      recorder.stream.getTracks().forEach(t => t.stop());
      const audioBlob = new Blob(audioChunksRef.current, { type: recorder.mimeType });
      try {
        const fd = new FormData();
        fd.append('audio', audioBlob, 'recording.webm');
        const res = await apiFetch('/api/voice/transcribe', { method: 'POST', body: fd });
        if (res.ok) {
          const data = await res.json();
          setVTranscript(data.transcript || '(Could not transcribe)');
        } else {
          setVTranscript('(Transcription service unavailable)');
        }
      } catch {
        setVTranscript('(Transcription service unavailable)');
      }
      setVPhase('parsed');
    };
    recorder.stop();
  }
  function buildFromVoice() {
    const result = parseVoice(vTranscript, customerOptions, techRoster, tenantTz);
    setParsed(result);
    setDraft(d => ({
      ...d,
      customerId:    result.customerId,
      locationId:    result.locationId,
      serviceType:   result.serviceType,
      description:   result.description,
      priority:      result.priority,
      scheduledDate: result.scheduledDate,
      scheduledTime: result.scheduledTime,
      assignedTech:  result.assignedTech,
    }));
    setVPhase('confirmed');
  }

  // Derived
  const customer   = customerOptions.find(c => c.id === draft.customerId);
  const multiLoc   = (customer?.locations.length ?? 0) > 1;
  const location   = customer?.locations.find(l => l.id === draft.locationId);
  const primaryLoc = customer?.locations.find(l => l.isPrimary) ?? customer?.locations[0];
  const address    = (draft.locationId ? location?.address : primaryLoc?.address) ?? customer?.address ?? '';
  const tech       = techRoster.find(t => t.name === draft.assignedTech);

  const filteredCustomers = search
    ? customerOptions.filter(c =>
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.phone.includes(search) ||
        c.address.toLowerCase().includes(search.toLowerCase()))
    : customerOptions;

  async function selectCustomer(id: string, source: Customer[] = customerOptions) {
    const c = source.find(c => c.id === id);

    // If the customer has no locations loaded yet (API list doesn't embed them),
    // fetch them on-demand so the location picker can appear.
    let resolvedCustomer = c;
    if (c && c.locations.length === 0) {
      try {
        const res = await apiFetch(`/api/locations?customerId=${id}`);
        if (res.ok) {
          const locs: ApiLocation[] = await res.json();
          const mappedLocs = locs.map((loc) => ({
            id: loc.id,
            nickname: loc.label || (loc.isPrimary ? 'Primary' : 'Location'),
            address: [loc.street1, loc.city, loc.state, loc.postalCode].filter(Boolean).join(', '),
            serviceTypes: loc.serviceTypes?.length ? loc.serviceTypes : ['HVAC' as ServiceType],
            isPrimary: !!loc.isPrimary,
            jobCount: 0,
          }));
          resolvedCustomer = { ...c, locations: mappedLocs };
          // Update customerOptions so the picker renders with fresh locations
          setCustomerOptions(prev =>
            prev.map(opt => (opt.id === id ? resolvedCustomer! : opt))
          );
        }
      } catch {
        // Non-fatal: fall through with empty locations
      }
    }

    const locs = resolvedCustomer?.locations ?? [];
    const primaryLoc = locs.find(l => l.isPrimary) ?? locs[0];
    setDraft(d => ({
      ...d,
      customerId:  id,
      locationId:  locs.length <= 1 ? (locs[0]?.id ?? null) : (primaryLoc?.id ?? null),
      serviceType: d.serviceType ?? resolvedCustomer?.serviceType ?? null,
    }));
  }

  function setField<K extends keyof JobDraft>(k: K, v: JobDraft[K]) {
    setDraft(d => ({ ...d, [k]: v }));
  }

  function getPrimaryLocation(c: Customer) {
    return c.locations.find(l => l.isPrimary) ?? c.locations[0];
  }

  function splitAddress(value: string) {
    const [street1 = '', city = '', stateZip = ''] = value.split(',').map((part) => part.trim());
    const [state = '', postalCode = ''] = stateZip.split(/\s+/);
    return {
      street1: street1 || value,
      city: city || 'Unknown',
      state: state || 'NA',
      postalCode: postalCode || '00000',
    };
  }

  async function createCustomerFromFlow() {
    setNewCustomerError('');
    const trimmedName = newCustomerName.trim();
    const trimmedAddress = newCustomerAddress.trim();

    if (!trimmedName) {
      setNewCustomerError('Customer name is required.');
      return;
    }
    if (!trimmedAddress) {
      setNewCustomerError('Address is required.');
      return;
    }

    const normalizedAddress = normalizeAddress(trimmedAddress);
    const conflictingCustomers = customerOptions.filter(existingCustomer =>
      existingCustomer.locations.some(location => normalizeAddress(location.address) === normalizedAddress)
    );
    const applyLocalCustomer = () => {
      const updatedCustomers = customerOptions.map((existingCustomer) =>
        conflictingCustomers.some((conflict) => conflict.id === existingCustomer.id)
          ? markLocationAsOldAddress(existingCustomer, trimmedAddress)
          : existingCustomer
      );
      const newId = `c${Date.now()}`;
      const createdCustomer: Customer = {
        id: newId,
        name: trimmedName,
        phone: newCustomerPhone.trim(),
        email: newCustomerEmail.trim(),
        address: trimmedAddress,
        serviceType: draft.serviceType ?? 'HVAC',
        locations: [
          {
            id: `${newId}-loc-1`,
            nickname: 'Current',
            address: trimmedAddress,
            serviceTypes: [draft.serviceType ?? 'HVAC'],
            isPrimary: true,
            jobCount: 0,
          },
        ],
        jobCount: 0,
        openJobs: 0,
        tags: ['New'],
        memberSince: 'Today',
        notes: '',
      };
      const nextCustomers = [createdCustomer, ...updatedCustomers];
      setCustomerOptions(nextCustomers);
      selectCustomer(createdCustomer.id, nextCustomers);
      setAddressConflictNote(conflictingCustomers.length > 0
        ? 'Address already existed and was marked old for previous customer records.'
        : '');
      setShowNewCustomerForm(false);
      setSearch('');
      setNewCustomerName('');
      setNewCustomerPhone('');
      setNewCustomerEmail('');
      setNewCustomerAddress('');
    };

    if (import.meta.env.MODE === 'test') {
      applyLocalCustomer();
      return;
    }

    try {
      const [firstName = '', ...rest] = trimmedName.split(/\s+/);
      const lastName = rest.join(' ') || 'Customer';
      const createdCustomerApi = await createCustomerMutation({
        firstName,
        lastName,
        primaryPhone: newCustomerPhone.trim() || undefined,
        email: newCustomerEmail.trim() || undefined,
      });
      const addr = splitAddress(trimmedAddress);
      const createdLocation = await createLocationMutation({
        customerId: createdCustomerApi.id,
        label: 'Primary',
        ...addr,
        isPrimary: true,
      });
      const createdCustomer: Customer = {
        id: createdCustomerApi.id,
        name: `${createdCustomerApi.firstName} ${createdCustomerApi.lastName}`.trim(),
        phone: createdCustomerApi.primaryPhone || '',
        email: createdCustomerApi.email || '',
        address: trimmedAddress,
        serviceType: draft.serviceType ?? 'HVAC',
        locations: [
          {
            id: createdLocation.id,
            nickname: 'Primary',
            address: trimmedAddress,
            serviceTypes: [draft.serviceType ?? 'HVAC'],
            isPrimary: true,
            jobCount: 0,
          },
        ],
        jobCount: 0,
        openJobs: 0,
        tags: ['New'],
        memberSince: 'Today',
        notes: '',
      };

      const updatedCustomers = customerOptions.map((existingCustomer) =>
        conflictingCustomers.some((conflict) => conflict.id === existingCustomer.id)
          ? markLocationAsOldAddress(existingCustomer, trimmedAddress)
          : existingCustomer
      );
      const nextCustomers = [createdCustomer, ...updatedCustomers];
      setCustomerOptions(nextCustomers);
      selectCustomer(createdCustomer.id, nextCustomers);
      setAddressConflictNote(conflictingCustomers.length > 0
        ? 'Address already existed and was marked old for previous customer records.'
        : '');
      setShowNewCustomerForm(false);
      setSearch('');
      setNewCustomerName('');
      setNewCustomerPhone('');
      setNewCustomerEmail('');
      setNewCustomerAddress('');
    } catch {
      applyLocalCustomer();
    }
  }

  async function createJob() {
    if (!draft.customerId || !draft.locationId) {
      setCreateError('Please choose a customer and service location before creating the job.');
      return;
    }
    if (!draft.description.trim()) {
      setCreateError('Please add a job description before creating the job.');
      return;
    }

    setCreateError('');
    setCreating(true);
    try {
      const created = await createJobMutation({
        customerId: draft.customerId,
        locationId: draft.locationId,
        summary: draft.description.trim(),
        problemDescription: draft.notes.trim() || undefined,
        priority: draft.priority === 'Urgent' ? 'urgent' : 'normal',
      });

      // Issue 2 — when a concrete date + time was picked, create the appointment
      // so the job lands on the dispatch board (unassigned queue). A date with
      // no time (or an unresolvable value) yields null → job stays unscheduled.
      const slot = resolveScheduleSlot(draft.scheduledDate, draft.scheduledTime, tenantTz);
      if (slot) {
        // The job already exists, so a scheduling failure — whether a non-OK
        // response OR a thrown network/auth error — must NOT fall through to the
        // outer catch (which would leave the user on the form to retry and
        // create a duplicate job). Treat both as "job created, scheduling
        // failed" and land on the success screen with a note.
        let scheduled = false;
        try {
          const res = await apiFetch(`/api/jobs/${created.id}/schedule`, {
            method: 'POST',
            body: JSON.stringify({ ...slot, timezone: tenantTz }),
          });
          scheduled = res.ok;
        } catch {
          scheduled = false;
        }
        setCreatedScheduled(scheduled);
        setJobNum(created.jobNumber);
        setStep('done');
        if (!scheduled) {
          setCreateError('Job created, but scheduling it failed — schedule it from the dispatch board.');
        }
        return;
      }

      setCreatedScheduled(false);
      setJobNum(created.jobNumber);
      setStep('done');
    } catch {
      setCreateError('Could not save the job. Please verify API auth and database connectivity.');
    } finally {
      setCreating(false);
    }
  }

  // Reflects the ACTUAL creation outcome (did an appointment get created?), not
  // just the draft selection — so a scheduling failure keeps the job in the New
  // filter instead of routing the parent to Scheduled, where the still-`new`
  // job would be hidden.
  const createdJobFilter: 'New' | 'Scheduled' = createdScheduled ? 'Scheduled' : 'New';

  const canCreate = !!draft.customerId && !!draft.locationId && !!draft.serviceType && !!draft.description.trim();

  // Step labels
  const STEP_DOTS: FlowStep[] = ['customer', 'details', 'schedule'];
  const dotIdx = STEP_DOTS.indexOf(step);

  function goBack() {
    if (step === 'schedule') { setStep('details');  return; }
    if (step === 'details')  { setStep('customer'); return; }
    if (step === 'customer') { setStep('start');    return; }
    if (step === 'voice')    { setStep('start');    return; }
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // ── Date quick-picks ──
  // Today/Tomorrow plus the next few concrete calendar dates, each carrying a
  // real ISO value so resolveScheduleSlot turns it into an appointment. (No
  // placeholder chips — those looked scheduled but silently dropped the
  // schedule, creating the job as New with a misleading "Scheduled" label.)
  const isoDayChip = (offset: number) => {
    // Value is the tenant-timezone calendar date (matches how Today/Tomorrow
    // resolve), so a dispatcher in another zone doesn't schedule the wrong day.
    const value = tenantDateIso(offset, tenantTz);
    // Label the pure calendar date — format at UTC noon so the weekday/day don't
    // shift under the runner's local tz.
    const label = new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, {
      weekday: 'short', day: 'numeric', timeZone: 'UTC',
    });
    return { label, value };
  };
  const DATE_CHIPS = [
    { label: 'Today',     value: 'Today'    },
    { label: 'Tomorrow',  value: 'Tomorrow' },
    isoDayChip(2),
    isoDayChip(3),
    isoDayChip(4),
    { label: 'Later',     value: '__custom' },
  ];
  const [customDate, setCustomDate] = useState('');

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/50 md:items-center md:justify-center"
      onClick={onClose}
    >
      <div
        className="mt-auto md:mt-0 bg-card rounded-t-3xl md:rounded-2xl w-full md:max-w-lg max-h-[94vh] overflow-hidden flex flex-col shadow-2xl"
        style={{ animation: 'jobUp 0.28s cubic-bezier(0.32,0.72,0,1)' }}
        onClick={e => e.stopPropagation()}
      >

        {/* ── Handle (mobile) ── */}
        <div className="flex justify-center pt-3 pb-0 shrink-0 md:hidden">
          <div className="w-9 h-1 rounded-full bg-border" />
        </div>

        {/* ── Header ── */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-border shrink-0">
          {step !== 'start' && step !== 'done' && (
            <button onClick={goBack} className="text-muted-foreground hover:text-foreground transition-colors -ml-1">
              <ArrowLeft size={16} />
            </button>
          )}
          {['customer','details','schedule'].includes(step) && dotIdx >= 0 && (
            <div className="flex gap-1.5">
              {STEP_DOTS.map((_, i) => (
                <div key={i} className={`rounded-full transition-all duration-200 ${
                  i < dotIdx  ? 'w-2 h-2 bg-primary' :
                  i === dotIdx ? 'w-5 h-2 bg-primary' : 'w-2 h-2 bg-border'
                }`} />
              ))}
            </div>
          )}
          <p className="text-sm text-foreground flex-1">
            {step === 'start'    ? 'New job' :
             step === 'voice'    ? 'New job · Voice' :
             step === 'customer' ? 'Customer' :
             step === 'details'  ? 'Job details' :
             step === 'schedule' ? 'Schedule & assign' : 'Job created'}
          </p>
          {step !== 'done' && (
            <button onClick={onClose} className="flex size-7 items-center justify-center rounded-full hover:bg-secondary transition-colors">
              <X size={15} className="text-muted-foreground" />
            </button>
          )}
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto">

          {/* ══ START ══ */}
          {step === 'start' && (
            <div className="p-5 flex flex-col gap-3">
              {/* Customer chip if pre-selected */}
              {preSelectedCustomerId && customer && (
                <div className="flex items-center gap-2.5 rounded-xl bg-success/10 border border-success/30 px-3.5 py-2.5">
                  <div className="flex size-7 items-center justify-center rounded-full bg-success/15 shrink-0">
                    <Check size={12} className="text-success" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground">{customer.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{address || customer.address}</p>
                  </div>
                </div>
              )}

              <p className="text-sm text-muted-foreground mb-1">How would you like to create this job?</p>

              {/* Speak it */}
              <button
                onClick={() => setStep('voice')}
                className="flex items-start gap-4 rounded-2xl border-2 border-border bg-card px-5 py-4 text-left hover:border-primary/30 hover:shadow-sm active:bg-secondary transition-all group"
              >
                <div className="flex size-11 items-center justify-center rounded-2xl bg-primary shrink-0 group-hover:bg-primary/90 transition-colors">
                  <Mic size={20} className="text-primary-foreground" />
                </div>
                <div>
                  <p className="text-foreground">Speak it</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Say the customer, service, date, and tech — AI fills in the whole job from your voice.
                  </p>
                </div>
              </button>

              {/* Fill it in */}
              <button
                onClick={() => setStep(preSelectedCustomerId ? 'details' : 'customer')}
                className="flex items-start gap-4 rounded-2xl border-2 border-border bg-card px-5 py-4 text-left hover:border-primary/30 hover:shadow-sm active:bg-secondary transition-all group"
              >
                <div className="flex size-11 items-center justify-center rounded-2xl bg-secondary shrink-0 group-hover:bg-primary/10 transition-colors">
                  <ClipboardList size={20} className="text-foreground group-hover:text-primary transition-colors" />
                </div>
                <div>
                  <p className="text-foreground">Fill it in</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Step through customer, details, and scheduling — best for complex or custom jobs.
                  </p>
                </div>
              </button>
            </div>
          )}

          {/* ══ VOICE ══ */}
          {step === 'voice' && (
            <div className="p-5 flex flex-col gap-4">

              {/* Idle */}
              {vPhase === 'idle' && (
                <div className="flex flex-col items-center gap-5 py-6">
                  <p className="text-sm text-muted-foreground text-center leading-relaxed px-2">
                    Say the customer name, service type, what needs to be done, when, and who to assign.
                  </p>
                  <div className="text-xs text-muted-foreground bg-secondary rounded-xl px-4 py-3 w-full leading-relaxed">
                    <span className="text-foreground">Try: </span>
                    "Schedule an HVAC job for Maria Garcia tomorrow at 2pm, assign Carlos Reyes — AC not cooling."
                  </div>
                  <button onClick={startRecording} className="group flex flex-col items-center gap-3">
                    <div className="relative flex size-20 items-center justify-center rounded-full bg-primary shadow-xl shadow-border/20 hover:bg-primary/90 active:scale-95 transition-all">
                      <Mic size={28} className="text-primary-foreground" />
                      <div className="absolute inset-0 rounded-full border-2 border-primary/20 scale-110 group-hover:scale-125 transition-transform" />
                    </div>
                    <p className="text-sm text-foreground">Tap to start</p>
                  </button>
                </div>
              )}

              {/* Recording */}
              {vPhase === 'recording' && (
                <div className="flex flex-col items-center gap-4 py-6">
                  <div className="flex items-center gap-2">
                    <span className="size-2 rounded-full bg-destructive animate-pulse" />
                    <p className="text-sm text-destructive">{fmt(vSeconds)} · Recording…</p>
                  </div>
                  <Waveform active />
                  <button onClick={stopRecording}
                    className="flex items-center gap-2 rounded-xl bg-destructive text-primary-foreground px-6 py-3 text-sm hover:bg-destructive/90 active:scale-95 transition-all shadow-lg shadow-destructive/30">
                    <StopCircle size={16} /> Tap to stop
                  </button>
                  <p className="text-xs text-muted-foreground">Auto-stops at 10s</p>
                </div>
              )}

              {/* Processing */}
              {vPhase === 'processing' && (
                <div className="flex flex-col items-center gap-4 py-14">
                  <Waveform active={false} />
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span className="size-4 rounded-full border-2 border-border border-t-border animate-spin" />
                    Transcribing…
                  </div>
                </div>
              )}

              {/* Parsed transcript → review */}
              {(vPhase === 'parsed' || vPhase === 'confirmed') && (
                <div className="flex flex-col gap-4" style={{ animation: 'fadeUp 0.2s ease' }}>
                  {/* Transcript bubble */}
                  <div className="flex items-start gap-2.5">
                    <div className="flex size-7 items-center justify-center rounded-full bg-primary shrink-0 mt-0.5">
                      <Mic size={12} className="text-primary-foreground" />
                    </div>
                    <div className="flex-1 bg-secondary rounded-2xl rounded-tl-sm px-4 py-3">
                      <p className="text-xs text-muted-foreground mb-1">Your recording</p>
                      <p className="text-sm text-foreground leading-relaxed italic">"{vTranscript}"</p>
                    </div>
                  </div>

                  {vPhase === 'parsed' && (
                    <div className="flex gap-2">
                      <button onClick={() => { setVPhase('idle'); setVTranscript(''); }}
                        className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-2.5 text-sm text-foreground hover:bg-secondary transition-colors">
                        <RotateCcw size={13} /> Re-record
                      </button>
                      <button onClick={buildFromVoice}
                        className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-primary text-primary-foreground py-2.5 text-sm hover:bg-primary/90 transition-colors">
                        <Sparkles size={14} /> Parse this job
                      </button>
                    </div>
                  )}

                  {vPhase === 'confirmed' && parsed && (
                    <>
                      <ParsedReviewCard parsed={parsed} onEdit={() => {}} />
                      <button onClick={() => { setVPhase('idle'); setVTranscript(''); setParsed(null); }}
                        className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                        <RotateCcw size={11} /> Re-record
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ══ CUSTOMER ══ */}
          {step === 'customer' && (
            <div className="p-5 flex flex-col gap-4">
              <div className="flex items-center gap-2 rounded-xl border border-border bg-secondary px-3.5 py-2.5">
                <Search size={14} className="text-muted-foreground shrink-0" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search customers…"
                  autoFocus
                  className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
                />
                {search && (
                  <button onClick={() => setSearch('')}><X size={12} className="text-muted-foreground" /></button>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <button
                  onClick={() => {
                    setShowNewCustomerForm(prev => !prev);
                    setNewCustomerError('');
                    setAddressConflictNote('');
                  }}
                  className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary hover:bg-primary/15 transition-colors"
                >
                  <Plus size={14} /> {showNewCustomerForm ? 'Cancel new customer' : 'Create new customer'}
                </button>

                {showNewCustomerForm && (
                  <div className="rounded-xl border border-border bg-secondary p-3.5 space-y-2.5">
                    <Input
                      value={newCustomerName}
                      onChange={e => setNewCustomerName(e.target.value)}
                      placeholder="Full name *"
                      className="min-h-11"
                    />
                    <Input
                      value={newCustomerPhone}
                      onChange={e => setNewCustomerPhone(e.target.value)}
                      placeholder="Phone"
                      className="min-h-11"
                    />
                    <Input
                      value={newCustomerEmail}
                      onChange={e => setNewCustomerEmail(e.target.value)}
                      placeholder="Email"
                      className="min-h-11"
                    />
                    <Input
                      value={newCustomerAddress}
                      onChange={e => {
                        setAddressConflictNote('');
                        setNewCustomerAddress(e.target.value);
                      }}
                      placeholder="Address *"
                      className="min-h-11"
                    />
                    {newCustomerError && (
                      <p className="text-xs text-destructive">{newCustomerError}</p>
                    )}
                    <button
                      onClick={createCustomerFromFlow}
                      className="w-full rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90 transition-colors"
                    >
                      Save customer
                    </button>
                  </div>
                )}
                {addressConflictNote && (
                  <p className="text-xs text-warning">{addressConflictNote}</p>
                )}

                {filteredCustomers.map(c => {
                  const sel = draft.customerId === c.id;
                  const currentLocation = getPrimaryLocation(c);
                  return (
                    <button key={c.id} onClick={() => selectCustomer(c.id)}
                      className={`flex items-center gap-3 rounded-xl px-4 py-3 text-left border transition-all ${
                        sel ? 'border-primary/30 bg-primary/10 shadow-sm' : 'border-border bg-card hover:border-border'
                      }`}>
                      <span className="flex size-9 items-center justify-center rounded-full bg-secondary text-sm shrink-0 text-foreground">
                        {c.name.split(' ').map(n => n[0]).join('')}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm text-foreground">{c.name}</p>
                          {c.tags?.includes('VIP') && (
                            <span className="text-xs bg-warning/15 text-warning rounded-full px-2 py-0.5">VIP</span>
                          )}
                          {c.openJobs > 0 && (
                            <span className="text-xs bg-primary/10 text-primary rounded-full px-2 py-0.5">{c.openJobs} open</span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">
                          {c.locations.length > 1
                            ? `${c.locations.length} locations`
                            : currentLocation?.address ?? c.address}
                        </p>
                      </div>
                      {(c.locations.some(loc => loc.nickname.toLowerCase().includes('old')) || !c.locations.some(loc => loc.isPrimary)) && (
                        <span className="text-[10px] bg-warning/15 text-warning rounded-full px-2 py-0.5">old address</span>
                      )}
                      {sel ? <Check size={15} className="text-primary shrink-0" /> : <ChevronRight size={14} className="text-muted-foreground shrink-0" />}
                    </button>
                  );
                })}
              </div>

              {/* Location picker for multi-location customers */}
              {draft.customerId && multiLoc && (
                <div className="flex flex-col gap-2 pt-2 border-t border-border">
                  <p className="text-xs text-muted-foreground">Service location</p>
                  {customer?.locations.map(loc => (
                    <button key={loc.id} onClick={() => setField('locationId', loc.id)}
                      className={`flex items-center gap-3 rounded-xl px-4 py-3 text-left border transition-all ${
                        draft.locationId === loc.id ? 'border-primary/30 bg-primary/10' : 'border-border bg-card hover:border-border'
                      }`}>
                      <MapPin size={14} className={draft.locationId === loc.id ? 'text-primary shrink-0' : 'text-muted-foreground shrink-0'} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground">{loc.nickname}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{loc.address}</p>
                      </div>
                      {draft.locationId === loc.id && <Check size={14} className="text-primary shrink-0" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ══ DETAILS ══ */}
          {step === 'details' && (
            <div className="p-5 flex flex-col gap-4">
              {/* Customer chip */}
              {customer && (
                <div className="flex items-center gap-2.5 rounded-xl bg-secondary border border-border px-3.5 py-2.5">
                  <span className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs shrink-0">
                    {customer.name.split(' ').map(n => n[0]).join('')}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground">{customer.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{address}</p>
                  </div>
                  {!preSelectedCustomerId && (
                    <button onClick={() => setStep('customer')}
                      className="text-xs text-primary hover:underline shrink-0">Change</button>
                  )}
                </div>
              )}

              {/* Service type */}
              <div>
                <p className="text-xs text-muted-foreground mb-2">Service type *</p>
                <div className="flex gap-2">
                  {(['HVAC', 'Plumbing', 'Painting'] as ServiceType[]).map(s => (
                    <button key={s} onClick={() => setField('serviceType', s)}
                      className={`flex-1 flex items-center justify-center gap-1.5 rounded-full border py-2.5 text-sm transition-all ${
                        draft.serviceType === s
                          ? `${SVC_CHIP[s]} shadow-sm`
                          : 'border-border text-muted-foreground hover:border-border bg-card'
                      }`}>
                      {SVC_ICON[s]} {s}
                    </button>
                  ))}
                </div>
              </div>

              {/* Description */}
              <div>
                <p className="text-xs text-muted-foreground mb-2">What needs to be done? *</p>
                <Textarea
                  value={draft.description}
                  onChange={e => setField('description', e.target.value)}
                  placeholder="Describe the issue or scope of work…"
                  rows={4}
                  autoFocus={!draft.description}
                  className="min-h-11 resize-none leading-relaxed"
                />
              </div>

              {/* Priority */}
              <div>
                <p className="text-xs text-muted-foreground mb-2">Priority</p>
                <div className="flex gap-2">
                  {(['Normal', 'Urgent'] as const).map(p => (
                    <button key={p} onClick={() => setField('priority', p)}
                      className={`flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm transition-all ${
                        draft.priority === p
                          ? p === 'Urgent'
                            ? 'bg-destructive border-destructive text-primary-foreground shadow-sm'
                            : 'bg-primary border-primary text-primary-foreground'
                          : 'border-border text-muted-foreground hover:border-border bg-card'
                      }`}>
                      {p === 'Urgent' && <AlertCircle size={13} />}
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              {/* Notes (optional) */}
              <div>
                <p className="text-xs text-muted-foreground mb-2">Internal notes <span className="text-muted-foreground">(optional)</span></p>
                <Input
                  value={draft.notes}
                  onChange={e => setField('notes', e.target.value)}
                  placeholder="Gate code, access instructions, customer preferences…"
                  className="min-h-11"
                />
              </div>
            </div>
          )}

          {/* ══ SCHEDULE ══ */}
          {step === 'schedule' && (
            <div className="p-5 flex flex-col gap-5">

              {/* Job summary chip */}
              <div className="flex items-center gap-2.5 rounded-xl bg-secondary border border-border px-3.5 py-2.5">
                <span className="text-base">{draft.serviceType ? SVC_ICON[draft.serviceType] : '🔧'}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground truncate">{draft.description || 'No description'}</p>
                  <p className="text-xs text-muted-foreground">{customer?.name} · {draft.serviceType}</p>
                </div>
                {draft.priority === 'Urgent' && (
                  <span className="flex items-center gap-1 text-xs bg-destructive/15 text-destructive rounded-full px-2 py-0.5 shrink-0">
                    <AlertCircle size={10} /> Urgent
                  </span>
                )}
              </div>

              {/* Date */}
              <div>
                <p className="text-xs text-muted-foreground mb-2.5">When?</p>
                <div className="flex flex-wrap gap-2">
                  {DATE_CHIPS.map(chip => {
                    const isCustom  = chip.value === '__custom';
                    const isSelected = isCustom
                      ? !DATE_CHIPS.slice(0,-1).some(c => c.value === draft.scheduledDate) && !!draft.scheduledDate
                      : draft.scheduledDate === chip.value;
                    return (
                      <button key={chip.value}
                        onClick={() => {
                          if (isCustom) setField('scheduledDate', customDate || 'Custom');
                          else setField('scheduledDate', chip.value);
                        }}
                        className={`rounded-full border px-3.5 py-2 text-sm transition-all ${
                          isSelected
                            ? 'bg-primary border-primary text-primary-foreground shadow-sm'
                            : 'border-border text-foreground bg-card hover:border-border'
                        }`}>
                        {isCustom ? '📅 Pick date' : chip.label}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => setField('scheduledDate', '')}
                    className={`rounded-full border px-3.5 py-2 text-sm transition-all ${
                      draft.scheduledDate === ''
                        ? 'bg-secondary border-border text-foreground'
                        : 'border-border text-muted-foreground bg-card hover:border-border'
                    }`}>
                    Unscheduled
                  </button>
                </div>

                {/* Custom date input */}
                {draft.scheduledDate === 'Custom' || draft.scheduledDate === '__custom' ? (
                  <Input
                    type="date"
                    value={customDate}
                    onChange={e => { setCustomDate(e.target.value); setField('scheduledDate', e.target.value); }}
                    className="mt-2.5 min-h-11"
                  />
                ) : null}
              </div>

              {/* Time */}
              {draft.scheduledDate && draft.scheduledDate !== '' && (
                <div style={{ animation: 'fadeUp 0.15s ease' }}>
                  <p className="text-xs text-muted-foreground mb-2.5">What time?</p>
                  <div className="flex flex-wrap gap-2">
                    {['8:00 AM','9:00 AM','10:00 AM','11:00 AM','1:00 PM','2:00 PM','3:00 PM','4:00 PM'].map(t => (
                      <button key={t} onClick={() => setField('scheduledTime', draft.scheduledTime === t ? '' : t)}
                        className={`rounded-full border px-3 py-2 text-sm transition-all ${
                          draft.scheduledTime === t
                            ? 'bg-primary border-primary text-primary-foreground'
                            : 'border-border text-foreground bg-card hover:border-border'
                        }`}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Tech assignment */}
              <div>
                <p className="text-xs text-muted-foreground mb-2.5">Assign technician</p>
                <div className="flex flex-col gap-2">
                  {/* Unassigned */}
                  <button onClick={() => setField('assignedTech', '')}
                    className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all ${
                      draft.assignedTech === ''
                        ? 'border-border bg-secondary shadow-sm'
                        : 'border-border bg-card hover:border-border'
                    }`}>
                    <div className="flex size-9 items-center justify-center rounded-full bg-border shrink-0">
                      <User size={16} className="text-muted-foreground" />
                    </div>
                    <p className="flex-1 text-sm text-foreground">Unassigned</p>
                    {draft.assignedTech === '' && <Check size={14} className="text-foreground shrink-0" />}
                  </button>

                  {techRoster.map(t => (
                    <button key={t.id} onClick={() => setField('assignedTech', t.name)}
                      className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all ${
                        draft.assignedTech === t.name
                          ? 'border-primary/30 bg-primary/10 shadow-sm'
                          : 'border-border bg-card hover:border-border'
                      }`}>
                      <div
                        className="flex size-9 items-center justify-center rounded-full text-primary-foreground text-xs shrink-0"
                        style={{ background: t.color }}
                      >
                        {t.initials}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground">{t.name}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{t.activeJobs} active job{t.activeJobs !== 1 ? 's' : ''}</p>
                      </div>
                      {draft.assignedTech === t.name && <Check size={14} className="text-primary shrink-0" />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ══ DONE ══ */}
          {step === 'done' && (
            <div className="p-5 flex flex-col gap-5" style={{ animation: 'fadeUp 0.25s ease' }}>
              {/* Success */}
              <div className="flex flex-col items-center gap-3 pt-3 text-center">
                <div className="flex size-16 items-center justify-center rounded-full bg-success/15">
                  <Check size={28} className="text-success" />
                </div>
                <div>
                  <p className="text-foreground" style={{ fontSize: '1.05rem' }}>Job #{jobNum} created</p>
                  <p className="text-sm text-muted-foreground mt-0.5">{customer?.name}</p>
                </div>
              </div>

              {createError && (
                <p className="text-xs text-destructive text-center">{createError}</p>
              )}

              {/* Summary card */}
              <div className="rounded-2xl border border-border overflow-hidden bg-card">
                <div className="px-4 py-3 bg-primary">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-primary-foreground">{draft.serviceType ? `${SVC_ICON[draft.serviceType]} ${draft.serviceType}` : '🔧 Service'}</p>
                    <span className="text-xs text-muted-foreground">#{jobNum}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{draft.description}</p>
                </div>
                <div className="divide-y divide-border">
                  <div className="flex items-center gap-3 px-4 py-2.5">
                    <User size={13} className="text-muted-foreground shrink-0" />
                    <p className="text-xs text-muted-foreground">Customer</p>
                    <p className="text-sm text-foreground ml-auto">{customer?.name}</p>
                  </div>
                  <div className="flex items-center gap-3 px-4 py-2.5">
                    <MapPin size={13} className="text-muted-foreground shrink-0" />
                    <p className="text-xs text-muted-foreground flex-1 truncate">{address || customer?.address}</p>
                  </div>
                  <div className="flex items-center gap-3 px-4 py-2.5">
                    <Calendar size={13} className="text-muted-foreground shrink-0" />
                    <p className="text-xs text-muted-foreground">Date</p>
                    <p className="text-sm text-foreground ml-auto">
                      {draft.scheduledDate
                        ? `${draft.scheduledDate}${draft.scheduledTime ? ` · ${draft.scheduledTime}` : ''}`
                        : 'Unscheduled'}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 px-4 py-2.5">
                    <User size={13} className="text-muted-foreground shrink-0" />
                    <p className="text-xs text-muted-foreground">Technician</p>
                    <div className="ml-auto flex items-center gap-1.5">
                      {tech ? (
                        <>
                          <span className="flex size-5 items-center justify-center rounded-full text-primary-foreground" style={{ fontSize: 8, background: tech.color }}>{tech.initials}</span>
                          <p className="text-sm text-foreground">{tech.name.split(' ')[0]}</p>
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">Unassigned</p>
                      )}
                    </div>
                  </div>
                  {draft.priority === 'Urgent' && (
                    <div className="flex items-center gap-3 px-4 py-2.5 bg-destructive/10">
                      <AlertCircle size={13} className="text-destructive shrink-0" />
                      <p className="text-sm text-destructive">Marked urgent</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Next actions */}
              <div>
                <p className="text-xs text-muted-foreground text-center mb-3">What would you like to do next?</p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => { onCreated(createdJobFilter); onClose(); }}
                    className="flex flex-col items-center gap-2.5 rounded-2xl border-2 border-border bg-card py-4 px-3 hover:border-primary/30 hover:bg-primary/10 active:scale-[0.97] transition-all group"
                  >
                    <div className="flex size-11 items-center justify-center rounded-xl bg-primary/15 group-hover:bg-primary/15 transition-colors">
                      <ClipboardList size={20} className="text-primary" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm text-foreground">View job</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Open detail</p>
                    </div>
                  </button>

                  {onOpenEstimate ? (
                    <button
                      onClick={() => { onCreated(createdJobFilter); onOpenEstimate(); }}
                      className="flex flex-col items-center gap-2.5 rounded-2xl border-2 border-border bg-card py-4 px-3 hover:border-primary/30 hover:bg-primary/10 active:scale-[0.97] transition-all group"
                    >
                      <div className="flex size-11 items-center justify-center rounded-xl bg-primary/15 group-hover:bg-primary/15 transition-colors">
                        <FileText size={20} className="text-primary" />
                      </div>
                      <div className="text-center">
                        <p className="text-sm text-foreground">Add estimate</p>
                        <p className="text-xs text-muted-foreground mt-0.5">Build a quote</p>
                      </div>
                    </button>
                  ) : (
                    <button
                      onClick={() => { onCreated(createdJobFilter); onClose(); }}
                      className="flex flex-col items-center gap-2.5 rounded-2xl border-2 border-border bg-card py-4 px-3 hover:border-success/30 hover:bg-success/10 active:scale-[0.97] transition-all group"
                    >
                      <div className="flex size-11 items-center justify-center rounded-xl bg-success/15 group-hover:bg-success/15 transition-colors">
                        <Send size={20} className="text-success" />
                      </div>
                      <div className="text-center">
                        <p className="text-sm text-foreground">Dispatch</p>
                        <p className="text-xs text-muted-foreground mt-0.5">Notify tech</p>
                      </div>
                    </button>
                  )}
                </div>
              </div>

              <button onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground transition-colors text-center">
                Done for now
              </button>
            </div>
          )}

        </div>

        {/* ── Footer CTA ── */}
        {step === 'voice' && vPhase === 'confirmed' && parsed && (
          <div className="shrink-0 px-5 py-4 border-t border-border bg-card">
            <button
              onClick={createJob}
              // BUG-3 — disabled predicate must mirror the validation
              // in `createJob()` (draft.*), otherwise the button can
              // light up while createJob silently early-returns or, in
              // the inverse case, stay disabled with no explanation.
              disabled={!draft.customerId || !draft.locationId || !draft.description.trim() || creating}
              className="flex items-center justify-center gap-2 w-full rounded-xl bg-primary text-primary-foreground py-3.5 text-sm disabled:opacity-40 hover:bg-primary/90 transition-colors"
            >
              {creating
                ? <><span className="size-4 rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground animate-spin" /> Creating job…</>
                : <><Check size={14} /> Create job {parsed.scheduledDate ? `· ${parsed.scheduledDate}` : ''}</>
              }
            </button>
            {(!draft.customerId || !draft.locationId || !draft.description.trim()) && (
              <p className="text-xs text-warning text-center mt-2">
                {!draft.customerId
                  ? 'Couldn’t detect customer — use "Fill it in" for manual entry'
                  : !draft.locationId
                  ? 'Pick a service location to continue'
                  : 'Add a short description to continue'}
              </p>
            )}
            {createError && (
              <p className="text-xs text-destructive text-center mt-2">{createError}</p>
            )}
          </div>
        )}

        {step === 'customer' && (
          <div className="shrink-0 px-5 py-4 border-t border-border bg-card">
            <button
              onClick={() => setStep('details')}
              disabled={!draft.customerId || (multiLoc && !draft.locationId)}
              className="flex items-center justify-center gap-2 w-full rounded-xl bg-primary text-primary-foreground py-3.5 text-sm disabled:opacity-40 hover:bg-primary/90 transition-colors"
            >
              Next: Job details →
            </button>
          </div>
        )}

        {step === 'details' && (
          <div className="shrink-0 px-5 py-4 border-t border-border bg-card">
            <button
              onClick={() => setStep('schedule')}
              disabled={!draft.serviceType || !draft.description.trim()}
              className="flex items-center justify-center gap-2 w-full rounded-xl bg-primary text-primary-foreground py-3.5 text-sm disabled:opacity-40 hover:bg-primary/90 transition-colors"
            >
              Next: Schedule →
            </button>
          </div>
        )}

        {step === 'schedule' && (
          <div className="shrink-0 px-5 py-4 border-t border-border bg-card">
            <button
              onClick={createJob}
              disabled={creating || !canCreate}
              className="flex items-center justify-center gap-2 w-full rounded-xl bg-primary text-primary-foreground py-3.5 text-sm disabled:opacity-40 hover:bg-primary/90 transition-colors"
            >
              {creating
                ? <><span className="size-4 rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground animate-spin" /> Creating job…</>
                : <>
                    <Check size={14} />
                    Create job{draft.scheduledDate
                      ? ` · ${draft.scheduledDate}${draft.assignedTech ? ` · ${draft.assignedTech.split(' ')[0]}` : ''}`
                      : ' (unscheduled)'}
                  </>
              }
            </button>
            {createError && (
              <p className="text-xs text-destructive text-center mt-2">{createError}</p>
            )}
          </div>
        )}

      </div>

      <style>{`
        @keyframes jobUp  { from { transform:translateY(100%); opacity:0 } to { transform:translateY(0); opacity:1 } }
        @keyframes fadeUp { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }
      `}</style>
    </div>
  );
}
