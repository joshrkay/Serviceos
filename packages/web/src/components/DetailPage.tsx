import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { ErrorState } from './ErrorState';
import { Button, type ButtonVariant } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Skeleton, SkeletonText } from './ui/skeleton';

export interface DetailSection {
  title: string;
  content: React.ReactNode;
}

export interface DetailAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
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

const ACTION_VARIANT: Record<
  NonNullable<DetailAction['variant']>,
  ButtonVariant
> = {
  primary: 'primary',
  secondary: 'outline',
  danger: 'danger',
};

function DetailSkeleton({ onBack }: { onBack?: () => void }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="mx-auto max-w-2xl px-4 md:px-6 py-5"
    >
      <span className="sr-only">Loading...</span>
      <div className="mb-5 flex items-center gap-3">
        {onBack && <Skeleton className="size-8 rounded-lg" />}
        <Skeleton className="h-6 w-40" />
      </div>
      <div className="flex flex-col gap-4">
        {[0, 1, 2].map((i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-4 w-32" />
            </CardHeader>
            <CardContent>
              <SkeletonText lines={3} />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
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
  if (isLoading) return <DetailSkeleton onBack={onBack} />;

  return (
    <div className="h-full overflow-y-auto pb-20 md:pb-6">
      <div className="mx-auto max-w-2xl px-4 md:px-6 pt-5">
        {/* Header */}
        <div className="mb-5 flex items-start gap-3">
          {onBack && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              leftIcon={<ArrowLeft size={16} />}
              className="mt-0.5"
            >
              Back
            </Button>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-slate-900">{title}</h1>
            {subtitle && (
              <p className="mt-0.5 truncate text-sm text-slate-400">
                {subtitle}
              </p>
            )}
          </div>
          {actions && actions.length > 0 && (
            <div className="flex shrink-0 items-center gap-2">
              {actions.map((action, i) => (
                <Button
                  key={i}
                  size="sm"
                  variant={ACTION_VARIANT[action.variant ?? 'secondary']}
                  disabled={action.disabled}
                  onClick={action.onClick}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          )}
        </div>

        {/* Sections */}
        <div className="flex flex-col gap-4">
          {sections.map((section, i) => (
            <Card key={i}>
              <CardHeader>
                <CardTitle>{section.title}</CardTitle>
              </CardHeader>
              <CardContent>{section.content}</CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
