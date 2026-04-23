import { FormEvent, useMemo, useState } from 'react';
import { useListQuery } from '../../hooks/useListQuery';
import { apiFetch } from '../../utils/api-fetch';

type CategoryFilter = 'All' | 'Labor' | 'Parts' | 'Materials';
type CatalogCategory = Exclude<CategoryFilter, 'All'>;

type CatalogUnit = 'each' | 'hour' | 'sq ft' | 'per lb' | 'per gal';

export interface CatalogSearchItem {
  id: string;
  name: string;
  description?: string;
  category: CatalogCategory;
  unit: CatalogUnit;
  unitPriceCents: number;
}

interface ItemFormState {
  name: string;
  description: string;
  unitPriceDollars: string;
  unit: CatalogUnit;
  category: CatalogCategory;
}

const CATEGORY_FILTERS: CategoryFilter[] = ['All', 'Labor', 'Parts', 'Materials'];
const UNITS: CatalogUnit[] = ['each', 'hour', 'sq ft', 'per lb', 'per gal'];

const EMPTY_FORM: ItemFormState = {
  name: '',
  description: '',
  unitPriceDollars: '',
  unit: 'each',
  category: 'Labor',
};

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function categoryBadgeClass(category: CatalogCategory): string {
  switch (category) {
    case 'Labor':
      return 'bg-violet-100 text-violet-700';
    case 'Parts':
      return 'bg-blue-100 text-blue-700';
    case 'Materials':
      return 'bg-green-100 text-green-700';
    default:
      return 'bg-slate-100 text-slate-700';
  }
}

