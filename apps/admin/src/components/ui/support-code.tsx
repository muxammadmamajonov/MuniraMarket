'use client';

import { cx } from '@muniramarket/ui';
import { useI18n } from '@/i18n/context';

/**
 * The "support code" of a failed request: the first characters of its `X-Request-ID`, which the
 * admin proxy, the gateway and the Core API all log as `request_id`. An operator reads it out (or
 * pastes it) and whoever checks the logs finds the exact request. Selectable text, monospace so
 * `0`/`O` and `1`/`l` stay apart. Renders nothing without a code.
 */
export function SupportCode({
  code,
  hint = false,
  className,
}: {
  code: string | null;
  /** Also show the one-line "send this to an administrator" hint. */
  hint?: boolean;
  className?: string;
}) {
  const { dict } = useI18n();
  if (code === null) return null;
  const [before, after] = dict.auth.supportCode.split('{code}');
  return (
    <div className={cx('flex flex-col gap-0.5 text-sm text-muted-foreground', className)}>
      <p data-testid="support-code">
        {before}
        <span className="rounded-md bg-surface-muted px-1.5 py-0.5 font-mono text-foreground select-all">
          {code}
        </span>
        {after}
      </p>
      {hint ? <p>{dict.auth.supportCodeHint}</p> : null}
    </div>
  );
}
