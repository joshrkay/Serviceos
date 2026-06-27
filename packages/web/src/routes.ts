import { createBrowserRouter } from 'react-router';
import { Shell } from './components/layout/Shell';
import { RouteErrorElement } from './components/layout/RouteErrorElement';
import { RoleHome } from './components/home/RoleHome';
import { AssistantPage } from './components/assistant/AssistantPage';
import { JobsPage } from './components/jobs/JobsPage';
import { SchedulePage } from './components/schedule/SchedulePage';
import { CustomersPage } from './components/customers/CustomersPage';
import { CustomerDetail } from './pages/customers/CustomerDetail';
import { EstimatesPage } from './components/estimates/EstimatesPage';
import { InvoicesPage } from './components/invoices/InvoicesPage';
import { SettingsPage } from './components/settings/SettingsPage';
import { TemplatesPage } from './components/settings/TemplatesPage';
import { PriceBookPage } from './components/settings/PriceBookPage';
import { FeedbackDashboard } from './components/settings/FeedbackDashboard';
import { LanguageSettingsPage } from './pages/settings/LanguageSettings';
import { OnboardingShell } from './components/onboarding/v2/OnboardingShell';
import { EstimateApprovalPage } from './components/customer/EstimateApprovalPage';
import { InvoicePaymentPage } from './components/customer/InvoicePaymentPage';
import { IntakeFormPage } from './components/customer/IntakeFormPage';
import { BookingPage } from './components/customer/BookingPage';
import { FeedbackPage } from './components/customer/FeedbackPage';
import { InteractionsPage } from './components/interactions/InteractionsPage';
import { DispatchLogPage } from './components/interactions/DispatchLogPage';
import { DispatchBoard } from './pages/dispatch/DispatchBoard';
import { LeadList } from './pages/leads/LeadList';
import { LeadDetail } from './pages/leads/LeadDetail';
import { LeadCreate } from './pages/leads/LeadCreate';
import { LoginPage } from './components/auth/LoginPage';
import { SignupPage } from './components/auth/SignupPage';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { MarketingLayout } from './components/marketing/MarketingLayout';
import { FeaturesPage } from './components/marketing/FeaturesPage';
import { PricingPage } from './components/marketing/PricingPage';
import { AboutPage } from './components/marketing/AboutPage';
import { DownloadPage } from './components/marketing/DownloadPage';
import { PrivacyPage } from './components/marketing/PrivacyPage';
import { TermsPage } from './components/marketing/TermsPage';
import { TechnicianDayPage } from './components/technician/TechnicianDayPage';
import { MaintenanceContractsPage } from './components/contracts/MaintenanceContractsPage';
import { ContractDetailPage } from './components/contracts/ContractDetailPage';
import { MoneyDashboardPage } from './components/reports/MoneyDashboardPage';
import { DigestPage } from './pages/digest/DigestPage';
import { RevenueBySourcePage } from './components/reports/RevenueBySourcePage';
import { InboxPage } from './components/inbox/InboxPage';
import { CommsInboxPage } from './pages/conversations/CommsInboxPage';
import { PortalShell } from './pages/portal/PortalShell';
import { Showcase } from './pages/design/Showcase';
import { InvoiceCreate } from './pages/invoices/InvoiceCreate';
import { EstimateCreate } from './pages/estimates/EstimateCreate';
import { JobCreate } from './pages/jobs/JobCreate';
import { JobPhotos } from './pages/jobs/JobPhotos';
import { CustomerEdit } from './pages/customers/CustomerEdit';
import { AppointmentEdit } from './pages/appointments/AppointmentEdit';
import { useParams, useNavigate } from 'react-router';
import React from 'react';

// P11-007 — wrappers that pull `:id` from the route and forward it to
// the typed edit components.
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

function LeadListRoute() {
  const navigate = useNavigate();
  return React.createElement(LeadList, {
    onSelectLead: (id: string) => navigate(`/leads/${id}`),
    onNewLead: () => navigate('/leads/new'),
  });
}

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

function LeadCreateRoute() {
  const navigate = useNavigate();
  return React.createElement(LeadCreate, {
    onCreated: (id: string) => navigate(`/leads/${id}`),
    onCancel: () => navigate('/leads'),
  });
}

function AppointmentEditRoute() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  if (!params.id) return null;
  return React.createElement(AppointmentEdit, {
    appointmentId: params.id,
    onBack: () => navigate(-1),
  });
}

// U9 (E7) — surface the per-job photo page so the persisted-photo pipeline
// (presign → PUT → attach → gallery) is reachable via `jobs/:id/photos`.
function JobPhotosRoute() {
  const params = useParams<{ id: string }>();
  if (!params.id) return null;
  return React.createElement(JobPhotos, { jobId: params.id });
}

// Wrap EstimatesPage to pre-select the estimate from the URL param.
function EstimateDetailRoute() {
  const params = useParams<{ id: string }>();
  if (!params.id) return null;
  return React.createElement(EstimatesPage as React.ComponentType<{ defaultSelectedId?: string }>, { defaultSelectedId: params.id });
}

// Wrap InvoicesPage to pre-select the invoice from the URL param.
function InvoiceDetailRoute() {
  const params = useParams<{ id: string }>();
  if (!params.id) return null;
  return React.createElement(InvoicesPage as React.ComponentType<{ defaultSelectedId?: string }>, { defaultSelectedId: params.id });
}

