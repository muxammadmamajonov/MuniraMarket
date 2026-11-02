import type { ReactNode } from 'react';

export interface EmptyPanelProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

/** An intentional "nothing here" panel: tinted icon, title, one line of help, optional action. */
export function EmptyPanel({ icon, title, description, action }: EmptyPanelProps) {
  return (
    <div
      data-testid="empty-panel"
      className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-surface px-6 py-12 text-center"
    >
      <span
        aria-hidden="true"
        className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-soft text-brand-ink"
      >
        {icon}
      </span>
      <h2 className="text-lg font-semibold">{title}</h2>
      {description ? <p className="max-w-sm text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}
