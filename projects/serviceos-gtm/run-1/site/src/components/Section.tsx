import type { ReactNode } from 'react';

export function Section({
  children,
  className = '',
  as: Tag = 'section',
  'aria-labelledby': labelledBy,
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div';
  'aria-labelledby'?: string;
}) {
  return (
    <Tag aria-labelledby={labelledBy} className={`py-16 sm:py-20 ${className}`}>
      <div className="container-page">{children}</div>
    </Tag>
  );
}