// Every top-level route gets `ErrorBoundary: RouteErrorElement` so an
// uncaught render/loader error renders the user-friendly fallback (with
// "Try again" / "Go back") instead of a blank white page. Errors thrown
// deeper in a subtree bubble up to the nearest route with an ErrorBoundary,
// so attaching it once at the outermost layer of the authenticated branch
// covers every nested page below.
export const router = createBrowserRouter([
  // ── Auth (fullscreen, no Shell) ───────────────────────────────────────────
  { path: '/login',  Component: LoginPage,  ErrorBoundary: RouteErrorElement },
  { path: '/signup', Component: SignupPage, ErrorBoundary: RouteErrorElement },

  // ── Public marketing site (shared header/footer, no auth) ──────────────
  // Standalone pages the LandingPage (at "/") and footers link to. Public so
  // they render signed-out and signed-in; "/" itself stays on ProtectedRoute.
  {
    Component: MarketingLayout,
    ErrorBoundary: RouteErrorElement,
    children: [
      { path: '/features', Component: FeaturesPage },
      { path: '/pricing',  Component: PricingPage  },
      { path: '/about',    Component: AboutPage    },
      { path: '/download', Component: DownloadPage },
      { path: '/privacy',  Component: PrivacyPage  },
      { path: '/terms',    Component: TermsPage    },
    ],
  },

  // ── Fullscreen flows (no Shell chrome) ─────────────────────────────────
  // §10 onboarding — v2 sidebar shell (the legacy v1 wizard was retired).
  {
    path: '/onboarding',
    Component: OnboardingShell,
    ErrorBoundary: RouteErrorElement,
  },
  { path: '/e/:id',      Component: EstimateApprovalPage, ErrorBoundary: RouteErrorElement },
  { path: '/pay/:id',    Component: InvoicePaymentPage,   ErrorBoundary: RouteErrorElement },
  { path: '/intake',     Component: IntakeFormPage,       ErrorBoundary: RouteErrorElement },
  { path: '/book',       Component: BookingPage,          ErrorBoundary: RouteErrorElement },
  { path: '/public/feedback/:token', Component: FeedbackPage, ErrorBoundary: RouteErrorElement },
  { path: '/portal/:token',          Component: PortalShell,  ErrorBoundary: RouteErrorElement },

  // ── App (with Shell nav, auth-gated) ───────────────────────────────────
  {
    path: '/',
    Component: ProtectedRoute,
    ErrorBoundary: RouteErrorElement,
    children: [{
      path: '/',
      Component: Shell,
      children: [
      { index: true,            Component: RoleHome        },
      { path: 'assistant',      Component: AssistantPage   },
      { path: 'jobs',           Component: JobsPage        },
      { path: 'jobs/new',       Component: JobCreate       },
      { path: 'jobs/:id',       Component: JobsPage        },
      { path: 'jobs/:id/photos', Component: JobPhotosRoute },
      { path: 'schedule',       Component: SchedulePage    },
      { path: 'dispatch',       Component: DispatchBoard   },
      { path: 'customers',      Component: CustomersPage   },
      { path: 'customers/:id',  Component: CustomerDetailRoute },
      { path: 'customers/:id/edit', Component: CustomerEditRoute },
      { path: 'appointments/:id/edit', Component: AppointmentEditRoute },
      { path: 'leads',          Component: LeadListRoute       },
      { path: 'leads/new',      Component: LeadCreateRoute     },
      { path: 'leads/:id',      Component: LeadDetailRoute     },
      { path: 'estimates',      Component: EstimatesPage   },
      { path: 'estimates/new',  Component: EstimateCreate  },
      { path: 'estimates/:id',  Component: EstimateDetailRoute },
      { path: 'invoices',       Component: InvoicesPage    },
      { path: 'invoices/new',   Component: InvoiceCreate   },
      { path: 'invoices/:id',   Component: InvoiceDetailRoute },
      { path: 'contracts',      Component: MaintenanceContractsPage },
      { path: 'contracts/:id',  Component: ContractDetailPage },
      { path: 'inbox',          Component: InboxPage        },
      { path: 'comms-inbox',    Component: CommsInboxPage   },
      { path: 'interactions',   Component: InteractionsPage },
      { path: 'interactions/dispatch', Component: DispatchLogPage },
      { path: 'settings',       Component: SettingsPage    },
      { path: 'settings/templates', Component: TemplatesPage   },
      { path: 'settings/price-book', Component: PriceBookPage },
      { path: 'settings/feedback', Component: FeedbackDashboard },
      { path: 'settings/language', Component: LanguageSettingsPage },
      { path: 'reports/money', Component: MoneyDashboardPage },
      // RV-062 — end-of-day digest web view (SMS deep link `/digest/<date>`;
      // no param / `latest` resolve to the most recent digest).
      { path: 'digest',         Component: DigestPage },
      { path: 'digest/:date',   Component: DigestPage },
      { path: 'reports/revenue-by-source', Component: RevenueBySourcePage },
      { path: 'technician/day', Component: TechnicianDayPage },
      { path: 'design',         Component: Showcase },
    ],
    }],
  },
]);
