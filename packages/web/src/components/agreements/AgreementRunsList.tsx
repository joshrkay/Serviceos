/**
 * P9-003 — AgreementRunsList.
 *
 * Renders the recent runs of a service agreement with status badges and
 * deep-links to the generated job/invoice. Pure presentational component.
 */
import React from 'react';
import type { AgreementRun, RunStatus } from '../../api/agreements';

const STATUS_CLASSES: Record<RunStatus, string> = {
  pending: 'bg-gray-100 text-gray-700',
  generated: 'bg-green-100 text-green-700',
  skipped: 'bg-yellow-100 text-yellow-700',
  failed: 'bg-red-100 text-red-700',
};

export interface AgreementRunsListProps {
  runs: AgreementRun[];
}

export function AgreementRunsList({ runs }: AgreementRunsListProps): JSX.Element {
  if (runs.length === 0) {
    return (
      <p className="text-sm text-gray-500" data-testid="agreement-runs-empty">
        No runs yet.
      </p>
    );
  }

  return (
    <ul className="divide-y" data-testid="agreement-runs-list">
      {runs.map((run) => (
        <li key={run.id} className="py-2 flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-sm font-medium">{run.scheduledFor}</span>
            {run.errorMessage && (
              <span className="text-xs text-red-600">{run.errorMessage}</span>
            )}
          </div>
          <div className="flex items-center gap-3 text-sm">
            {run.generatedJobId && (
              <a
                className="text-blue-600 hover:underline"
                href={`/jobs/${run.generatedJobId}`}
              >
                Job
              </a>
            )}
            {run.generatedInvoiceId && (
              <a
                className="text-blue-600 hover:underline"
                href={`/invoices/${run.generatedInvoiceId}`}
              >
                Invoice
              </a>
            )}
            <span
              className={`text-xs px-2 py-1 rounded ${STATUS_CLASSES[run.status]}`}
              data-testid={`run-status-${run.id}`}
            >
              {run.status}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
