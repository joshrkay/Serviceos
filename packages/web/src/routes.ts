import { createBrowserRouter, useParams, useNavigate } from 'react-router';
import React from 'react';
// First-paint-critical shells stay eagerly imported so the most common entry
// paths (`/` home, `/login`) render without an extra round-trip. Every other
// route is split into its own chunk via `lazy:` below, so the initial download
// no longer pulls the JS for pages the user hasn't navigated to (BUG-6
// follow-up: manual vendor chunks shrank vendors; this splits the app's own
// page code too).
import { Shell } from './components/layout/Shell';
import { RouteErrorElement } from './components/layout/RouteErrorElement';
import { RouteFallback } from './components/layout/RouteFallback';
import { RoleHome } from './components/home/RoleHome';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { LoginPage } from './components/auth/LoginPage';

// The param-wrapper routes (`:id` → typed props) are defined *inside* their
// lazy loaders below, so each heavy page stays out of the eager graph while the
// tiny wrapper logic loads with its own chunk. Shared hydrate fallback element
// for cold deep-links into those lazy chunks.
const routeFallback = React.createElement(RouteFallback);

export const router = createBrowserRouter([
  // ── Auth (fullscreen, no Shell) ───────────────────────────────────────────
  { path: '/login',  Component: LoginPage,  ErrorBoundary: RouteErrorElement },
  {
    path: '/signup',
    lazy: async () => ({ Component: (await import('./components/auth/SignupPage')).SignupPage }),
    ErrorBoundary: RouteErrorElement,
    hydrateFallbackElement: routeFallback,
  },

  // ── Public marketing site (shared header/footer, no auth) ──────────────
  // Standalone pages the LandingPage (at "/") and footers link to. Public so
  // they render signed-out and signed-in; "/" itself stays on ProtectedRoute.
  {
    lazy: async () => ({ Component: (await import('./components/marketing/MarketingLayout')).MarketingLayout }),
    ErrorBoundary: RouteErrorElement,
    hydrateFallbackElement: routeFallback,
    children: [
      { path: '/features', lazy: async () => ({ Component: (await import('./components/marketing/FeaturesPage')).FeaturesPage }) },
      { path: '/pricing',  lazy: async () => ({ Component: (await import('./components/marketing/PricingPage')).PricingPage }) },
      { path: '/about',    lazy: async () => ({ Component: (await import('./components/marketing/AboutPage')).AboutPage }) },
      { path: '/download', lazy: async () => ({ Component: (await import('./components/marketing/DownloadPage')).DownloadPage }) },
      { path: '/privacy',  lazy: async () => ({ Component: (await import('./components/marketing/PrivacyPage')).PrivacyPage }) },
      { path: '/terms',    lazy: async () => ({ Component: (await import('./components/marketing/TermsPage')).TermsPage }) },
    ],
  },

  // ── Fullscreen flows (no Shell chrome) ─────────────────────────────────
  // §10 onboarding — v2 sidebar shell (the legacy v1 wizard was retired).
  {
    path: '/onboarding',
    lazy: async () => ({ Component: (await import('./components/onboarding/v2/OnboardingShell')).OnboardingShell }),
    ErrorBoundary: RouteErrorElement,
    hydrateFallbackElement: routeFallback,
  },
  { path: '/e/:id',      lazy: async () => ({ Component: (await import('./components/customer/EstimateApprovalPage')).EstimateApprovalPage }), ErrorBoundary: RouteErrorElement, hydrateFallbackElement: routeFallback },
  { path: '/pay/:id',    lazy: async () => ({ Component: (await import('./components/customer/InvoicePaymentPage')).InvoicePaymentPage }),   ErrorBoundary: RouteErrorElement, hydrateFallbackElement: routeFallback },
  { path: '/intake',     lazy: async () => ({ Component: (await import('./components/customer/IntakeFormPage')).IntakeFormPage }),           ErrorBoundary: RouteErrorElement, hydrateFallbackElement: routeFallback },
  { path: '/book',       lazy: async () => ({ Component: (await import('./components/customer/BookingPage')).BookingPage }),                 ErrorBoundary: RouteErrorElement, hydrateFallbackElement: routeFallback },
  { path: '/public/feedback/:token', lazy: async () => ({ Component: (await import('./components/customer/FeedbackPage')).FeedbackPage }),  ErrorBoundary: RouteErrorElement, hydrateFallbackElement: routeFallback },
  { path: '/portal/:token',          lazy: async () => ({ Component: (await import('./pages/portal/PortalShell')).PortalShell }),           ErrorBoundary: RouteErrorElement, hydrateFallbackElement: routeFallback },

  // ── App (with Shell nav, auth-gated) ───────────────────────────────────
  {
    path: '/',
    Component: ProtectedRoute,
    ErrorBoundary: RouteErrorElement,
    children: [{
      path: '/',
      Component: Shell,
      // Covers cold deep-links to any lazy app page below (chain:
      // ProtectedRoute → Shell → <lazy page>).
      hydrateFallbackElement: routeFallback,
      children: [
      // The index (home) renders on the hottest path — keep it eager.
      { index: true,            Component: RoleHome        },
      { path: 'assistant',      lazy: async () => ({ Component: (await import('./components/assistant/AssistantPage')).AssistantPage }) },
      { path: 'jobs',           lazy: async () => ({ Component: (await import('./components/jobs/JobsPage')).JobsPage }) },
      { path: 'jobs/new',       lazy: async () => ({ Component: (await import('./pages/jobs/JobCreate')).JobCreate }) },
      { path: 'jobs/:id',       lazy: async () => ({ Component: (await import('./components/jobs/JobsPage')).JobsPage }) },
      // U9 (E7) — per-job photo page so the persisted-photo pipeline
      // (presign → PUT → attach → gallery) is reachable via `jobs/:id/photos`.
      {
        path: 'jobs/:id/photos',
        lazy: async () => {
          const { JobPhotos } = await import('./pages/jobs/JobPhotos');
          function JobPhotosRoute() {
            const params = useParams<{ id: string }>();
            if (!params.id) return null;
            return React.createElement(JobPhotos, { jobId: params.id });
          }
          return { Component: JobPhotosRoute };
        },
      },
      { path: 'schedule',       lazy: async () => ({ Component: (await import('./components/schedule/SchedulePage')).SchedulePage }) },
      { path: 'dispatch',       lazy: async () => ({ Component: (await import('./pages/dispatch/DispatchBoard')).DispatchBoard }) },
      { path: 'customers',      lazy: async () => ({ Component: (await import('./components/customers/CustomersPage')).CustomersPage }) },
      {
        path: 'customers/:id',
        lazy: async () => {
          const { CustomerDetail } = await import('./pages/customers/CustomerDetail');
          function CustomerDetailRoute() {
            const params = useParams<{ id: string }>();
            const navigate = useNavigate();
            if (!params.id) return null;
            return React.createElement(CustomerDetail, {
              customerId: params.id,
              onBack: () => navigate('/customers'),
              onEdit: () => navigate(`/customers/${params.id}/edit`),
              onArchived: () => navigate('/customers'),
            });
          }
          return { Component: CustomerDetailRoute };
        },
      },
      {
        path: 'customers/:id/edit',
        lazy: async () => {
          const { CustomerEdit } = await import('./pages/customers/CustomerEdit');
          function CustomerEditRoute() {
            const params = useParams<{ id: string }>();
            const navigate = useNavigate();
            if (!params.id) return null;
            return React.createElement(CustomerEdit, {
              customerId: params.id,
              onSaved: (id: string) => navigate(`/customers/${id}`),
              onCancel: () => navigate(-1),
            });
          }
          return { Component: CustomerEditRoute };
        },
      },
      {
        path: 'appointments/:id/edit',
        lazy: async () => {
          const { AppointmentEdit } = await import('./pages/appointments/AppointmentEdit');
          function AppointmentEditRoute() {
            const params = useParams<{ id: string }>();
            const navigate = useNavigate();
            if (!params.id) return null;
            return React.createElement(AppointmentEdit, {
              appointmentId: params.id,
              onBack: () => navigate(-1),
            });
          }
          return { Component: AppointmentEditRoute };
        },
      },
      {
        path: 'leads',
        lazy: async () => {
          const { LeadList } = await import('./pages/leads/LeadList');
          function LeadListRoute() {
            const navigate = useNavigate();
            return React.createElement(LeadList, {
              onSelectLead: (id: string) => navigate(`/leads/${id}`),
              onNewLead: () => navigate('/leads/new'),
            });
          }
          return { Component: LeadListRoute };
        },
      },
      {
        path: 'leads/new',
        lazy: async () => {
          const { LeadCreate } = await import('./pages/leads/LeadCreate');
          function LeadCreateRoute() {
            const navigate = useNavigate();
            return React.createElement(LeadCreate, {
              onCreated: (id: string) => navigate(`/leads/${id}`),
              onCancel: () => navigate('/leads'),
            });
          }
          return { Component: LeadCreateRoute };
        },
      },
      {
        path: 'leads/:id',
        lazy: async () => {
          const { LeadDetail } = await import('./pages/leads/LeadDetail');
          function LeadDetailRoute() {
            const params = useParams<{ id: string }>();
            const navigate = useNavigate();
            if (!params.id) return null;
            return React.createElement(LeadDetail, {
              leadId: params.id,
              onBack: () => navigate('/leads'),
              onConverted: (customerId: string) => navigate(`/customers/${customerId}`),
            });
          }
          return { Component: LeadDetailRoute };
        },
      },
      { path: 'estimates',      lazy: async () => ({ Component: (await import('./components/estimates/EstimatesPage')).EstimatesPage }) },
      { path: 'estimates/new',  lazy: async () => ({ Component: (await import('./pages/estimates/EstimateCreate')).EstimateCreate }) },
      {
        path: 'estimates/:id',
        lazy: async () => {
          const { EstimatesPage } = await import('./components/estimates/EstimatesPage');
          function EstimateDetailRoute() {
            const params = useParams<{ id: string }>();
            if (!params.id) return null;
            return React.createElement(
              EstimatesPage as React.ComponentType<{ defaultSelectedId?: string }>,
              { defaultSelectedId: params.id },
            );
          }
          return { Component: EstimateDetailRoute };
        },
      },
      { path: 'invoices',       lazy: async () => ({ Component: (await import('./components/invoices/InvoicesPage')).InvoicesPage }) },
      { path: 'invoices/new',   lazy: async () => ({ Component: (await import('./pages/invoices/InvoiceCreate')).InvoiceCreate }) },
      {
        path: 'invoices/:id',
        lazy: async () => {
          const { InvoicesPage } = await import('./components/invoices/InvoicesPage');
          function InvoiceDetailRoute() {
            const params = useParams<{ id: string }>();
            if (!params.id) return null;
            return React.createElement(
              InvoicesPage as React.ComponentType<{ defaultSelectedId?: string }>,
              { defaultSelectedId: params.id },
            );
          }
          return { Component: InvoiceDetailRoute };
        },
      },
      { path: 'contracts',      lazy: async () => ({ Component: (await import('./components/contracts/MaintenanceContractsPage')).MaintenanceContractsPage }) },
      { path: 'contracts/:id',  lazy: async () => ({ Component: (await import('./components/contracts/ContractDetailPage')).ContractDetailPage }) },
      { path: 'inbox',          lazy: async () => ({ Component: (await import('./components/inbox/InboxPage')).InboxPage }) },
      { path: 'comms-inbox',    lazy: async () => ({ Component: (await import('./pages/conversations/CommsInboxPage')).CommsInboxPage }) },
      { path: 'interactions',   lazy: async () => ({ Component: (await import('./components/interactions/InteractionsPage')).InteractionsPage }) },
      { path: 'interactions/dispatch', lazy: async () => ({ Component: (await import('./components/interactions/DispatchLogPage')).DispatchLogPage }) },
      { path: 'settings',       lazy: async () => ({ Component: (await import('./components/settings/SettingsPage')).SettingsPage }) },
      { path: 'settings/templates', lazy: async () => ({ Component: (await import('./components/settings/TemplatesPage')).TemplatesPage }) },
      { path: 'settings/price-book', lazy: async () => ({ Component: (await import('./components/settings/PriceBookPage')).PriceBookPage }) },
      { path: 'settings/feedback', lazy: async () => ({ Component: (await import('./components/settings/FeedbackDashboard')).FeedbackDashboard }) },
      { path: 'settings/language', lazy: async () => ({ Component: (await import('./pages/settings/LanguageSettings')).LanguageSettingsPage }) },
      { path: 'reports/money', lazy: async () => ({ Component: (await import('./components/reports/MoneyDashboardPage')).MoneyDashboardPage }) },
      // RV-062 — end-of-day digest web view (SMS deep link `/digest/<date>`;
      // no param / `latest` resolve to the most recent digest).
      { path: 'digest',         lazy: async () => ({ Component: (await import('./pages/digest/DigestPage')).DigestPage }) },
      { path: 'digest/:date',   lazy: async () => ({ Component: (await import('./pages/digest/DigestPage')).DigestPage }) },
      { path: 'reports/revenue-by-source', lazy: async () => ({ Component: (await import('./components/reports/RevenueBySourcePage')).RevenueBySourcePage }) },
      { path: 'technician/day', lazy: async () => ({ Component: (await import('./components/technician/TechnicianDayPage')).TechnicianDayPage }) },
      { path: 'design',         lazy: async () => ({ Component: (await import('./pages/design/Showcase')).Showcase }) },
    ],
    }],
  },
]);
