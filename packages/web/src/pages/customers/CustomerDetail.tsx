import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { DetailPage } from '../../components/DetailPage';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { CommunicationTimeline } from '../../components/customers/CommunicationTimeline';
import { LanguageBadge } from '../../components/customers/LanguageBadge';
import { apiFetch } from '../../utils/api-fetch';

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
  ].filter(Boolean).join(', ');
}

export function CustomerDetail({ customerId, onBack, onEdit, onArchived }: CustomerDetailProps) {
  const { data, isLoading, error, refetch } = useDetailQuery<Customer>('/api/customers', customerId);
  const [locations, setLocations] = useState<ServiceLocation[]>([]);
  const [locationsError, setLocationsError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteSaving, setNoteSaving] = useState(false);
  const [locationForm, setLocationForm] = useState<LocationFormState>(emptyLocationForm);
  const [locationSaving, setLocationSaving] = useState(false);

  const loadLocations = useCallback(async () => {
    setLocationsError(null);
    try {
      const res = await apiFetch(`/api/locations?customerId=${encodeURIComponent(customerId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setLocations(await res.json());
    } catch (err) {
      setLocationsError(err instanceof Error ? err.message : 'Failed to load locations');
    }
  }, [customerId]);

  useEffect(() => {
    if (!data) return;
    setNote(data.communicationNotes ?? '');
    void loadLocations();
  }, [data, loadLocations]);

  const handleSaveNote = useCallback(async () => {
    setNoteSaving(true);
    setNoteError(null);
    try {
      const res = await apiFetch(`/api/customers/${customerId}`, {
        method: 'PUT',
        body: JSON.stringify({
          firstName: data?.firstName,
          lastName: data?.lastName,
          companyName: data?.companyName,
          primaryPhone: data?.primaryPhone,
          secondaryPhone: data?.secondaryPhone,
          email: data?.email,
          preferredChannel: data?.preferredChannel,
          communicationNotes: note.trim() || '',
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.message ?? `HTTP ${res.status}`);
      }
      await refetch();
    } catch (err) {
      setNoteError(err instanceof Error ? err.message : 'Failed to save note');
    } finally {
      setNoteSaving(false);
    }
  }, [customerId, data, note, refetch]);

  const handleAddLocation = useCallback(async (event: React.FormEvent) => {
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
      await loadLocations();
    } catch (err) {
      setLocationsError(err instanceof Error ? err.message : 'Failed to add location');
    } finally {
      setLocationSaving(false);
    }
  }, [customerId, loadLocations, locationForm]);

  const handleArchive = useCallback(async () => {
    const res = await apiFetch(`/api/customers/${customerId}/archive`, { method: 'POST' });
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
        { label: data.isArchived ? 'Archived' : 'Archive', onClick: handleArchive, variant: 'danger' },
      ]}
      sections={[
        {
          title: 'Contact Information',
          content: (
            <div>
              <p>Email: {data.email || 'N/A'}</p>
              <p>Phone: {data.primaryPhone || 'N/A'}</p>
              <p>Secondary: {data.secondaryPhone || 'N/A'}</p>
              <p>Preferred: {data.preferredChannel}</p>
              {/* P11-002: surface the customer's spoken-language preference
                  so dispatchers can route Spanish callers correctly. The
                  badge renders nothing when no preference is set. */}
              <p className="flex items-center gap-2">
                <span>Language:</span>
                <LanguageBadge language={data.preferredLanguage ?? null} />
                <label className="ml-2 text-xs">
                  <span className="sr-only">Edit preferred language</span>
                  <select
                    aria-label="Preferred language"
                    defaultValue={data.preferredLanguage ?? ''}
                    className="rounded border px-1 py-0.5 text-xs"
                  >
                    <option value="">—</option>
                    <option value="en">English</option>
                    <option value="es">Español</option>
                  </select>
                </label>
              </p>
            </div>
          ),
        },
        {
          title: 'Customer Notes',
          content: (
            <div>
              {note.trim() ? (
                <p className="whitespace-pre-wrap">{note}</p>
              ) : (
                <p className="text-sm text-slate-500">No customer notes yet.</p>
              )}
              <label className="mt-3 block text-xs text-slate-500">
                Edit customer notes
                <textarea
                  aria-label="Customer notes"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </label>
              {noteError && <p role="alert" className="mt-2 text-sm text-red-600">{noteError}</p>}
              <button
                type="button"
                onClick={handleSaveNote}
                disabled={noteSaving}
                className="mt-2 rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
              >
                {noteSaving ? 'Saving...' : 'Save note'}
              </button>
            </div>
          ),
        },
        {
          title: 'Service Locations',
          content: (
            <div>
              {locationsError && <p role="alert" className="mb-2 text-sm text-red-600">{locationsError}</p>}
              <div className="space-y-2">
                {locations.map((location) => (
                  <div key={location.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-slate-900">{location.label || 'Service location'}</p>
                      {location.isPrimary && (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">Primary</span>
                      )}
                    </div>
                    <p className="text-sm text-slate-600">{formatLocation(location)}</p>
                    {location.accessNotes && <p className="mt-1 text-xs text-amber-700">{location.accessNotes}</p>}
                  </div>
                ))}
                {locations.length === 0 && <p className="text-sm text-slate-500">No service locations yet.</p>}
              </div>
              <form onSubmit={handleAddLocation} className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2">
                <input
                  aria-label="Location label"
                  placeholder="Label"
                  value={locationForm.label}
                  onChange={(event) => setLocationForm((prev) => ({ ...prev, label: event.target.value }))}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
                <input
                  aria-label="Street address"
                  placeholder="Street address"
                  required
                  value={locationForm.street1}
                  onChange={(event) => setLocationForm((prev) => ({ ...prev, street1: event.target.value }))}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
                <input
                  aria-label="City"
                  placeholder="City"
                  required
                  value={locationForm.city}
                  onChange={(event) => setLocationForm((prev) => ({ ...prev, city: event.target.value }))}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
                <input
                  aria-label="State"
                  placeholder="State"
                  required
                  value={locationForm.state}
                  onChange={(event) => setLocationForm((prev) => ({ ...prev, state: event.target.value }))}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
                <input
                  aria-label="Postal code"
                  placeholder="Postal code"
                  required
                  value={locationForm.postalCode}
                  onChange={(event) => setLocationForm((prev) => ({ ...prev, postalCode: event.target.value }))}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
                <button
                  type="submit"
                  disabled={locationSaving}
                  className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                >
                  {locationSaving ? 'Saving...' : 'Add service location'}
                </button>
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
                  <Link to={`/leads/${data.originatingLeadId}`} className="text-blue-600 hover:underline">
                    {data.originatingLeadId}
                  </Link>
                  .
                </p>
              ) : null}
              <CommunicationTimeline customerId={customerId} />
            </div>
          ),
        },
      ]}
    />
  );
}
