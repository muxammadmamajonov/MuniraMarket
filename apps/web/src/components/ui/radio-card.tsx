import type { ReactNode } from 'react';

export interface RadioCardProps {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  onBlur?: () => void;
  disabled?: boolean;
  /** Marks the input as the element a `BottomSheet` focuses when it opens. */
  autoFocusInSheet?: boolean;
  children: ReactNode;
}

/**
 * A choice card with a drawn radio dot. The real `<input type="radio">` stays in the DOM
 * (`sr-only`) so the group keeps native semantics and arrow-key behaviour; the dot and the card
 * react to `:checked` / `:focus-visible` through `has-*` variants, like the delivery-slot tiles.
 */
export function RadioCard({
  name,
  value,
  checked,
  onChange,
  onBlur,
  disabled = false,
  autoFocusInSheet = false,
  children,
}: RadioCardProps) {
  return (
    <label
      className={
        'group flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 ' +
        'transition-colors duration-150 motion-reduce:transition-none ' +
        'has-checked:border-primary has-checked:bg-surface-muted has-disabled:cursor-not-allowed has-disabled:opacity-50 ' +
        'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus'
      }
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        {...(onBlur === undefined ? {} : { onBlur })}
        {...(autoFocusInSheet ? { 'data-autofocus': '' } : {})}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-border-strong transition-colors duration-150 group-has-checked:border-primary motion-reduce:transition-none"
      >
        <span className="size-2.5 scale-50 rounded-full bg-primary opacity-0 transition-[transform,opacity] duration-150 ease-out-strong group-has-checked:scale-100 group-has-checked:opacity-100 motion-reduce:transition-none" />
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </label>
  );
}
