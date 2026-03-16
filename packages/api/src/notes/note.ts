import { v4 as uuidv4 } from 'uuid';

export type NoteEntityType = 'customer' | 'location' | 'job' | 'estimate' | 'invoice';

export interface InternalNote {
  id: string;
  tenantId: string;
  entityType: NoteEntityType;
  entityId: string;
  content: string;
  authorId: string;
  authorRole: string;
  isPinned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateNoteInput {
  tenantId: string;
  entityType: NoteEntityType;
  entityId: string;
  content: string;
  authorId: string;
  authorRole: string;
  isPinned?: boolean;
}

export interface NoteRepository {
  create(note: InternalNote): Promise<InternalNote>;
  findById(tenantId: string, id: string): Promise<InternalNote | null>;
  findByEntity(tenantId: string, entityType: NoteEntityType, entityId: string): Promise<InternalNote[]>;
  update(tenantId: string, id: string, updates: Partial<InternalNote>): Promise<InternalNote | null>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

export function validateNoteInput(input: CreateNoteInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.entityType) errors.push('entityType is required');
  if (input.entityType && !['customer', 'location', 'job', 'estimate', 'invoice'].includes(input.entityType)) {
    errors.push('Invalid entityType');
  }
  if (!input.entityId) errors.push('entityId is required');
  if (!input.content) errors.push('content is required');
  if (!input.authorId) errors.push('authorId is required');
  if (!input.authorRole) errors.push('authorRole is required');
  return errors;
}

export async function createNote(
  input: CreateNoteInput,
  repository: NoteRepository
): Promise<InternalNote> {
  const note: InternalNote = {
    id: uuidv4(),
    tenantId: input.tenantId,
    entityType: input.entityType,
    entityId: input.entityId,
    content: input.content,
    authorId: input.authorId,
    authorRole: input.authorRole,
    isPinned: input.isPinned ?? false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return repository.create(note);
}

export async function updateNote(
  tenantId: string,
  noteId: string,
  content: string,
  repository: NoteRepository
): Promise<InternalNote | null> {
  return repository.update(tenantId, noteId, { content, updatedAt: new Date() });
}

export async function deleteNote(
  tenantId: string,
  noteId: string,
  repository: NoteRepository
): Promise<boolean> {
  return repository.delete(tenantId, noteId);
}

export async function pinNote(
  tenantId: string,
  noteId: string,
  repository: NoteRepository
): Promise<InternalNote | null> {
  return repository.update(tenantId, noteId, { isPinned: true, updatedAt: new Date() });
}

export async function unpinNote(
  tenantId: string,
  noteId: string,
  repository: NoteRepository
): Promise<InternalNote | null> {
  return repository.update(tenantId, noteId, { isPinned: false, updatedAt: new Date() });
}

export async function listNotes(
  tenantId: string,
  entityType: NoteEntityType,
  entityId: string,
  repository: NoteRepository
): Promise<InternalNote[]> {
  return repository.findByEntity(tenantId, entityType, entityId);
}

export class InMemoryNoteRepository implements NoteRepository {
  private notes: Map<string, InternalNote> = new Map();

  async create(note: InternalNote): Promise<InternalNote> {
    this.notes.set(note.id, { ...note });
    return { ...note };
  }

  async findById(tenantId: string, id: string): Promise<InternalNote | null> {
    const n = this.notes.get(id);
    if (!n || n.tenantId !== tenantId) return null;
    return { ...n };
  }

  async findByEntity(tenantId: string, entityType: NoteEntityType, entityId: string): Promise<InternalNote[]> {
    return Array.from(this.notes.values())
      .filter((n) => n.tenantId === tenantId && n.entityType === entityType && n.entityId === entityId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((n) => ({ ...n }));
  }

  async update(tenantId: string, id: string, updates: Partial<InternalNote>): Promise<InternalNote | null> {
    const n = this.notes.get(id);
    if (!n || n.tenantId !== tenantId) return null;
    const updated = { ...n, ...updates };
    this.notes.set(id, updated);
    return { ...updated };
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const n = this.notes.get(id);
    if (!n || n.tenantId !== tenantId) return false;
    this.notes.delete(id);
    return true;
  }
}
