export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'ServiceOS API',
    description: 'Multi-tenant field service management platform API. Use Bearer token authentication with Clerk JWT. All endpoints require the `Authorization: Bearer <token>` header.',
    version: '1.0.0',
  },
  servers: [{ url: '/api/v1', description: 'API v1' }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http' as const,
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Clerk JWT token. For development, use a mock token with payload: { sub: "user_id", sid: "session_id", role: "owner", org_id: "tenant_uuid" }',
      },
    },
    schemas: {
      Error: {
        type: 'object' as const,
        properties: {
          error: { type: 'string' as const },
          message: { type: 'string' as const },
          details: { type: 'object' as const },
        },
      },
      Customer: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          tenantId: { type: 'string' as const, format: 'uuid' },
          firstName: { type: 'string' as const },
          lastName: { type: 'string' as const },
          displayName: { type: 'string' as const },
          companyName: { type: 'string' as const },
          primaryPhone: { type: 'string' as const },
          secondaryPhone: { type: 'string' as const },
          email: { type: 'string' as const, format: 'email' },
          preferredChannel: { type: 'string' as const, enum: ['phone', 'email', 'sms', 'none'] },
          smsConsent: { type: 'boolean' as const },
          communicationNotes: { type: 'string' as const },
          isArchived: { type: 'boolean' as const },
          createdBy: { type: 'string' as const },
          createdAt: { type: 'string' as const, format: 'date-time' },
          updatedAt: { type: 'string' as const, format: 'date-time' },
        },
      },
      CreateCustomer: {
        type: 'object' as const,
        properties: {
          firstName: { type: 'string' as const, maxLength: 100 },
          lastName: { type: 'string' as const, maxLength: 100 },
          companyName: { type: 'string' as const },
          primaryPhone: { type: 'string' as const },
          secondaryPhone: { type: 'string' as const },
          email: { type: 'string' as const, format: 'email' },
          preferredChannel: { type: 'string' as const, enum: ['phone', 'email', 'sms', 'none'] },
          smsConsent: { type: 'boolean' as const },
          communicationNotes: { type: 'string' as const },
        },
      },
      ServiceLocation: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          tenantId: { type: 'string' as const, format: 'uuid' },
          customerId: { type: 'string' as const },
          label: { type: 'string' as const },
          street1: { type: 'string' as const },
          street2: { type: 'string' as const },
          city: { type: 'string' as const },
          state: { type: 'string' as const },
          postalCode: { type: 'string' as const },
          country: { type: 'string' as const },
          accessNotes: { type: 'string' as const },
          isPrimary: { type: 'boolean' as const },
          isArchived: { type: 'boolean' as const },
          createdAt: { type: 'string' as const, format: 'date-time' },
          updatedAt: { type: 'string' as const, format: 'date-time' },
        },
      },
      CreateServiceLocation: {
        type: 'object' as const,
        required: ['customerId', 'street1', 'city', 'state', 'postalCode'],
        properties: {
          customerId: { type: 'string' as const },
          label: { type: 'string' as const },
          street1: { type: 'string' as const },
          street2: { type: 'string' as const },
          city: { type: 'string' as const },
          state: { type: 'string' as const },
          postalCode: { type: 'string' as const },
          country: { type: 'string' as const, default: 'US' },
          accessNotes: { type: 'string' as const },
          isPrimary: { type: 'boolean' as const },
        },
      },
      Job: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          tenantId: { type: 'string' as const, format: 'uuid' },
          customerId: { type: 'string' as const },
          locationId: { type: 'string' as const },
          jobNumber: { type: 'string' as const },
          summary: { type: 'string' as const },
          problemDescription: { type: 'string' as const },
          status: { type: 'string' as const, enum: ['new', 'scheduled', 'in_progress', 'completed', 'canceled'] },
          priority: { type: 'string' as const, enum: ['low', 'normal', 'high', 'urgent'] },
          assignedTechnicianId: { type: 'string' as const },
          createdBy: { type: 'string' as const },
          createdAt: { type: 'string' as const, format: 'date-time' },
          updatedAt: { type: 'string' as const, format: 'date-time' },
        },
      },
      CreateJob: {
        type: 'object' as const,
        required: ['customerId', 'locationId', 'summary'],
        properties: {
          customerId: { type: 'string' as const },
          locationId: { type: 'string' as const },
          summary: { type: 'string' as const, maxLength: 500 },
          problemDescription: { type: 'string' as const },
          priority: { type: 'string' as const, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
        },
      },
      Appointment: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          tenantId: { type: 'string' as const, format: 'uuid' },
          jobId: { type: 'string' as const },
          scheduledStart: { type: 'string' as const, format: 'date-time' },
          scheduledEnd: { type: 'string' as const, format: 'date-time' },
          arrivalWindowStart: { type: 'string' as const, format: 'date-time' },
          arrivalWindowEnd: { type: 'string' as const, format: 'date-time' },
          timezone: { type: 'string' as const },
          status: { type: 'string' as const, enum: ['scheduled', 'confirmed', 'in_progress', 'completed', 'canceled', 'no_show'] },
          notes: { type: 'string' as const },
          createdBy: { type: 'string' as const },
          createdAt: { type: 'string' as const, format: 'date-time' },
          updatedAt: { type: 'string' as const, format: 'date-time' },
        },
      },
      CreateAppointment: {
        type: 'object' as const,
        required: ['jobId', 'scheduledStart', 'scheduledEnd', 'timezone'],
        properties: {
          jobId: { type: 'string' as const },
          scheduledStart: { type: 'string' as const, format: 'date-time' },
          scheduledEnd: { type: 'string' as const, format: 'date-time' },
          arrivalWindowStart: { type: 'string' as const, format: 'date-time' },
          arrivalWindowEnd: { type: 'string' as const, format: 'date-time' },
          timezone: { type: 'string' as const },
          notes: { type: 'string' as const },
        },
      },
      LineItem: {
        type: 'object' as const,
        required: ['id', 'description', 'quantity', 'unitPriceCents', 'totalCents', 'sortOrder'],
        properties: {
          id: { type: 'string' as const },
          description: { type: 'string' as const },
          category: { type: 'string' as const, enum: ['labor', 'material', 'equipment', 'other'] },
          quantity: { type: 'number' as const },
          unitPriceCents: { type: 'integer' as const },
          totalCents: { type: 'integer' as const },
          sortOrder: { type: 'integer' as const },
          taxable: { type: 'boolean' as const, default: true },
        },
      },
      Estimate: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          tenantId: { type: 'string' as const, format: 'uuid' },
          jobId: { type: 'string' as const },
          estimateNumber: { type: 'string' as const },
          status: { type: 'string' as const, enum: ['draft', 'ready_for_review', 'sent', 'accepted', 'rejected', 'expired'] },
          lineItems: { type: 'array' as const, items: { $ref: '#/components/schemas/LineItem' } },
          totals: { type: 'object' as const },
          validUntil: { type: 'string' as const, format: 'date-time' },
          customerMessage: { type: 'string' as const },
          internalNotes: { type: 'string' as const },
          createdBy: { type: 'string' as const },
          createdAt: { type: 'string' as const, format: 'date-time' },
          updatedAt: { type: 'string' as const, format: 'date-time' },
        },
      },
      CreateEstimate: {
        type: 'object' as const,
        required: ['jobId', 'lineItems'],
        properties: {
          jobId: { type: 'string' as const },
          lineItems: { type: 'array' as const, items: { $ref: '#/components/schemas/LineItem' }, minItems: 1 },
          discountCents: { type: 'integer' as const, default: 0 },
          taxRateBps: { type: 'integer' as const, default: 0, description: 'Tax rate in basis points (e.g. 825 = 8.25%)' },
          validUntil: { type: 'string' as const, format: 'date-time' },
          customerMessage: { type: 'string' as const },
          internalNotes: { type: 'string' as const },
        },
      },
      Invoice: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          tenantId: { type: 'string' as const, format: 'uuid' },
          jobId: { type: 'string' as const },
          estimateId: { type: 'string' as const },
          invoiceNumber: { type: 'string' as const },
          status: { type: 'string' as const, enum: ['draft', 'open', 'partially_paid', 'paid', 'void', 'canceled'] },
          lineItems: { type: 'array' as const, items: { $ref: '#/components/schemas/LineItem' } },
          totals: { type: 'object' as const },
          amountPaidCents: { type: 'integer' as const },
          amountDueCents: { type: 'integer' as const },
          issuedAt: { type: 'string' as const, format: 'date-time' },
          dueDate: { type: 'string' as const, format: 'date-time' },
          customerMessage: { type: 'string' as const },
          createdBy: { type: 'string' as const },
          createdAt: { type: 'string' as const, format: 'date-time' },
          updatedAt: { type: 'string' as const, format: 'date-time' },
        },
      },
      CreateInvoice: {
        type: 'object' as const,
        required: ['jobId', 'lineItems'],
        properties: {
          jobId: { type: 'string' as const },
          estimateId: { type: 'string' as const },
          lineItems: { type: 'array' as const, items: { $ref: '#/components/schemas/LineItem' }, minItems: 1 },
          discountCents: { type: 'integer' as const, default: 0 },
          taxRateBps: { type: 'integer' as const, default: 0 },
          customerMessage: { type: 'string' as const },
        },
      },
      Payment: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          tenantId: { type: 'string' as const, format: 'uuid' },
          invoiceId: { type: 'string' as const },
          amountCents: { type: 'integer' as const },
          method: { type: 'string' as const, enum: ['cash', 'check', 'credit_card', 'bank_transfer', 'other'] },
          status: { type: 'string' as const },
          providerReference: { type: 'string' as const },
          note: { type: 'string' as const },
          receivedAt: { type: 'string' as const, format: 'date-time' },
          processedBy: { type: 'string' as const },
          createdAt: { type: 'string' as const, format: 'date-time' },
        },
      },
      RecordPayment: {
        type: 'object' as const,
        required: ['invoiceId', 'amountCents', 'method'],
        properties: {
          invoiceId: { type: 'string' as const },
          amountCents: { type: 'integer' as const, minimum: 1 },
          method: { type: 'string' as const, enum: ['cash', 'check', 'credit_card', 'bank_transfer', 'other'] },
          providerReference: { type: 'string' as const },
          note: { type: 'string' as const },
        },
      },
      Note: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          tenantId: { type: 'string' as const, format: 'uuid' },
          entityType: { type: 'string' as const, enum: ['customer', 'location', 'job', 'estimate', 'invoice'] },
          entityId: { type: 'string' as const },
          content: { type: 'string' as const },
          authorId: { type: 'string' as const },
          authorRole: { type: 'string' as const },
          isPinned: { type: 'boolean' as const },
          createdAt: { type: 'string' as const, format: 'date-time' },
          updatedAt: { type: 'string' as const, format: 'date-time' },
        },
      },
      CreateNote: {
        type: 'object' as const,
        required: ['entityType', 'entityId', 'content'],
        properties: {
          entityType: { type: 'string' as const, enum: ['customer', 'location', 'job', 'estimate', 'invoice'] },
          entityId: { type: 'string' as const },
          content: { type: 'string' as const },
          isPinned: { type: 'boolean' as const, default: false },
        },
      },
      Conversation: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          tenantId: { type: 'string' as const, format: 'uuid' },
          title: { type: 'string' as const },
          entityType: { type: 'string' as const },
          entityId: { type: 'string' as const },
          status: { type: 'string' as const, enum: ['open', 'closed', 'archived'] },
          createdBy: { type: 'string' as const },
          createdAt: { type: 'string' as const, format: 'date-time' },
          updatedAt: { type: 'string' as const, format: 'date-time' },
        },
      },
      CreateConversation: {
        type: 'object' as const,
        properties: {
          title: { type: 'string' as const },
          entityType: { type: 'string' as const },
          entityId: { type: 'string' as const },
        },
      },
      Message: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          tenantId: { type: 'string' as const, format: 'uuid' },
          conversationId: { type: 'string' as const },
          messageType: { type: 'string' as const, enum: ['text', 'transcript', 'system_event', 'note'] },
          content: { type: 'string' as const },
          senderId: { type: 'string' as const },
          senderRole: { type: 'string' as const },
          fileId: { type: 'string' as const },
          source: { type: 'string' as const },
          metadata: { type: 'object' as const },
          createdAt: { type: 'string' as const, format: 'date-time' },
        },
      },
      CreateMessage: {
        type: 'object' as const,
        required: ['messageType'],
        properties: {
          messageType: { type: 'string' as const, enum: ['text', 'transcript', 'system_event', 'note'] },
          content: { type: 'string' as const },
          fileId: { type: 'string' as const, format: 'uuid' },
          source: { type: 'string' as const },
          metadata: { type: 'object' as const },
        },
      },
      TenantSettings: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          tenantId: { type: 'string' as const, format: 'uuid' },
          businessName: { type: 'string' as const },
          businessPhone: { type: 'string' as const },
          businessEmail: { type: 'string' as const, format: 'email' },
          timezone: { type: 'string' as const },
          estimatePrefix: { type: 'string' as const },
          invoicePrefix: { type: 'string' as const },
          nextEstimateNumber: { type: 'integer' as const },
          nextInvoiceNumber: { type: 'integer' as const },
          defaultPaymentTermDays: { type: 'integer' as const },
          terminologyPreferences: { type: 'object' as const },
          createdAt: { type: 'string' as const, format: 'date-time' },
          updatedAt: { type: 'string' as const, format: 'date-time' },
        },
      },
      UpdateSettings: {
        type: 'object' as const,
        properties: {
          businessName: { type: 'string' as const },
          businessPhone: { type: 'string' as const },
          businessEmail: { type: 'string' as const, format: 'email' },
          timezone: { type: 'string' as const },
          estimatePrefix: { type: 'string' as const },
          invoicePrefix: { type: 'string' as const },
          defaultPaymentTermDays: { type: 'integer' as const },
          terminologyPreferences: { type: 'object' as const },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    // Customers
    '/customers': {
      post: {
        tags: ['Customers'],
        summary: 'Create a customer',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateCustomer' } } } },
        responses: {
          '201': { description: 'Customer created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Customer' } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '401': { description: 'Unauthorized' },
        },
      },
      get: {
        tags: ['Customers'],
        summary: 'List customers',
        parameters: [
          { name: 'includeArchived', in: 'query' as const, schema: { type: 'boolean' as const }, description: 'Include archived customers' },
          { name: 'search', in: 'query' as const, schema: { type: 'string' as const }, description: 'Search by name, company, or email' },
        ],
        responses: {
          '200': { description: 'Customer list', content: { 'application/json': { schema: { type: 'array' as const, items: { $ref: '#/components/schemas/Customer' } } } } },
        },
      },
    },
    '/customers/{id}': {
      get: {
        tags: ['Customers'],
        summary: 'Get a customer',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        responses: {
          '200': { description: 'Customer details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Customer' } } } },
          '404': { description: 'Not found' },
        },
      },
      put: {
        tags: ['Customers'],
        summary: 'Update a customer',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateCustomer' } } } },
        responses: {
          '200': { description: 'Customer updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Customer' } } } },
          '404': { description: 'Not found' },
        },
      },
    },
    '/customers/{id}/archive': {
      post: {
        tags: ['Customers'],
        summary: 'Archive a customer',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        responses: {
          '200': { description: 'Customer archived', content: { 'application/json': { schema: { $ref: '#/components/schemas/Customer' } } } },
          '404': { description: 'Not found' },
        },
      },
    },
    // Locations
    '/locations': {
      post: {
        tags: ['Locations'],
        summary: 'Create a service location',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateServiceLocation' } } } },
        responses: {
          '201': { description: 'Location created', content: { 'application/json': { schema: { $ref: '#/components/schemas/ServiceLocation' } } } },
        },
      },
      get: {
        tags: ['Locations'],
        summary: 'List locations by customer',
        parameters: [{ name: 'customerId', in: 'query' as const, required: true, schema: { type: 'string' as const } }],
        responses: {
          '200': { description: 'Location list', content: { 'application/json': { schema: { type: 'array' as const, items: { $ref: '#/components/schemas/ServiceLocation' } } } } },
        },
      },
    },
    '/locations/{id}': {
      get: {
        tags: ['Locations'],
        summary: 'Get a location',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        responses: {
          '200': { description: 'Location details', content: { 'application/json': { schema: { $ref: '#/components/schemas/ServiceLocation' } } } },
          '404': { description: 'Not found' },
        },
      },
      put: {
        tags: ['Locations'],
        summary: 'Update a location',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateServiceLocation' } } } },
        responses: {
          '200': { description: 'Location updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/ServiceLocation' } } } },
          '404': { description: 'Not found' },
        },
      },
    },
    '/locations/{id}/archive': {
      post: {
        tags: ['Locations'],
        summary: 'Archive a location',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        responses: { '200': { description: 'Location archived' } },
      },
    },
    '/locations/{id}/set-primary': {
      post: {
        tags: ['Locations'],
        summary: 'Set location as primary',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        responses: { '200': { description: 'Primary location updated' } },
      },
    },
    // Jobs
    '/jobs': {
      post: {
        tags: ['Jobs'],
        summary: 'Create a job',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateJob' } } } },
        responses: {
          '201': { description: 'Job created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Job' } } } },
        },
      },
      get: {
        tags: ['Jobs'],
        summary: 'List jobs',
        parameters: [
          { name: 'status', in: 'query' as const, schema: { type: 'string' as const, enum: ['new', 'scheduled', 'in_progress', 'completed', 'canceled'] } },
          { name: 'customerId', in: 'query' as const, schema: { type: 'string' as const } },
          { name: 'technicianId', in: 'query' as const, schema: { type: 'string' as const } },
          { name: 'search', in: 'query' as const, schema: { type: 'string' as const } },
        ],
        responses: {
          '200': { description: 'Job list', content: { 'application/json': { schema: { type: 'array' as const, items: { $ref: '#/components/schemas/Job' } } } } },
        },
      },
    },
    '/jobs/{id}': {
      get: {
        tags: ['Jobs'],
        summary: 'Get a job',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        responses: {
          '200': { description: 'Job details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Job' } } } },
          '404': { description: 'Not found' },
        },
      },
      put: {
        tags: ['Jobs'],
        summary: 'Update a job',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateJob' } } } },
        responses: {
          '200': { description: 'Job updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Job' } } } },
          '404': { description: 'Not found' },
        },
      },
    },
    '/jobs/{id}/transition': {
      post: {
        tags: ['Jobs'],
        summary: 'Transition job status',
        description: 'Valid transitions: new→scheduled|canceled, scheduled→in_progress|canceled, in_progress→completed|scheduled|canceled, canceled→new',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' as const, required: ['status'], properties: { status: { type: 'string' as const, enum: ['new', 'scheduled', 'in_progress', 'completed', 'canceled'] } } } } },
        },
        responses: { '200': { description: 'Status transitioned' } },
      },
    },
    // Appointments
    '/appointments': {
      post: {
        tags: ['Appointments'],
        summary: 'Create an appointment',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateAppointment' } } } },
        responses: { '201': { description: 'Appointment created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Appointment' } } } } },
      },
      get: {
        tags: ['Appointments'],
        summary: 'List appointments by job',
        parameters: [{ name: 'jobId', in: 'query' as const, required: true, schema: { type: 'string' as const } }],
        responses: {
          '200': { description: 'Appointment list', content: { 'application/json': { schema: { type: 'array' as const, items: { $ref: '#/components/schemas/Appointment' } } } } },
        },
      },
    },
    '/appointments/{id}': {
      get: {
        tags: ['Appointments'],
        summary: 'Get an appointment',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        responses: { '200': { description: 'Appointment details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Appointment' } } } } },
      },
      put: {
        tags: ['Appointments'],
        summary: 'Update an appointment',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateAppointment' } } } },
        responses: { '200': { description: 'Appointment updated' } },
      },
    },
    // Estimates
    '/estimates': {
      post: {
        tags: ['Estimates'],
        summary: 'Create an estimate',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateEstimate' } } } },
        responses: { '201': { description: 'Estimate created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Estimate' } } } } },
      },
    },
    '/estimates/{id}': {
      get: {
        tags: ['Estimates'],
        summary: 'Get an estimate',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        responses: { '200': { description: 'Estimate details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Estimate' } } } } },
      },
      put: {
        tags: ['Estimates'],
        summary: 'Update an estimate (draft/ready_for_review only)',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateEstimate' } } } },
        responses: { '200': { description: 'Estimate updated' } },
      },
    },
    '/estimates/{id}/transition': {
      post: {
        tags: ['Estimates'],
        summary: 'Transition estimate status',
        description: 'Valid transitions: draft→ready_for_review|sent, ready_for_review→sent|draft, sent→accepted|rejected|expired, rejected→draft, expired→draft',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' as const, required: ['status'], properties: { status: { type: 'string' as const, enum: ['draft', 'ready_for_review', 'sent', 'accepted', 'rejected', 'expired'] } } } } },
        },
        responses: { '200': { description: 'Status transitioned' } },
      },
    },
    // Invoices
    '/invoices': {
      post: {
        tags: ['Invoices'],
        summary: 'Create an invoice',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateInvoice' } } } },
        responses: { '201': { description: 'Invoice created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Invoice' } } } } },
      },
    },
    '/invoices/{id}': {
      get: {
        tags: ['Invoices'],
        summary: 'Get an invoice',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        responses: { '200': { description: 'Invoice details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Invoice' } } } } },
      },
      put: {
        tags: ['Invoices'],
        summary: 'Update an invoice',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateInvoice' } } } },
        responses: { '200': { description: 'Invoice updated' } },
      },
    },
    '/invoices/{id}/issue': {
      post: {
        tags: ['Invoices'],
        summary: 'Issue an invoice (sets status to open, calculates due date)',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' as const, properties: { paymentTermDays: { type: 'integer' as const, default: 30 } } } } },
        },
        responses: { '200': { description: 'Invoice issued' } },
      },
    },
    '/invoices/{id}/transition': {
      post: {
        tags: ['Invoices'],
        summary: 'Transition invoice status',
        description: 'Valid transitions: draft→open|canceled, open→partially_paid|paid|void, partially_paid→paid|void',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' as const, required: ['status'], properties: { status: { type: 'string' as const, enum: ['draft', 'open', 'partially_paid', 'paid', 'void', 'canceled'] } } } } },
        },
        responses: { '200': { description: 'Status transitioned' } },
      },
    },
    // Payments
    '/payments': {
      post: {
        tags: ['Payments'],
        summary: 'Record a payment',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RecordPayment' } } } },
        responses: { '201': { description: 'Payment recorded', content: { 'application/json': { schema: { type: 'object' as const, properties: { payment: { $ref: '#/components/schemas/Payment' }, invoice: { $ref: '#/components/schemas/Invoice' } } } } } } },
      },
      get: {
        tags: ['Payments'],
        summary: 'List payments by invoice',
        parameters: [{ name: 'invoiceId', in: 'query' as const, required: true, schema: { type: 'string' as const } }],
        responses: { '200': { description: 'Payment list', content: { 'application/json': { schema: { type: 'array' as const, items: { $ref: '#/components/schemas/Payment' } } } } } },
      },
    },
    // Notes
    '/notes': {
      post: {
        tags: ['Notes'],
        summary: 'Create a note',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateNote' } } } },
        responses: { '201': { description: 'Note created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Note' } } } } },
      },
      get: {
        tags: ['Notes'],
        summary: 'List notes by entity',
        parameters: [
          { name: 'entityType', in: 'query' as const, required: true, schema: { type: 'string' as const, enum: ['customer', 'location', 'job', 'estimate', 'invoice'] } },
          { name: 'entityId', in: 'query' as const, required: true, schema: { type: 'string' as const } },
        ],
        responses: { '200': { description: 'Note list', content: { 'application/json': { schema: { type: 'array' as const, items: { $ref: '#/components/schemas/Note' } } } } } },
      },
    },
    '/notes/{id}': {
      put: {
        tags: ['Notes'],
        summary: 'Update a note',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' as const, required: ['content'], properties: { content: { type: 'string' as const } } } } } },
        responses: { '200': { description: 'Note updated' } },
      },
      delete: {
        tags: ['Notes'],
        summary: 'Delete a note',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        responses: { '204': { description: 'Note deleted' } },
      },
    },
    // Conversations
    '/conversations': {
      post: {
        tags: ['Conversations'],
        summary: 'Create a conversation',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateConversation' } } } },
        responses: { '201': { description: 'Conversation created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Conversation' } } } } },
      },
    },
    '/conversations/{id}': {
      get: {
        tags: ['Conversations'],
        summary: 'Get a conversation',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        responses: { '200': { description: 'Conversation details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Conversation' } } } } },
      },
    },
    '/conversations/{id}/messages': {
      post: {
        tags: ['Conversations'],
        summary: 'Add a message to a conversation',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateMessage' } } } },
        responses: { '201': { description: 'Message added', content: { 'application/json': { schema: { $ref: '#/components/schemas/Message' } } } } },
      },
      get: {
        tags: ['Conversations'],
        summary: 'Get messages for a conversation',
        parameters: [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } }],
        responses: { '200': { description: 'Message list', content: { 'application/json': { schema: { type: 'array' as const, items: { $ref: '#/components/schemas/Message' } } } } } },
      },
    },
    // Settings
    '/settings': {
      get: {
        tags: ['Settings'],
        summary: 'Get tenant settings',
        responses: { '200': { description: 'Tenant settings', content: { 'application/json': { schema: { $ref: '#/components/schemas/TenantSettings' } } } } },
      },
      put: {
        tags: ['Settings'],
        summary: 'Update tenant settings',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateSettings' } } } },
        responses: { '200': { description: 'Settings updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/TenantSettings' } } } } },
      },
    },
  },
  tags: [
    { name: 'Customers', description: 'Customer management' },
    { name: 'Locations', description: 'Service location management' },
    { name: 'Jobs', description: 'Job/work order management' },
    { name: 'Appointments', description: 'Appointment scheduling' },
    { name: 'Estimates', description: 'Estimate creation and management' },
    { name: 'Invoices', description: 'Invoice management' },
    { name: 'Payments', description: 'Payment processing' },
    { name: 'Notes', description: 'Internal notes' },
    { name: 'Conversations', description: 'Conversation and messaging' },
    { name: 'Settings', description: 'Tenant configuration' },
  ],
};
