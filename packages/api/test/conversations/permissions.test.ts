import {
  canAccessConversation,
  filterVisibleConversations,
  getVisibilityScope,
  validateAccessContext,
  requireConversationAccess,
  ConversationAccessContext,
  ConversationRecord,
} from '../../src/conversations/permissions';

describe('P3-015 — Conversation permissions and visibility rules', () => {
  const ownerContext: ConversationAccessContext = {
    userId: 'owner-1',
    role: 'owner',
    tenantId: 'tenant-1',
  };

  const dispatcherContext: ConversationAccessContext = {
    userId: 'dispatcher-1',
    role: 'dispatcher',
    tenantId: 'tenant-1',
  };

  const technicianContext: ConversationAccessContext = {
    userId: 'tech-1',
    role: 'technician',
    tenantId: 'tenant-1',
  };

  const conversation: ConversationRecord = {
    id: 'conv-1',
    tenantId: 'tenant-1',
    createdBy: 'dispatcher-1',
    assignedUserIds: ['tech-1'],
  };

  const unassignedConversation: ConversationRecord = {
    id: 'conv-2',
    tenantId: 'tenant-1',
    createdBy: 'dispatcher-1',
    assignedUserIds: ['tech-other'],
  };

  it('happy path — owner can access any conversation', () => {
    expect(canAccessConversation(ownerContext, conversation)).toBe(true);
    expect(canAccessConversation(ownerContext, unassignedConversation)).toBe(true);
  });

  it('happy path — dispatcher can access any conversation', () => {
    expect(canAccessConversation(dispatcherContext, conversation)).toBe(true);
    expect(canAccessConversation(dispatcherContext, unassignedConversation)).toBe(true);
  });

  it('happy path — technician can access assigned conversation', () => {
    expect(canAccessConversation(technicianContext, conversation)).toBe(true);
  });

  it('happy path — filters conversations by visibility', () => {
    const conversations = [conversation, unassignedConversation];
    const visible = filterVisibleConversations(technicianContext, conversations);
    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe('conv-1');

    const ownerVisible = filterVisibleConversations(ownerContext, conversations);
    expect(ownerVisible).toHaveLength(2);
  });

  it('happy path — visibility scope correct per role', () => {
    expect(getVisibilityScope('owner')).toBe('all');
    expect(getVisibilityScope('dispatcher')).toBe('all');
    expect(getVisibilityScope('technician')).toBe('assigned');
  });

  it('validation — invalid input rejected with clear errors', () => {
    const errors = validateAccessContext({});
    expect(errors).toContain('userId is required');
    expect(errors).toContain('role is required');
    expect(errors).toContain('tenantId is required');
  });

  it('role escalation test — technician cannot access unassigned conversation', () => {
    expect(canAccessConversation(technicianContext, unassignedConversation)).toBe(false);
  });

  it('missing auth returns 401', async () => {
    const getConv = async () => conversation;
    const middleware = requireConversationAccess(getConv);

    const req = { auth: undefined, params: { conversationId: 'conv-1' } } as any;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as any;
    const next = jest.fn();

    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('wrong tenant returns 403', () => {
    const crossTenantConv: ConversationRecord = {
      id: 'conv-3',
      tenantId: 'tenant-other',
      createdBy: 'user-x',
    };
    expect(canAccessConversation(ownerContext, crossTenantConv)).toBe(false);
  });
});
