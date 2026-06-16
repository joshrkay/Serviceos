import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Field, Input, Select } from '../ui';
import {
  type CustomerContact,
  type CustomerContactRole,
  listContacts,
  createContact,
  updateContact,
  archiveContact,
} from '../../api/customers';

/**
 * U1 (CRM Jobber parity) — multiple contacts per customer.
 *
 * Self-contained panel for the customer detail page: lists contacts with
 * their role, lets the owner add a contact, promote one to primary, or
 * remove (archive) it. Talks to /api/customers/:id/contacts.
 */

const ROLE_LABELS: Record<CustomerContactRole, string> = {
  primary: 'Primary',
  billing: 'Billing',
  site: 'Site',
  other: 'Other',
};

interface ContactFormState {
  name: string;
  role: CustomerContactRole;
  phone: string;
  email: string;
}

const emptyForm: ContactFormState = { name: '', role: 'other', phone: '', email: '' };

export function ContactsPanel({ customerId }: { customerId: string }) {
  const [contacts, setContacts] = useState<CustomerContact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<ContactFormState>(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setContacts(await listContacts(customerId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load contacts');
    }
  }, [customerId]);

  useEffect(() => {
    // Clear the prior customer's contacts so a customerId change doesn't flash
    // stale rows while the new fetch is in flight.
    setContacts([]);
    void load();
  }, [load]);

  const handleAdd = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setSaving(true);
      setError(null);
      try {
        await createContact(customerId, {
          name: form.name.trim(),
          role: form.role,
          phone: form.phone.trim() || undefined,
          email: form.email.trim() || undefined,
        });
        setForm(emptyForm);
        toast.success('Contact added');
        await load();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to add contact';
        setError(message);
        toast.error(message);
      } finally {
        setSaving(false);
      }
    },
    [customerId, form, load],
  );

  const handleSetPrimary = useCallback(
    async (contactId: string) => {
      try {
        await updateContact(customerId, contactId, { isPrimary: true });
        toast.success('Primary contact updated');
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to update contact');
      }
    },
    [customerId, load],
  );

  const handleRemove = useCallback(
    async (contactId: string) => {
      try {
        await archiveContact(customerId, contactId);
        toast.success('Contact removed');
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to remove contact');
      }
    },
    [customerId, load],
  );

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {contacts.map((contact) => (
          <div
            key={contact.id}
            className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 p-3"
          >
            <span className="text-sm font-medium text-slate-900">{contact.name}</span>
            <Badge variant={contact.isPrimary ? 'info' : 'neutral'}>
              {ROLE_LABELS[contact.role]}
            </Badge>
            {/* "Main contact" flag is independent of role; only show the extra
                badge when the role label doesn't already say "Primary". */}
            {contact.isPrimary && contact.role !== 'primary' && (
              <Badge variant="success">Primary</Badge>
            )}
            <span className="text-sm text-slate-500">
              {[contact.phone, contact.email].filter(Boolean).join(' · ') || '—'}
            </span>
            <div className="ml-auto flex gap-2">
              {!contact.isPrimary && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleSetPrimary(contact.id)}
                >
                  Make primary
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleRemove(contact.id)}
                aria-label={`Remove ${contact.name}`}
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
        {contacts.length === 0 && (
          <p className="text-sm text-slate-400">No additional contacts yet.</p>
        )}
      </div>

      <form onSubmit={handleAdd} className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Name" required className="md:col-span-2">
          <Input
            required
            aria-label="Name"
            value={form.name}
            placeholder="e.g. Dana Decider"
            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          />
        </Field>
        <Field label="Role">
          <Select
            aria-label="Contact role"
            value={form.role}
            onChange={(e) =>
              setForm((p) => ({ ...p, role: e.target.value as CustomerContactRole }))
            }
          >
            <option value="primary">Primary</option>
            <option value="billing">Billing</option>
            <option value="site">Site</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <Field label="Phone">
          <Input
            aria-label="Phone"
            value={form.phone}
            onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
          />
        </Field>
        <Field label="Email" className="md:col-span-2">
          <Input
            aria-label="Email"
            type="email"
            value={form.email}
            onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
          />
        </Field>
        <div className="md:col-span-2">
          <Button type="submit" variant="outline" loading={saving}>
            Add contact
          </Button>
        </div>
      </form>
    </div>
  );
}
