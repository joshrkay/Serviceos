import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createCustomerSchema } from '../shared/contracts';
import { asyncRoute } from '../middleware/async-route';
import {
  createCustomer,
  getCustomer,
  updateCustomer,
  listCustomers,
  listCustomersWithMeta,
  archiveCustomer,
  CustomerRepository,
  MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT,
} from '../customers/customer';
import { AuditRepository } from '../audit/audit';
import {
  getCustomerTimeline,
  type CustomerTimelineDeps,
} from '../customers/timeline-service';
import { timelineQuerySchema } from '../customers/timeline';
import {
  ContactRepository,
  createContact,
  listContacts,
  updateContact,
  archiveContact,
} from '../customers/contact';
import {
  TagRepository,
  addCustomerTag,
  removeCustomerTag,
  listCustomerTags,
} from '../customers/tag';
import {
  CustomFieldRepository,
  setCustomFieldValue,
  listResolvedCustomFields,
} from '../customers/custom-field';
import {
  createCustomerContactSchema,
  updateCustomerContactSchema,
  addCustomerTagSchema,
  setCustomFieldValueSchema,
} from '../shared/contracts';

/**
 * P9-002 — Optional dependencies for the customer timeline endpoint.
 * When omitted the timeline route is omitted from the router (leaving the
 * mount point quietly 404 so existing callers and tests are unaffected).
 */
export type CustomerRouterTimelineDeps = CustomerTimelineDeps;

