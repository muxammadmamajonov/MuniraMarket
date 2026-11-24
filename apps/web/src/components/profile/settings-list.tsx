import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChevronRightIcon } from '../icons';
import { FOCUS_RING, GROUP } from '../ui-classes';

/**
 * Grouped settings rows in the native iOS / Telegram style: a small caption above a white block,
 * rows with a coloured 30px icon tile, the title, an optional value on the right and a chevron.
 * Rows are split by an inset hairline that starts after the tile (never under it), and the press
 * state is a background tint, not a scale: these are list rows, not buttons.
 */

export type TileTone = 'brand' | 'ink' | 'soft' | 'muted';

const TONES: Record<TileTone, string> = {
  brand: 'bg-primary text-primary-foreground',
  ink: 'bg-foreground text-background',
  soft: 'bg-brand-soft text-brand-ink',
  muted: 'bg-surface-muted text-foreground',
};

/** A rounded-square icon tile (iOS "settings" glyph). Decorative. */
export function IconTile({ tone, children }: { tone: TileTone; children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className={`flex size-[30px] shrink-0 items-center justify-center rounded-[9px] ${TONES[tone]} [&>svg]:size-[18px]`}
    >
      {children}
    </span>
  );
}

/** Inset divider above every row but the first; it starts at the text, after the tile. */
const ROW =
  'relative flex min-h-13 w-full items-center gap-3 px-4 py-2.5 text-left ' +
  'before:absolute before:top-0 before:right-0 before:left-[58px] before:h-px before:bg-hairline first:before:hidden';

const ROW_PRESS =
  'transition-colors duration-150 hover:bg-surface-muted active:bg-surface-muted ' +
  `${FOCUS_RING} focus-visible:-outline-offset-2`;

export function SettingsGroup({
  title,
  footer,
  children,
  labelledBy,
}: {
  title?: string;
  footer?: ReactNode;
  children: ReactNode;
  labelledBy?: string;
}) {
  return (
    <section aria-labelledby={labelledBy} className="flex flex-col gap-1.5">
      {title === undefined ? null : (
        <h2
          id={labelledBy}
          className="px-4 text-[13px] leading-4 font-medium tracking-[0.02em] text-muted-foreground uppercase"
        >
          {title}
        </h2>
      )}
      <div className={`${GROUP} flex flex-col overflow-hidden`}>{children}</div>
      {footer === undefined ? null : (
        <div className="px-4 text-[13px] leading-[18px] text-muted-foreground">{footer}</div>
      )}
    </section>
  );
}

interface RowContentProps {
  icon?: ReactNode;
  tone?: TileTone;
  title: ReactNode;
  value?: ReactNode;
  chevron?: boolean;
  trailing?: ReactNode;
}

function RowContent({
  icon,
  tone = 'muted',
  title,
  value,
  chevron = true,
  trailing,
}: RowContentProps) {
  return (
    <>
      {icon === undefined ? null : <IconTile tone={tone}>{icon}</IconTile>}
      <span className="min-w-0 flex-1 truncate text-[17px] leading-[22px]">{title}</span>
      {value === undefined ? null : (
        <span className="max-w-[45%] shrink-0 truncate text-[15px] text-muted-foreground">
          {value}
        </span>
      )}
      {trailing}
      {chevron ? (
        <ChevronRightIcon
          aria-hidden="true"
          width={18}
          height={18}
          className="-mr-1 shrink-0 text-muted-foreground/70"
        />
      ) : null}
    </>
  );
}

export function SettingsLinkRow({
  href,
  testId,
  ...content
}: RowContentProps & { href: string; testId?: string }) {
  return (
    <Link href={href} data-testid={testId} className={`${ROW} ${ROW_PRESS}`}>
      <RowContent {...content} />
    </Link>
  );
}

export function SettingsButtonRow({
  onClick,
  disabled,
  testId,
  danger = false,
  ...content
}: RowContentProps & {
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={`${ROW} ${ROW_PRESS} disabled:opacity-50 ${danger ? 'text-danger' : ''}`}
    >
      <RowContent {...content} />
    </button>
  );
}

/** A non-interactive row (a value shown, or a row that holds its own control). */
export function SettingsStaticRow({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={`${ROW} ${className ?? ''}`}>{children}</div>;
}

/**
 * An iOS-style switch (`role="switch"`). The knob slides with transform only; the track colour
 * changes with a short transition. Reduced motion: no slide animation.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  testId,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[31px] w-[51px] shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 disabled:opacity-50 ${checked ? 'bg-primary' : 'bg-border-strong/50'} ${FOCUS_RING} before:absolute before:-inset-2 before:content-['']`}
    >
      <span
        aria-hidden="true"
        className={`size-[27px] rounded-full bg-white shadow-[0_2px_6px_rgb(0_0_0/0.18)] transition-transform duration-200 ease-out-strong motion-reduce:transition-none ${checked ? 'translate-x-5' : 'translate-x-0'}`}
      />
    </button>
  );
}
