import { cx } from '@muniramarket/ui';
import { useId } from 'react';

/**
 * MuniraMarket mark for the back office: the same flat geometry as the storefront's
 * (`apps/web/src/brand/munira-mark.ts`, exported as `public/brand/munira-mark.svg`), copied as
 * static paths because the apps do not share source. If the storefront mark changes, re-copy it
 * from that file. Drawn in `--mm-color-wordmark-primary` (the sign's deep red on light and dark).
 */
export function BrandMark({ className }: { className?: string }) {
  const mask = `mm-cut-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  return (
    <svg
      viewBox="0 0 58 58"
      aria-hidden="true"
      focusable="false"
      className={cx('shrink-0', className)}
      data-testid="brand-mark"
    >
      <g transform="translate(0 10)">
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="-10" width="58" height="58">
          <rect x="0" y="-10" width="58" height="58" fill="#fff" />
          <path
            d="M25.99 12.01Q24.41 5.74 20.36 0.8"
            fill="none"
            stroke="#000"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
          <path
            d="M33.55 11.78Q42.59 7.68 49.02 0.29"
            fill="none"
            stroke="#000"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </mask>
        <g mask={`url(#${mask})`}>
          <g
            fill="none"
            stroke="var(--mm-color-wordmark-primary)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3.4"
          >
            <path d="M2.6 13.2V10H9L16.18 37.6" />
            <path d="M10.46 15.6H46L42 33.4H15.08" />
            <path d="M16.18 37.6H43.6" />
          </g>
          <g fill="var(--mm-color-wordmark-primary)">
            <path d="M17.23 18.5H43.39a1.6 1.6 0 0 1 0 3.2H17.23a1.6 1.6 0 0 1 0-3.2z" />
            <path d="M18.37 22.9H42.4a1.6 1.6 0 0 1 0 3.2H18.37a1.6 1.6 0 0 1 0-3.2z" />
            <path d="M19.51 27.3H41.41a1.6 1.6 0 0 1 0 3.2H19.51a1.6 1.6 0 0 1 0-3.2z" />
            <path d="M17.9 43.4a3.3 3.3 0 1 0 6.6 0a3.3 3.3 0 1 0-6.6 0z" />
            <path d="M35.5 43.4a3.3 3.3 0 1 0 6.6 0a3.3 3.3 0 1 0-6.6 0z" />
            <path d="M27.4 14.6C31.62 8.53 26.69 0.72 18.6 -1.6C17.02 6.39 21.25 13.75 27.4 14.6z" />
            <path d="M30 14.6C40.15 19.19 50.69 9.68 52.2 -3C39.81 -3.13 29.78 5.2 30 14.6z" />
          </g>
        </g>
      </g>
    </svg>
  );
}

/**
 * Brand lockup for the admin chrome: mark, MUNIRA / MARKET as on the shop sign and a quiet
 * "admin" tag, so nobody mistakes the back office for the storefront. The accessible name is the
 * app name, given once.
 */
export function BrandLockup({ appName, tag }: { appName: string; tag: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <BrandMark className="size-8" />
      <span aria-hidden="true" className="flex min-w-0 flex-col leading-none">
        <span className="text-[15px] font-black tracking-[-0.01em] whitespace-nowrap">
          <span className="text-(--mm-color-wordmark-primary)">MUNIRA</span>{' '}
          <span className="text-(--mm-color-wordmark-secondary)">MARKET</span>
        </span>
        <span className="mt-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {tag}
        </span>
      </span>
      <span className="sr-only">{appName}</span>
    </span>
  );
}
