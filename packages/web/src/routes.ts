import { createBrowserRouter } from 'react-router';
import { Shell } from './components/layout/Shell';
import { HomePage } from './components/home/HomePage';
import { AssistantPage } from './components/assistant/AssistantPage';
import { JobsPage } from './components/jobs/JobsPage';
import { SchedulePage } from './components/schedule/SchedulePage';
import { CustomersPage } from './components/customers/CustomersPage';
import { CustomerDetailPage } from './components/customers/CustomerDetailPage';
import { EstimatesPage } from './components/estimates/EstimatesPage';
import { InvoicesPage } from './components/invoices/InvoicesPage';
import { SettingsPage } from './components/settings/SettingsPage';
import { TemplatesPage } from './components/settings/TemplatesPage';
import { PriceBookPage } from './components/settings/PriceBookPage';
import { FeedbackDashboard } from './components/settings/FeedbackDashboard';
import { LanguageSettingsPage } from './pages/settings/LanguageSettings';
import { OnboardingPage } from './components/onboarding/OnboardingPage';
import { EstimateApprovalPage } from './components/customer/EstimateApprovalPage';
import { InvoicePaymentPage } from './components/customer/InvoicePaymentPage';
import { IntakeFormPage } from './components/customer/IntakeFormPage';
import { FeedbackPage } from './components/customer/FeedbackPage';
import { InteractionsPage } from './components/interactions/InteractionsPage';
import { LeadsPage } from './components/leads/LeadsPage';
import { LoginPage } from './components/auth/LoginPage';
import { SignupPage } from './components/auth/SignupPage';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { TechnicianDayPage } from './components/technician/TechnicianDayPage';
import { MaintenanceContractsPage } from './components/contracts/MaintenanceContractsPage';
import { ContractDetailPage } from './components/contracts/ContractDetailPage';
import { RevenueBySourcePage } from './components/reports/RevenueBySourcePage';
import { PortalShell } from './pages/portal/PortalShell';
import { InvoiceCreate } from './pages/invoices/InvoiceCreate';
import { EstimateCreate } from './pages/estimates/EstimateCreate';
import { JobCreate } from './pages/jobs/JobCreate';
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

function AppointmentEditRoute() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  if (!params.id) return null;
  return React.createElement(AppointmentEdit, {
    appointmentId: params.id,
    onBack: () => navigate(-1),
  });
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

export const router = createBrowserRouter([
  // ── Auth (fullscreen, no Shell) ──────────────────────────────────────────
  { path: '/login',  Component: LoginPage  },
  { path: '/signup', Component: SignupPage },

  // ── Fullscreen flows (no Shell chrome) ──────────────────────────────────
  { path: '/onboarding', Component: OnboardingPage },
  { path: '/e/:id',      Component: EstimateApprovalPage },
  { path: '/pay/:id',    Component: InvoicePaymentPage },
  { path: '/intake',     Component: IntakeFormPage },
  { path: '/public/feedback/:token', Component: FeedbackPage },
  { path: '/portal/:token',          Component: PortalShell },

  // ── App (with Shell nav, auth-gated) ────────────────────────────────────
  {
    path: '/',
    Component: ProtectedRoute,
    children: [{
      path: '/',
      Component: Shell,
      children: [
      { index: true,            Component: HomePage        },
      { path: 'assistant',      Component: AssistantPage   },
      { path: 'jobs',           Component: JobsPage        },
      { path: 'jobs/new',       Component: JobCreate       },
      { path: 'jobs/:id',       Component: JobsPage        },
      { path: 'schedule',       Component: SchedulePage    },
      { path: 'customers',      Component: CustomersPage   },
      { path: 'customers/:id',  Component: CustomerDetailPage },
      { path: 'customers/:id/edit', Component: CustomerEditRoute },
      { path: 'appointments/:id/edit', Component: AppointmentEditRoute },
      { path: 'contracts/:id',  Component: ContractDetailPage },
      { path: 'leads',          Component: LeadsPage       },
      { path: 'estimates',      Component: EstimatesPage   },
      { path: 'estimates/new',  Component: EstimateCreate  },
      { path: 'estimates/:id',  Component: EstimateDetailRoute },
      { path: 'invoices',       Component: InvoicesPage    },
      { path: 'invoices/new',   Component: InvoiceCreate   },
      { path: 'invoices/:id',   Component: InvoiceDetailRoute },
      { path: 'contracts',      Component: MaintenanceContractsPage },
      { path: 'contracts/:id',  Component: ContractDetailPage },
      { path: 'interactions',   Component: InteractionsPage },
      { path: 'settings',       Component: SettingsPage    },
      { path: 'settings/templates', Component: TemplatesPage   },
      { path: 'settings/price-book', Component: PriceBookPage },
      { path: 'settings/feedback', Component: FeedbackDashboard },
      { path: 'settings/language', Component: LanguageSettingsPage },
      { path: 'reports/revenue-by-source', Component: RevenueBySourcePage },
      { path: 'technician/day', Component: TechnicianDayPage },
    ],
    }],
  },
]);
