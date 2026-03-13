import React, { useState } from 'react';
import { ContextEntity } from '../../types/conversation';

export interface ContextPanelProps {
  entities: ContextEntity[];
  conversationTitle?: string;
}

interface CollapsibleSectionProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function CollapsibleSection({ title, children, defaultOpen = true }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="context-section" data-testid="context-section">
      <button
        className="context-section-header"
        data-testid="context-section-toggle"
        onClick={() => setOpen(!open)}
      >
        <span>{title}</span>
        <span>{open ? '▼' : '▶'}</span>
      </button>
      {open && (
        <div className="context-section-content" data-testid="context-section-content">
          {children}
        </div>
      )}
    </div>
  );
}

function sanitizeDetailValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '[complex value]';
}

const ENTITY_TYPE_LABELS: Record<string, string> = {
  customer: 'Customer',
  location: 'Location',
  job: 'Job',
  appointment: 'Appointment',
  estimate: 'Estimate',
};

export function ContextPanel({ entities, conversationTitle }: ContextPanelProps) {
  if (!entities || entities.length === 0) {
    return (
      <div className="context-panel" data-testid="context-panel">
        <div className="context-panel-empty" data-testid="context-panel-empty">
          No linked context available
        </div>
      </div>
    );
  }

  return (
    <div className="context-panel" data-testid="context-panel">
      {conversationTitle && (
        <h3 className="context-panel-title" data-testid="context-panel-title">
          {conversationTitle}
        </h3>
      )}
      {entities.map((entity) => (
        <CollapsibleSection
          key={`${entity.type}-${entity.id}`}
          title={ENTITY_TYPE_LABELS[entity.type] ?? entity.type}
        >
          <div className="context-entity" data-testid={`context-entity-${entity.type}`}>
            <div className="context-entity-label" data-testid="context-entity-label">
              {entity.label}
            </div>
            <dl className="context-entity-details">
              {Object.entries(entity.details).map(([key, value]) => (
                <React.Fragment key={key}>
                  <dt data-testid={`context-detail-key-${key}`}>{key}</dt>
                  <dd data-testid={`context-detail-value-${key}`}>{sanitizeDetailValue(value)}</dd>
                </React.Fragment>
              ))}
            </dl>
          </div>
        </CollapsibleSection>
      ))}
    </div>
  );
}
