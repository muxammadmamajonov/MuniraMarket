import type { ReactNode } from 'react';

/**
 * Category line icons drawn for MuniraMarket (24x24 grid, 1.75px round strokes, `currentColor`).
 * They replace the old initial-letter tiles. Decorative: the category link carries the name.
 */
export type CategoryIconKind =
  | 'produce'
  | 'bread'
  | 'dairy'
  | 'meat'
  | 'grain'
  | 'oil'
  | 'drink'
  | 'tea'
  | 'household'
  | 'basket';

/**
 * Slug prefix -> icon. Matched against the slug without a `demo-` prefix, Uzbek first (the
 * catalogue's slugs are Uzbek), with English and transliterated Russian as fallbacks so a new
 * category an operator adds still finds its icon. Anything unknown gets the basket.
 */
const RULES: ReadonlyArray<readonly [RegExp, CategoryIconKind]> = [
  [/^(meva|sabzavot|fruit|veg|produce|frukt|ovosh)/, 'produce'],
  [/^(non|bread|pishiriq|bakery|xleb|khleb|vypech)/, 'bread'],
  [/^(sut|milk|dairy|tuxum|egg|moloch)/, 'dairy'],
  [/^(gosht|go-sht|meat|parranda|poultry|myaso)/, 'meat'],
  [/^(bakaleya|don|guruch|un-|grain|rice|flour|krup)/, 'grain'],
  [/^(yog|oil|ziravor|spice|masl)/, 'oil'],
  [/^(ichimlik|sharbat|drink|juice|water|napit|sok)/, 'drink'],
  [/^(choy|qahva|shirinlik|tea|coffee|sweet|chay|kofe)/, 'tea'],
  [/^(uy|household|home|bytov|khoz)/, 'household'],
];

export function categoryIconFor(slug: string): CategoryIconKind {
  const key = slug.toLowerCase().replace(/^demo-/, '');
  for (const [pattern, kind] of RULES) if (pattern.test(key)) return kind;
  return 'basket';
}

const PATHS: Record<CategoryIconKind, ReactNode> = {
  produce: (
    <>
      <path d="M12 8.2c-1.5-1.2-3.6-1.5-5.2-.6C4.6 8.8 4.3 12.2 5.3 15c1 3 3.3 5.5 5.1 5.5.8 0 1.1-.4 1.6-.4s.8.4 1.6.4c1.8 0 4.1-2.5 5.1-5.5 1-2.8.7-6.2-1.5-7.4-1.6-.9-3.7-.6-5.2.6z" />
      <path d="M12 8.2c0-1.8.6-3.3 1.8-4.6" />
      <path d="M13.6 5.4c1.4-1 3.1-1.1 4.6-.2-1.1 1.5-2.9 1.9-4.6.2z" />
    </>
  ),
  bread: (
    <>
      <path d="M5.5 11.2A3.8 3.8 0 0 1 7 4h10a3.8 3.8 0 0 1 1.5 7.2V19a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19z" />
      <path d="M9 9.5 10.5 7.5M12.5 9.5 14 7.5" />
    </>
  ),
  dairy: (
    <>
      <path d="M7.5 8.5 9 4h6l1.5 4.5V19a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.5 19z" />
      <path d="M7.5 8.5h9" />
      <path d="M12 12.3c1.2 1.4 1.8 2.4 1.8 3.2a1.8 1.8 0 0 1-3.6 0c0-.8.6-1.8 1.8-3.2z" />
    </>
  ),
  meat: (
    <>
      <path d="M4 12.8C4 8.3 7.9 4.5 12.9 4.5s7.1 2.6 7.1 6c0 2.4-1.6 3.8-3.2 5.2-1.7 1.6-2.7 4.3-6.6 4.3-3.7 0-6.2-3.4-6.2-7.2z" />
      <circle cx="12.5" cy="11" r="2" />
    </>
  ),
  grain: (
    <>
      <path d="M12 21V8" />
      <path d="M12 8c-1.7-.4-2.8-1.8-2.8-3.6 1.7.4 2.8 1.8 2.8 3.6zM12 8c1.7-.4 2.8-1.8 2.8-3.6-1.7.4-2.8 1.8-2.8 3.6z" />
      <path d="M12 12.5c-2-.2-3.4-1.6-3.6-3.6 2 .2 3.4 1.6 3.6 3.6zM12 12.5c2-.2 3.4-1.6 3.6-3.6-2 .2-3.4 1.6-3.6 3.6z" />
      <path d="M12 17c-2-.2-3.4-1.6-3.6-3.6 2 .2 3.4 1.6 3.6 3.6zM12 17c2-.2 3.4-1.6 3.6-3.6-2 .2-3.4 1.6-3.6 3.6z" />
    </>
  ),
  oil: (
    <>
      <path d="M10 3.5h4" />
      <path d="M10.5 3.5v3L8 10v9a1.5 1.5 0 0 0 1.5 1.5h5A1.5 1.5 0 0 0 16 19v-9l-2.5-3.5v-3" />
      <path d="M12 12.5c1 1.2 1.5 2 1.5 2.7a1.5 1.5 0 0 1-3 0c0-.7.5-1.5 1.5-2.7z" />
    </>
  ),
  drink: (
    <>
      <path d="M6.5 8h11l-1.3 11.2a1.5 1.5 0 0 1-1.5 1.3H9.3a1.5 1.5 0 0 1-1.5-1.3z" />
      <path d="M13 8l1.4-4.5H17" />
      <path d="M7 12.5h10" />
    </>
  ),
  tea: (
    <>
      <path d="M5 10h11v3.5a5.5 5.5 0 0 1-11 0z" />
      <path d="M16 11h1.3a2.2 2.2 0 0 1 0 4.4H15.6" />
      <path d="M4 20.5h13" />
      <path d="M9 3.5c-.8.9-.8 1.9 0 2.8M12 3.5c-.8.9-.8 1.9 0 2.8" />
    </>
  ),
  household: (
    <>
      <path d="M4.5 11 12 4.5l7.5 6.5V19a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19z" />
      <path d="M12 11.5v5M9.5 14h5" />
    </>
  ),
  basket: (
    <>
      <path d="M3.5 9.5h17l-1.6 8.2a2 2 0 0 1-2 1.8H7.1a2 2 0 0 1-2-1.8z" />
      <path d="m8 9.5 3-5M16 9.5l-3-5" />
    </>
  ),
};

export interface CategoryIconProps {
  kind: CategoryIconKind;
  className?: string;
}

export function CategoryIcon({ kind, className }: CategoryIconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon={kind}
      className={className}
    >
      {PATHS[kind]}
    </svg>
  );
}
