import type { ReactNode } from 'react';

/** Page title with an optional action area; wraps on narrow screens instead of squeezing the title. */
export function PageHeader({
  title,
  subtitle,
  actions,
  leading,
  badge,
}: {
  title: string;
  subtitle?: string | undefined;
  actions?: ReactNode;
  /** A visual before the title (the product photo). */
  leading?: ReactNode;
  /** A status badge right after the title, so state and name read together. */
  badge?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-1 basis-60 items-center gap-4">
        {leading}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1
              title={title}
              className="line-clamp-3 min-w-0 text-[28px] leading-8 font-bold tracking-[-0.025em] break-words"
            >
              {title}
            </h1>
            {badge}
          </div>
          {subtitle === undefined ? null : (
            <p className="mt-1 text-[15px] text-muted-foreground">{subtitle}</p>
          )}
        </div>
      </div>
      {actions === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
