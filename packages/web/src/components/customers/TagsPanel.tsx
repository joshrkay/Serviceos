import React, { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { Button, Input } from '../ui';
import { listTags, addTag, removeTag } from '../../api/customers';

/**
 * U2 (CRM Jobber parity) — customer tags.
 *
 * Self-contained chip editor for the customer detail page: renders the
 * customer's tags as removable chips and adds new ones. The server returns
 * the updated tag list on add/remove, so we render straight from the
 * response. Talks to /api/customers/:id/tags.
 */
export function TagsPanel({ customerId }: { customerId: string }) {
  const [tags, setTags] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTags(await listTags(customerId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tags');
    }
  }, [customerId]);

  useEffect(() => {
    // Drop the prior customer's tags so a customerId change doesn't flash
    // stale chips while the new fetch is in flight.
    setTags([]);
    void load();
  }, [load]);

  const handleAdd = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const tag = draft.trim();
      if (!tag) return;
      // Skip the round-trip when the tag is already present (case-insensitive).
      if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
        toast.error('Tag already added');
        return;
      }
      setSaving(true);
      setError(null);
      try {
        setTags(await addTag(customerId, tag));
        setDraft('');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to add tag';
        setError(message);
        toast.error(message);
      } finally {
        setSaving(false);
      }
    },
    [customerId, draft, tags],
  );

  const handleRemove = useCallback(
    async (tag: string) => {
      try {
        setTags(await removeTag(customerId, tag));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to remove tag');
      }
    },
    [customerId],
  );

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full bg-secondary py-1 pl-3 pr-1 text-sm text-foreground"
          >
            {tag}
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() => handleRemove(tag)}
              className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <X size={13} />
            </button>
          </span>
        ))}
        {tags.length === 0 && <p className="text-sm text-muted-foreground">No tags yet.</p>}
      </div>

      <form onSubmit={handleAdd} className="flex items-center gap-2">
        <Input
          aria-label="Add a tag"
          placeholder="e.g. vip, net-30"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="max-w-xs"
        />
        <Button type="submit" size="sm" variant="outline" loading={saving} disabled={!draft.trim()}>
          Add tag
        </Button>
      </form>
    </div>
  );
}
