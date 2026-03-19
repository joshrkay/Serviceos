import { faker } from './faker';
import { InternalNote, NoteEntityType, CreateNoteInput } from '../../src/notes/note';

export function buildNote(overrides?: Partial<InternalNote>): InternalNote {
  return {
    id: faker.string.uuid(),
    tenantId: faker.string.uuid(),
    entityType: faker.helpers.arrayElement(['customer', 'location', 'job', 'estimate', 'invoice'] as NoteEntityType[]),
    entityId: faker.string.uuid(),
    content: faker.lorem.paragraph(),
    authorId: faker.string.uuid(),
    authorRole: 'dispatcher',
    isPinned: false,
    createdAt: faker.date.recent(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

export function buildCreateNoteInput(overrides?: Partial<CreateNoteInput>): CreateNoteInput {
  return {
    tenantId: faker.string.uuid(),
    entityType: 'job',
    entityId: faker.string.uuid(),
    content: faker.lorem.paragraph(),
    authorId: faker.string.uuid(),
    authorRole: 'dispatcher',
    ...overrides,
  };
}
