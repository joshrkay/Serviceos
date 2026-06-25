/**
 * P10-001 — Tenant-branded card primitive used across portal pages.
 *
 * Stays purely presentational so PortalShell can drop it onto any tab
 * without coupling to the routing layer.
 */
import { ReactNode } from 'react';

export interface PortalCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Right-side trailing content (e.g. a status pill or money amount). */
  trailing?: ReactNode;
  /** Optional click handler — entire card becomes a button. */
  onClick?: () => void;
}

export function PortalCard({ title, subtitle, children, trailing, onClick }: PortalCardProps) {
  const Wrapper = onClick ? 'button' : 'div';
  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={
        'w-full text-left bg-card rounded-2xl border border-border p-4 shadow-sm ' +
        (onClick ? 'hover:border-primary/30 transition-colors cursor-pointer' : '')
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-foreground truncate">{title}</div>
          {subtitle ? (
            <div className="text-sm text-muted-foreground truncate">{subtitle}</div>
          ) : null}
        </div>
        {trailing ? <div className="shrink-0">{trailing}</div> : null}
      </div>
      <div className="mt-3 text-sm text-foreground">{children}</div>
    </Wrapper>
  );
}
