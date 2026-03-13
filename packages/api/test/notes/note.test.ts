import {
  createNote,
  updateNote,
  deleteNote,
  listNotes,
  validateNoteInput,
  InMemoryNoteRepository,
} from '../../src/notes/note';

describe('P1-015 — Internal notes across key entities', () => {
  let repo: InMemoryNoteRepository;

  beforeEach(() => {
    repo = new InMemoryNoteRepository();
  });

  it('happy path — creates note for customer', async () => {
    const note = await createNote(
      {
        tenantId: 'tenant-1',
        entityType: 'customer',
        entityId: 'cust-1',
        content: 'VIP customer, handle with care',
        authorId: 'user-1',
        authorRole: 'owner',
      },
      repo
    );

    expect(note.id).toBeTruthy();
    expect(note.content).toBe('VIP customer, handle with care');
    expect(note.isPinned).toBe(false);
  });

  it('happy path — creates notes for different entity types', async () => {
    for (const entityType of ['customer', 'location', 'job', 'estimate', 'invoice'] as const) {
      const note = await createNote(
        {
          tenantId: 'tenant-1',
          entityType,
          entityId: `${entityType}-1`,
          content: `Note for ${entityType}`,
          authorId: 'user-1',
          authorRole: 'owner',
        },
        repo
      );
      expect(note.entityType).toBe(entityType);
    }
  });

  it('happy path — updates note content', async () => {
    const note = await createNote(
      { tenantId: 'tenant-1', entityType: 'job', entityId: 'job-1', content: 'Original', authorId: 'u-1', authorRole: 'owner' },
      repo
    );

    const updated = await updateNote('tenant-1', note.id, 'Updated content', repo);
    expect(updated!.content).toBe('Updated content');
  });

  it('happy path — deletes note', async () => {
    const note = await createNote(
      { tenantId: 'tenant-1', entityType: 'job', entityId: 'job-1', content: 'To delete', authorId: 'u-1', authorRole: 'owner' },
      repo
    );

    const result = await deleteNote('tenant-1', note.id, repo);
    expect(result).toBe(true);

    const notes = await listNotes('tenant-1', 'job', 'job-1', repo);
    expect(notes).toHaveLength(0);
  });

  it('happy path — lists notes for entity', async () => {
    await createNote(
      { tenantId: 'tenant-1', entityType: 'customer', entityId: 'cust-1', content: 'Note 1', authorId: 'u-1', authorRole: 'owner' },
      repo
    );
    await createNote(
      { tenantId: 'tenant-1', entityType: 'customer', entityId: 'cust-1', content: 'Note 2', authorId: 'u-2', authorRole: 'dispatcher' },
      repo
    );

    const notes = await listNotes('tenant-1', 'customer', 'cust-1', repo);
    expect(notes).toHaveLength(2);
  });

  it('happy path — creates pinned note', async () => {
    const note = await createNote(
      {
        tenantId: 'tenant-1',
        entityType: 'customer',
        entityId: 'cust-1',
        content: 'Important',
        authorId: 'u-1',
        authorRole: 'owner',
        isPinned: true,
      },
      repo
    );

    expect(note.isPinned).toBe(true);
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateNoteInput({
      tenantId: '',
      entityType: '' as any,
      entityId: '',
      content: '',
      authorId: '',
      authorRole: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('entityType is required');
    expect(errors).toContain('entityId is required');
    expect(errors).toContain('content is required');
    expect(errors).toContain('authorId is required');
    expect(errors).toContain('authorRole is required');
  });

  it('validation — rejects invalid entityType', () => {
    const errors = validateNoteInput({
      tenantId: 'tenant-1',
      entityType: 'widget' as any,
      entityId: 'w-1',
      content: 'Test',
      authorId: 'u-1',
      authorRole: 'owner',
    });
    expect(errors).toContain('Invalid entityType');
  });
});