export function createCustomerRouter(
  customerRepo: CustomerRepository,
  auditRepo: AuditRepository,
  timelineDeps?: CustomerRouterTimelineDeps,
  // U1 (CRM Jobber parity) — when provided, mounts the nested
  // /:id/contacts CRUD. Optional so existing call sites/tests that don't
  // wire a contact repo keep the routes quietly 404 (same pattern as
  // timelineDeps above).
  contactRepo?: ContactRepository,
  // U2 (CRM Jobber parity) — customer tags + per-customer custom-field values.
  // Optional, same quietly-404 pattern.
  tagRepo?: TagRepository,
  customFieldRepo?: CustomFieldRepository
): Router {
  const router = Router();

  // Shared by the nested CRM sub-resource routes (contacts, tags, custom
  // fields): confirm the parent customer exists within the tenant so a
  // cross-tenant or bogus customerId 404s before any child write.
  const loadCustomerOr404 = async (
    req: AuthenticatedRequest,
    res: Response
  ): Promise<boolean> => {
    const customer = await getCustomer(req.auth!.tenantId, req.params.id, customerRepo);
    if (!customer) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
      return false;
    }
    return true;
  };

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('customers:create'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = createCustomerSchema.parse(req.body);
      const result = await createCustomer(
        {
          ...parsed,
          tenantId: req.auth!.tenantId,
          createdBy: req.auth!.userId,
          actorRole: req.auth!.role,
        },
        customerRepo,
        auditRepo
      );
      res.status(201).json(result);
    })
  );

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('customers:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const includeArchived = req.query.includeArchived === 'true';
      const search = req.query.search as string | undefined;
      const sort: 'asc' | 'desc' = req.query.sort === 'desc' ? 'desc' : 'asc';

      // P1-018: when `paginated=true` (or limit/offset are present) we
      // return `{ data, total }` so the frontend can drive UI pagination.
      // Without those query params we keep the legacy bare-array shape so
      // existing list consumers don't need changes.
      const wantsPaginated =
        req.query.paginated === 'true' ||
        req.query.limit !== undefined ||
        req.query.offset !== undefined;

      const limitRaw = req.query.limit as string | undefined;
      const offsetRaw = req.query.offset as string | undefined;
      const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : DEFAULT_LIST_LIMIT;
      const offset = offsetRaw !== undefined ? parseInt(offsetRaw, 10) : 0;
      if (limitRaw !== undefined && (Number.isNaN(limit) || limit < 1 || limit > MAX_LIST_LIMIT)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: `limit must be between 1 and ${MAX_LIST_LIMIT}`,
        });
        return;
      }
      if (offsetRaw !== undefined && (Number.isNaN(offset) || offset < 0)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'offset must be a non-negative integer',
        });
        return;
      }

      if (wantsPaginated) {
        const result = await listCustomersWithMeta(req.auth!.tenantId, customerRepo, {
          includeArchived,
          search,
          limit,
          offset,
          sort,
        });
        res.json(result);
        return;
      }

      const result = await listCustomers(req.auth!.tenantId, customerRepo, {
        includeArchived,
        search,
        sort,
      });
      res.json(result);
    })
  );

  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('customers:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const result = await getCustomer(req.auth!.tenantId, req.params.id, customerRepo);
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
        return;
      }
      res.json(result);
    })
  );

  router.put(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('customers:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const result = await updateCustomer(
        req.auth!.tenantId,
        req.params.id,
        req.body,
        customerRepo,
        req.auth!.userId,
        auditRepo
      );
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
        return;
      }
      res.json(result);
    })
  );

  router.post(
    '/:id/archive',
    requireAuth,
    requireTenant,
    requirePermission('customers:delete'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const result = await archiveCustomer(
        req.auth!.tenantId,
        req.params.id,
        customerRepo,
        req.auth!.userId,
        auditRepo
      );
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
        return;
      }
      res.json(result);
    })
  );

  // P9-002 — Unified communication timeline. Read-only aggregator across
  // notes, jobs, estimates, invoices, payments, conversations, and
  // appointments. Tenant scoping is enforced inside `getCustomerTimeline`
  // via each source repo's existing tenant-scoped methods.
  if (timelineDeps) {
    router.get(
      '/:id/timeline',
      requireAuth,
      requireTenant,
      requirePermission('customers:view'),
      asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
        const customer = await getCustomer(
          req.auth!.tenantId,
          req.params.id,
          customerRepo
        );
        if (!customer) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
          return;
        }
        const parsed = timelineQuerySchema.parse(req.query);
        const result = await getCustomerTimeline(
          req.auth!.tenantId,
          req.params.id,
          timelineDeps,
          {
            before: parsed.before,
            limit: parsed.limit,
            kinds: parsed.kinds,
          }
        );
        res.json(result);
      })
    );
  }

  // U1 (CRM Jobber parity) — nested customer-contacts CRUD. Every handler
  // first confirms the parent customer exists within the tenant (so a
  // cross-tenant or bogus customerId 404s before any contact write), then
  // delegates to the tenant-scoped contact repo.
  if (contactRepo) {
    router.get(
      '/:id/contacts',
      requireAuth,
      requireTenant,
      requirePermission('customers:view'),
      asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
        if (!(await loadCustomerOr404(req, res))) return;
        const includeArchived = req.query.includeArchived === 'true';
        const contacts = await listContacts(
          req.auth!.tenantId,
          req.params.id,
          contactRepo,
          includeArchived
        );
        res.json(contacts);
      })
    );

    router.post(
      '/:id/contacts',
      requireAuth,
      requireTenant,
      requirePermission('customers:update'),
      asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
        if (!(await loadCustomerOr404(req, res))) return;
        const parsed = createCustomerContactSchema.parse(req.body);
        const contact = await createContact(
          {
            ...parsed,
            tenantId: req.auth!.tenantId,
            customerId: req.params.id,
            createdBy: req.auth!.userId,
            actorRole: req.auth!.role,
          },
          contactRepo,
          auditRepo
        );
        res.status(201).json(contact);
      })
    );

    router.put(
      '/:id/contacts/:contactId',
      requireAuth,
      requireTenant,
      requirePermission('customers:update'),
      asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
        if (!(await loadCustomerOr404(req, res))) return;
        const parsed = updateCustomerContactSchema.parse(req.body);
        const existing = await contactRepo.findById(req.auth!.tenantId, req.params.contactId);
        if (!existing || existing.customerId !== req.params.id) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Contact not found' });
          return;
        }
        const updated = await updateContact(
          req.auth!.tenantId,
          req.params.contactId,
          parsed,
          contactRepo,
          req.auth!.userId,
          auditRepo
        );
        res.json(updated);
      })
    );

    router.post(
      '/:id/contacts/:contactId/archive',
      requireAuth,
      requireTenant,
      requirePermission('customers:update'),
      asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
        if (!(await loadCustomerOr404(req, res))) return;
        const existing = await contactRepo.findById(req.auth!.tenantId, req.params.contactId);
        if (!existing || existing.customerId !== req.params.id) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Contact not found' });
          return;
        }
        const archived = await archiveContact(
          req.auth!.tenantId,
          req.params.contactId,
          contactRepo,
          req.auth!.userId,
          auditRepo
        );
        res.json(archived);
      })
    );
  }

  // U2 (CRM Jobber parity) — customer tags.
  if (tagRepo) {
    router.get(
      '/:id/tags',
      requireAuth,
      requireTenant,
      requirePermission('customers:view'),
      asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
        if (!(await loadCustomerOr404(req, res))) return;
        const tags = await listCustomerTags(req.auth!.tenantId, req.params.id, tagRepo);
        res.json(tags);
      })
    );

    router.post(
      '/:id/tags',
      requireAuth,
      requireTenant,
      requirePermission('customers:update'),
      asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
        if (!(await loadCustomerOr404(req, res))) return;
        const { tag } = addCustomerTagSchema.parse(req.body);
        await addCustomerTag(
          req.auth!.tenantId,
          req.params.id,
          tag,
          tagRepo,
          req.auth!.userId,
          auditRepo
        );
        const tags = await listCustomerTags(req.auth!.tenantId, req.params.id, tagRepo);
        res.status(201).json(tags);
      })
    );

    router.delete(
      '/:id/tags/:tag',
      requireAuth,
      requireTenant,
      requirePermission('customers:update'),
      asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
        if (!(await loadCustomerOr404(req, res))) return;
        await removeCustomerTag(
          req.auth!.tenantId,
          req.params.id,
          decodeURIComponent(req.params.tag),
          tagRepo,
          req.auth!.userId,
          auditRepo
        );
        const tags = await listCustomerTags(req.auth!.tenantId, req.params.id, tagRepo);
        res.json(tags);
      })
    );
  }

  // U2 (CRM Jobber parity) — per-customer custom-field values (defs are
  // managed by the tenant-level router at /api/customer-custom-fields).
  if (customFieldRepo) {
    router.get(
      '/:id/custom-fields',
      requireAuth,
      requireTenant,
      requirePermission('customers:view'),
      asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
        if (!(await loadCustomerOr404(req, res))) return;
        const fields = await listResolvedCustomFields(
          req.auth!.tenantId,
          req.params.id,
          customFieldRepo
        );
        res.json(fields);
      })
    );

    router.put(
      '/:id/custom-fields/:fieldDefId',
      requireAuth,
      requireTenant,
      requirePermission('customers:update'),
      asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
        if (!(await loadCustomerOr404(req, res))) return;
        const { value } = setCustomFieldValueSchema.parse(req.body);
        await setCustomFieldValue(
          req.auth!.tenantId,
          req.params.id,
          req.params.fieldDefId,
          value,
          customFieldRepo,
          req.auth!.userId,
          auditRepo
        );
        const fields = await listResolvedCustomFields(
          req.auth!.tenantId,
          req.params.id,
          customFieldRepo
        );
        res.json(fields);
      })
    );
  }

  return router;
}
