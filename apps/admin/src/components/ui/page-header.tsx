import type { ReactNode } from 'react';

/** Page title with an optional action area; wraps on narrow screens instead of squeezing the title. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string | undefined;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1 basis-60">
        <h1 title={title} className="line-clamp-3 text-2xl font-bold tracking-tight break-words">
          {title}
        </h1>
        {subtitle === undefined ? null : <p className="text-muted-foreground">{subtitle}</p>}
      </div>
      {actions === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
