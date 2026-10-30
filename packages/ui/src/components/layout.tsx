import type { HTMLAttributes } from 'react';
import { cx } from '../cx';

export type ContainerTag = 'div' | 'section' | 'header' | 'footer' | 'nav';

export interface ContainerProps extends HTMLAttributes<HTMLElement> {
  as?: ContainerTag;
}

/** Centres content, caps its width and applies the page gutter. Mobile-first. */
export function Container({ as: Tag = 'div', className, ...rest }: ContainerProps) {
  return <Tag className={cx('mx-auto w-full max-w-3xl px-4 sm:px-6', className)} {...rest} />;
}

export type ScreenProps = HTMLAttributes<HTMLElement>;

/**
 * Full-height page wrapper rendered as the page's `<main>` landmark. Respects the notch and home
 * indicator safe areas, which matters inside the Telegram Mini App.
 */
export function Screen({ className, ...rest }: ScreenProps) {
  return (
    <main
      className={cx(
        'flex min-h-dvh flex-col bg-background text-foreground',
        'pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]',
        className,
      )}
      {...rest}
    />
  );
}
