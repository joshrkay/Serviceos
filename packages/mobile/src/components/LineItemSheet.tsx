import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { useApiClient } from '../lib/useApiClient';
import { formatMoneyShort } from '../lib/format';
import { PrimaryButton } from './Buttons';

export interface LineItem {
  catalogItemId?: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
}

interface CatalogItem {
  id: string;
  name: string;
  unitPriceCents: number;
}

export interface LineItemSheetProps {
  visible: boolean;
  onClose: () => void;
  onAdd: (item: LineItem) => void;
}

/** Catalog-search sheet for adding grounded line items (never trust LLM prices). */
export function LineItemSheet({ visible, onClose, onAdd }: LineItemSheetProps) {
  const api = useApiClient();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(false);

  const search = async (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const res = await api(`/api/catalog/items?search=${encodeURIComponent(q.trim())}`);
      if (res.ok) {
        const body = (await res.json()) as { items?: CatalogItem[] };
        setItems(body.items ?? []);
      }
    } finally {
      setLoading(false);
    }
  };

  const filtered = useMemo(() => items, [items]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 bg-background px-6 pt-16">
        <Text className="font-heading text-2xl font-semibold text-foreground">Add line item</Text>
        <TextInput
          className="mt-4 min-h-11 rounded-md border border-border px-4 py-2 text-base text-foreground"
          placeholder="Search your price book…"
          value={query}
          onChangeText={(t) => void search(t)}
        />
        <FlatList
          className="mt-4"
          data={filtered}
          keyExtractor={(i) => i.id}
          ListEmptyComponent={
            <Text className="text-base text-mutedForeground">
              {loading ? 'Searching…' : 'Search your catalog to add items.'}
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                onAdd({
                  catalogItemId: item.id,
                  description: item.name,
                  quantity: 1,
                  unitPriceCents: item.unitPriceCents,
                });
                onClose();
                setQuery('');
                setItems([]);
              }}
              className="mb-2 min-h-11 flex-row items-center justify-between rounded-md border border-border px-4 py-3"
            >
              <Text className="flex-1 text-base text-foreground">{item.name}</Text>
              <Text className="text-base text-mutedForeground">{formatMoneyShort(item.unitPriceCents)}</Text>
            </Pressable>
          )}
        />
        <PrimaryButton label="Done" onPress={onClose} className="mt-4" />
      </View>
    </Modal>
  );
}

export function LineItemList({
  items,
  onRemove,
}: {
  items: LineItem[];
  onRemove: (index: number) => void;
}) {
  if (items.length === 0) {
    return <Text className="text-base text-mutedForeground">No line items yet.</Text>;
  }

  return (
    <View>
      {items.map((item, index) => (
        <View
          key={`${item.catalogItemId ?? item.description}-${index}`}
          className="mb-2 flex-row items-center justify-between rounded-md border border-border px-4 py-3"
        >
          <View className="flex-1 pr-3">
            <Text className="text-base text-foreground">{item.description}</Text>
            <Text className="text-sm text-mutedForeground">
              {item.quantity} × {formatMoneyShort(item.unitPriceCents)}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Remove line item"
            onPress={() => onRemove(index)}
            className="min-h-11 min-w-11 items-center justify-center"
          >
            <Text className="text-base text-destructive">Remove</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}
