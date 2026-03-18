import { v4 as uuidv4 } from 'uuid';
import { VerticalPackRegistry, VerticalPack } from './vertical-pack-registry';

function buildCanonicalPack(
  packId: string,
  verticalType: VerticalPack['verticalType'],
  displayName: string,
  description: string
): VerticalPack {
  const now = new Date();
  return {
    id: uuidv4(),
    packId,
    version: '1.0.0',
    verticalType,
    status: 'active',
    displayName,
    description,
    metadata: {
      canonical: true,
      seededBy: 'createApp',
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function seedCanonicalVerticalPacks(registry: VerticalPackRegistry): Promise<[VerticalPack, VerticalPack]> {
  return Promise.all([
    registry.register(
      buildCanonicalPack(
        'hvac-v1',
        'hvac',
        'HVAC Pack',
        'Canonical HVAC pack with terminology and categories for estimating.'
      )
    ),
    registry.register(
      buildCanonicalPack(
        'plumbing-v1',
        'plumbing',
        'Plumbing Pack',
        'Canonical plumbing pack with terminology and categories for estimating.'
      )
    ),
  ]);
}
