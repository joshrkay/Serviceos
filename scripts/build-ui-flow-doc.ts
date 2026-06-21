/**
 * Assemble the UI flow doc (docs/ui-flows/README.md) from the curated screen
 * graph + the screenshots captured by:
 *   - e2e/ui-flow-capture.spec.ts        (web, into docs/ui-flows/captures/web)
 *   - e2e/ui-flow-capture-mobile.spec.ts (mobile, into .../captures/mobile)
 *
 * Output = a Mermaid structural map (always renders) + each screen as an
 * embedded screenshot in flow order with its outgoing navigation. Screens
 * whose PNG hasn't been captured yet render a "not captured yet" note, so the
 * doc is useful before/without a full capture run.
 *
 * Run: `npm run ui-flow:doc` (or `tsx scripts/build-ui-flow-doc.ts`). No app /
 * backend needed — it only reads the graph + whatever PNGs exist.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

interface Screen {
  /** Capture filename stem — must match the screenshot the spec writes. */
  label: string;
  title: string;
  /** Outgoing navigation, as labels in the same app group. */
  to?: string[];
  /** Notes (e.g. "opened from an SMS link"). */
  note?: string;
}

interface Group {
  id: string;
  title: string;
  app: 'web' | 'mobile' | 'public';
  /** Subdir under captures/ where this group's PNGs live. */
  dir: 'web' | 'mobile';
  screens: Screen[];
}

const GROUPS: Group[] = [
  {
    id: 'mobile',
    title: 'Mobile app — operator',
    app: 'mobile',
    dir: 'mobile',
    screens: [
      { label: 'sign-in', title: 'Sign in', to: ['home'] },
      {
        label: 'home',
        title: 'Home / Today (hub)',
        to: ['voice', 'approvals', 'messages', 'customers', 'jobs', 'estimates', 'invoices', 'schedule', 'settings'],
      },
      { label: 'voice', title: 'Voice — speak an action' },
      { label: 'approvals', title: 'Approval inbox', to: ['proposal'] },
      { label: 'proposal', title: 'Proposal review (approve / edit / reject)', note: 'Also opened from a push notification' },
      { label: 'messages', title: 'Messages', to: ['thread'] },
      { label: 'thread', title: 'Message thread (text / call)' },
      { label: 'customers', title: 'Customers', to: ['customer'] },
      { label: 'customer', title: 'Customer detail', to: ['thread'] },
      { label: 'jobs', title: 'Jobs' },
      { label: 'estimates', title: 'Estimates' },
      { label: 'invoices', title: 'Invoices' },
      { label: 'schedule', title: 'Schedule' },
      { label: 'settings', title: 'Settings' },
    ],
  },
  {
    id: 'web',
    title: 'Web app — back office',
    app: 'web',
    dir: 'web',
    screens: [
      { label: 'login', title: 'Login / Signup', to: ['onboarding', 'home'] },
      { label: 'onboarding', title: 'Onboarding', to: ['home'] },
      {
        label: 'home',
        title: 'Home dashboard',
        to: ['assistant', 'inbox', 'comms-inbox', 'jobs-list', 'schedule', 'dispatch', 'customers-list', 'leads-list', 'estimates-list', 'invoices-list', 'contracts-list', 'interactions', 'reports-money', 'reports-revenue', 'digest', 'technician-day', 'settings'],
      },
      { label: 'assistant', title: 'AI Assistant' },
      { label: 'inbox', title: 'Inbox' },
      { label: 'comms-inbox', title: 'Comms inbox' },
      { label: 'jobs-list', title: 'Jobs', to: ['jobs-new', 'jobs-detail'] },
      { label: 'jobs-new', title: 'New job' },
      { label: 'jobs-detail', title: 'Job detail' },
      { label: 'schedule', title: 'Schedule' },
      { label: 'dispatch', title: 'Dispatch board' },
      { label: 'customers-list', title: 'Customers', to: ['customers-detail'] },
      { label: 'customers-detail', title: 'Customer detail', to: ['customers-edit', 'appointments-edit'] },
      { label: 'customers-edit', title: 'Edit customer' },
      { label: 'appointments-edit', title: 'Edit appointment' },
      { label: 'leads-list', title: 'Leads', to: ['leads-new', 'leads-detail'] },
      { label: 'leads-new', title: 'New lead' },
      { label: 'leads-detail', title: 'Lead detail' },
      { label: 'estimates-list', title: 'Estimates', to: ['estimates-new'] },
      { label: 'estimates-new', title: 'New estimate' },
      { label: 'invoices-list', title: 'Invoices', to: ['invoices-new'] },
      { label: 'invoices-new', title: 'New invoice' },
      { label: 'contracts-list', title: 'Contracts', to: ['contracts-detail'] },
      { label: 'contracts-detail', title: 'Contract detail' },
      { label: 'interactions', title: 'Interactions / Dispatch log' },
      { label: 'reports-money', title: 'Reports — Money' },
      { label: 'reports-revenue', title: 'Reports — Revenue by source' },
      { label: 'digest', title: 'Daily digest' },
      { label: 'technician-day', title: 'Technician day' },
      { label: 'settings', title: 'Settings', to: ['settings-templates', 'settings-price-book', 'settings-feedback', 'settings-language'] },
      { label: 'settings-templates', title: 'Settings — Templates' },
      { label: 'settings-price-book', title: 'Settings — Price book' },
      { label: 'settings-feedback', title: 'Settings — Feedback' },
      { label: 'settings-language', title: 'Settings — Language' },
    ],
  },
  {
    id: 'public',
    title: 'Public — customer-facing (opened from SMS / email / website links)',
    app: 'public',
    dir: 'web',
    screens: [
      { label: 'estimate-approval', title: 'Estimate approval (/e/:id)', note: 'Link sent from an estimate', to: ['invoice-payment'] },
      { label: 'invoice-payment', title: 'Invoice payment (/pay/:id)', note: 'Link sent from an invoice' },
      { label: 'intake', title: 'Intake form (/intake)', note: 'Website / SMS link' },
      { label: 'booking', title: 'Booking (/book)', note: 'Website / SMS link' },
      { label: 'feedback', title: 'Feedback (/public/feedback/:token)', note: 'Sent after a completed job' },
      { label: 'portal', title: 'Customer portal (/portal/:token)', note: 'Customer self-serve link' },
    ],
  },
];

