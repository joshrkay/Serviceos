import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  type CustomerGroup,
  type CustomerGroupWithCount,
  addCustomerToGroup as addApi,
  listCustomerGroups as listApi,
  listGroupsForCustomer as forCustomerApi,
  removeCustomerFromGroup as removeApi,
} from '../../api/customer-groups';

/**
 * U8 (CRM Jobber parity) — a customer's group membership.
 *
 * Shows every active group as a toggle; checking adds the customer to the
 * group, unchecking removes them. Group definitions are managed in settings.
 * API fns are injectable for jsdom.
 */
export interface CustomerGroupsPanelApi {
  listGroups: typeof listApi;
  forCustomer: typeof forCustomerApi;
  add: typeof addApi;
  remove: typeof removeApi;
}

const DEFAULT_API: CustomerGroupsPanelApi = {
  listGroups: listApi,
  forCustomer: forCustomerApi,
  add: addApi,
  remove: removeApi,
};

export function CustomerGroupsPanel({
  customerId,
  api = DEFAULT_API,
}: {
  customerId: string;
  api?: CustomerGroupsPanelApi;
}) {
  const [groups, setGroups] = useState<CustomerGroupWithCount[]>([]);
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [all, mine] = await Promise.all([api.listGroups(), api.forCustomer(customerId)]);
      setGroups(all);
      setMemberIds(new Set(mine.map((g: CustomerGroup) => g.id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load groups');
    }
  }, [api, customerId]);

  useEffect(() => {
    setGroups([]);
    setMemberIds(new Set());
    void load();
  }, [load]);

  const toggle = useCallback(
    async (group: CustomerGroupWithCount, member: boolean) => {
      setPendingId(group.id);
      // Optimistic update so the checkbox responds immediately.
      setMemberIds((prev) => {
        const next = new Set(prev);
        if (member) next.add(group.id);
        else next.delete(group.id);
        return next;
      });
      try {
        if (member) await api.add(group.id, customerId);
        else await api.remove(group.id, customerId);
      } catch (err) {
        // Roll back on failure.
        setMemberIds((prev) => {
          const next = new Set(prev);
          if (member) next.delete(group.id);
          else next.add(group.id);
          return next;
        });
        toast.error(err instanceof Error ? err.message : 'Failed to update group');
      } finally {
        setPendingId(null);
      }
    },
    [api, customerId],
  );

  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {error ?? 'No groups defined. Create them in settings to segment customers.'}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {groups.map((group) => {
        const member = memberIds.has(group.id);
        return (
          <label key={group.id} className="flex items-center gap-2 min-h-11">
            <input
              type="checkbox"
              aria-label={group.name}
              checked={member}
              disabled={pendingId === group.id}
              onChange={(e) => toggle(group, e.target.checked)}
              className="h-5 w-5"
            />
            {group.color && (
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: group.color }}
              />
            )}
            <span className="text-sm text-foreground">{group.name}</span>
          </label>
        );
      })}
    </div>
  );
}
