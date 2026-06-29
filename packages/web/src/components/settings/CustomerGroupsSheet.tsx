/**
 * U8 (CRM Jobber parity) — customer group manager.
 *
 * Create/archive named customer segments (with an optional color). Membership
 * is edited on each customer's detail; campaigns can target a group. Talks to
 * /api/customer-groups. API fns are injectable for jsdom.
 */
import { useCallback, useEffect, useState } from 'react';
import { X, Users, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '../ui';
import {
  type CustomerGroupWithCount,
  archiveCustomerGroup as archiveApi,
  createCustomerGroup as createApi,
  listCustomerGroups as listApi,
} from '../../api/customer-groups';

export interface CustomerGroupsSheetApi {
  list: typeof listApi;
  create: typeof createApi;
  archive: typeof archiveApi;
}

const DEFAULT_API: CustomerGroupsSheetApi = { list: listApi, create: createApi, archive: archiveApi };

export function CustomerGroupsSheet({
  onClose,
  api = DEFAULT_API,
}: {
  onClose: () => void;
  api?: CustomerGroupsSheetApi;
}) {
  const [groups, setGroups] = useState<CustomerGroupWithCount[]>([]);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#3b82f6');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setGroups(await api.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load groups');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setError('');
    if (!name.trim()) {
      setError('Give the group a name.');
      return;
    }
    setSaving(true);
    try {
      await api.create({ name: name.trim(), color });
      setName('');
      setColor('#3b82f6');
      await load();
      toast.success('Group created');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not create group';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const archive = async (group: CustomerGroupWithCount) => {
    try {
      await api.archive(group.id);
      await load();
      toast.success(`${group.name} removed`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove group');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="customer-groups-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 sticky top-0 bg-white">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
            <Users size={16} className="text-slate-700" />
          </span>
          <h2 id="customer-groups-title" className="flex-1 text-base text-slate-900">
            Customer groups
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-3">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <p className="text-sm text-slate-500">
            Named segments you can target with campaigns. Add customers to a group from their profile.
          </p>

          {groups.length === 0 && <p className="text-sm text-slate-400 italic">No groups yet.</p>}
          {groups.map((group) => (
            <div
              key={group.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                {group.color && (
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: group.color }}
                  />
                )}
                <span className="text-sm text-slate-900 truncate">{group.name}</span>
                <span className="text-xs text-slate-400 shrink-0">
                  {group.memberCount} member{group.memberCount === 1 ? '' : 's'}
                </span>
              </div>
              <button
                type="button"
                aria-label={`Remove ${group.name}`}
                onClick={() => archive(group)}
                className="flex items-center justify-center min-h-11 px-2 rounded-lg text-slate-400 hover:text-destructive"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}

          <div className="rounded-lg border border-border p-3 flex items-center gap-2">
            <input
              type="color"
              aria-label="Group color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-11 w-11 rounded-lg border border-border"
            />
            <Input
              aria-label="New group name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="min-h-11 flex-1"
              placeholder="Group name (e.g. Service plan members)"
            />
            <button
              type="button"
              onClick={add}
              disabled={saving}
              className="flex items-center gap-1 min-h-11 px-3 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50"
            >
              <Plus size={14} /> {saving ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