const ROOT = process.cwd();
const DOC_DIR = path.join(ROOT, 'docs/ui-flows');

function nodeId(groupId: string, label: string): string {
  return `${groupId}_${label}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

function hasCapture(group: Group, label: string): boolean {
  return fs.existsSync(path.join(DOC_DIR, 'captures', group.dir, `${label}.png`));
}

function mermaid(): string {
  const lines: string[] = ['```mermaid', 'flowchart LR'];
  for (const group of GROUPS) {
    lines.push(`  subgraph ${group.id}["${group.title}"]`);
    lines.push('    direction TB');
    for (const s of group.screens) {
      lines.push(`    ${nodeId(group.id, s.label)}["${s.title}"]`);
    }
    for (const s of group.screens) {
      for (const target of s.to ?? []) {
        lines.push(`    ${nodeId(group.id, s.label)} --> ${nodeId(group.id, target)}`);
      }
    }
    lines.push('  end');
  }
  // Cross-group links: where the customer-facing pages originate.
  const xlink = (from: [string, string], label: string, to: [string, string]): string =>
    `  ${nodeId(from[0], from[1])} -.->|"${label}"| ${nodeId(to[0], to[1])}`;
  lines.push(xlink(['web', 'estimates-new'], 'send link', ['public', 'estimate-approval']));
  lines.push(xlink(['web', 'invoices-new'], 'send link', ['public', 'invoice-payment']));
  lines.push(xlink(['mobile', 'proposal'], 'approve & send', ['public', 'estimate-approval']));
  lines.push('```');
  return lines.join('\n');
}

function section(group: Group): string {
  const out: string[] = [`## ${group.title}`, ''];
  for (const s of group.screens) {
    out.push(`### ${s.title}`);
    if (hasCapture(group, s.label)) {
      out.push('', `![${s.title}](captures/${group.dir}/${s.label}.png)`, '');
    } else {
      out.push('', `> _Screenshot not captured yet — run \`npm run ui-flow:capture\` (\`captures/${group.dir}/${s.label}.png\`)._`, '');
    }
    if (s.note) out.push(`- ${s.note}`);
    if (s.to && s.to.length > 0) {
      const titles = s.to.map((t) => group.screens.find((x) => x.label === t)?.title ?? t);
      out.push(`- → ${titles.join(', ')}`);
    }
    out.push('');
  }
  return out.join('\n');
}

function build(): string {
  const captured = GROUPS.reduce(
    (n, g) => n + g.screens.filter((s) => hasCapture(g, s.label)).length,
    0,
  );
  const total = GROUPS.reduce((n, g) => n + g.screens.length, 0);
  return [
    '# ServiceOS — UI Screen Flow',
    '',
    '> Generated by `npm run ui-flow:doc` (`scripts/build-ui-flow-doc.ts`).',
    `> Screenshots captured: **${captured} / ${total}**. To (re)capture, see "Capturing screenshots" below.`,
    '',
    'A map of every UI screen and how users move between them, across the mobile',
    'operator app, the web back office, and the public customer-facing pages.',
    '',
    '## Flow map',
    '',
    mermaid(),
    '',
    ...GROUPS.map(section),
    '## Capturing screenshots',
    '',
    'Screens render only against a running app with auth + data, so capture runs',
    'where that exists (CI, a dev machine, or a deployed env), not in a bare',
    'container. Then re-run the assembler to embed the images.',
    '',
    '```bash',
    '# Web (Vite SPA) — local stack OR a deployed URL that has Clerk wired:',
    'UI_FLOW=1 VITE_CLERK_PUBLISHABLE_KEY=pk_test_... E2E_CLERK_SECRET_KEY=sk_test_... \\',
    '  npm run ui-flow:capture',
    '#   …or against a deployed env (no local stack):',
    'UI_FLOW=1 E2E_BASE_URL=https://your-web-env.example.com npm run ui-flow:capture',
    '',
    '# Mobile (Expo operator app) — export to web, serve it, then capture:',
    'cd packages/mobile && npm run export:web && cd ../..',
    'npx serve packages/mobile/.e2e-web -l 8081 &',
    'UI_FLOW=1 E2E_MOBILE_URL=http://localhost:8081 \\',
    '  npx playwright test e2e/ui-flow-capture-mobile.spec.ts --project=ui-flow',
    '',
    '# Rebuild this doc with the new screenshots embedded:',
    'npm run ui-flow:doc',
    '```',
    '',
    'Without Clerk creds the web tour runs anonymously (authed routes redirect to',
    'login); set `E2E_CLERK_*` for the real authenticated screens.',
    '',
  ].join('\n');
}

fs.mkdirSync(DOC_DIR, { recursive: true });
const outPath = path.join(DOC_DIR, 'README.md');
fs.writeFileSync(outPath, build(), 'utf8');
console.log(`Wrote ${path.relative(ROOT, outPath)}`);
