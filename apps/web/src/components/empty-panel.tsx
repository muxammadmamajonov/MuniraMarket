import type { ReactNode } from 'react';

export interface EmptyPanelProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

/**
 * An intentional "nothing here" screen: a large tinted disc with the icon, the title, one line of
 * help and the next step. No frame around it: an empty screen is an invitation, not a box.
 */
export function EmptyPanel({ icon, title, description, action }: EmptyPanelProps) {
  return (
    <div
      data-testid="empty-panel"
      className="flex flex-col items-center gap-3 px-6 py-12 text-center"
    >
      <span
        aria-hidden="true"
        className="mb-1 flex size-20 items-center justify-center rounded-full bg-brand-soft text-brand-ink [&_svg]:size-9"
      >
        {icon}
      </span>
      <h2 className="text-xl leading-7 font-bold tracking-[-0.01em] text-balance">{title}</h2>
      {description ? (
        <p className="max-w-xs text-muted-foreground text-pretty">{description}</p>
      ) : null}
      {action ? <div className="mt-2 flex w-full max-w-xs flex-col">{action}</div> : null}
    </div>
  );
}
