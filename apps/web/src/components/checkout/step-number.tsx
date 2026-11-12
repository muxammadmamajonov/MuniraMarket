/**
 * The step's place in the checkout sequence (address, time, recipient, payment, comment), drawn
 * before a section heading. Decorative for screen readers: the heading text is the name, and the
 * order is the reading order.
 */
export function StepNumber({ step }: { step: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-sm font-bold text-background tabular-nums"
    >
      {step}
    </span>
  );
}

/** Heading classes for a numbered checkout section. */
export const STEP_HEADING = 'flex items-center gap-2.5 text-lg leading-7 font-bold tracking-[-0.01em]';
