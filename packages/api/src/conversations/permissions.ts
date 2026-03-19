import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { Role, hasPermission, isValidRole } from '../auth/rbac';
import { Conversation } from './conversation-service';

export interface ConversationAccessContext {
  userId: string;
  role: Role;
  tenantId: string;
}

export interface ConversationVisibilityRule {
  role: Role;
  scope: 'all' | 'assigned';
}

export interface ConversationAccessLookup {
  getConversationById: (conversationId: string) => Promise<Conversation | null>;
}

const VISIBILITY_RULES: ConversationVisibilityRule[] = [
  { role: 'owner', scope: 'all' },
  { role: 'dispatcher', scope: 'all' },
  { role: 'technician', scope: 'assigned' },
];

export function getVisibilityScope(role: Role): 'all' | 'assigned' {
  const rule = VISIBILITY_RULES.find((r) => r.role === role);
  return rule?.scope ?? 'assigned';
}

export function canAccessConversation(
  context: ConversationAccessContext,
  conversation: Conversation
): boolean {
  if (conversation.tenantId !== context.tenantId) {
    return false;
  }

  if (!hasPermission(context.role, 'conversations:view')) {
    return false;
  }

  const scope = getVisibilityScope(context.role);
  if (scope === 'all') {
    return true;
  }

  // 'assigned' scope: role-specific behavior
  if (context.role === 'technician') {
    return conversation.assignedUserIds?.includes(context.userId) ?? false;
  }

  // Fallback for non-technician roles that may use assigned scope in the future.
  if (conversation.createdBy === context.userId) {
    return true;
  }

  return conversation.assignedUserIds?.includes(context.userId) ?? false;
}

export function filterVisibleConversations(
  context: ConversationAccessContext,
  conversations: Conversation[]
): Conversation[] {
  return conversations.filter((conv) => canAccessConversation(context, conv));
}

export function validateAccessContext(context: Partial<ConversationAccessContext>): string[] {
  const errors: string[] = [];
  if (!context.userId) errors.push('userId is required');
  if (!context.role) errors.push('role is required');
  if (!context.tenantId) errors.push('tenantId is required');
  return errors;
}

export function requireConversationAccess({ getConversationById }: ConversationAccessLookup) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.auth) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }

    const conversationId = req.params.conversationId;
    if (!conversationId) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'conversationId is required' });
      return;
    }

    if (!isValidRole(req.auth.role)) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'Invalid role' });
      return;
    }

    let conversation: Conversation | null;
    try {
      conversation = await getConversationById(conversationId);
    } catch (err) {
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to check conversation access' });
      return;
    }

    if (!conversation) {
      if (getConversationById) {
        try {
          const anyTenantConversation = await getConversationById(conversationId);
          if (anyTenantConversation && anyTenantConversation.tenantId !== req.auth.tenantId) {
            res.status(403).json({ error: 'FORBIDDEN', message: 'Conversation belongs to another tenant' });
            return;
          }
        } catch (err) {
          res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to check conversation access' });
          return;
        }
      }

      res.status(404).json({ error: 'NOT_FOUND', message: 'Conversation not found' });
      return;
    }

    if (conversation.tenantId !== req.auth.tenantId) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'Cross-tenant conversation access is forbidden' });
      return;
    }

    const context: ConversationAccessContext = {
      userId: req.auth.userId,
      role: req.auth.role as Role,
      tenantId: req.auth.tenantId,
    };

    if (!canAccessConversation(context, conversation)) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'Insufficient conversation access' });
      return;
    }

    next();
  };
}
