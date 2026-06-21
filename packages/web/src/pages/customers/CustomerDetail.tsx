import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { MapPin, CalendarPlus, FileText, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { DetailPage } from '../../components/DetailPage';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { CommunicationTimeline } from '../../components/customers/CommunicationTimeline';
import { CustomerProfitCard } from '../../components/customers/CustomerProfitCard';
import { toTitleCase } from '../../utils/string';
import { LanguageBadge } from '../../components/customers/LanguageBadge';
import { ContactsPanel } from '../../components/customers/ContactsPanel';
import { TagsPanel } from '../../components/customers/TagsPanel';
import { CustomFieldsPanel } from '../../components/customers/CustomFieldsPanel';
import { apiFetch } from '../../utils/api-fetch';
import {
  Badge,
  Button,
  Field,
  Input,
  Select,
  Textarea,
} from '../../components/ui';

interface Customer {
  id: string;
  displayName: string;
  firstName: string;
  lastName: string;
  companyName?: string;
  email?: string;
  primaryPhone?: string;
  secondaryPhone?: string;
  preferredChannel: string;
  communicationNotes?: string;
  isArchived: boolean;
  originatingLeadId?: string;
  /** Jobber-parity acquisition channel ("How did you hear about us?"). */
  source?: string;
  /** P11-002: optional spoken-language preference. */
  preferredLanguage?: 'en' | 'es' | null;
}

interface ServiceLocation {
  id: string;
  label?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
  accessNotes?: string;
  isPrimary: boolean;
  /** U3 (CRM Jobber parity) — service vs billing/mailing address. */
  addressType?: 'service' | 'billing' | 'both';
}

interface LocationFormState {
  label: string;
  street1: string;
  city: string;
  state: string;
  postalCode: string;
}

interface CustomerDetailProps {
  customerId: string;
  onBack?: () => void;
  onEdit?: () => void;
  onArchived?: () => void;
}

const emptyLocationForm: LocationFormState = {
  label: '',
  street1: '',
  city: '',
  state: '',
  postalCode: '',
};

function formatLocation(location: ServiceLocation): string {
  return [
    location.street1,
    location.street2,
    location.city,
    location.state,
    location.postalCode,
  ]
    .filter(Boolean)
    .join(', ');
}

export function CustomerDetail({
  customerId,
  onBack,
  onEdit,
  onArchived,
}: CustomerDetailProps) {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useDetailQuery<Customer>(
    '/api/customers',
    customerId,
  );
  const [locations, setLocations] = useState<ServiceLocation[]>([]);
  const [locationsError, setLocationsError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteSaving, setNoteSaving] = useState(false);
  const [language, setLanguage] = useState<string>('');
  const [languageSaving, setLanguageSaving] = useState(false);
  const [locationForm, setLocationForm] =
    useState<LocationFormState>(emptyLocationForm);
  const [locationSaving, setLocationSaving] = useState(false);

  const loadLocations = useCallback(async () => {
    setLocationsError(null);
    try {
      const res = await apiFetch(
        `/api/locations?customerId=${encodeURIComponent(customerId)}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setLocations(await res.json());
    } catch (err) {
      setLocationsError(
        err instanceof Error ? err.message : 'Failed to load locations',
      );
    }
  }, [customerId]);

  useEffect(() => {
    if (!data) return;
    setNote(data.communicationNotes ?? '');
    setLanguage(data.preferredLanguage ?? '');
    void loadLocations();
  }, [data, loadLocations]);

  // Partial update — send only `communicationNotes` so we never clobber
  // other fields with potentially stale local values.
  const handleSaveNote = useCallback(async () => {
    setNoteSaving(true);
    setNoteError(null);
    try {
      const res = await apiFetch(`/api/customers/${customerId}`, {
        method: 'PUT',
        body: JSON.stringify({ communicationNotes: note.trim() || '' }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.message ?? `HTTP ${res.status}`);
      }
      toast.success('Customer note saved');
      await refetch();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to save note';
      setNoteError(message);
      toast.error(message);
    } finally {
      setNoteSaving(false);
    }
  }, [customerId, note, refetch]);

  // P11-002: persist the spoken-language preference. Previously this
  // control had a defaultValue but no handler, so selections were lost.
  const handleLanguageChange = useCallback(
    async (next: string) => {
      const previous = language;
      setLanguage(next);
      setLanguageSaving(true);
      try {
        const res = await apiFetch(`/api/customers/${customerId}`, {
          method: 'PUT',
          body: JSON.stringify({ preferredLanguage: next || null }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json?.message ?? `HTTP ${res.status}`);
        }
        toast.success('Language preference saved');
        await refetch();
      } catch (err) {
        setLanguage(previous);
        toast.error(
          err instanceof Error ? err.message : 'Failed to save language',
        );
      } finally {
        setLanguageSaving(false);
      }
    },
    [customerId, language, refetch],
  );

  const handleAddLocation = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setLocationSaving(true);
      setLocationsError(null);
      try {
        const res = await apiFetch('/api/locations', {
          method: 'POST',
          body: JSON.stringify({
            customerId,
            label: locationForm.label.trim() || undefined,
            street1: locationForm.street1.trim(),
            city: locationForm.city.trim(),
            state: locationForm.state.trim(),
            postalCode: locationForm.postalCode.trim(),
          }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json?.message ?? `HTTP ${res.status}`);
        }
        setLocationForm(emptyLocationForm);
        toast.success('Service location added');
        await loadLocations();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to add location';
        setLocationsError(message);
        toast.error(message);
      } finally {
        setLocationSaving(false);
      }
    },
    [customerId, loadLocations, locationForm],
  );

  // U3 (CRM Jobber parity) — mark a property as the billing/mailing address
  // (invoices/estimates resolve to it via resolveBillingLocation server-side).
  const handleSetBilling = useCallback(
    async (locationId: string) => {
      try {
        const res = await apiFetch(`/api/locations/${locationId}`, {
          method: 'PUT',
          body: JSON.stringify({ addressType: 'billing' }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json?.message ?? `HTTP ${res.status}`);
        }
        toast.success('Billing address updated');
        await loadLocations();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : 'Failed to set billing address',
        );
      }
    },
    [loadLocations],
  );

  const handleArchive = useCallback(async () => {
    const res = await apiFetch(`/api/customers/${customerId}/archive`, {
      method: 'POST',
    });
    if (res.ok) onArchived?.();
  }, [customerId, onArchived]);

  if (!data) {
    return (
      <DetailPage
        title="Customer"
        sections={[]}
        isLoading={isLoading}
        error={error}
        onBack={onBack}
        onRetry={refetch}
      />
    );
  }

  return (
    <DetailPage
      title={data.displayName}
      subtitle={data.companyName}
      isLoading={isLoading}
      error={error}
      onBack={onBack}
      onRetry={refetch}
      actions={[
        { label: 'Edit', onClick: () => onEdit?.(), variant: 'primary' },
        {
          label: data.isArchived ? 'Archived' : 'Archive',
          onClick: handleArchive,
          variant: 'danger',
          disabled: data.isArchived,
        },
      ]}
      sections={[
        {
          // 4.5 — quick actions: schedule, estimate, message. Each deep-links
          // into the matching create/compose flow with this customer attached.
          title: 'Quick Actions',
          content: (
            <div className="grid grid-cols-3 gap-2" data-testid="customer-quick-actions">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  navigate(`/jobs/new?customerId=${encodeURIComponent(customerId)}`)
                }
              >
                <CalendarPlus size={14} className="mr-1.5" />
                Schedule
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  navigate(`/estimates/new?customerId=${encodeURIComponent(customerId)}`)
                }
              >
                <FileText size={14} className="mr-1.5" />
                Estimate
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  navigate(`/comms-inbox?customerId=${encodeURIComponent(customerId)}`)
                }
              >
                <MessageSquare size={14} className="mr-1.5" />
                Message
              </Button>
            </div>
          ),
        },
        {
          title: 'Contact Information',
          content: (
            <dl className="flex flex-col gap-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-400">Email</dt>
                <dd className="text-slate-800">{data.email || '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-400">Phone</dt>
                <dd className="text-slate-800">{data.primaryPhone || '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-400">Secondary</dt>
                <dd className="text-slate-800">{data.secondaryPhone || '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-400">Preferred channel</dt>
                <dd className="text-slate-800 capitalize">
                  {data.preferredChannel}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-400">Source</dt>
                <dd className="text-slate-800">
                  {data.source ? toTitleCase(data.source) : '—'}
                </dd>
              </div>
              {/* P11-002: spoken-language preference, now persisted on change
                  so dispatchers can route Spanish callers correctly. */}
              <div className="flex items-center justify-between gap-4 pt-1">
                <dt className="flex items-center gap-2 text-slate-400">
                  Language
                  <LanguageBadge
                    language={(language || null) as 'en' | 'es' | null}
                  />
                </dt>
                <dd className="w-32">
                  <Select
                    aria-label="Preferred language"
                    value={language}
                    disabled={languageSaving}
                    onChange={(e) => handleLanguageChange(e.target.value)}
                  >
                    <option value="">—</option>
                    <option value="en">English</option>
                    <option value="es">Español</option>
                  </Select>
                </dd>
              </div>
            </dl>
          ),
        },
        {
          title: 'Contacts',
          content: <ContactsPanel customerId={customerId} />,
        },
        {
          title: 'Customer Notes',
          content: (
            <div className="flex flex-col gap-3">
              {note.trim() ? (
                <p className="whitespace-pre-wrap text-sm text-slate-700">
                  {note}
                </p>
              ) : (
                <p className="text-sm text-slate-400">No customer notes yet.</p>
              )}
              <Field label="Edit customer notes" error={noteError}>
                <Textarea
                  aria-label="Customer notes"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={3}
                />
              </Field>
              <div>
                <Button
                  size="sm"
                  loading={noteSaving}
                  onClick={handleSaveNote}
                >
                  Save note
                </Button>
              </div>
            </div>
          ),
        },
        {
          title: 'Tags',
          content: <TagsPanel customerId={customerId} />,
        },
        {
          title: 'Custom Fields',
          content: <CustomFieldsPanel customerId={customerId} />,
        },
        {
          title: 'Service Locations',
          content: (
            <div className="flex flex-col gap-4">
              {locationsError && (
                <p role="alert" className="text-sm text-red-600">
                  {locationsError}
                </p>
              )}
              <div className="flex flex-col gap-2">
                {locations.map((location) => (
                  <div
                    key={location.id}
                    className="rounded-xl border border-slate-200 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <MapPin size={13} className="shrink-0 text-slate-400" />
                      <p className="text-sm text-slate-900">
                        {location.label || 'Service location'}
                      </p>
                      {location.isPrimary && (
                        <Badge variant="info">Primary</Badge>
                      )}
                      {(location.addressType === 'billing' ||
                        location.addressType === 'both') && (
                        <Badge variant="success">Billing</Badge>
                      )}
                      {location.addressType !== 'billing' &&
                        location.addressType !== 'both' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="ml-auto"
                            onClick={() => handleSetBilling(location.id)}
                          >
                            Set as billing
                          </Button>
                        )}
                    </div>
                    <p className="mt-1 pl-5 text-sm text-slate-600">
                      {formatLocation(location)}
                    </p>
                    {location.accessNotes && (
                      <p className="mt-1 pl-5 text-xs text-amber-700">
                        {location.accessNotes}
                      </p>
                    )}
                  </div>
                ))}
                {locations.length === 0 && (
                  <p className="text-sm text-slate-400">
                    No service locations yet.
                  </p>
                )}
              </div>
              <form
                onSubmit={handleAddLocation}
                className="grid grid-cols-1 gap-3 md:grid-cols-2"
              >
                <Field label="Label" className="md:col-span-2">
                  <Input
                    placeholder="e.g. Home, Office"
                    value={locationForm.label}
                    onChange={(event) =>
                      setLocationForm((prev) => ({
                        ...prev,
                        label: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="Street address" required className="md:col-span-2">
                  <Input
                    required
                    value={locationForm.street1}
                    onChange={(event) =>
                      setLocationForm((prev) => ({
                        ...prev,
                        street1: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="City" required>
                  <Input
                    required
                    value={locationForm.city}
                    onChange={(event) =>
                      setLocationForm((prev) => ({
                        ...prev,
                        city: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="State" required>
                  <Input
                    required
                    value={locationForm.state}
                    onChange={(event) =>
                      setLocationForm((prev) => ({
                        ...prev,
                        state: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="Postal code" required>
                  <Input
                    required
                    value={locationForm.postalCode}
                    onChange={(event) =>
                      setLocationForm((prev) => ({
                        ...prev,
                        postalCode: event.target.value,
                      }))
                    }
                  />
                </Field>
                <div className="flex items-end md:col-span-2">
                  <Button
                    type="submit"
                    variant="outline"
                    loading={locationSaving}
                  >
                    Add service location
                  </Button>
                </div>
              </form>
            </div>
          ),
        },
        {
          title: 'Activity',
          content: (
            <div className="space-y-3">
              {data.originatingLeadId ? (
                <p className="text-sm text-slate-700">
                  Converted from lead{' '}
                  <Link
                    to={`/leads/${data.originatingLeadId}`}
                    className="text-blue-600 hover:underline"
                  >
                    {data.originatingLeadId}
                  </Link>
                  .
                </p>
              ) : null}
              <CustomerProfitCard customerId={customerId} />
              <CommunicationTimeline customerId={customerId} />
            </div>
          ),
        },
      ]}
    />
  );
}