export function PriceBookPage() {
  const { data, isLoading, error, refetch } = useListQuery<CatalogSearchItem>('/api/catalog/items', { pageSize: 200 });

  const [activeCategory, setActiveCategory] = useState<CategoryFilter>('All');
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<CatalogSearchItem | null>(null);
  const [formState, setFormState] = useState<ItemFormState>(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [isArchivingId, setIsArchivingId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const filteredItems = useMemo(() => {
    if (activeCategory === 'All') return data;
    return data.filter(item => item.category === activeCategory);
  }, [activeCategory, data]);

  const openCreate = () => {
    setEditingItem(null);
    setFormState(EMPTY_FORM);
    setMutationError(null);
    setIsSheetOpen(true);
  };

  const openEdit = (item: CatalogSearchItem) => {
    setEditingItem(item);
    setFormState({
      name: item.name,
      description: item.description ?? '',
      unitPriceDollars: (item.unitPriceCents / 100).toFixed(2),
      unit: item.unit,
      category: item.category,
    });
    setMutationError(null);
    setIsSheetOpen(true);
  };

  const closeSheet = () => {
    setIsSheetOpen(false);
    setEditingItem(null);
    setFormState(EMPTY_FORM);
    setMutationError(null);
  };

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setMutationError(null);
    setIsSaving(true);

    try {
      const parsedPrice = parseFloat(formState.unitPriceDollars);
      if (Number.isNaN(parsedPrice) || parsedPrice < 0) {
        setMutationError('Please enter a valid non-negative unit price.');
        return;
      }

      const payload = {
        name: formState.name,
        description: formState.description,
        unit: formState.unit,
        category: formState.category,
        unitPriceCents: Math.round(parseFloat(formState.unitPriceDollars) * 100),
      };

      if (editingItem) {
        const response = await apiFetch(`/api/catalog/items/${editingItem.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          throw new Error(`Failed to update item (${response.status})`);
        }
      } else {
        const response = await apiFetch('/api/catalog/items', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          throw new Error(`Failed to create item (${response.status})`);
        }
      }

      closeSheet();
      refetch();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Failed to save item');
    } finally {
      setIsSaving(false);
    }
  };

  const handleArchive = async (itemId: string) => {
    setMutationError(null);
    setIsArchivingId(itemId);
    try {
      const response = await apiFetch(`/api/catalog/items/${itemId}`, { method: 'DELETE' });
      if (!response.ok) {
        throw new Error(`Failed to archive item (${response.status})`);
      }
      refetch();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Failed to archive item');
    } finally {
      setIsArchivingId(null);
    }
  };

  return (
    <div className="relative h-full bg-slate-50">
      <div className="mx-auto max-w-4xl p-4 md:p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl text-slate-900">Price book</h1>
            <p className="text-sm text-slate-500">Manage labor, parts, and materials pricing.</p>
          </div>
          <button
            type="button"
            onClick={openCreate}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-700"
          >
            Add item
          </button>
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          {CATEGORY_FILTERS.map(category => (
            <button
              key={category}
              type="button"
              onClick={() => setActiveCategory(category)}
              className={`rounded-full px-3 py-1.5 text-sm transition ${
                activeCategory === category
                  ? 'bg-slate-900 text-white'
                  : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100'
              }`}
            >
              {category}
            </button>
          ))}
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr_auto] gap-3 border-b border-slate-100 px-4 py-2 text-xs uppercase tracking-wide text-slate-500">
            <span>Item</span>
            <span>Category</span>
            <span>Unit</span>
            <span>Price</span>
            <span className="text-right">Actions</span>
          </div>

          {isLoading && <p className="px-4 py-6 text-sm text-slate-500">Loading items…</p>}
          {error && <p className="px-4 py-6 text-sm text-rose-600">{error}</p>}
          {!isLoading && !error && filteredItems.length === 0 && (
            <p className="px-4 py-6 text-sm text-slate-500">No items found.</p>
          )}

          {!isLoading && !error && filteredItems.map(item => (
            <div key={item.id} className="grid grid-cols-[2fr_1fr_1fr_1fr_auto] gap-3 border-b border-slate-100 px-4 py-3 text-sm last:border-b-0">
              <div>
                <p className="text-slate-900">{item.name}</p>
                {item.description && <p className="text-xs text-slate-500">{item.description}</p>}
              </div>
              <div>
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs ${categoryBadgeClass(item.category)}`}>
                  {item.category}
                </span>
              </div>
              <p className="text-slate-700">{item.unit}</p>
              <p className="text-slate-900">{formatPrice(item.unitPriceCents)}</p>
              <div className="flex items-center justify-end gap-2">
                <button type="button" onClick={() => openEdit(item)} className="text-blue-600 hover:underline">Edit</button>
                <button
                  type="button"
                  onClick={() => handleArchive(item.id)}
                  disabled={isArchivingId === item.id}
                  className="text-rose-600 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isArchivingId === item.id ? 'Archiving…' : 'Archive'}
                </button>
              </div>
            </div>
          ))}
        </div>
        {mutationError && <p className="mt-3 text-sm text-rose-600">{mutationError}</p>}
      </div>

      {isSheetOpen && (
        <div className="fixed inset-0 z-50 flex">
          <button type="button" aria-label="Close panel" className="flex-1 bg-black/30" onClick={closeSheet} />
          <aside className="h-full w-full max-w-md overflow-y-auto bg-white p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg text-slate-900">{editingItem ? 'Edit item' : 'Add item'}</h2>
              <button type="button" onClick={closeSheet} className="text-slate-500 hover:text-slate-700">Close</button>
            </div>

            <form onSubmit={handleSave} className="space-y-4">
              <label className="block text-sm text-slate-700">
                Name
                <input
                  value={formState.name}
                  onChange={event => setFormState(current => ({ ...current, name: event.target.value }))}
                  placeholder="item-name"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                  required
                />
              </label>

              <label className="block text-sm text-slate-700">
                Description
                <textarea
                  value={formState.description}
                  onChange={event => setFormState(current => ({ ...current, description: event.target.value }))}
                  placeholder="Describe this item"
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </label>

              <label className="block text-sm text-slate-700">
                Unit price ($)
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={formState.unitPriceDollars}
                  onChange={event => setFormState(current => ({ ...current, unitPriceDollars: event.target.value }))}
                  placeholder="0.00"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                  required
                />
              </label>

              <label className="block text-sm text-slate-700">
                Unit
                <select
                  value={formState.unit}
                  onChange={event => setFormState(current => ({ ...current, unit: event.target.value as CatalogUnit }))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                >
                  {UNITS.map(unit => (
                    <option key={unit} value={unit}>{unit}</option>
                  ))}
                </select>
              </label>

              <label className="block text-sm text-slate-700">
                Category
                <select
                  value={formState.category}
                  onChange={event => setFormState(current => ({ ...current, category: event.target.value as CatalogCategory }))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                >
                  {CATEGORY_FILTERS.filter(category => category !== 'All').map(category => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
              </label>

              <button
                type="submit"
                disabled={isSaving || !formState.name.trim()}
                className="w-full rounded-lg bg-slate-900 px-3 py-2 text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSaving ? 'Saving…' : editingItem ? 'Save changes' : 'Create item'}
              </button>
              {mutationError && <p className="text-sm text-rose-600">{mutationError}</p>}
            </form>
          </aside>
        </div>
      )}
    </div>
  );
}
