import React from 'react';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';

export interface DetailSection {
  title: string;
  content: React.ReactNode;
}

export interface DetailAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
}

export interface DetailPageProps {
  title: string;
  subtitle?: string;
  sections: DetailSection[];
  actions?: DetailAction[];
  isLoading: boolean;
  error: string | null;
  onBack?: () => void;
  onRetry: () => void;
}

export function DetailPage({
  title,
  subtitle,
  sections,
  actions,
  isLoading,
  error,
  onBack,
  onRetry,
}: DetailPageProps) {
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (isLoading) return <LoadingState />;

  return (
    <div className="detail-page">
      <div className="detail-page-header">
        {onBack && <button onClick={onBack}>Back</button>}
        <div>
          <h1>{title}</h1>
          {subtitle && <p className="subtitle">{subtitle}</p>}
        </div>
        {actions && (
          <div className="detail-actions">
            {actions.map((action, i) => (
              <button
                key={i}
                onClick={action.onClick}
                className={`action-${action.variant || 'secondary'}`}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="detail-sections">
        {sections.map((section, i) => (
          <div key={i} className="detail-section">
            <h2>{section.title}</h2>
            <div className="section-content">{section.content}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
