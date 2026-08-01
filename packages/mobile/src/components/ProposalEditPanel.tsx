import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import {
  buildEdits,
  editableScalarFields,
  payloadLineItems,
  type EditableLineItem,
} from '../proposals/proposalEdit';
import { LineItemList, LineItemSheet, type LineItem } from './LineItemSheet';

export interface ProposalEditPanelProps {
  payload: Record<string, unknown> | undefined;
  saving: boolean;
  onCancel: () => void;
  /** Called with the changed fields only; the caller PUTs { edits }. */
  onSave: (edits: Record<string, unknown>) => void;
}

/**
 * U2 (F4) — edit-before-approve. Scalar payload fields become inputs (cents
 * render/parse as dollars via string math); line items get the grounded
 * catalog editor: remove rows or add from the price book via LineItemSheet.
 * Free-text price entry is deliberately not offered — added lines carry the
 * catalog's price (CLAUDE.md: never trust an ungrounded price).
 */
export function ProposalEditPanel({ payload, saving, onCancel, onSave }: ProposalEditPanelProps) {
  const fields = editableScalarFields(payload);
  const initialItems = payloadLineItems(payload);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [items, setItems] = useState<EditableLineItem[] | null>(initialItems);
  const [itemsChanged, setItemsChanged] = useState(false);
  const [showSheet, setShowSheet] = useState(false);
  const [invalid, setInvalid] = useState<string[]>([]);

  function save() {
    const built = buildEdits(payload, drafts);
    if (built.invalid.length > 0) {
      setInvalid(built.invalid);
      return;
    }
    setInvalid([]);
    const edits: Record<string, unknown> = { ...built.edits };
    if (itemsChanged && items) edits.lineItems = items;
    if (Object.keys(edits).length === 0) {
      onCancel(); // nothing changed — just leave edit mode
      return;
    }
    onSave(edits);
  }

  return (
    <View className="mt-5 rounded-lg border border-border bg-card p-4">
      <Text className="text-base font-medium text-foreground">Edit before approving</Text>

      {fields.map((field) => (
        <View key={field.key} className="mt-3">
          <Text className="text-sm text-mutedForeground">
            {field.kind === 'cents' ? `${field.label} ($)` : field.label}
          </Text>
          <TextInput
            accessibilityLabel={`Edit ${field.label}`}
            value={drafts[field.key] ?? field.value}
            onChangeText={(t) => setDrafts((d) => ({ ...d, [field.key]: t }))}
            keyboardType={field.kind === 'text' ? 'default' : 'decimal-pad'}
            className="mt-1 min-h-11 rounded-md border border-border px-4 py-2 text-base text-foreground"
          />
        </View>
      ))}

      {items ? (
        <View className="mt-4">
          <Text className="text-sm text-mutedForeground">Line items</Text>
          <View className="mt-2">
            <LineItemList
              items={items as LineItem[]}
              onRemove={(index) => {
                setItems((prev) => (prev ? prev.filter((_, i) => i !== index) : prev));
                setItemsChanged(true);
              }}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add line item"
            onPress={() => setShowSheet(true)}
            className="mt-2 min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
          >
            <Text className="text-base text-foreground">+ Add from price book</Text>
          </Pressable>
          <LineItemSheet
            visible={showSheet}
            onClose={() => setShowSheet(false)}
            onAdd={(item) => {
              setItems((prev) => [...(prev ?? []), item]);
              setItemsChanged(true);
            }}
          />
        </View>
      ) : null}

      {invalid.length > 0 ? (
        <Text className="mt-3 text-base text-destructive">
          Check these amounts: {invalid.join(', ')}
        </Text>
      ) : null}

      <View className="mt-4 flex-row gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel edit"
          onPress={onCancel}
          disabled={saving}
          className="min-h-11 flex-1 items-center justify-center rounded-md border border-border px-4 py-3"
        >
          <Text className="text-base text-foreground">Cancel</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save edits"
          onPress={save}
          disabled={saving}
          className="min-h-11 flex-1 items-center justify-center rounded-md bg-primary px-4 py-3"
        >
          {saving ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text className="text-base font-semibold text-primaryForeground">Save</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}
